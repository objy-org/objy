import { randomUUID } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  DEFAULT_SHARD,
  GLOBAL_COLLECTION,
  GLOBAL_DATABASE,
  isTopologyResharding,
  topologySourceShards,
} from "./shard-map.js";
import { LocalWalStore } from "./local-wal.js";
import { createObjectStorage } from "./object-storage.js";
import { DEFAULT_DATA_PREFIX, DEFAULT_LOCAL_WAL_DIR } from "./config.js";
import { decodeUtf8Chunks } from "./ndjson.js";
import { ContextLifecycle } from "./context-lifecycle.js";
import { WorkBudget } from "./derived-state-scheduler.js";
import { resolve } from "node:path";
import { PrimaryStateStore, isPrimary, publicationKeys } from "./primary-state.js";

const DEFAULT_SEGMENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_JOURNAL_BYTES = 4 * 1024 * 1024;
const RESTORE_APPLY_BATCH_SIZE = 10_000;
const RESTORE_PARSE_YIELD_LINES = 1000;
let snapshotSequence = 0;
const WAL_POSITION = Symbol("walPosition");

export class PersistenceManager {
  constructor({
    node,
    storage,
    prefix = DEFAULT_DATA_PREFIX,
    flushMs = 5000,
    opBatchSize = 1000,
    journalMaxBytes = DEFAULT_JOURNAL_BYTES,
    snapshotMs = 60_000,
    segmentBytes = DEFAULT_SEGMENT_BYTES,
    compactJournals = true,
    snapshotRetention,
    journalRetention,
    snapshotDirtyOnly = true,
    snapshotRole = "primary",
    restoreScopes,
    restoreSnapshotId,
    ack = "memory",
    localWal,
    durable = false,
  } = {}) {
    if (!node) throw new Error("node is required");
    if (!storage) throw new Error("storage is required");
    this.node = node;
    this.storage = storage;
    this.prefix = normalizePrefix(prefix);
    this.flushMs = Math.max(0, Number(flushMs) || 0);
    this.opBatchSize = Math.max(1, Number(opBatchSize) || 1000);
    this.journalMaxBytes = Math.max(1024, Number(journalMaxBytes) || DEFAULT_JOURNAL_BYTES);
    this.snapshotMs = Math.max(0, Number(snapshotMs) || 0);
    this.segmentBytes = Math.max(1024, Number(segmentBytes) || DEFAULT_SEGMENT_BYTES);
    this.compactJournals = compactJournals !== false;
    this.snapshotRetention = normalizeRetention(snapshotRetention);
    this.journalRetention = normalizeRetention(journalRetention);
    this.snapshotDirtyOnly = snapshotDirtyOnly !== false;
    this.snapshotRole = normalizeSnapshotRole(snapshotRole);
    this.restoreScopes = restoreScopes;
    this.restoreSnapshotId = normalizeSnapshotId(restoreSnapshotId);
    this.durable = durable === true;
    this.localWal = createLocalWalStore(localWal, node.id);
    this.states = new PrimaryStateStore({ storage, node,
      ...(this.durable ? { clockPath: resolve(localWal?.dir || DEFAULT_LOCAL_WAL_DIR, safe(node.id), "publication-clock.json") } : {}),
    });
    this.ack = normalizeAckMode(ack);
    if (this.ack === "localWal" && !this.localWal) {
      throw new Error("persistence.ack localWal requires persistence.localWal.mode on");
    }
    this.pending = new Map();
    this.pendingBytes = 0;
    this.dirtyScopes = new Map();
    this.pendingDatabases = new Map();
    this.pendingDatabaseDrops = new Set();
    this.pendingMeta = new Map();
    this.pendingCollectionDrops = new Set();
    this.localWalPending = [];
    this.localWalPendingBytes = 0;
    this.localWalAccepted = 0;
    this.localWalDurable = 0;
    this.flushTimer = null;
    this.localWalTimer = null;
    this.snapshotTimer = null;
    this.unsubscribe = null;
    this.flushing = null;
    this.localWalFlushing = null;
    this.checkpointing = null;
    this.flushPaused = false;
    this.lastError = null;
    this.reshardCollections = null;
    this.contextVersions = new Map();
    this.replayingLocalWal = false;
    this.lifecycle = new ContextLifecycle({ node, persistence: this });
  }

  async restore(options = {}) {
    const progress = options.progress || null;
    progress?.start?.({
      mode: this._restoreMode(),
      snapshotId: this.restoreSnapshotId || null,
    });
    const root = this._rootPrefix();
    const stats = restoreStats();
    let maxLocalSeq = this.node.seq;

    try {
      progress?.update?.({ phase: "listing" });
      const publications = await this.storage.list(root);
      const keys = publicationKeys(publications);
      const { deletedDatabases, tombstones } = await this._contextState(keys, publications);
      const scopes = this._filterRestoreScopes(uniqueScopes(keys, this.prefix))
        .filter((scope) => !deletedDatabases.has(scope.database))
        .filter((scope) => !tombstones.has(collectionKey(scope.database, scope.collection)));
      if (this._isManagedReshard()) this._rememberReshardCollections(scopes);
      progress?.update?.({
        phase: "metadata",
        scopesTotal: scopes.length,
        totalKeys: keys.length,
      });

      this.node.db.beginBulkLoad?.();
      stats.databaseTombstones = this._restoreDatabaseTombstones(deletedDatabases);
      stats.collectionTombstones = this._restoreCollectionTombstones(tombstones);
      stats.databases = await this._restoreDatabaseMetadata(keys, publications);
      stats.metadata = await this._restoreMetadata(keys, publications);
      maxLocalSeq = await this._restoreScopeSet(keys, scopes, stats, maxLocalSeq, progress, publications);

      if (this.localWal && !this.restoreSnapshotId) {
        progress?.update?.({ phase: "local-wal" });
        const local = await this._restoreLocalWal();
        stats.localWalRecords = local.records;
        stats.localWalOps = local.ops;
        stats.localWalDatabases = local.databases;
        stats.localWalDatabaseDrops = local.databaseDrops;
        stats.localWalMetadata = local.metadata;
        stats.localWalCollectionDrops = local.collectionDrops;
        stats.localWalSkippedPartialRecords = local.skippedPartialRecords;
        progress?.add?.("localWalOps", local.ops);
        maxLocalSeq = Math.max(maxLocalSeq, local.maxLocalSeq);
      }
    } catch (err) {
      progress?.fail?.(err);
      throw err;
    } finally {
      this.node.db.endBulkLoad?.();
    }

    this.node.seq = Math.max(this.node.seq, maxLocalSeq);
    if (this.node.log.length === 0) this.node.trimmed = Math.max(this.node.trimmed, this.node.seq);
    if (this._isManagedReshard()) {
      this._assertDisjointReshardShards();
      stats.reshardCheckpoint = await this.checkpoint({
        primaryOnly: true,
        shards: this._restoreTargetShardNames(),
      });
    }
    progress?.done?.(stats);
    return stats;
  }

  async restoreScope(scope, options = {}) {
    return this.lifecycle.track(scope?.database && scope.database !== "*" ? scope : null, () => this._restoreScope(scope, options));
  }

  async _restoreScope(scope, options = {}) {
    const progress = options.progress || null;
    const root = this._rootPrefix();
    const publications = await this.storage.list(root);
    const keys = publicationKeys(publications);
    const { deletedDatabases, tombstones } = await this._contextState(keys, publications);
    const scopes = this._filterCatchUpScopes(uniqueScopes(keys, this.prefix), scope)
      .filter((candidate) => !deletedDatabases.has(candidate.database))
      .filter((candidate) => !tombstones.has(collectionKey(candidate.database, candidate.collection)));
    const stats = restoreStats();
    let maxLocalSeq = this.node.seq;

    this.node.db.beginBulkLoad?.();
    try {
      stats.databaseTombstones = this._restoreDatabaseTombstones(deletedDatabases);
      stats.collectionTombstones = this._restoreCollectionTombstones(tombstones);
      stats.databases = await this._restoreDatabaseMetadata(keys, publications);
      stats.metadata = await this._restoreMetadata(keys, publications);
      maxLocalSeq = await this._restoreScopeSet(keys, scopes, stats, maxLocalSeq, progress, publications);
      if (!scope) this._rememberUnscopedCursors(scopes);
      else this._rememberScopeSetCursors(scope, scopes);
    } finally {
      this.node.db.endBulkLoad?.();
      this.node.startIndexWarmup?.();
    }

    this.node.seq = Math.max(this.node.seq, maxLocalSeq);
    if (this.node.log.length === 0) this.node.trimmed = Math.max(this.node.trimmed, this.node.seq);
    return stats;
  }

  start() {
    if (!this.unsubscribe) {
      this.unsubscribe = this.node.onChange((change) => this._onChange(change));
    }
    if (this.flushMs && !this.flushTimer) {
      this.flushTimer = setInterval(() => {
        this.flush().catch((err) => (this.lastError = err));
      }, this.flushMs);
      this.flushTimer.unref?.();
    }
    if (this.localWal?.flushMs && !this.localWalTimer) {
      this.localWalTimer = setInterval(() => {
        this.flushLocal().catch((err) => (this.lastError = err));
      }, this.localWal.flushMs);
      this.localWalTimer.unref?.();
    }
    if (this.snapshotMs && !this.snapshotTimer) {
      this.snapshotTimer = setInterval(() => {
        this.checkpoint({ automatic: true }).catch((err) => (this.lastError = err));
      }, this.snapshotMs);
      this.snapshotTimer.unref?.();
    }
  }

