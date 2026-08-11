import { randomUUID } from "node:crypto";
import { DEFAULT_SHARD, GLOBAL_COLLECTION, GLOBAL_DATABASE } from "./shard-map.js";
import { LocalWalStore } from "./local-wal.js";
import { createObjectStorage } from "./object-storage.js";

const DEFAULT_PREFIX = "spread-db";
const DEFAULT_SEGMENT_BYTES = 16 * 1024 * 1024;

export class PersistenceManager {
  constructor({
    node,
    storage,
    prefix = DEFAULT_PREFIX,
    flushMs = 1000,
    opBatchSize = 1000,
    snapshotMs = 60_000,
    segmentBytes = DEFAULT_SEGMENT_BYTES,
    compactJournals = true,
    snapshotDirtyOnly = true,
    snapshotRole = "primary",
    restoreScopes,
    restoreMode = "scoped",
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
    this.snapshotMs = Math.max(0, Number(snapshotMs) || 0);
    this.segmentBytes = Math.max(1024, Number(segmentBytes) || DEFAULT_SEGMENT_BYTES);
    this.compactJournals = compactJournals !== false;
    this.snapshotDirtyOnly = snapshotDirtyOnly !== false;
    this.snapshotRole = normalizeSnapshotRole(snapshotRole);
    this.restoreScopes = restoreScopes;
    this.restoreMode = restoreMode;
    this.localWal = createLocalWalStore(localWal, node.id);
    this.ack = normalizeAckMode(ack);
    if (this.ack === "localWal" && !this.localWal) {
      throw new Error("persistence.ack localWal requires persistence.localWal.mode on");
    }
    this.pending = new Map();
    this.dirtyScopes = new Map();
    this.pendingDatabases = new Map();
    this.pendingMeta = new Map();
    this.pendingCollectionDrops = new Set();
    this.localWalPending = [];
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

  async restore() {
    const root = this._rootPrefix();
    const keys = await this.storage.list(root);
    const scopes = this._filterRestoreScopes(uniqueScopes(keys, this.prefix));
    const stats = {
      scopes: 0,
      databases: 0,
      metadata: 0,
      snapshots: 0,
      snapshotObjects: 0,
      journals: 0,
      journalOps: 0,
      localWalRecords: 0,
      localWalOps: 0,
      localWalDatabases: 0,
      localWalMetadata: 0,
      localWalCollectionDrops: 0,
      localWalSkippedPartialRecords: 0,
    };
    let maxLocalSeq = this.node.seq;

    stats.databases = await this._restoreDatabaseMetadata(keys);
    stats.metadata = await this._restoreMetadata(keys);

    for (const scope of scopes) {
      stats.scopes++;
      const restored = await this._restoreSnapshot(scope);
      if (restored) {
        stats.snapshots++;
        stats.snapshotObjects += restored.objects;
        if (restored.node === this.node.id) maxLocalSeq = Math.max(maxLocalSeq, restored.seq);
      }

      const journalKeys = keys.filter((key) => key.startsWith(`${scopePrefix(this.prefix, scope)}/journal/`));
      for (const key of journalKeys.sort()) {
        const raw = await this.storage.get(key);
        if (!raw) continue;
        const segment = JSON.parse(raw);
        const ops = this._filterRestoreOps(scope, Array.isArray(segment.ops) ? segment.ops : []);
        const sourceNode = segment.node || "persistence";
        this.node.applyRemote(sourceNode, ops, `persistence:${key}`);
        rememberRestoredCursor(this.node, sourceNode, scope, ops);
        for (const op of ops) {
          if (op.from === this.node.id && Number.isFinite(op.seq)) {
            maxLocalSeq = Math.max(maxLocalSeq, op.seq);
          }
        }
        stats.journals++;
        stats.journalOps += ops.length;
      }
    }

    if (this.localWal) {
      const local = await this._restoreLocalWal();
      stats.localWalRecords = local.records;
      stats.localWalOps = local.ops;
      stats.localWalDatabases = local.databases;
      stats.localWalMetadata = local.metadata;
      stats.localWalCollectionDrops = local.collectionDrops;
      stats.localWalSkippedPartialRecords = local.skippedPartialRecords;
      maxLocalSeq = Math.max(maxLocalSeq, local.maxLocalSeq);
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
      dirtyScopes: this.dirtyScopes.size,
      dirtyOps: [...this.dirtyScopes.values()].reduce((sum, dirty) => sum + dirty.ops, 0),
      pendingDatabases: this.pendingDatabases.size,
      pendingMetadata: this.pendingMeta.size,
      pendingCollectionDrops: this.pendingCollectionDrops.size,
      ack: this.ack,
      localWal: this.localWal ? {
        path: this.localWal.filePath,
        fsync: this.localWal.fsync,
        pendingRecords: this.localWalPending.length,
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
    this._queueLocalWal({
      type: "database",
      database: change.database,
      meta: clone(change.meta),
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
    this._queueLocalWal({
      type: "ops",
      ...commonScope(cloned),
      ...seqRange(cloned),
      count: cloned.length,
      ops: cloned,
    });
  }

  _queueOp(op) {
    if (!op?.db || !op.coll || !op.id || !op.shard) return;
    const cloned = clone(op);
    const scope = { database: op.db, collection: op.coll, shard: op.shard };
    const key = scopeKey(scope);
    const pending = this.pending.get(key) || [];
    pending.push(cloned);
    this.pending.set(key, pending);
    this._markDirty(key, cloned);
    if (pending.length >= this.opBatchSize) {
      this.flush().catch((err) => (this.lastError = err));
    }
    return cloned;
  }

  _queueLocalWal(record) {
    if (!this.localWal) return;
    this.localWalPending.push({
      version: 1,
      node: this.node.id,
      createdAt: new Date().toISOString(),
      ...record,
    });
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
    if (!this.pending.size && !this.pendingDatabases.size && !this.pendingMeta.size && !this.pendingCollectionDrops.size) {
      return { scopes: 0, ops: 0, databases: 0, metadata: 0, collectionDrops: 0 };
    }

    const batches = this.pending;
    const databases = this.pendingDatabases;
    const metadata = this.pendingMeta;
    const collectionDrops = this.pendingCollectionDrops;
    this.pending = new Map();
    this.pendingDatabases = new Map();
    this.pendingMeta = new Map();
    this.pendingCollectionDrops = new Set();
    let scopeCount = 0;
    let opCount = 0;
    let databaseCount = 0;
    let metadataCount = 0;
    let collectionDropCount = 0;

    try {
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
        metadata: metadataCount,
        collectionDrops: collectionDropCount,
      };
    } catch (err) {
      this._requeueBatches(batches);
      this._requeueDatabases(databases);
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

    try {
      const written = await this.localWal.append(records);
      return {
        records: records.length,
        ops: records.reduce((sum, record) => sum + (record.type === "ops" ? Number(record.count) || 0 : 0), 0),
        databases: records.filter((record) => record.type === "database").length,
        metadata: records.filter((record) => record.type === "meta").length,
        collectionDrops: records.filter((record) => record.type === "dropCollection").length,
        bytes: written.bytes,
      };
    } catch (err) {
      this.localWalPending = [...records, ...this.localWalPending];
      this.lastError = err;
      throw err;
    }
  }

  async _truncateLocalWalIfDurable() {
    if (!this.localWal || this.localWalPending.length || this.localWalFlushing) return;
    if (this.pending.size || this.pendingDatabases.size || this.pendingMeta.size || this.pendingCollectionDrops.size) return;
    await this.localWal.truncate();
  }

  _requeueBatches(batches) {
    for (const [key, ops] of batches) {
      const current = this.pending.get(key) || [];
      this.pending.set(key, [...ops, ...current]);
    }
  }

  _requeueDatabases(databases) {
    for (const [database, meta] of databases) {
      if (!this.pendingDatabases.has(database)) this.pendingDatabases.set(database, meta);
    }
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
    await this.storage.put(
      `${databasePrefix(this.prefix, database)}/meta.json`,
      JSON.stringify(meta),
      "application/json",
    );
  }

  async _writeCollectionMeta({ database, collection }, meta) {
    await this.storage.put(
      `${collectionPrefix(this.prefix, database, collection)}/meta.json`,
      JSON.stringify(meta),
      "application/json",
    );
  }

  async _deleteCollection({ database, collection }) {
    await this.storage.deletePrefix(`${collectionPrefix(this.prefix, database, collection)}/`);
  }

  async _writeJournalBatch(scope, ops) {
    const seqs = ops.map((op) => Number(op.seq)).filter(Number.isFinite);
    const firstSeq = seqs.length ? Math.min(...seqs) : 0;
    const lastSeq = seqs.length ? Math.max(...seqs) : 0;
    const segment = {
      version: 1,
      node: this.node.id,
      database: scope.database,
      collection: scope.collection,
      shard: scope.shard,
      firstSeq,
      lastSeq,
      count: ops.length,
      ops,
    };
    const key = `${scopePrefix(this.prefix, scope)}/journal/${safe(this.node.id)}/${Date.now()}-${pad(firstSeq)}-${pad(lastSeq)}-${randomUUID()}.json`;
    await this.storage.put(key, JSON.stringify(segment), "application/json");
  }

  async _checkpointOnce(options = {}) {
    await this.flush();
    this.flushPaused = true;
    const scopes = this._snapshotScopes(options);
    const stats = { scopes: 0, objects: 0, segments: 0 };
    try {
      for (const scope of scopes) {
        const written = await this._writeSnapshot(scope);
        this._markCheckpointed(scope);
        stats.scopes++;
        stats.objects += written.objects;
        stats.segments += written.segments;
      }
    } finally {
      this.flushPaused = false;
    }
    return stats;
  }

  _snapshotScopes({ automatic = false } = {}) {
    const scopes = [];
    const ownedShards = this._ownedShardNames();
    for (const collection of this._collectionScopes()) {
      const shards = ownedShards.length ? ownedShards : this.node.shardMap.shardsForCollection(collection.database, collection.collection);
      for (const shard of shards.length ? shards : [DEFAULT_SHARD]) {
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
    if (!this.node.url) return true;
    const peers = this.node.peersForShard(shard).filter((peer) => peer.url);
    if (!peers.length) return true;
    const primary = peers[0];
    return normalizeUrl(primary.url) === this.node.url || primary.nodeId === this.node.id || primary.key === this.node.id;
  }

  _markCheckpointed(scope) {
    const key = scopeKey(scope);
    const dirty = this.dirtyScopes.get(key);
    if (dirty && scope.dirtyVersion !== undefined && dirty.version > scope.dirtyVersion) return;
    this.dirtyScopes.delete(key);
  }

  _filterRestoreScopes(scopes) {
    const targets = this.restoreScopes || this.node.ownedShardTargets();
    if (!targets.length || targets.some(isGlobalTarget)) return scopes;
    if (this.restoreMode === "reshard") {
      return scopes.filter((scope) => targets.some((target) => matchesRestoreCollection(scope, target)));
    }
    return scopes.filter((scope) => targets.some((target) => matchesRestoreTarget(scope, target)));
  }

  _filterRestoreObjects(scope, objects) {
    if (this.restoreMode !== "reshard") return objects;
    const targets = this.restoreScopes || this.node.ownedShardTargets();
    if (!targets.length || targets.some(isGlobalTarget)) return objects;
    return objects.filter((object) => this._objectMatchesRestoreTargets(scope.database, scope.collection, object.id, targets));
  }

  _filterRestoreOps(scope, ops) {
    if (this.restoreMode !== "reshard") return ops;
    const targets = this.restoreScopes || this.node.ownedShardTargets();
    if (!targets.length || targets.some(isGlobalTarget)) return ops;
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

  async _writeSnapshot(scope) {
    const id = snapshotId();
    const base = `${scopePrefix(this.prefix, scope)}/snapshots/${id}`;
    const segments = [];
    let objectCount = 0;

    for (const chunk of chunkJsonIterable(this.node.snapshotScopeObjects(scope), this.segmentBytes, `${scopeKey(scope)} snapshot`)) {
      const key = `${base}/segment-${String(segments.length).padStart(6, "0")}.json`;
      await this.storage.put(key, chunk.body, "application/json");
      segments.push({ key, count: chunk.count, bytes: chunk.bytes });
      objectCount += chunk.count;
    }

    const manifest = {
      version: 1,
      id,
      node: this.node.id,
      seq: this.node.seq,
      createdAt: new Date().toISOString(),
      database: scope.database,
      collection: scope.collection,
      shard: scope.shard,
      objectCount,
      segments,
    };
    await this.storage.put(`${base}/manifest.json`, JSON.stringify(manifest), "application/json");
    await this.storage.put(`${scopePrefix(this.prefix, scope)}/latest.json`, JSON.stringify(manifest), "application/json");
    if (this.compactJournals) await this._compactJournals(scope);
    return { objects: objectCount, segments: segments.length };
  }

  async _compactJournals(scope) {
    const prefix = `${scopePrefix(this.prefix, scope)}/journal/`;
    const keys = await this.storage.list(prefix);
    if (!keys.length) return 0;
    return this.storage.delete(keys);
  }

  async _restoreSnapshot(scope) {
    const raw = await this.storage.get(`${scopePrefix(this.prefix, scope)}/latest.json`);
    if (!raw) return null;
    const manifest = JSON.parse(raw);
    let objects = 0;

    for (const segment of manifest.segments || []) {
      const body = await this.storage.get(segment.key);
      if (body === null) throw new Error(`snapshot segment missing: ${segment.key}`);
      const rows = this._filterRestoreObjects(scope, JSON.parse(body));
      const sourceNode = manifest.node || "persistence";
      const cursorKey = this.node._cursorKey ? this.node._cursorKey(sourceNode, scope) : `persistence:${scopeKey(scope)}:snapshot`;
      this.node.applySnapshot(sourceNode, {
        node: sourceNode,
        lastSeq: manifest.seq || 0,
        collections: [{ db: scope.database, coll: scope.collection, objects: rows }],
      }, cursorKey);
      objects += rows.length;
    }

    return { node: manifest.node, seq: Number(manifest.seq) || 0, objects };
  }

  async _restoreMetadata(keys) {
    let count = 0;
    for (const key of keys) {
      const target = parseMetaFromKey(key, this.prefix);
      if (!target) continue;
      const raw = await this.storage.get(key);
      if (!raw) continue;
      this.node.db.setCollectionMeta(target.database, target.collection, JSON.parse(raw));
      count++;
    }
    return count;
  }

  async _restoreDatabaseMetadata(keys) {
    let count = 0;
    for (const key of keys) {
      const target = parseDatabaseMetaFromKey(key, this.prefix);
      if (!target) continue;
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
      metadata: 0,
      collectionDrops: 0,
      skippedPartialRecords,
      maxLocalSeq: this.node.seq,
    };

    let line = 0;
    for (const record of records) {
      line++;
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
    const targets = this.restoreScopes || this.node.ownedShardTargets();
    if (!targets.length || targets.some(isGlobalTarget)) return ops;
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
    flushMs: config.flushMs ?? 1000,
    opBatchSize: config.opBatchSize ?? 1000,
    snapshotMs: config.snapshotMs ?? 60_000,
    segmentBytes: config.segmentBytes ?? DEFAULT_SEGMENT_BYTES,
    compactJournals: config.compactJournals !== false,
    snapshotDirtyOnly: config.snapshotDirtyOnly !== false,
    snapshotRole: config.snapshotRole || "primary",
    restoreMode: config.restoreMode || "scoped",
    restoreScopes: config.restoreScopes,
    ack: config.ack || "memory",
    localWal: config.localWal,
  });
}

function* chunkJsonIterable(rows, maxBytes, label) {
  let current = [];
  let bytes = 2;

  function makeChunk() {
    return { body: `[${current.join(",")}]`, count: current.length, bytes };
  }

  let i = 0;
  for (const value of rows) {
    const row = stringifyJson(value, `${label} row ${i}`);
    i++;
    const rowBytes = Buffer.byteLength(row);
    const nextBytes = bytes + (current.length ? 1 : 0) + rowBytes;
    if (current.length && nextBytes > maxBytes) {
      yield makeChunk();
      current = [];
      bytes = 2;
    }
    current.push(row);
    bytes += (current.length > 1 ? 1 : 0) + rowBytes;
  }

  if (current.length) {
    yield makeChunk();
    return;
  }
  yield { body: "[]", count: 0, bytes: 2 };
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

function uniqueScopes(keys, prefix) {
  const scopes = new Map();
  for (const key of keys) {
    const scope = parseScopeFromKey(key, prefix);
    if (scope) scopes.set(scopeKey(scope), scope);
  }
  return [...scopes.values()].sort((a, b) => scopeKey(a).localeCompare(scopeKey(b)));
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
  return { records: 0, ops: 0, databases: 0, metadata: 0, collectionDrops: 0, bytes: 0 };
}

function mergeLocalFlushStats(target, source = {}) {
  target.records += Number(source.records) || 0;
  target.ops += Number(source.ops) || 0;
  target.databases += Number(source.databases) || 0;
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

function isGlobalTarget(target) {
  return target.database === GLOBAL_DATABASE && target.collection === GLOBAL_COLLECTION && target.shard === DEFAULT_SHARD;
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

function databasePrefix(prefix, database) {
  return `${normalizePrefix(prefix)}/db/${safe(database)}`.replace(/^\/+/, "");
}

function snapshotId() {
  return `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID()}`;
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

function normalizeUrl(url) {
  return url ? String(url).replace(/\/+$/, "") : null;
}
