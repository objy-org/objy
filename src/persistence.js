import { randomUUID } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { DEFAULT_SHARD, GLOBAL_COLLECTION, GLOBAL_DATABASE } from "./shard-map.js";
import { LocalWalStore } from "./local-wal.js";
import { createObjectStorage } from "./object-storage.js";

const DEFAULT_PREFIX = "spread-db";
const DEFAULT_SEGMENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_JOURNAL_BYTES = 4 * 1024 * 1024;
const RESTORE_APPLY_BATCH_SIZE = 10_000;
const RESTORE_PARSE_YIELD_LINES = 1000;
let snapshotSequence = 0;

export class PersistenceManager {
  constructor({
    node,
    storage,
    prefix = DEFAULT_PREFIX,
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
    restoreMode = "scoped",
    restoreSnapshotId,
    ack = "memory",
    localWal,
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
    this.restoreMode = restoreMode;
    this.restoreSnapshotId = normalizeSnapshotId(restoreSnapshotId);
    this.localWal = createLocalWalStore(localWal, node.id);
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
    this.flushTimer = null;
    this.localWalTimer = null;
    this.snapshotTimer = null;
    this.unsubscribe = null;
    this.flushing = null;
    this.localWalFlushing = null;
    this.checkpointing = null;
    this.flushPaused = false;
    this.lastError = null;
  }

  async restore(options = {}) {
    const progress = options.progress || null;
    progress?.start?.({
      mode: this.restoreMode,
      snapshotId: this.restoreSnapshotId || null,
    });
    const root = this._rootPrefix();
    const stats = restoreStats();
    let maxLocalSeq = this.node.seq;

    try {
      progress?.update?.({ phase: "listing" });
      const keys = await this.storage.list(root);
      const deletedDatabases = databaseTombstones(keys, this.prefix);
      const tombstones = collectionTombstones(keys, this.prefix);
      const scopes = this._filterRestoreScopes(uniqueScopes(keys, this.prefix))
        .filter((scope) => !deletedDatabases.has(scope.database))
        .filter((scope) => !tombstones.has(collectionKey(scope.database, scope.collection)));
      progress?.update?.({
        phase: "metadata",
        scopesTotal: scopes.length,
        totalKeys: keys.length,
      });

      this.node.db.beginBulkLoad?.();
      stats.databaseTombstones = this._restoreDatabaseTombstones(deletedDatabases);
      stats.collectionTombstones = this._restoreCollectionTombstones(tombstones);
      stats.databases = await this._restoreDatabaseMetadata(keys);
      stats.metadata = await this._restoreMetadata(keys);
      maxLocalSeq = await this._restoreScopeSet(keys, scopes, stats, maxLocalSeq, progress);

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
    try {
      if (this.restoreMode === "reshard") {
        progress?.update?.({ phase: "checkpointing" });
        stats.reshardCheckpoint = await this.checkpoint({ primaryOnly: true });
      }
      progress?.done?.(stats);
    } catch (err) {
      progress?.fail?.(err);
      throw err;
    }
    return stats;
  }

  async restoreScope(scope, options = {}) {
    const progress = options.progress || null;
    const root = this._rootPrefix();
    const keys = await this.storage.list(root);
    const deletedDatabases = databaseTombstones(keys, this.prefix);
    const tombstones = collectionTombstones(keys, this.prefix);
    const scopes = this._filterCatchUpScopes(uniqueScopes(keys, this.prefix), scope)
      .filter((candidate) => !deletedDatabases.has(candidate.database))
      .filter((candidate) => !tombstones.has(collectionKey(candidate.database, candidate.collection)));
    const stats = restoreStats();
    let maxLocalSeq = this.node.seq;

    this.node.db.beginBulkLoad?.();
    try {
      stats.databaseTombstones = this._restoreDatabaseTombstones(deletedDatabases);
      stats.collectionTombstones = this._restoreCollectionTombstones(tombstones);
      stats.databases = await this._restoreDatabaseMetadata(keys);
      stats.metadata = await this._restoreMetadata(keys);
      maxLocalSeq = await this._restoreScopeSet(keys, scopes, stats, maxLocalSeq, progress);
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
    await this.flushLocal();
    await this.flush();
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
    while (this.localWalPending.length || this.localWalFlushing) {
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
    this.pendingDatabaseDrops.add(change.database);
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
    const key = collectionKey(change.database, change.collection);
    this.pendingCollectionDrops.add(key);
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
    if (!this.localWal) return;
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
    if (!this.localWal) return;
    const entry = {
      version: 1,
      node: this.node.id,
      createdAt: new Date().toISOString(),
      ...record,
    };
    this.localWalPending.push(entry);
    this.localWalPendingBytes += jsonBytes(entry, "pending local WAL record") + 1;
  }

  _queueOp(op) {
    if (!op?.db || !op.coll || !op.id || !op.shard) return;
    const cloned = clone(op);
    const scope = { database: op.db, collection: op.coll, shard: op.shard };
    const key = scopeKey(scope);
    const pending = this.pending.get(key) || [];
    pending.push(cloned);
    this.pending.set(key, pending);
    this.pendingBytes += jsonBytes(cloned, "pending journal op");
    this._markDirty(key, cloned);
    if (pending.length >= this.opBatchSize) {
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

  async _flushOnce() {
    if (this.flushPaused) return { scopes: 0, ops: 0 };
    if (!this.pending.size && !this.pendingDatabases.size && !this.pendingDatabaseDrops.size && !this.pendingMeta.size && !this.pendingCollectionDrops.size) {
      return { scopes: 0, ops: 0, databases: 0, databaseDrops: 0, metadata: 0, collectionDrops: 0 };
    }

    const batches = this.pending;
    const databases = this.pendingDatabases;
    const databaseDrops = this.pendingDatabaseDrops;
    const metadata = this.pendingMeta;
    const collectionDrops = this.pendingCollectionDrops;
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
      this._requeueBatches(batches);
      this._requeueDatabases(databases);
      this._requeueDatabaseDrops(databaseDrops);
      this._requeueMetadata(metadata);
      this._requeueCollectionDrops(collectionDrops);
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
    if (!this.localWal || this.localWalPending.length || this.localWalFlushing) return;
    if (this.pending.size || this.pendingDatabases.size || this.pendingDatabaseDrops.size || this.pendingMeta.size || this.pendingCollectionDrops.size) return;
    await this.localWal.truncate();
  }

  _requeueBatches(batches) {
    for (const [key, ops] of batches) {
      const current = this.pending.get(key) || [];
      this.pending.set(key, [...ops, ...current]);
    }
    this.pendingBytes = pendingOpsJsonBytes(this.pending);
  }

  _requeueDatabases(databases) {
    for (const [database, meta] of databases) {
      if (!this.pendingDatabases.has(database)) this.pendingDatabases.set(database, meta);
    }
  }

  _requeueDatabaseDrops(databaseDrops) {
    for (const database of databaseDrops) this.pendingDatabaseDrops.add(database);
  }

  _requeueMetadata(metadata) {
    for (const [key, meta] of metadata) {
      if (!this.pendingMeta.has(key)) this.pendingMeta.set(key, meta);
    }
  }

  _requeueCollectionDrops(collectionDrops) {
    for (const key of collectionDrops) this.pendingCollectionDrops.add(key);
  }

  async _writeDatabaseMeta(database, meta) {
    await this.storage.delete([databaseTombstoneKey(this.prefix, database)]);
    await this.storage.put(
      `${databasePrefix(this.prefix, database)}/meta.json`,
      JSON.stringify(meta),
      "application/json",
    );
  }

  async _writeCollectionMeta({ database, collection }, meta) {
    await this.storage.delete([collectionTombstoneKey(this.prefix, database, collection)]);
    await this.storage.put(
      `${collectionPrefix(this.prefix, database, collection)}/meta.json`,
      JSON.stringify(meta),
      "application/json",
    );
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
    for (const chunk of chunkOpsForRecord(ops, {
      maxBytes: this.journalMaxBytes,
      maxOps: this.opBatchSize,
      label: `${scopeKey(scope)} journal`,
    })) {
      await this._writeJournalSegment(scope, chunk);
    }
  }

  async _writeJournalSegment(scope, ops) {
    const seqs = ops.map((op) => Number(op.seq)).filter(Number.isFinite);
    const firstSeq = seqs.length ? Math.min(...seqs) : 0;
    const lastSeq = seqs.length ? Math.max(...seqs) : 0;
    const key = `${scopePrefix(this.prefix, scope)}/journal/${safe(this.node.id)}/${Date.now()}-${pad(firstSeq)}-${pad(lastSeq)}-${randomUUID()}.jsonl`;
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

  _snapshotScopes({ automatic = false, primaryOnly = false } = {}) {
    const scopes = [];
    const ownedShards = this._ownedShardNames();
    for (const collection of this._collectionScopes()) {
      const shards = ownedShards.length ? ownedShards : this.node.shardMap.shardsForCollection(collection.database, collection.collection);
      for (const shard of shards.length ? shards : [DEFAULT_SHARD]) {
        if (primaryOnly && !this._shouldSnapshotForRole(shard)) continue;
        const scope = { database: collection.database, collection: collection.collection, shard };
        if (automatic && !this._shouldAutoSnapshot(scope)) continue;
        const dirty = this.dirtyScopes.get(scopeKey(scope));
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

  _shouldAutoSnapshot(scope) {
    if (!this._shouldSnapshotForRole(scope.shard)) return false;
    if (!this.snapshotDirtyOnly) return true;
    return this.dirtyScopes.has(scopeKey(scope));
  }

  _shouldSnapshotForRole(shard) {
    if (this.snapshotRole === "all") return true;
    if (this.snapshotRole === "none") return false;
    return this.node.isPrimaryForShard(shard);
  }

  _markCheckpointed(scope) {
    const key = scopeKey(scope);
    const dirty = this.dirtyScopes.get(key);
    if (dirty && scope.dirtyVersion !== undefined && dirty.version > scope.dirtyVersion) return;
    this.dirtyScopes.delete(key);
  }

  _filterRestoreScopes(scopes) {
    const targets = this._restoreTargets();
    if (this._restoreAllTargets(targets)) return scopes;
    if (this.restoreMode === "reshard") {
      return scopes.filter((scope) => targets.some((target) => matchesRestoreCollection(scope, target)));
    }
    return scopes.filter((scope) => targets.some((target) => matchesRestoreTarget(scope, target)));
  }

  _filterCatchUpScopes(scopes, scope) {
    if (!scope) return this._filterRestoreScopes(scopes);
    return scopes.filter((candidate) => matchesRestoreTarget(candidate, scope));
  }

  _filterRestoreObjects(scope, objects) {
    if (this.restoreMode !== "reshard") return objects;
    const targets = this._restoreTargets();
    if (this._restoreAllTargets(targets)) return objects;
    const out = [];
    for (const object of objects || []) {
      const row = this._filterRestoreObject(scope, object, targets);
      if (row) out.push(row);
    }
    return out;
  }

  _filterRestoreObject(scope, object, targets = null) {
    if (!object) return null;
    if (this.restoreMode !== "reshard") return object;
    const restoreTargets = targets || this._restoreTargets();
    if (this._restoreAllTargets(restoreTargets)) return object;
    if (!this._objectMatchesRestoreTargets(scope.database, scope.collection, object.id, restoreTargets)) return null;
    return {
      ...object,
      shard: this.node.shardForObject(scope.database, scope.collection, object.id),
    };
  }

  _filterRestoreOps(scope, ops) {
    if (this.restoreMode !== "reshard") return ops;
    const targets = this._restoreTargets();
    if (this._restoreAllTargets(targets)) return ops;
    return ops
      .filter((op) => this._objectMatchesRestoreTargets(op.db || scope.database, op.coll || scope.collection, op.id, targets))
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

  _restoreAllTargets(targets) {
    if (targets?.length) return false;
    if (!this.node.url) return true;
    return this.node.shardMap.syncTargets().length === 0;
  }

  async _writeSnapshot(scope, id = snapshotId(), coverage = this._snapshotCoverage()) {
    const base = `${scopePrefix(this.prefix, scope)}/snapshots/${id}`;
    const segments = [];
    let objectCount = 0;

    for (const chunk of chunkJsonlIterable(this.node.snapshotScopeObjects(scope), this.segmentBytes, `${scopeKey(scope)} snapshot`)) {
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
      databaseMeta: clone(this.node.getDatabaseMeta(scope.database) || {}),
      collectionMeta: clone(this.node.getCollectionMeta(scope.database, scope.collection) || {}),
      cursors: this._snapshotCursors(scope, coverage),
      format: "jsonl",
      objectCount,
      segments,
    };
    await this.storage.put(`${base}/manifest.json`, JSON.stringify(manifest), "application/json");
    await this.storage.put(`${scopePrefix(this.prefix, scope)}/latest.json`, JSON.stringify(manifest), "application/json");
    const retainedJournalsDeleted = this.compactJournals ? await this._compactJournals(scope, manifest.cursors) : 0;
    const retainedSnapshotsDeleted = await this._applySnapshotRetention(scope, id);
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
    const covered = keys.filter((key) => {
      const info = parseJournalKey(key, this.prefix);
      if (!info?.node || !info.lastSeq) return false;
      return (Number(cursors[info.node]) || 0) >= info.lastSeq;
    });
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
    const keys = await this.storage.list(prefix);
    const snapshots = snapshotEntries(keys, prefix);
    const latest = snapshots.find((entry) => entry.id === latestId);
    const removable = filterSnapshotRetention(snapshots, this.snapshotRetention, latest || { id: latestId })
      .flatMap((entry) => entry.keys);
    if (!removable.length) return 0;
    return this.storage.delete(removable);
  }

  async _restoreSnapshot(scope, progress = null) {
    const manifestKey = this.restoreSnapshotId
      ? `${scopePrefix(this.prefix, scope)}/snapshots/${this.restoreSnapshotId}/manifest.json`
      : `${scopePrefix(this.prefix, scope)}/latest.json`;
    const raw = await this.storage.get(manifestKey);
    if (!raw) return null;
    const manifest = JSON.parse(raw);
    let objects = 0;
    if (this.restoreSnapshotId) this._restoreManifestMetadata(scope, manifest);

    for (const segment of manifest.segments || []) {
      objects += await this._restoreSnapshotSegment(scope, manifest, segment, progress);
    }

    return {
      node: manifest.node,
      seq: Number(manifest.seq) || 0,
      cursors: normalizeSnapshotCursors(manifest),
      objects,
    };
  }

  async _restoreSnapshotSegment(scope, manifest, segment = {}, progress = null) {
    const sourceNode = manifest.node || "persistence";
    const cursorKey = this.node._cursorKey ? this.node._cursorKey(sourceNode, scope) : `persistence:${scopeKey(scope)}:snapshot`;
    const lastSeq = Number(manifest.seq) || 0;
    let objects = 0;

    const applyRows = async (rows) => {
      if (!rows.length) return;
      const applied = this.node.applySnapshotObjects(sourceNode, {
        database: scope.database,
        collection: scope.collection,
        scope,
        lastSeq,
        objects: rows,
      }, cursorKey);
      objects += applied;
      progress?.add?.("snapshotObjects", applied);
      await yieldToEventLoop();
    };

    if (isJsonlSegment(segment)) {
      let batch = [];
      for await (const object of jsonlObjectsFromStorage(this.storage, segment.key, `${scopeKey(scope)} snapshot`)) {
        const row = this._filterRestoreObject(scope, object);
        if (!row) continue;
        batch.push(row);
        if (batch.length < RESTORE_APPLY_BATCH_SIZE) continue;
        await applyRows(batch);
        batch = [];
      }
      await applyRows(batch);
      return objects;
    }

    let batch = [];
    for await (const object of jsonArrayObjectsFromStorage(this.storage, segment.key, `${scopeKey(scope)} legacy snapshot`)) {
      const row = this._filterRestoreObject(scope, object);
      if (!row) continue;
      batch.push(row);
      if (batch.length < RESTORE_APPLY_BATCH_SIZE) continue;
      await applyRows(batch);
      batch = [];
    }
    await applyRows(batch);
    return objects;
  }

  async _restoreJournalSegment(scope, key, snapshotCursors = {}, progress = null) {
    if (key.endsWith(".jsonl")) return this._restoreJsonlJournalSegment(scope, key, snapshotCursors, progress);
    return this._restoreLegacyJsonJournalSegment(scope, key, snapshotCursors, progress);
  }

  async _restoreJsonlJournalSegment(scope, key, snapshotCursors = {}, progress = null) {
    const journalInfo = parseJournalKey(key, this.prefix);
    const sourceNode = journalInfo?.node || "persistence";
    const coveredSeq = Number(snapshotCursors[sourceNode]) || 0;
    const stats = emptyJournalRestoreStats(this.node.seq);
    let batch = [];
    let segmentOps = 0;

    const flush = async () => {
      if (!batch.length) return;
      const applied = this._applyRestoredJournalOps(sourceNode, scope, key, batch);
      stats.ops += applied;
      progress?.add?.("journalOps", applied);
      stats.maxLocalSeq = Math.max(stats.maxLocalSeq, maxLocalSeqForOps(batch, this.node.id));
      batch = [];
      await yieldToEventLoop();
    };

    for await (const op of jsonlObjectsFromStorage(this.storage, key, `${scopeKey(scope)} journal`)) {
      segmentOps++;
      const seq = Number(op?.seq);
      if (Number.isFinite(seq) && seq <= coveredSeq) continue;
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
    const coveredSeq = Number(snapshotCursors[sourceNode]) || 0;
    const segmentOps = Array.isArray(segment.ops) ? segment.ops : [];
    const stats = emptyJournalRestoreStats(this.node.seq);

    for (const rawBatch of chunkArray(segmentOps, this.opBatchSize)) {
      const batch = rawBatch.filter((op) => {
        const seq = Number(op?.seq);
        return !Number.isFinite(seq) || seq > coveredSeq;
      });
      if (!batch.length) continue;
      const applied = this._applyRestoredJournalOps(sourceNode, scope, key, batch);
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

  _applyRestoredJournalOps(sourceNode, scope, key, ops) {
    const filtered = this._filterRestoreOps(scope, ops);
    if (!filtered.length) return 0;
    this.node.applyRemote(sourceNode, filtered, `persistence:${key}`);
    rememberRestoredCursor(this.node, sourceNode, scope, filtered);
    return filtered.length;
  }

  async _restoreMetadata(keys) {
    let count = 0;
    for (const key of keys) {
      const target = parseMetaFromKey(key, this.prefix);
      if (!target) continue;
      if (this.node.db.isDatabaseDeleted(target.database)) continue;
      if (this.node.db.isCollectionDeleted(target.database, target.collection)) continue;
      const raw = await this.storage.get(key);
      if (!raw) continue;
      this.node.db.setCollectionMeta(target.database, target.collection, JSON.parse(raw));
      count++;
    }
    return count;
  }

  _restoreCollectionTombstones(tombstones) {
    for (const key of tombstones) {
      const target = parseCollectionKey(key);
      this.node.db.deleteCollection(target.database, target.collection);
    }
    return tombstones.size;
  }

  _restoreDatabaseTombstones(tombstones) {
    for (const database of tombstones) this.node.db.deleteDatabase(database);
    return tombstones.size;
  }

  async _restoreDatabaseMetadata(keys) {
    let count = 0;
    for (const key of keys) {
      const target = parseDatabaseMetaFromKey(key, this.prefix);
      if (!target) continue;
      if (this.node.db.isDatabaseDeleted(target.database)) continue;
      const raw = await this.storage.get(key);
      if (!raw) continue;
      this.node.db.setDatabaseMeta(target.database, JSON.parse(raw));
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

    let line = 0;
    for (const record of records) {
      line++;
      if (line % RESTORE_PARSE_YIELD_LINES === 0) await yieldToEventLoop();
      if (!record || record.version !== 1) continue;
      if (record.type === "ops") {
        const ops = this._filterLocalWalOps(Array.isArray(record.ops) ? record.ops : []);
        const sourceNode = record.node || "local-wal";
        this.node.applyRemote(sourceNode, ops, `local-wal:${line}`);
        rememberRestoredCursors(this.node, sourceNode, ops);
        for (const op of ops) {
          if (op.from === this.node.id && Number.isFinite(op.seq)) {
            stats.maxLocalSeq = Math.max(stats.maxLocalSeq, op.seq);
          }
        }
        stats.ops += ops.length;
        continue;
      }

      if (record.type === "database" && record.database && record.meta && isPlainObject(record.meta)) {
        this.node.db.setDatabaseMeta(record.database, clone(record.meta));
        stats.databases++;
        continue;
      }

      if (record.type === "dropDatabase" && record.database) {
        this.node.db.deleteDatabase(record.database);
        stats.databaseDrops++;
        continue;
      }

      if (record.type === "meta" && record.database && record.collection && record.meta && isPlainObject(record.meta)) {
        this.node.db.setCollectionMeta(record.database, record.collection, clone(record.meta));
        stats.metadata++;
        continue;
      }

      if (record.type === "dropCollection" && record.database && record.collection) {
        this.node.db.deleteCollection(record.database, record.collection);
        stats.collectionDrops++;
      }
    }

    return stats;
  }

  _filterLocalWalOps(ops) {
    const targets = this._restoreTargets();
    if (this._restoreAllTargets(targets)) return ops;
    if (this.restoreMode === "reshard") {
      return ops
        .filter((op) => this._objectMatchesRestoreTargets(op.db, op.coll, op.id, targets))
        .map((op) => ({
          ...op,
          shard: this.node.shardForObject(op.db, op.coll, op.id),
        }));
    }
    return ops.filter((op) => targets.some((target) => matchesRestoreTarget(opScope(op, this.node), target)));
  }

  _rootPrefix() {
    return this.prefix ? `${this.prefix}/` : "";
  }

  _restoreManifestMetadata(scope, manifest = {}) {
    if (isPlainObject(manifest.databaseMeta)) {
      this.node.db.setDatabaseMeta(scope.database, clone(manifest.databaseMeta));
    }
    if (isPlainObject(manifest.collectionMeta)) {
      this.node.db.setCollectionMeta(scope.database, scope.collection, clone(manifest.collectionMeta));
    }
  }

  _snapshotCursors(scope, coverage = this._snapshotCoverage()) {
    const cursors = { [this.node.id]: Number(coverage.seq) || 0 };
    const suffix = this.node._cursorKey ? `|${scope.database}/${scope.collection}/${scope.shard}` : null;
    if (!suffix) return cursors;
    for (const [key, seen] of coverage.lastSeen || []) {
      if (typeof key !== "string" || !key.endsWith(suffix)) continue;
      const sourceNode = key.slice(0, -suffix.length);
      if (!sourceNode) continue;
      cursors[sourceNode] = Math.max(cursors[sourceNode] || 0, Number(seen) || 0);
    }
    return cursors;
  }

  async _restoreScopeSet(keys, scopes, stats, maxLocalSeq, progress = null) {
    const restoredByScope = new Map();
    let nextMaxLocalSeq = maxLocalSeq;

    let scopeIndex = 0;
    for (const scope of scopes) {
      progress?.scope?.(scope, scopeIndex, scopes.length);
      stats.scopes++;
      const restored = await this._restoreSnapshot(scope, progress);
      restoredByScope.set(scopeKey(scope), restored);
      if (restored) {
        stats.snapshots++;
        stats.snapshotObjects += restored.objects;
        this._rememberSnapshotCursors(scope, restored.cursors);
        if (restored.node === this.node.id) nextMaxLocalSeq = Math.max(nextMaxLocalSeq, restored.seq);
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
      const journalKeys = keys.filter((key) => key.startsWith(`${scopePrefix(this.prefix, scope)}/journal/`));
      for (const key of journalKeys.sort()) {
        const journalInfo = parseJournalKey(key, this.prefix);
        const sourceFromKey = journalInfo?.node;
        const coveredFromKey = Number(sourceFromKey ? snapshotCursors[sourceFromKey] : 0) || 0;
        if (journalInfo?.lastSeq && coveredFromKey >= journalInfo.lastSeq) {
          stats.skippedJournals++;
          stats.skippedJournalOps += journalInfo.count || 0;
          progress?.add?.("skippedJournals", 1);
          progress?.add?.("skippedJournalOps", journalInfo.count || 0);
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
    prefix: config.prefix || "spread-db",
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
    restoreMode: config.restoreMode || "scoped",
    restoreSnapshotId: config.restoreSnapshotId,
    restoreScopes: config.restoreScopes,
    ack: config.ack || "memory",
    localWal: config.localWal,
  });
}

function* chunkJsonlIterable(rows, maxBytes, label) {
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
    if (stream === null) throw new Error(`snapshot segment missing: ${key}`);
    yield* parseJsonArrayStream(stream, label);
    return;
  }

  const body = await storage.get(key);
  if (body === null) throw new Error(`snapshot segment missing: ${key}`);
  yield* parseJsonArrayText(body, label);
}

async function* parseJsonlStream(stream, label) {
  let buffer = "";
  let line = 0;
  let yielded = 0;
  for await (const chunk of stream) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const raw of lines) {
      line++;
      const trimmed = raw.trim();
      if (trimmed) {
        yield parseJsonLine(trimmed, label, line);
        yielded++;
        if (yielded % RESTORE_PARSE_YIELD_LINES === 0) await yieldToEventLoop();
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
  let parser = createJsonArrayParser(label);
  for await (const chunk of stream) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    yield* parser.push(text);
  }
  yield* parser.finish();
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

      if (itemStarted && depth === 0 && !inString) {
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

function isJsonlSegment(segment = {}) {
  return segment.format === "jsonl" || String(segment.key || "").endsWith(".jsonl");
}

function* chunkArray(values, size) {
  const chunkSize = Math.max(1, Number(size) || 1);
  for (let i = 0; i < (values || []).length; i += chunkSize) yield values.slice(i, i + chunkSize);
}

function emptyJournalRestoreStats(maxLocalSeq = 0) {
  return { journals: 0, ops: 0, skippedJournals: 0, skippedOps: 0, maxLocalSeq };
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
    if (op?.from !== nodeId) continue;
    const seq = Number(op.seq);
    if (Number.isFinite(seq) && seq > max) max = seq;
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

function rememberRestoredCursors(node, sourceNode, ops) {
  const byScope = new Map();
  for (const op of ops || []) {
    const scope = opScope(op, node);
    const key = scopeKey(scope);
    const scoped = byScope.get(key) || { scope, ops: [] };
    scoped.ops.push(op);
    byScope.set(key, scoped);
  }
  for (const { scope, ops: scopedOps } of byScope.values()) {
    rememberRestoredCursor(node, sourceNode, scope, scopedOps);
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
    dir: config?.dir || ".spread-db/wal",
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
  const count = lastSeq >= firstSeq && firstSeq > 0 ? lastSeq - firstSeq + 1 : 0;
  return {
    ...scope,
    node: decodeURIComponent(parts[7]),
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
    firstSeq: Number.isFinite(firstSeq) ? firstSeq : 0,
    lastSeq: Number.isFinite(lastSeq) ? lastSeq : 0,
    count,
  };
}

function parseMetaFromKey(key, prefix) {
  const root = normalizePrefix(prefix);
  const expected = root ? `${root}/` : "";
  if (!key.startsWith(expected)) return null;
  const parts = key.slice(expected.length).split("/");
  if (parts[0] !== "db" || parts[2] !== "collection" || parts[4] !== "meta.json") return null;
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
  if (parts[0] !== "db" || parts[2] !== "meta.json") return null;
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

function snapshotEntries(keys, prefix) {
  const byId = new Map();
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const id = rest.split("/")[0];
    if (!id || rest === id) continue;
    const entry = byId.get(id) || {
      id,
      createdAtMs: snapshotCreatedAtMs(id),
      keys: [],
    };
    entry.keys.push(key);
    byId.set(id, entry);
  }
  return [...byId.values()].sort((left, right) => {
    const created = right.createdAtMs - left.createdAtMs;
    return created || right.id.localeCompare(left.id);
  });
}

function filterSnapshotRetention(snapshots, retention, latest = null) {
  if (!retentionEnabled(retention)) return [];
  const keep = new Set(latest?.id ? [latest.id] : []);
  const keepLatest = Math.max(0, Number(retention.keepLatest) || 0);
  for (const snapshot of snapshots.slice(0, keepLatest)) keep.add(snapshot.id);

  const keepSince = retention.keepForMs > 0 ? Date.now() - retention.keepForMs : null;
  if (keepSince !== null) {
    for (const snapshot of snapshots) {
      if (!snapshot.createdAtMs || snapshot.createdAtMs >= keepSince) keep.add(snapshot.id);
    }
  }

  return snapshots.filter((snapshot) => !keep.has(snapshot.id));
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
  if (value === "all" || value === "none" || value === "primary") return value;
  throw new Error("persistence.snapshotRole must be one of: primary, all, none");
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
  const cursors = isPlainObject(manifest.cursors) ? { ...manifest.cursors } : {};
  if (manifest.node) cursors[manifest.node] = Math.max(Number(cursors[manifest.node]) || 0, Number(manifest.seq) || 0);
  return cursors;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