  async stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.localWalTimer) clearInterval(this.localWalTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.flushTimer = null;
    this.localWalTimer = null;
    this.snapshotTimer = null;
    await this.checkpointing?.catch((err) => { this.lastError = err; });
    await this.flushLocal();
    do { await this.flush(); } while (this._hasPending());
  }

  async afterWrite() {
    if (this.ack !== "localWal") return { records: 0, ops: 0 };
    return this.flushLocal();
  }

  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this._flushOnce().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async flushLocal() {
    if (!this.localWal) return { records: 0, ops: 0 };
    const total = emptyLocalFlushStats();
    const target = this.localWalAccepted;
    // Cover the writes accepted at entry, without chasing unrelated traffic.
    while (this.localWalDurable < target && (this.localWalPending.length || this.localWalFlushing)) {
      if (this.localWalFlushing) {
        mergeLocalFlushStats(total, await this.localWalFlushing);
        continue;
      }
      this.localWalFlushing = this._flushLocalOnce().finally(() => {
        this.localWalFlushing = null;
      });
      mergeLocalFlushStats(total, await this.localWalFlushing);
    }
    return total;
  }

  async checkpoint(options = {}) {
    if (this.checkpointing) return this.checkpointing;
    this.checkpointing = this._checkpointOnce(options).finally(() => {
      this.checkpointing = null;
    });
    return this.checkpointing;
  }

  async reshardReadiness() {
    const shardMap = this.node.shardMapSnapshot();
    if (!isTopologyResharding(shardMap)) {
      return { ready: true, topologyId: shardMap.topology?.id || null, expectedScopes: 0, completedScopes: 0, missing: [] };
    }

    const collections = this.reshardCollections || await this._loadReshardCollections(shardMap);

    const missing = [];
    const targetShards = Object.keys(shardMap.shards).sort();
    const expected = [];
    for (const collection of collections.values()) {
      for (const shard of targetShards) {
        const scope = { ...collection, shard };
        expected.push({ scope, key: `${scopePrefix(this.prefix, scope)}/latest.json` });
      }
    }
    let completedScopes = 0;
    for (let i = 0; i < expected.length; i += 32) {
      const batch = expected.slice(i, i + 32);
      const found = await Promise.all(batch.map(async ({ key }) => (await this.states.read(key)).body));
      for (let j = 0; j < batch.length; j++) {
        if (!isCompletedTargetManifest(found[j], shardMap.topology.id, batch[j].scope)) missing.push(batch[j].scope);
        else completedScopes++;
      }
    }

    const expectedScopes = expected.length;
    return {
      ready: missing.length === 0,
      topologyId: shardMap.topology.id,
      sourceScopes: collections.size,
      expectedScopes,
      completedScopes,
      missing,
    };
  }

  _rememberReshardCollections(scopes) {
    this.reshardCollections = new Map();
    for (const scope of scopes) {
      this.reshardCollections.set(collectionKey(scope.database, scope.collection), {
        database: scope.database,
        collection: scope.collection,
      });
    }
  }

  async _loadReshardCollections(shardMap) {
    const keys = await this.storage.list(this._rootPrefix());
    const sourceShards = new Set(topologySourceShards(shardMap));
    const { deletedDatabases, tombstones } = await this._contextState(keys, keys);
    const scopes = uniqueScopes(keys, this.prefix)
      .filter((scope) => sourceShards.has(scope.shard))
      .filter((scope) => !deletedDatabases.has(scope.database))
      .filter((scope) => !tombstones.has(collectionKey(scope.database, scope.collection)));
    this._rememberReshardCollections(scopes);
    return this.reshardCollections;
  }

  getStats() {
    return {
      pendingScopes: this.pending.size,
      pendingOps: [...this.pending.values()].reduce((sum, ops) => sum + ops.length, 0),
      pendingBytes: this.pendingBytes,
      dirtyScopes: this.dirtyScopes.size,
      dirtyOps: [...this.dirtyScopes.values()].reduce((sum, dirty) => sum + dirty.ops, 0),
      pendingDatabases: this.pendingDatabases.size,
      pendingDatabaseDrops: this.pendingDatabaseDrops.size,
      pendingMetadata: this.pendingMeta.size,
      pendingCollectionDrops: this.pendingCollectionDrops.size,
      ack: this.ack,
      localWal: this.localWal ? {
        path: this.localWal.filePath,
        fsync: this.localWal.fsync,
        pendingRecords: this.localWalPending.length,
        pendingBytes: this.localWalPendingBytes,
        flushActive: this.localWalFlushing !== null,
      } : null,
      lastError: this.lastError?.message || null,
    };
  }

  _onChange(change) {
    if (this.replayingLocalWal) return;
    if (change.kind === "database") {
      this._queueDatabase(change);
      return;
    }
    if (change.kind === "dropDatabase") {
      this._queueDatabaseDrop(change);
      return;
    }
    if (change.kind === "dropCollection") {
      this._queueCollectionDrop(change);
      return;
    }
    if (change.kind === "meta") {
      this._queueMeta(change);
      return;
    }
    if (change.kind === "ops") {
      this._queueOps(change.ops || []);
      return;
    }
  }

  _queueDatabase(change) {
    if (!change.database || !change.meta) return;
    this._reviveContext(change.database);
    this.pendingDatabases.set(change.database, clone(change.meta));
    this.pendingDatabaseDrops.delete(change.database);
    this._queueLocalWal({
      type: "database",
      database: change.database,
      meta: clone(change.meta),
    });
  }

  _queueDatabaseDrop(change) {
    if (!change.database) return;
    this._advanceContext(change.database);
    if (!this.lifecycle.record(change.database)) this.pendingDatabaseDrops.add(change.database);
    this.pendingDatabases.delete(change.database);
    for (const key of [...this.pendingMeta.keys()]) {
      if (parseCollectionKey(key).database === change.database) this.pendingMeta.delete(key);
    }
    for (const key of [...this.pendingCollectionDrops]) {
      if (parseCollectionKey(key).database === change.database) this.pendingCollectionDrops.delete(key);
    }
    for (const key of [...this.pending.keys()]) {
      if (parseScopeKey(key).database === change.database) this.pending.delete(key);
    }
    this.pendingBytes = pendingOpsJsonBytes(this.pending);
    this._removePendingLocalWalForDatabase(change.database);
    this._queueLocalWal({
      type: "dropDatabase",
      database: change.database,
    });
  }

  _queueMeta(change) {
    if (!change.database || !change.collection || !change.meta) return;
    this._reviveContext(change.database, change.collection);
    this.pendingMeta.set(collectionKey(change.database, change.collection), clone(change.meta));
    this._queueLocalWal({
      type: "meta",
      database: change.database,
      collection: change.collection,
      meta: clone(change.meta),
    });
  }

  _queueCollectionDrop(change) {
    if (!change.database || !change.collection) return;
    this._advanceContext(change.database, change.collection);
    const key = collectionKey(change.database, change.collection);
    if (!this.lifecycle.record(change.database) && !this.lifecycle.record(change.database, change.collection)) this.pendingCollectionDrops.add(key);
    this.pendingMeta.delete(key);
    this._removePendingLocalWalForCollection(change.database, change.collection);
    for (const pendingKey of [...this.pending.keys()]) {
      const scope = parseScopeKey(pendingKey);
      if (scope.database === change.database && scope.collection === change.collection) {
        this.pending.delete(pendingKey);
      }
    }
    this.pendingBytes = pendingOpsJsonBytes(this.pending);
    this._queueLocalWal({
      type: "dropCollection",
      database: change.database,
      collection: change.collection,
    });
  }

  _queueOps(ops) {
    const cloned = [];
    for (const op of ops || []) {
      const queued = this._queueOp(op);
      if (queued) cloned.push(queued);
    }
    if (!cloned.length) return;
    if (!this.localWal || this.replayingLocalWal) return;
    const maxBytes = this.localWal?.maxRecordBytes || this.journalMaxBytes;
    const maxOps = this.localWal?.maxOpsPerRecord || this.opBatchSize;
    for (const chunk of chunkOpsForRecord(cloned, { maxBytes, maxOps, label: "local WAL ops record" })) {
      this._queueLocalWal({
        type: "ops",
        ...commonScope(chunk),
        ...seqRange(chunk),
        count: chunk.length,
        ops: chunk,
      });
    }
  }

  _queueLocalWal(record) {
    if (!this.localWal || this.replayingLocalWal) return;
    const entry = {
      [WAL_POSITION]: ++this.localWalAccepted,
      version: 1,
      node: this.node.id,
      createdAt: new Date().toISOString(),
      ...record,
      ...(record.type !== "ops" ? { contextTicket: this.lifecycle.ticket(record) } : {}),
    };
    this.localWalPending.push(entry);
    this.localWalPendingBytes += jsonBytes(entry, "pending local WAL record") + 1;
  }

  _queueOp(op) {
    if (!op?.db || !op.coll || !op.id || !op.shard) return;
    const cloned = this.replayingLocalWal ? op : clone(op);
    const scope = { database: op.db, collection: op.coll, shard: op.shard };
    const key = scopeKey(scope);
    const pending = this.pending.get(key) || [];
    pending.push(cloned);
    this.pending.set(key, pending);
    this.pendingBytes += jsonBytes(cloned, "pending journal op");
    this._markDirty(key, cloned);
    if (!this.replayingLocalWal && pending.length >= this.opBatchSize) {
      this.flush().catch((err) => (this.lastError = err));
    }
    return cloned;
  }

  _removePendingLocalWalForCollection(database, collection) {
    if (!this.localWalPending.length) return;
    this.localWalPending = this.localWalPending.filter((record) => {
      if (record.type === "ops") {
        record.ops = (record.ops || []).filter((op) => op.db !== database || op.coll !== collection);
        record.count = record.ops.length;
        delete record.database;
        delete record.collection;
        delete record.shard;
        Object.assign(record, commonScope(record.ops), seqRange(record.ops));
        return record.ops.length > 0;
      }
      if (record.database !== database || record.collection !== collection) return true;
      return record.type !== "meta" && record.type !== "dropCollection";
    });
    this.localWalPendingBytes = pendingWalJsonBytes(this.localWalPending);
  }

  _removePendingLocalWalForDatabase(database) {
    if (!this.localWalPending.length) return;
    this.localWalPending = this.localWalPending.filter((record) => {
      if (record.type === "ops") {
        record.ops = (record.ops || []).filter((op) => op.db !== database);
        record.count = record.ops.length;
        delete record.database;
        delete record.collection;
        delete record.shard;
        Object.assign(record, commonScope(record.ops), seqRange(record.ops));
        return record.ops.length > 0;
      }
      return record.database !== database;
    });
    this.localWalPendingBytes = pendingWalJsonBytes(this.localWalPending);
  }

  _markDirty(key, op) {
    const dirty = this.dirtyScopes.get(key) || { ops: 0, version: 0, lastSeq: 0 };
    dirty.ops++;
    dirty.version++;
    const seq = Number(op.seq);
    if (Number.isFinite(seq) && seq > dirty.lastSeq) dirty.lastSeq = seq;
    this.dirtyScopes.set(key, dirty);
  }

  _advanceContext(database, collection = "") {
    const key = collectionKey(database, collection);
    this.contextVersions.set(key, (this.contextVersions.get(key) || 0) + 1);
    for (const key of this.dirtyScopes.keys()) {
      const scope = parseScopeKey(key);
      if (scope.database === database && (!collection || scope.collection === collection)) this.dirtyScopes.delete(key);
    }
  }

  _reviveContext(database, collection = "") {
    if ((this.contextVersions.get(collectionKey(database, collection)) || 0) % 2) this._advanceContext(database, collection);
  }

  _contextVersion(database, collection = "") {
    return `${this.contextVersions.get(collectionKey(database, "")) || 0}/${this.contextVersions.get(collectionKey(database, collection)) || 0}`;
  }

  _hasPending() {
    return this.pending.size || this.pendingDatabases.size || this.pendingDatabaseDrops.size || this.pendingMeta.size || this.pendingCollectionDrops.size;
  }

  async _flushOnce() {
    if (this.flushPaused) return { scopes: 0, ops: 0 };
    if (!this._hasPending()) {
      return { scopes: 0, ops: 0, databases: 0, databaseDrops: 0, metadata: 0, collectionDrops: 0 };
    }

    const batches = this.pending;
    const databases = this.pendingDatabases;
    const databaseDrops = this.pendingDatabaseDrops;
    const metadata = this.pendingMeta;
    const collectionDrops = this.pendingCollectionDrops;
    const versions = new Map();
    const remember = ({ database, collection = "" }) => versions.set(collectionKey(database, collection), this._contextVersion(database, collection));
    for (const key of batches.keys()) remember(parseScopeKey(key));
    for (const database of [...databases.keys(), ...databaseDrops]) remember({ database });
    for (const key of [...metadata.keys(), ...collectionDrops]) remember(parseCollectionKey(key));
    const stillCurrent = ({ database, collection = "" }) => versions.get(collectionKey(database, collection)) === this._contextVersion(database, collection);
    this.pending = new Map();
    this.pendingBytes = 0;
    this.pendingDatabases = new Map();
    this.pendingDatabaseDrops = new Set();
    this.pendingMeta = new Map();
    this.pendingCollectionDrops = new Set();
    let scopeCount = 0;
    let opCount = 0;
    let databaseCount = 0;
    let databaseDropCount = 0;
    let metadataCount = 0;
    let collectionDropCount = 0;

    try {
      for (const database of databaseDrops) {
        await this._deleteDatabase(database);
        databaseDropCount++;
      }
      for (const key of collectionDrops) {
        const target = parseCollectionKey(key);
        await this._deleteCollection(target);
        collectionDropCount++;
      }
      for (const [database, meta] of databases) {
        await this._writeDatabaseMeta(database, meta);
        databaseCount++;
      }
      for (const [key, meta] of metadata) {
        await this._writeCollectionMeta(parseCollectionKey(key), meta);
        metadataCount++;
      }
      for (const [key, ops] of batches) {
        if (!ops.length) continue;
        await this._writeJournalBatch(parseScopeKey(key), ops);
        scopeCount++;
        opCount += ops.length;
      }
      await this._truncateLocalWalIfDurable();
      return {
        scopes: scopeCount,
        ops: opCount,
        databases: databaseCount,
        databaseDrops: databaseDropCount,
        metadata: metadataCount,
        collectionDrops: collectionDropCount,
      };
    } catch (err) {
      this._requeueBatches(batches, stillCurrent);
      this._requeueDatabases(databases, stillCurrent);
      this._requeueDatabaseDrops(databaseDrops, stillCurrent);
      this._requeueMetadata(metadata, stillCurrent);
      this._requeueCollectionDrops(collectionDrops, stillCurrent);
      this.lastError = err;
      throw err;
    }
  }

  async _flushLocalOnce() {
    if (!this.localWal || !this.localWalPending.length) return emptyLocalFlushStats();
    const records = this.localWalPending;
    this.localWalPending = [];
    this.localWalPendingBytes = 0;

    try {
      const written = await this.localWal.append(records);
      this.localWalDurable = Math.max(this.localWalDurable, records.at(-1)[WAL_POSITION]);
      return {
        records: records.length,
        ops: records.reduce((sum, record) => sum + (record.type === "ops" ? Number(record.count) || 0 : 0), 0),
        databases: records.filter((record) => record.type === "database").length,
        databaseDrops: records.filter((record) => record.type === "dropDatabase").length,
        metadata: records.filter((record) => record.type === "meta").length,
        collectionDrops: records.filter((record) => record.type === "dropCollection").length,
        bytes: written.bytes,
      };
    } catch (err) {
      this.localWalPending = [...records, ...this.localWalPending];
      this.localWalPendingBytes = pendingWalJsonBytes(this.localWalPending);
      this.lastError = err;
      throw err;
    }
  }

  async _truncateLocalWalIfDurable() {
    const covered = () => !this.replayingLocalWal && !this.localWalPending.length && !this.localWalFlushing &&
      !this.pending.size && !this.pendingDatabases.size && !this.pendingDatabaseDrops.size &&
      !this.pendingMeta.size && !this.pendingCollectionDrops.size;
    if (this.localWal && covered()) await this.localWal.truncate(covered);
  }

  _requeueBatches(batches, stillCurrent) {
    for (const [key, ops] of batches) {
      if (!stillCurrent(parseScopeKey(key))) continue;
      const current = this.pending.get(key) || [];
      this.pending.set(key, [...ops, ...current]);
    }
    this.pendingBytes = pendingOpsJsonBytes(this.pending);
  }

  _requeueDatabases(databases, stillCurrent) {
    for (const [database, meta] of databases) {
      if (!stillCurrent({ database })) continue;
      if (!this.pendingDatabases.has(database)) this.pendingDatabases.set(database, meta);
    }
  }

  _requeueDatabaseDrops(databaseDrops, stillCurrent) {
    for (const database of databaseDrops) if (stillCurrent({ database })) this.pendingDatabaseDrops.add(database);
  }

  _requeueMetadata(metadata, stillCurrent) {
    for (const [key, meta] of metadata) {
      if (!stillCurrent(parseCollectionKey(key))) continue;
      if (!this.pendingMeta.has(key)) this.pendingMeta.set(key, meta);
    }
  }

  _requeueCollectionDrops(collectionDrops, stillCurrent) {
    for (const key of collectionDrops) if (stillCurrent(parseCollectionKey(key))) this.pendingCollectionDrops.add(key);
  }

  async _writeDatabaseMeta(database, meta) {
    return this._writeContextMeta({ database }, `${databasePrefix(this.prefix, database)}/meta.json`, meta);
  }

  async _writeCollectionMeta({ database, collection }, meta) {
    return this._writeContextMeta({ database, collection }, `${collectionPrefix(this.prefix, database, collection)}/meta.json`, meta);
  }

  async _writeContextMeta(context, path, meta) {
    if (!isPrimary(this.node, context.database)) return;
    const version = this._contextVersion(context.database, context.collection);
    const old = await this.states.read(path);
    if (version !== this._contextVersion(context.database, context.collection)) return;
    const marker = context.collection === undefined ? databaseTombstoneKey(this.prefix, context.database)
      : collectionTombstoneKey(this.prefix, context.database, context.collection);
    await this.storage.delete([marker]);
    if (version !== this._contextVersion(context.database, context.collection)) return;
    // Keep lifecycle markers separate from application-owned meta properties.
    const managed = this.lifecycle.record(context.database) || this.lifecycle.record(context.database, context.collection);
    const value = managed ? { version: 1, meta } : meta;
    if (old.revision && Number(old.revision.slice(0, 16)) === (this.node.shardMapSnapshot().ownershipEpoch || 0) &&
        old.body && JSON.stringify(persistedMeta(old.body, managed)) === JSON.stringify(meta)) return;
    await this.states.publish(path, value, { previous: old.revision, guard: () => {
      if (version !== this._contextVersion(context.database, context.collection)) throw snapshotConflict("context changed during metadata publication");
      this.lifecycle.assert(context.database, context.collection);
    } });
    await this.states.prune(path);
  }

  async fenceContext(record) {
    const collections = record.collection === undefined ? record.collections || [] : [record.collection];
    const paths = [];
    if (isPrimary(this.node, record.database)) {
      if (record.collection === undefined) paths.push(`${databasePrefix(this.prefix, record.database)}/meta.json`);
      for (const collection of collections) paths.push(`${collectionPrefix(this.prefix, record.database, collection)}/meta.json`);
    }
    for (const shard of Object.keys(this.node.shardMapSnapshot().shards)) {
      if (!this.node.isPrimaryForShard(shard)) continue;
      for (const collection of collections) paths.push(`${scopePrefix(this.prefix, { database: record.database, collection, shard })}/latest.json`);
    }
    for (const path of paths) {
      const old = await this.states.read(path);
      if (old.body && JSON.parse(old.body).deletedBy === record.id) continue;
      await this.states.publish(path, { deletedBy: record.id });
      await this.states.prune(path);
    }
  }

  async _deleteCollection({ database, collection }) {
    await this.storage.deletePrefix(`${collectionPrefix(this.prefix, database, collection)}/`);
    await this.storage.put(
      collectionTombstoneKey(this.prefix, database, collection),
      JSON.stringify({ database, collection, deletedAt: new Date().toISOString() }),
      "application/json",
    );
  }

  async _deleteDatabase(database) {
    await this.storage.deletePrefix(`${databasePrefix(this.prefix, database)}/`);
    await this.storage.put(
      databaseTombstoneKey(this.prefix, database),
      JSON.stringify({ database, deletedAt: new Date().toISOString() }),
      "application/json",
    );
  }

  async _writeJournalBatch(scope, ops) {
    const byOrigin = new Map();
    for (const op of ops) {
      const source = op.from || this.node.id;
      const values = byOrigin.get(source) || [];
      values.push(op);
      byOrigin.set(source, values);
    }
    for (const values of byOrigin.values()) {
      for (const chunk of chunkOpsForRecord(values, {
        maxBytes: this.journalMaxBytes,
        maxOps: this.opBatchSize,
        label: `${scopeKey(scope)} journal`,
      })) await this._writeJournalSegment(scope, chunk);
    }
  }

  async _writeJournalSegment(scope, ops) {
    const seqs = ops.map((op) => Number(op.seq)).filter(Number.isFinite);
    const firstSeq = seqs.length ? Math.min(...seqs) : 0;
    const lastSeq = seqs.length ? Math.max(...seqs) : 0;
    const origin = ops[0]?.from;
    const verified = typeof origin === "string" && origin.length > 0 && ops.every((op) => op.from === origin && Number.isSafeInteger(op.seq) && op.seq > 0);
    const suffix = verified ? `-${ops.length}.origin` : "";
    const key = `${scopePrefix(this.prefix, scope)}/journal/${safe(verified ? origin : this.node.id)}/${Date.now()}-${pad(firstSeq)}-${pad(lastSeq)}-${randomUUID()}${suffix}.jsonl`;
    await this.storage.put(key, jsonlBody(ops, `${scopeKey(scope)} journal`), "application/x-ndjson");
  }

  async _checkpointOnce(options = {}) {
    await this.flush();
    this.flushPaused = true;
    const coverage = this._snapshotCoverage();
    const scopes = this._snapshotScopes(options);
    const checkpointId = snapshotId();
    const stats = { id: checkpointId, scopes: 0, objects: 0, segments: 0, retainedSnapshotsDeleted: 0, retainedJournalsDeleted: 0 };
    try {
      for (const scope of scopes) {
        const written = await this._writeSnapshot(scope, checkpointId, coverage);
        this._markCheckpointed(scope);
        stats.scopes++;
        stats.objects += written.objects;
        stats.segments += written.segments;
        stats.retainedSnapshotsDeleted += written.retainedSnapshotsDeleted || 0;
        stats.retainedJournalsDeleted += written.retainedJournalsDeleted || 0;
      }
    } finally {
      this.flushPaused = false;
    }
    return stats;
  }

  _snapshotScopes({ automatic = false, primaryOnly = false, shards: selectedShards } = {}) {
    const scopes = [];
    if ((automatic || primaryOnly) && this.snapshotRole === "none") return scopes;
    const selected = selectedShards?.length ? new Set(selectedShards) : null;
    const ownedShards = this._ownedShardNames().filter((shard) => !selected || selected.has(shard));
    for (const collection of this._collectionScopes()) {
      const shards = ownedShards.length
        ? ownedShards
        : selected
          ? []
          : this.node.shardMap.shardsForCollection(collection.database, collection.collection);
      for (const shard of shards.length ? shards : [DEFAULT_SHARD]) {
        if (!this.node.isPrimaryForShard(shard)) continue;
        const scope = { database: collection.database, collection: collection.collection, shard };
        const dirty = this.dirtyScopes.get(scopeKey(scope));
        if (automatic && this.snapshotDirtyOnly && !dirty) continue;
        if (dirty) scope.dirtyVersion = dirty.version;
        scopes.push(scope);
      }
    }
    return scopes;
  }

  _collectionScopes() {
    const scopes = [];
    for (const database of this.node.listDatabases()) {
      for (const collection of this.node.listCollections(database)) {
        scopes.push({ database, collection });
      }
    }
    return scopes;
  }

  _markCheckpointed(scope) {
    const key = scopeKey(scope);
    const dirty = this.dirtyScopes.get(key);
    if (dirty && scope.dirtyVersion !== undefined && dirty.version > scope.dirtyVersion) return;
    this.dirtyScopes.delete(key);
  }

  _filterRestoreScopes(scopes) {
    const targets = this._restoreTargets();
    if (this._restoreMode() === "reshard") {
      const sourceShards = new Set(this._reshardSourceShards());
      return scopes.filter((scope) => sourceShards.has(scope.shard)
        && (this._restoreAllTargets(targets) || targets.some((target) => matchesRestoreCollection(scope, target))));
    }
    if (this._restoreAllTargets(targets)) return scopes;
    return scopes.filter((scope) => targets.some((target) => matchesRestoreTarget(scope, target)));
  }

  _filterCatchUpScopes(scopes, scope) {
    if (!scope) return this._filterRestoreScopes(scopes);
    return scopes.filter((candidate) => matchesRestoreTarget(candidate, scope));
  }

  _filterRestoreObject(scope, object, targets = null) {
    if (!object) return null;
    if (this._restoreMode() !== "reshard") return object;
    const restoreTargets = targets || this._restoreTargets();
    if (!this._restoreAllTargets(restoreTargets)
      && !this._objectMatchesRestoreTargets(scope.database, scope.collection, object.id, restoreTargets)) return null;
    return {
      ...object,
      shard: this.node.shardForObject(scope.database, scope.collection, object.id),
    };
  }

  _filterRestoreOps(scope, ops) {
    if (this._restoreMode() !== "reshard") return ops;
    const targets = this._restoreTargets();
    return ops
      .filter((op) => this._restoreAllTargets(targets)
        || this._objectMatchesRestoreTargets(op.db || scope.database, op.coll || scope.collection, op.id, targets))
      .map((op) => ({
        ...op,
        shard: this.node.shardForObject(op.db || scope.database, op.coll || scope.collection, op.id),
      }));
  }

  _objectMatchesRestoreTargets(database, collection, objectId, targets) {
    const routedShard = this.node.shardForObject(database, collection, objectId);
    return targets.some((target) => matchesRestoreTarget({ database, collection, shard: routedShard }, target));
  }

  _ownedShardNames() {
    return [...new Set(this.node.ownedShardTargets().map((target) => target.shard))];
  }

  _restoreTargets() {
    return this.restoreScopes || this.node.ownedShardTargets();
  }

  _restoreTargetShardNames() {
    return [...new Set(this._restoreTargets().map((target) => target.shard).filter(Boolean))];
  }

  _restoreMode() {
    return this._isManagedReshard() ? "reshard" : "scoped";
  }

  _isManagedReshard() {
    return isTopologyResharding(this.node.shardMapSnapshot());
  }

  _reshardSourceShards() {
    return topologySourceShards(this.node.shardMapSnapshot());
  }

  _assertDisjointReshardShards() {
    const source = new Set(this._reshardSourceShards());
    for (const target of Object.keys(this.node.shardMapSnapshot().shards || {})) {
      if (source.has(target)) throw new Error(`source and target shard names overlap: ${target}`);
    }
  }

  _restoreAllTargets(targets) {
    if (targets?.length) return false;
    if (!this.node.url) return true;
    return this.node.shardMap.syncTargets().length === 0;
  }

  async _writeSnapshot(scope, id = snapshotId(), coverage = this._snapshotCoverage()) {
    if (!this.node.isPrimaryForShard(scope.shard)) throw snapshotConflict("only the shard primary may publish snapshots");
    const contextVersion = this._contextVersion(scope.database, scope.collection);
    const contextTicket = this.lifecycle.ticket(scope);
    const headKey = `${scopePrefix(this.prefix, scope)}/latest.json`;
    const previous = await this.states.read(headKey);
    const previousValue = previous.body === null ? null : JSON.parse(previous.body);
    const previousManifest = previousValue?.deletedBy ? null : previousValue;
    if (previousManifest) validateSnapshotManifest(previousManifest, scope);
    const cursors = this._snapshotCursors(scope, coverage);
    if (previousManifest && !coversCursors(cursors, normalizeSnapshotCursors(previousManifest))) {
      throw snapshotConflict("snapshot would regress published coverage");
    }
    const base = `${scopePrefix(this.prefix, scope)}/snapshots/${id}`;
    const segments = [];
    let objectCount = 0;

    for await (const chunk of chunkJsonlIterable(this.node.snapshotScopeObjects(scope), this.segmentBytes, `${scopeKey(scope)} snapshot`)) {
      const key = `${base}/segment-${String(segments.length).padStart(6, "0")}.jsonl`;
      await this.storage.put(key, chunk.body, "application/x-ndjson");
      segments.push({ key, count: chunk.count, bytes: chunk.bytes, format: "jsonl" });
      objectCount += chunk.count;
    }

    const manifest = {
      version: 1,
      id,
      node: this.node.id,
      seq: coverage.seq,
      createdAt: new Date().toISOString(),
      database: scope.database,
      collection: scope.collection,
      shard: scope.shard,
      topologyId: this.node.shardMapSnapshot().topology?.id || null,
      databaseMeta: clone(this.node.getDatabaseMeta(scope.database) || {}),
      collectionMeta: clone(this.node.getCollectionMeta(scope.database, scope.collection) || {}),
      cursors,
      format: "jsonl",
      objectCount,
      segments,
      parentSnapshotId: previousManifest?.id || null,
      contextTicket,
    };
    if (contextVersion !== this._contextVersion(scope.database, scope.collection)) throw snapshotConflict("context changed during checkpoint");
    await this.storage.put(`${base}/manifest.json`, JSON.stringify(manifest), "application/json");
    if (contextVersion !== this._contextVersion(scope.database, scope.collection)) throw snapshotConflict("context changed during checkpoint");
    const published = await this.states.publish(headKey, manifest, { previous: previous.revision, guard: () => {
      if (!this.node.isPrimaryForShard(scope.shard)) throw snapshotConflict("snapshot primary changed");
      if (contextVersion !== this._contextVersion(scope.database, scope.collection) || JSON.stringify(contextTicket) !== JSON.stringify(this.lifecycle.ticket(scope))) throw snapshotConflict("context changed during checkpoint");
      this.lifecycle.assert(scope.database, scope.collection);
    } });
    if ((await this.states.read(headKey)).revision !== published.revision) throw snapshotConflict("snapshot publication was superseded");
    const retainedJournalsDeleted = this.compactJournals ? await this._compactJournals(scope, manifest.cursors) : 0;
    const retainedSnapshotsDeleted = await this._applySnapshotRetention(scope, id);
    await this.states.prune(headKey);
    return { objects: objectCount, segments: segments.length, retainedJournalsDeleted, retainedSnapshotsDeleted };
  }

  _snapshotCoverage() {
    return {
      seq: this.node.seq,
      lastSeen: new Map(this.node.lastSeen || []),
    };
  }

  async _compactJournals(scope, cursors = {}) {
    const prefix = `${scopePrefix(this.prefix, scope)}/journal/`;
    const keys = await this.storage.list(prefix);
    if (!keys.length) return 0;
    const covered = [];
    for (const key of keys) {
      if (!key.endsWith(".jsonl") && !key.endsWith(".json")) continue;
      const info = parseJournalKey(key, this.prefix);
      if (info?.originVerified) {
        if ((Number(cursors[info.node]) || 0) >= info.lastSeq) covered.push(key);
        continue;
      }
      let complete = true;
      for await (const op of journalObjectsFromStorage(this.storage, key, scopeKey(scope))) {
        if (!operationCovered(op, cursors)) {
          complete = false;
          break;
        }
      }
      if (complete) covered.push(key);
    }
    if (!covered.length) return 0;
    const removable = filterRetentionKeys(covered, this.journalRetention, (key) => {
      const info = parseJournalKey(key, this.prefix);
      return info?.createdAtMs || 0;
    });
    if (!removable.length) return 0;
    return this.storage.delete(removable);
  }

  async _applySnapshotRetention(scope, latestId) {
    if (!retentionEnabled(this.snapshotRetention)) return 0;
    const prefix = `${scopePrefix(this.prefix, scope)}/snapshots/`;
    const keepSince = this.snapshotRetention.keepForMs > 0 ? Date.now() - this.snapshotRetention.keepForMs : null;
    let id = latestId, position = 0, removed = 0;
    const visited = new Set();
    // Only published ancestors are eligible. Unpublished candidates may still
    // be uploading and cannot be distinguished safely by creation time.
    while (id) {
      if (typeof id !== "string" || id.includes("/")) throw new Error("invalid snapshot ancestor id");
      if (visited.has(id)) throw new Error("invalid snapshot ancestry");
      visited.add(id);
      const raw = await this.storage.get(`${prefix}${id}/manifest.json`);
      if (raw === null) break;
      const manifest = JSON.parse(raw);
      validateSnapshotManifest(manifest, scope);
      const parent = manifest.parentSnapshotId;
      if (parent === id) throw new Error("invalid snapshot ancestry");
      const created = Date.parse(manifest.createdAt) || snapshotCreatedAtMs(id);
      const keep = position === 0 || position < this.snapshotRetention.keepLatest ||
        (keepSince !== null && (!created || created >= keepSince));
      if (!keep) removed += await this.storage.deletePrefix(`${prefix}${id}/`);
      id = parent;
      position++;
      await yieldToEventLoop();
    }
    return removed;
  }

  async _restoreSnapshot(scope, progress = null, publications) {
    const manifestKey = this.restoreSnapshotId
      ? `${scopePrefix(this.prefix, scope)}/snapshots/${this.restoreSnapshotId}/manifest.json`
      : `${scopePrefix(this.prefix, scope)}/latest.json`;
    let raw;
    let current;
    const ownsHead = Object.hasOwn(this.node.shardMapSnapshot().shards, scope.shard) && this.node.isPrimaryForShard(scope.shard);
    if (this.restoreSnapshotId) raw = await this.storage.get(manifestKey);
    else {
      current = await this.states.read(manifestKey, publications);
      raw = current.body;
    }
    if (!raw) {
      if (current && ownsHead) await this.states.adopt(manifestKey, current);
      return null;
    }
    const manifest = JSON.parse(raw);
    if (manifest.deletedBy) return null;
    if (manifest.contextTicket && JSON.stringify(manifest.contextTicket) !== JSON.stringify(this.lifecycle.ticket(scope))) return null;
    validateSnapshotManifest(manifest, scope);
    if (current && ownsHead) await this.states.adopt(manifestKey, current);
    let objects = 0;
    let rows = 0;
    if (this.restoreSnapshotId) this._restoreManifestMetadata(scope, manifest);
    else this._ensureRestoreManifestContext(scope, manifest);

    for (const segment of manifest.segments || []) {
      const restored = await this._restoreSnapshotSegment(scope, manifest, segment, progress);
      objects += restored.objects;
      rows += restored.rows;
    }
    if (manifest.objectCount !== undefined && rows !== manifest.objectCount) throw new Error("snapshot object count mismatch");

    return {
      node: manifest.node,
      seq: Number(manifest.seq) || 0,
      cursors: normalizeSnapshotCursors(manifest),
      objects,
    };
  }

  async _restoreSnapshotSegment(scope, manifest, segment = {}, progress = null) {
    const key = String(segment.key || "");
    const jsonl = segment.format === "jsonl" || key.endsWith(".jsonl");
    const legacyJson = segment.format === "json" || key.endsWith(".json");
    if (!jsonl && !legacyJson) {
      throw new Error(`unsupported snapshot segment format: ${segment.key || "missing key"}`);
    }
    const sourceNode = manifest.node || "persistence";
    const cursorKey = "persistence:snapshot-restore";
    let objects = 0;
    let count = 0;

    const applyRows = async (rows) => {
      if (!rows.length) return;
      const applied = this.node.applySnapshotObjects(sourceNode, {
        database: scope.database,
        collection: scope.collection,
        scope,
        lastSeq: 0,
        objects: rows,
      }, cursorKey);
      this.node.lastSeen.delete(cursorKey);
      objects += applied;
      progress?.add?.("snapshotObjects", applied);
      await yieldToEventLoop();
    };

    const source = jsonl
      ? jsonlObjectsFromStorage(this.storage, key, `${scopeKey(scope)} snapshot`)
      : jsonArrayObjectsFromStorage(this.storage, key, `${scopeKey(scope)} legacy snapshot`);
    let batch = [];
    for await (const object of source) {
      validateSnapshotRow(object, scope);
      count++;
      const row = this._filterRestoreObject(scope, object);
      if (!row) continue;
      batch.push(row);
      if (batch.length < RESTORE_APPLY_BATCH_SIZE) continue;
      await applyRows(batch);
      batch = [];
    }
    await applyRows(batch);
    if (segment.count !== undefined && count !== segment.count) throw new Error(`snapshot segment count mismatch: ${key}`);
    return { objects, rows: count };
  }

  async _restoreJournalSegment(scope, key, snapshotCursors = {}, progress = null) {
    if (key.endsWith(".jsonl")) return this._restoreJsonlJournalSegment(scope, key, snapshotCursors, progress);
    if (key.endsWith(".json")) return this._restoreLegacyJsonJournalSegment(scope, key, snapshotCursors, progress);
    throw new Error(`unsupported journal segment format: ${key}`);
  }

  async _restoreJsonlJournalSegment(scope, key, snapshotCursors = {}, progress = null) {
    const journalInfo = parseJournalKey(key, this.prefix);
    const sourceNode = journalInfo?.node || "persistence";
    const stats = emptyJournalRestoreStats(this.node.seq);
    let batch = [];
    let segmentOps = 0;

    const flush = async () => {
      if (!batch.length) return;
      const applied = this._applyRestoredJournalOps(sourceNode, scope, batch);
      stats.ops += applied;
      progress?.add?.("journalOps", applied);
      stats.maxLocalSeq = Math.max(stats.maxLocalSeq, maxLocalSeqForOps(batch, this.node.id));
      batch = [];
      await yieldToEventLoop();
    };

    for await (const op of jsonlObjectsFromStorage(this.storage, key, `${scopeKey(scope)} journal`)) {
      segmentOps++;
      validateJournalOp(op, scope);
      if ((!op.from || op.from === this.node.id) && Number.isSafeInteger(op.seq)) stats.maxLocalSeq = Math.max(stats.maxLocalSeq, op.seq);
      if (operationCovered(op, snapshotCursors)) continue;
      batch.push(op);
      if (batch.length >= this.opBatchSize) await flush();
    }
    await flush();

    if (stats.ops > 0) stats.journals = 1;
    else if (segmentOps > 0) {
      stats.skippedJournals = 1;
      stats.skippedOps = segmentOps;
    }
    return stats;
  }

  async _restoreLegacyJsonJournalSegment(scope, key, snapshotCursors = {}, progress = null) {
    const raw = await this.storage.get(key);
    if (!raw) return emptyJournalRestoreStats(this.node.seq);
    const segment = JSON.parse(raw);
    const sourceNode = segment.node || parseJournalKey(key, this.prefix)?.node || "persistence";
    const segmentOps = Array.isArray(segment.ops) ? segment.ops : [];
    const stats = emptyJournalRestoreStats(this.node.seq);

    for (let offset = 0; offset < segmentOps.length; offset += this.opBatchSize) {
      const input = segmentOps.slice(offset, offset + this.opBatchSize);
      for (const op of input) validateJournalOp(op, scope);
      stats.maxLocalSeq = Math.max(stats.maxLocalSeq, maxLocalSeqForOps(input, this.node.id));
      const batch = input.filter((op) => !operationCovered(op, snapshotCursors));
      if (!batch.length) continue;
      const applied = this._applyRestoredJournalOps(sourceNode, scope, batch);
      stats.ops += applied;
      progress?.add?.("journalOps", applied);
      stats.maxLocalSeq = Math.max(stats.maxLocalSeq, maxLocalSeqForOps(batch, this.node.id));
      await yieldToEventLoop();
    }

    if (stats.ops > 0) stats.journals = 1;
    else if (segmentOps.length) {
      stats.skippedJournals = 1;
      stats.skippedOps = segmentOps.length;
    }
    return stats;
  }

  _applyRestoredJournalOps(sourceNode, scope, ops) {
    const filtered = this._filterRestoreOps(scope, ops);
    if (!filtered.length) return 0;
    this.node.applyRemote(sourceNode, filtered, "persistence:journal-restore");
    this.node.lastSeen.delete("persistence:journal-restore");
    rememberRestoredCursors(this.node, filtered);
    return filtered.length;
  }

  async _restoreMetadata(keys, publications) {
    let count = 0;
    for (const key of keys) {
      const target = parseMetaFromKey(key, this.prefix);
      if (!target) continue;
      if (this.node.db.isDatabaseDeleted(target.database)) continue;
      if (this.node.db.isCollectionDeleted(target.database, target.collection)) continue;
      const current = await this.states.read(key, publications);
      const raw = current.body;
      if (!raw) continue;
      const meta = persistedMeta(raw, this.lifecycle.record(target.database) || this.lifecycle.record(target.database, target.collection));
      if (isPrimary(this.node, target.database)) await this.states.adopt(key, current);
      if (meta === null) continue;
      this.node.db.setCollectionMeta(target.database, target.collection, meta);
      count++;
    }
    return count;
  }

  _restoreCollectionTombstones(tombstones) {
    for (const key of tombstones) {
      const target = parseCollectionKey(key);
      this.lifecycle.internal(() => this.node.db.deleteCollection(target.database, target.collection));
    }
    return tombstones.size;
  }

  _restoreDatabaseTombstones(tombstones) {
    for (const database of tombstones) this.lifecycle.internal(() => this.node.db.deleteDatabase(database));
    return tombstones.size;
  }

  async _restoreDatabaseMetadata(keys, publications) {
    let count = 0;
    for (const key of keys) {
      const target = parseDatabaseMetaFromKey(key, this.prefix);
      if (!target) continue;
      if (this.node.db.isDatabaseDeleted(target.database)) continue;
      const current = await this.states.read(key, publications);
      const raw = current.body;
      if (!raw) continue;
      const meta = persistedMeta(raw, this.lifecycle.record(target.database));
      if (isPrimary(this.node, target.database)) await this.states.adopt(key, current);
      if (meta === null) continue;
      this.node.db.setDatabaseMeta(target.database, meta);
      count++;
    }
    return count;
  }

  async _restoreLocalWal() {
    const { records, skippedPartialRecords } = await this.localWal.readRecords();
    const stats = {
      records: records.length,
      ops: 0,
      databases: 0,
      databaseDrops: 0,
      metadata: 0,
      collectionDrops: 0,
      skippedPartialRecords,
      maxLocalSeq: this.node.seq,
    };

    this.replayingLocalWal = true;
    try {
      let line = 0;
      for (const record of records) {
        line++;
        if (line % RESTORE_PARSE_YIELD_LINES === 0) await yieldToEventLoop();
        if (!record || record.version !== 1) continue;
        if (record.type !== "ops") {
          const ticket = this.lifecycle.ticket(record);
          if (ticket.some(Boolean) && (record.type.startsWith("drop") || !record.contextTicket ||
            ticket[0] !== record.contextTicket[0] || ticket[1] !== record.contextTicket[1])) continue;
          const state = this.lifecycle.record(record.database) || this.lifecycle.record(record.database, record.collection);
          if (state && state.status !== "active") continue;
        }
        if (record.type === "ops") {
          const ops = this._filterLocalWalOps(Array.isArray(record.ops) ? record.ops : []).filter((op) => !this.lifecycle.obsolete(op));
          const sourceNode = record.node || "local-wal";
          this.node.applyRemote(sourceNode, ops, `local-wal:${line}`);
          this.node.lastSeen.delete(`local-wal:${line}`);
          rememberRestoredCursors(this.node, ops);
          this._queueOps(ops);
          stats.maxLocalSeq = Math.max(stats.maxLocalSeq, maxLocalSeqForOps(ops, this.node.id));
          stats.ops += ops.length;
          continue;
        }

        if (record.type === "database" && record.database && record.meta && isPlainObject(record.meta)) {
          this.node.db.setDatabaseMeta(record.database, clone(record.meta));
          this._queueDatabase(record);
          stats.databases++;
          continue;
        }

        if (record.type === "dropDatabase" && record.database) {
          this.node.db.deleteDatabase(record.database);
          this._queueDatabaseDrop(record);
          stats.databaseDrops++;
          continue;
        }

        if (record.type === "meta" && record.database && record.collection && record.meta && isPlainObject(record.meta)) {
          this.node.db.setCollectionMeta(record.database, record.collection, clone(record.meta));
          this._queueMeta(record);
          stats.metadata++;
          continue;
        }

        if (record.type === "dropCollection" && record.database && record.collection) {
          this.node.db.deleteCollection(record.database, record.collection);
          this._queueCollectionDrop(record);
          stats.collectionDrops++;
        }
      }
    } finally {
      this.replayingLocalWal = false;
    }

    return stats;
  }

  _filterLocalWalOps(ops) {
    const targets = this._restoreTargets();
    if (this._restoreMode() === "reshard") {
      return ops
        .filter((op) => this._restoreAllTargets(targets)
          || this._objectMatchesRestoreTargets(op.db, op.coll, op.id, targets))
        .map((op) => ({
          ...op,
          shard: this.node.shardForObject(op.db, op.coll, op.id),
        }));
    }
    if (this._restoreAllTargets(targets)) return ops;
    return ops.filter((op) => targets.some((target) => matchesRestoreTarget(opScope(op, this.node), target)));
  }

  _rootPrefix() {
    return this.prefix ? `${this.prefix}/` : "";
  }

  async _contextState(keys, publications) {
    await this.lifecycle.load(publications);
    const deletedDatabases = databaseTombstones(keys, this.prefix);
    const tombstones = collectionTombstones(keys, this.prefix);
    for (const record of this.lifecycle.records.values()) {
      if (this.lifecycle.record(record.database, record.collection) !== record) continue;
      const values = record.collection === undefined ? deletedDatabases : tombstones;
      const slot = record.collection === undefined ? record.database : collectionKey(record.database, record.collection);
      if (record.status === "active") values.delete(slot);
      else values.add(slot);
    }
    return { deletedDatabases, tombstones };
  }

  _restoreManifestMetadata(scope, manifest = {}) {
    if (isPlainObject(manifest.databaseMeta)) {
      this.node.db.setDatabaseMeta(scope.database, clone(manifest.databaseMeta));
    }
    if (isPlainObject(manifest.collectionMeta)) {
      this.node.db.setCollectionMeta(scope.database, scope.collection, clone(manifest.collectionMeta));
    }
  }

  _ensureRestoreManifestContext(scope, manifest = {}) {
    if (!this.node.getDatabaseMeta(scope.database)) {
      this.node.db.setDatabaseMeta(scope.database, clone(manifest.databaseMeta || {}));
    }
    if (!this.node.getCollectionMeta(scope.database, scope.collection)) {
      this.node.db.setCollectionMeta(scope.database, scope.collection, clone(manifest.collectionMeta || {}));
    }
  }

  _snapshotCursors(scope, coverage = this._snapshotCoverage()) {
    const cursors = Object.assign(Object.create(null), { [this.node.id]: Number(coverage.seq) || 0 });
    for (const [key, seen] of coverage.lastSeen || []) {
      if (typeof key !== "string") continue;
      const boundary = key.lastIndexOf("|");
      const sourceNode = boundary < 0 ? key : key.slice(0, boundary);
      if (!sourceNode) continue;
      if (boundary >= 0) {
        const [database, collection, shard] = key.slice(boundary + 1).split("/");
        if (!matchesRestoreTarget(scope, { database, collection, shard })) continue;
      }
      cursors[sourceNode] = Math.max(cursors[sourceNode] || 0, Number(seen) || 0);
    }
    return cursors;
  }

  async _restoreScopeSet(keys, scopes, stats, maxLocalSeq, progress = null, publications) {
    const restoredByScope = new Map();
    let nextMaxLocalSeq = maxLocalSeq;

    let scopeIndex = 0;
    for (const scope of scopes) {
      progress?.scope?.(scope, scopeIndex, scopes.length);
      stats.scopes++;
      const restored = await this._restoreSnapshot(scope, progress, publications);
      restoredByScope.set(scopeKey(scope), restored);
      if (restored) {
        stats.snapshots++;
        stats.snapshotObjects += restored.objects;
        this._rememberSnapshotCursors(scope, restored.cursors);
        nextMaxLocalSeq = Math.max(nextMaxLocalSeq, Number(restored.cursors[this.node.id]) || 0);
      }
      scopeIndex++;
      progress?.scope?.(scope, scopeIndex, scopes.length);
      await yieldToEventLoop();
    }

    scopeIndex = 0;
    for (const scope of scopes) {
      if (this.restoreSnapshotId) continue;
      progress?.scope?.(scope, scopeIndex, scopes.length);
      const snapshotCursors = restoredByScope.get(scopeKey(scope))?.cursors || {};
      const journalKeys = keys.filter((key) =>
        key.startsWith(`${scopePrefix(this.prefix, scope)}/journal/`)
          && (key.endsWith(".jsonl") || key.endsWith(".json")));
      for (const key of journalKeys.sort()) {
        const info = parseJournalKey(key, this.prefix);
        if (info?.originVerified && (Number(snapshotCursors[info.node]) || 0) >= info.lastSeq) {
          stats.skippedJournals++;
          stats.skippedJournalOps += info.count;
          progress?.add?.("skippedJournals", 1);
          progress?.add?.("skippedJournalOps", info.count);
          continue;
        }
        const restored = await this._restoreJournalSegment(scope, key, snapshotCursors, progress);
        stats.journals += restored.journals;
        stats.journalOps += restored.ops;
        stats.skippedJournals += restored.skippedJournals;
        stats.skippedJournalOps += restored.skippedOps;
        progress?.add?.("skippedJournals", restored.skippedJournals);
        progress?.add?.("skippedJournalOps", restored.skippedOps);
        nextMaxLocalSeq = Math.max(nextMaxLocalSeq, restored.maxLocalSeq);
      }
      scopeIndex++;
      progress?.scope?.(scope, scopeIndex, scopes.length);
      await yieldToEventLoop();
    }

    return nextMaxLocalSeq;
  }

  _rememberSnapshotCursors(scope, cursors = {}) {
    if (!this.node._cursorKey) return;
    for (const [sourceNode, seq] of Object.entries(cursors || {})) {
      if (!sourceNode || sourceNode === "persistence") continue;
      const cursorKey = this.node._cursorKey(sourceNode, scope);
      this.node.lastSeen.set(cursorKey, Math.max(this.node.lastSeen.get(cursorKey) || 0, Number(seq) || 0));
    }
  }

  _rememberUnscopedCursors(scopes) {
    if (!this.node._cursorKey || !scopes?.length) return;
    const bySource = new Map();
    for (const [key, seen] of this.node.lastSeen || []) {
      if (typeof key !== "string") continue;
      for (const scope of scopes) {
        const suffix = `|${scope.database}/${scope.collection}/${scope.shard}`;
        if (!key.endsWith(suffix)) continue;
        const sourceNode = key.slice(0, -suffix.length);
        if (!sourceNode) continue;
        const entry = bySource.get(sourceNode) || { count: 0, min: Infinity };
        entry.count++;
        entry.min = Math.min(entry.min, Number(seen) || 0);
        bySource.set(sourceNode, entry);
      }
    }
    for (const [sourceNode, entry] of bySource) {
      if (entry.count < scopes.length || !Number.isFinite(entry.min) || entry.min <= 0) continue;
      this.node.lastSeen.set(this.node._cursorKey(sourceNode), Math.max(this.node.lastSeen.get(sourceNode) || 0, entry.min));
    }
  }

  _rememberScopeSetCursors(target, scopes) {
    if (!this.node._cursorKey || !target || !scopes?.length) return;
    const matchingScopes = scopes.filter((scope) => matchesRestoreTarget(scope, target));
    if (!matchingScopes.length) return;
    const bySource = new Map();

    for (const [key, seen] of this.node.lastSeen || []) {
      if (typeof key !== "string") continue;
      for (const scope of matchingScopes) {
        const suffix = `|${scope.database}/${scope.collection}/${scope.shard}`;
        if (!key.endsWith(suffix)) continue;
        const sourceNode = key.slice(0, -suffix.length);
        if (!sourceNode) continue;
        const entry = bySource.get(sourceNode) || { count: 0, min: Infinity };
        entry.count++;
        entry.min = Math.min(entry.min, Number(seen) || 0);
        bySource.set(sourceNode, entry);
      }
    }

    for (const [sourceNode, entry] of bySource) {
      if (entry.count < matchingScopes.length || !Number.isFinite(entry.min) || entry.min <= 0) continue;
      const cursorKey = this.node._cursorKey(sourceNode, target);
      this.node.lastSeen.set(cursorKey, Math.max(this.node.lastSeen.get(cursorKey) || 0, entry.min));
    }
  }
}

export function createPersistence(node, config = {}) {
  const mode = config.mode || "off";
  if (mode === "off" || mode === false) return null;
  if (mode !== "s3" && mode !== "memory") {
    throw new Error(`unsupported persistence mode: ${mode}`);
  }

  const storage = createObjectStorage({ mode, s3: config.s3 || {} });

  return new PersistenceManager({
    node,
    storage,
    prefix: config.prefix || DEFAULT_DATA_PREFIX,
    flushMs: config.flushMs ?? 5000,
    opBatchSize: config.opBatchSize ?? 1000,
    journalMaxBytes: config.journalMaxBytes ?? DEFAULT_JOURNAL_BYTES,
    snapshotMs: config.snapshotMs ?? 60_000,
    segmentBytes: config.segmentBytes ?? DEFAULT_SEGMENT_BYTES,
    compactJournals: config.compactJournals !== false,
    snapshotRetention: config.snapshotRetention,
    journalRetention: config.journalRetention,
    snapshotDirtyOnly: config.snapshotDirtyOnly !== false,
    snapshotRole: config.snapshotRole || "primary",
    restoreSnapshotId: config.restoreSnapshotId,
    restoreScopes: config.restoreScopes,
    ack: config.ack || "memory",
    localWal: config.localWal,
    durable: mode === "s3",
  });
}

async function* chunkJsonlIterable(rows, maxBytes, label) {
  const budget = new WorkBudget({ maxSliceMs: 4 });
  let current = [];
  let bytes = 0;

  function makeChunk() {
    return { body: current.length ? `${current.join("\n")}\n` : "", count: current.length, bytes };
  }

  let i = 0;
  for (const value of rows) {
    const row = stringifyJson(value, `${label} row ${i}`);
    i++;
    const rowBytes = Buffer.byteLength(row);
    const nextBytes = bytes + rowBytes + 1;
    if (current.length && nextBytes > maxBytes) {
      yield makeChunk();
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += rowBytes + 1;
    const pause = budget.checkpoint(i);
    if (pause) await pause;
  }

  if (current.length) {
    yield makeChunk();
    return;
  }
  yield { body: "", count: 0, bytes: 0 };
}

function jsonlBody(values, label) {
  if (!values?.length) return "";
  return `${values.map((value, i) => stringifyJson(value, `${label} row ${i}`)).join("\n")}\n`;
}

async function* jsonlObjectsFromStorage(storage, key, label) {
  if (typeof storage.getStream === "function") {
    const stream = await storage.getStream(key);
    if (stream === null) throw new Error(`segment missing: ${key}`);
    yield* parseJsonlStream(stream, label);
    return;
  }

  const body = await storage.get(key);
  if (body === null) throw new Error(`segment missing: ${key}`);
  yield* parseJsonlText(body, label);
}

async function* jsonArrayObjectsFromStorage(storage, key, label) {
  if (typeof storage.getStream === "function") {
    const stream = await storage.getStream(key);
    if (stream === null) throw new Error(`segment missing: ${key}`);
    yield* parseJsonArrayStream(stream, label);
    return;
  }

  const body = await storage.get(key);
  if (body === null) throw new Error(`segment missing: ${key}`);
  yield* parseJsonArrayText(body, label);
}

async function* parseJsonlStream(stream, label) {
  let buffer = "";
  let line = 0;
  let yielded = 0;
  for await (const text of decodeUtf8Chunks(stream)) {
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const raw of lines) {
      line++;
      const trimmed = raw.trim();
      if (trimmed) {
        yield parseJsonLine(trimmed, label, line);
        if (++yielded % RESTORE_PARSE_YIELD_LINES === 0) await yieldToEventLoop();
      }
    }
  }
  const trimmed = buffer.trim();
  if (trimmed) yield parseJsonLine(trimmed, label, line + 1);
}

function* parseJsonlText(body, label) {
  const lines = String(body || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed) yield parseJsonLine(trimmed, label, i + 1);
  }
}

async function* parseJsonArrayStream(stream, label) {
  const parser = createJsonArrayParser(label);
  for await (const text of decodeUtf8Chunks(stream)) yield* parser.push(text);
  yield* parser.finish();
}

async function* journalObjectsFromStorage(storage, key, label) {
  if (key.endsWith(".jsonl")) {
    yield* jsonlObjectsFromStorage(storage, key, `${label} journal`);
    return;
  }
  const raw = await storage.get(key);
  if (raw === null) throw new Error(`segment missing: ${key}`);
  const segment = JSON.parse(raw);
  if (!Array.isArray(segment.ops)) throw new Error(`invalid journal segment: ${key}`);
  yield* segment.ops;
}

function operationCovered(op, cursors) {
  const source = op?.from;
  return typeof source === "string" && Number.isSafeInteger(op?.seq) && op.seq > 0 &&
    op.seq <= (Number(cursors[source]) || 0);
}

function validateJournalOp(op, scope) {
  if (op?.db !== scope.database || op?.coll !== scope.collection || (op.shard && op.shard !== scope.shard)) {
    throw new Error("journal operation belongs to another context");
  }
  if (!["putObj", "delObj", "touch"].includes(op.kind) || typeof op.id !== "string" || !op.id ||
      (op.from !== undefined && (typeof op.from !== "string" || !op.from)) ||
      !Number.isSafeInteger(op.seq) || op.seq < 1 || !Number.isSafeInteger(op.ts?.c) || typeof op.ts.n !== "string") {
    throw new Error("invalid journal operation");
  }
}

function coversCursors(cursors, previous) {
  return Object.entries(previous).every(([source, seq]) => (Number(cursors[source]) || 0) >= seq);
}

function snapshotConflict(message) {
  return Object.assign(new Error(message), { code: "SNAPSHOT_CONFLICT" });
}

function validateSnapshotManifest(manifest, scope) {
  for (const key of ["database", "collection", "shard"]) {
    if (manifest?.[key] !== scope[key]) throw new Error("snapshot manifest belongs to another context");
  }
  if (!Array.isArray(manifest.segments)) throw new Error("invalid snapshot segments");
  if (manifest.seq !== undefined && (!Number.isSafeInteger(manifest.seq) || manifest.seq < 0)) throw new Error("invalid snapshot sequence");
  if (manifest.cursors !== undefined && (!isPlainObject(manifest.cursors) ||
      Object.values(manifest.cursors).some((seq) => !Number.isSafeInteger(seq) || seq < 0))) {
    throw new Error("invalid snapshot cursors");
  }
  if (manifest.objectCount !== undefined && (!Number.isSafeInteger(manifest.objectCount) || manifest.objectCount < 0)) {
    throw new Error("invalid snapshot object count");
  }
  for (const segment of manifest.segments) {
    if (typeof segment?.key !== "string" ||
        (segment.count !== undefined && (!Number.isSafeInteger(segment.count) || segment.count < 0))) {
      throw new Error("invalid snapshot segment count or key");
    }
  }
}

function validateSnapshotRow(row, scope) {
  const ts = row?.deleted || row?.ts;
  if (typeof row?.id !== "string" || !row.id || !Number.isSafeInteger(ts?.c) || typeof ts.n !== "string") {
    throw new Error("invalid snapshot object");
  }
  if (row.shard && row.shard !== scope.shard) throw new Error("snapshot object belongs to another shard scope");
}

function* parseJsonArrayText(body, label) {
  const parser = createJsonArrayParser(label);
  yield* parser.push(String(body || ""));
  yield* parser.finish();
}

function createJsonArrayParser(label) {
  let started = false;
  let finished = false;
  let itemStarted = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let item = "";
  let index = 0;

  function* push(text) {
    for (const ch of text) {
      if (finished) {
        if (!/\s/.test(ch)) throw new Error(`invalid JSON array in ${label}: trailing content`);
        continue;
      }

      if (!started) {
        if (/\s/.test(ch)) continue;
        if (ch !== "[") throw new Error(`invalid JSON array in ${label}: expected [`);
        started = true;
        continue;
      }

      if (!itemStarted) {
        if (/\s/.test(ch) || ch === ",") continue;
        if (ch === "]") {
          finished = true;
          continue;
        }
        itemStarted = true;
        item = "";
        depth = 0;
        inString = false;
        escaped = false;
      }

      item += ch;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === "\"") inString = false;
        continue;
      }

      if (ch === "\"") inString = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;

      if (depth === 0 && !inString) {
        yield parseJsonArrayItem(item, label, index++);
        itemStarted = false;
        item = "";
      }
    }
  }

  function* finish() {
    if (!started) return;
    if (itemStarted) throw new Error(`invalid JSON array in ${label}: unfinished item ${index}`);
    if (!finished) throw new Error(`invalid JSON array in ${label}: missing closing ]`);
  }

  return { push, finish };
}

function parseJsonArrayItem(item, label, index) {
  try {
    return JSON.parse(item);
  } catch (err) {
    throw new Error(`invalid JSON array item in ${label} at index ${index}: ${err.message}`);
  }
}

function parseJsonLine(line, label, number) {
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new Error(`invalid JSONL in ${label} at line ${number}: ${err.message}`);
  }
}

function emptyJournalRestoreStats(maxLocalSeq = 0) {
  return { journals: 0, ops: 0, skippedJournals: 0, skippedOps: 0, maxLocalSeq };
}

function isCompletedTargetManifest(raw, topologyId, scope) {
  if (raw === null) return false;
  try {
    const manifest = JSON.parse(raw);
    return manifest.topologyId === topologyId
      && manifest.database === scope.database
      && manifest.collection === scope.collection
      && manifest.shard === scope.shard;
  } catch {
    return false;
  }
}

function restoreStats() {
  return {
    scopes: 0,
    databases: 0,
    metadata: 0,
    databaseTombstones: 0,
    collectionTombstones: 0,
    snapshots: 0,
    snapshotObjects: 0,
    journals: 0,
    journalOps: 0,
    localWalRecords: 0,
    localWalOps: 0,
    localWalDatabases: 0,
    localWalDatabaseDrops: 0,
    localWalMetadata: 0,
    localWalCollectionDrops: 0,
    localWalSkippedPartialRecords: 0,
    skippedJournals: 0,
    skippedJournalOps: 0,
  };
}

function maxLocalSeqForOps(ops, nodeId) {
  let max = 0;
  for (const op of ops || []) {
    if (op?.from && op.from !== nodeId) continue;
    const seq = Number(op.seq);
    if (Number.isSafeInteger(seq) && seq > max) max = seq;
  }
  return max;
}

function stringifyJson(value, label) {
  try {
    return JSON.stringify(value);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new Error(`JSON too large while serializing ${label}; reduce segment size or split oversized objects`);
    }
    throw err;
  }
}

function jsonBytes(value, label) {
  return Buffer.byteLength(stringifyJson(value, label));
}

function pendingOpsJsonBytes(pending) {
  let total = 0;
  for (const ops of pending.values()) total += jsonBytes(ops, "pending journal ops");
  return total;
}

function pendingWalJsonBytes(records) {
  let total = 0;
  for (const record of records || []) total += jsonBytes(record, "pending local WAL record") + 1;
  return total;
}

function* chunkOpsForRecord(ops, { maxBytes, maxOps, label }) {
  let current = [];
  let bytes = 2;

  for (let i = 0; i < ops.length; i++) {
    const op = stringifyJson(ops[i], `${label} op ${i}`);
    const opBytes = Buffer.byteLength(op);
    const nextBytes = bytes + (current.length ? 1 : 0) + opBytes;
    if (current.length && (current.length >= maxOps || nextBytes > maxBytes)) {
      yield current;
      current = [];
      bytes = 2;
    }
    current.push(ops[i]);
    bytes += (current.length > 1 ? 1 : 0) + opBytes;
  }

  if (current.length) yield current;
}

function uniqueScopes(keys, prefix) {
  const scopes = new Map();
  for (const key of keys) {
    const scope = parseScopeFromKey(key, prefix);
    if (scope) scopes.set(scopeKey(scope), scope);
  }
  return [...scopes.values()].sort((a, b) => scopeKey(a).localeCompare(scopeKey(b)));
}

function persistedMeta(raw, managed) {
  const value = JSON.parse(raw);
  if (!managed) return value;
  if (Object.keys(value).length === 1 && value.deletedBy) return null;
  if (value.version !== 1 || !isPlainObject(value.meta)) throw new Error("invalid context metadata envelope");
  return value.meta;
}

function collectionTombstones(keys, prefix) {
  const deleted = new Set();
  for (const key of keys) {
    const target = parseCollectionTombstoneFromKey(key, prefix);
    if (target) deleted.add(collectionKey(target.database, target.collection));
  }
  return deleted;
}

function databaseTombstones(keys, prefix) {
  const deleted = new Set();
  for (const key of keys) {
    const database = parseDatabaseTombstoneFromKey(key, prefix);
    if (database) deleted.add(database);
  }
  return deleted;
}

function rememberRestoredCursor(node, sourceNode, scope, ops) {
  if (!sourceNode || sourceNode === "persistence" || !node._cursorKey) return;
  const cursorKey = node._cursorKey(sourceNode, scope);
  let seen = node.lastSeen.get(cursorKey) || 0;
  for (const op of ops || []) {
    const seq = Number(op.seq);
    if (Number.isFinite(seq) && seq > seen) seen = seq;
  }
  if (seen) node.lastSeen.set(cursorKey, seen);
}

function rememberRestoredCursors(node, ops) {
  const byScope = new Map();
  for (const op of ops || []) {
    const scope = opScope(op, node);
    const source = op.from;
    if (typeof source !== "string" || !source) continue;
    const key = `${source}\n${scopeKey(scope)}`;
    const scoped = byScope.get(key) || { source, scope, ops: [] };
    scoped.ops.push(op);
    byScope.set(key, scoped);
  }
  for (const { source, scope, ops: scopedOps } of byScope.values()) {
    rememberRestoredCursor(node, source, scope, scopedOps);
  }
}

function emptyLocalFlushStats() {
  return { records: 0, ops: 0, databases: 0, databaseDrops: 0, metadata: 0, collectionDrops: 0, bytes: 0 };
}

function mergeLocalFlushStats(target, source = {}) {
  target.records += Number(source.records) || 0;
  target.ops += Number(source.ops) || 0;
  target.databases += Number(source.databases) || 0;
  target.databaseDrops += Number(source.databaseDrops) || 0;
  target.metadata += Number(source.metadata) || 0;
  target.collectionDrops += Number(source.collectionDrops) || 0;
  target.bytes += Number(source.bytes) || 0;
  return target;
}

function createLocalWalStore(config, nodeId) {
  const mode = localWalMode(config);
  if (mode === "off") return null;
  if (mode !== "on") throw new Error(`unsupported local WAL mode: ${mode}`);
  return new LocalWalStore({
    nodeId,
    dir: config?.dir || DEFAULT_LOCAL_WAL_DIR,
    fsync: config?.fsync !== false,
    flushMs: config?.flushMs ?? 0,
    maxRecordBytes: config?.maxRecordBytes,
    maxOpsPerRecord: config?.maxOpsPerRecord,
  });
}

function localWalMode(config = {}) {
  const mode = config?.mode ?? "off";
  if (mode === true) return "on";
  if (mode === false) return "off";
  return mode;
}

function normalizeAckMode(value) {
  const mode = value || "memory";
  if (mode === "memory") return "memory";
  if (mode === "localWal" || mode === "local-wal" || mode === "wal") return "localWal";
  throw new Error("persistence.ack must be one of: memory, localWal");
}

function commonScope(ops) {
  if (!ops.length) return {};
  const first = opScope(ops[0]);
  for (const op of ops.slice(1)) {
    const next = opScope(op);
    if (
      next.database !== first.database ||
      next.collection !== first.collection ||
      next.shard !== first.shard
    ) {
      return {};
    }
  }
  return first;
}

function seqRange(ops) {
  const seqs = (ops || []).map((op) => Number(op.seq)).filter(Number.isFinite);
  return {
    firstSeq: seqs.length ? Math.min(...seqs) : 0,
    lastSeq: seqs.length ? Math.max(...seqs) : 0,
  };
}

function opScope(op, node) {
  return {
    database: op.db,
    collection: op.coll,
    shard: op.shard || node?.shardForObject(op.db, op.coll, op.id) || DEFAULT_SHARD,
  };
}

function matchesRestoreTarget(scope, target) {
  return (
    (target.database === GLOBAL_DATABASE || target.database === scope.database) &&
    (target.collection === GLOBAL_COLLECTION || target.collection === scope.collection) &&
    target.shard === scope.shard
  );
}

function matchesRestoreCollection(scope, target) {
  return (
    (target.database === GLOBAL_DATABASE || target.database === scope.database) &&
    (target.collection === GLOBAL_COLLECTION || target.collection === scope.collection)
  );
}

function parseScopeFromKey(key, prefix) {
  const root = normalizePrefix(prefix);
  const expected = root ? `${root}/` : "";
  if (!key.startsWith(expected)) return null;
  const parts = key.slice(expected.length).split("/");
  if (parts[0] !== "db" || parts[2] !== "collection" || parts[4] !== "shard") return null;
  if (!parts[1] || !parts[3] || !parts[5]) return null;
  return {
    database: decodeURIComponent(parts[1]),
    collection: decodeURIComponent(parts[3]),
    shard: decodeURIComponent(parts[5]),
  };
}

function parseJournalKey(key, prefix) {
  const scope = parseScopeFromKey(key, prefix);
  if (!scope) return null;
  const root = normalizePrefix(prefix);
  const expected = root ? `${root}/` : "";
  const parts = key.slice(expected.length).split("/");
  if (parts[6] !== "journal" || !parts[7] || !parts[8]) return null;
  const file = parts[8];
  const match = file.match(/^(\d+)-(\d+)-(\d+)-.+\.jsonl?$/);
  const createdAtMs = match ? Number(match[1]) : 0;
  const firstSeq = match ? Number(match[2]) : 0;
  const lastSeq = match ? Number(match[3]) : 0;
  const originCount = file.match(/-(\d+)\.origin\.jsonl$/);
  const originVerified = Boolean(match && originCount && firstSeq > 0 && lastSeq >= firstSeq && Number(originCount[1]) > 0);
  const count = originVerified ? Number(originCount[1]) : lastSeq >= firstSeq && firstSeq > 0 ? lastSeq - firstSeq + 1 : 0;
  return {
    ...scope,
    node: decodeURIComponent(parts[7]),
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
    firstSeq: Number.isFinite(firstSeq) ? firstSeq : 0,
    lastSeq: Number.isFinite(lastSeq) ? lastSeq : 0,
    count,
    originVerified,
  };
}

function parseMetaFromKey(key, prefix) {
  const root = normalizePrefix(prefix);
  const expected = root ? `${root}/` : "";
  if (!key.startsWith(expected)) return null;
  const parts = key.slice(expected.length).split("/");
  if (parts.length !== 5 || parts[0] !== "db" || parts[2] !== "collection" || parts[4] !== "meta.json") return null;
  if (!parts[1] || !parts[3]) return null;
  return {
    database: decodeURIComponent(parts[1]),
    collection: decodeURIComponent(parts[3]),
  };
}

function parseCollectionTombstoneFromKey(key, prefix) {
  const root = normalizePrefix(prefix);
  const expected = root ? `${root}/` : "";
  if (!key.startsWith(expected)) return null;
  const parts = key.slice(expected.length).split("/");
  if (parts[0] !== "db" || parts[2] !== "collection-tombstones" || !parts[3]?.endsWith(".json")) return null;
  if (!parts[1]) return null;
  return {
    database: decodeURIComponent(parts[1]),
    collection: decodeURIComponent(parts[3].slice(0, -5)),
  };
}

function parseDatabaseMetaFromKey(key, prefix) {
  const root = normalizePrefix(prefix);
  const expected = root ? `${root}/` : "";
  if (!key.startsWith(expected)) return null;
  const parts = key.slice(expected.length).split("/");
  if (parts.length !== 3 || parts[0] !== "db" || parts[2] !== "meta.json") return null;
  if (!parts[1]) return null;
  return {
    database: decodeURIComponent(parts[1]),
  };
}

function parseDatabaseTombstoneFromKey(key, prefix) {
  const root = normalizePrefix(prefix);
  const expected = root ? `${root}/` : "";
  if (!key.startsWith(expected)) return null;
  const parts = key.slice(expected.length).split("/");
  if (parts[0] !== "database-tombstones" || !parts[1]?.endsWith(".json")) return null;
  return decodeURIComponent(parts[1].slice(0, -5));
}

function filterRetentionKeys(keys, retention, createdAtMsForKey) {
  if (!retentionEnabled(retention)) return keys;
  const keepLatest = Math.max(0, Number(retention.keepLatest) || 0);
  const sorted = [...keys].sort((left, right) => {
    const created = (createdAtMsForKey(right) || 0) - (createdAtMsForKey(left) || 0);
    return created || right.localeCompare(left);
  });
  const keep = new Set(sorted.slice(0, keepLatest));
  const keepSince = retention.keepForMs > 0 ? Date.now() - retention.keepForMs : null;
  if (keepSince !== null) {
    for (const key of sorted) {
      const createdAtMs = createdAtMsForKey(key) || 0;
      if (!createdAtMs || createdAtMs >= keepSince) keep.add(key);
    }
  }
  return sorted.filter((key) => !keep.has(key));
}

function parseScopeKey(key) {
  const [database, collection, shard] = key.split("\n");
  return { database, collection, shard };
}

function parseCollectionKey(key) {
  const [database, collection] = key.split("\n");
  return { database, collection };
}

function scopeKey(scope) {
  return `${scope.database}\n${scope.collection}\n${scope.shard}`;
}

function collectionKey(database, collection) {
  return `${database}\n${collection}`;
}

function scopePrefix(prefix, scope) {
  return `${normalizePrefix(prefix)}/db/${safe(scope.database)}/collection/${safe(scope.collection)}/shard/${safe(scope.shard)}`.replace(/^\/+/, "");
}

function collectionPrefix(prefix, database, collection) {
  return `${normalizePrefix(prefix)}/db/${safe(database)}/collection/${safe(collection)}`.replace(/^\/+/, "");
}

function collectionTombstoneKey(prefix, database, collection) {
  return `${databasePrefix(prefix, database)}/collection-tombstones/${safe(collection)}.json`;
}

function databasePrefix(prefix, database) {
  return `${normalizePrefix(prefix)}/db/${safe(database)}`.replace(/^\/+/, "");
}

function databaseTombstoneKey(prefix, database) {
  return `${normalizePrefix(prefix)}/database-tombstones/${safe(database)}.json`.replace(/^\/+/, "");
}

function snapshotId() {
  snapshotSequence = (snapshotSequence + 1) % 1_000_000;
  const seq = String(snapshotSequence).padStart(6, "0");
  return `${new Date().toISOString().replace(/[-:.]/g, "")}-${seq}-${randomUUID()}`;
}

function snapshotCreatedAtMs(id) {
  const match = String(id || "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/);
  if (!match) return 0;
  const [, year, month, day, hour, minute, second, ms] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(ms),
  );
}

function safe(value) {
  return encodeURIComponent(String(value));
}

function pad(value) {
  return String(Math.max(0, value)).padStart(16, "0");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePrefix(prefix) {
  return String(prefix || "").replace(/^\/+|\/+$/g, "");
}

function normalizeSnapshotRole(value) {
  if (value === "none" || value === "primary") return value;
  throw new Error("persistence.snapshotRole must be one of: primary, none");
}

function normalizeRetention(config = {}) {
  return {
    keepLatest: positiveInt(config?.keepLatest, 0),
    keepForMs: positiveInt(config?.keepForMs, 0),
  };
}

function retentionEnabled(retention = {}) {
  return (Number(retention.keepLatest) || 0) > 0 || (Number(retention.keepForMs) || 0) > 0;
}

function normalizeSnapshotId(id) {
  if (typeof id !== "string" || id.length === 0) return null;
  if (id.includes("/")) throw new Error("persistence.restoreSnapshotId must not contain slashes");
  return id;
}

function normalizeSnapshotCursors(manifest = {}) {
  const cursors = Object.assign(Object.create(null), isPlainObject(manifest.cursors) ? manifest.cursors : {});
  if (manifest.node) cursors[manifest.node] = Math.max(Number(cursors[manifest.node]) || 0, Number(manifest.seq) || 0);
  return cursors;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
