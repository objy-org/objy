import { randomUUID } from "node:crypto";
import { DEFAULT_SHARD, GLOBAL_COLLECTION, GLOBAL_DATABASE } from "./shard-map.js";
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
    restoreScopes,
    restoreMode = "scoped",
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
    this.restoreScopes = restoreScopes;
    this.restoreMode = restoreMode;
    this.pending = new Map();
    this.pendingDatabases = new Map();
    this.pendingMeta = new Map();
    this.pendingCollectionDrops = new Set();
    this.flushTimer = null;
    this.snapshotTimer = null;
    this.unsubscribe = null;
    this.flushing = null;
    this.checkpointing = null;
    this.flushPaused = false;
    this.lastError = null;
  }

  async restore() {
    const root = this._rootPrefix();
    const keys = await this.storage.list(root);
    const scopes = this._filterRestoreScopes(uniqueScopes(keys, this.prefix));
    const stats = { scopes: 0, databases: 0, metadata: 0, snapshots: 0, snapshotObjects: 0, journals: 0, journalOps: 0 };
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
        this.node.applyRemote(segment.node || "persistence", ops, `persistence:${key}`);
        for (const op of ops) {
          if (op.from === this.node.id && Number.isFinite(op.seq)) {
            maxLocalSeq = Math.max(maxLocalSeq, op.seq);
          }
        }
        stats.journals++;
        stats.journalOps += ops.length;
      }
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
    if (this.snapshotMs && !this.snapshotTimer) {
      this.snapshotTimer = setInterval(() => {
        this.checkpoint().catch((err) => (this.lastError = err));
      }, this.snapshotMs);
      this.snapshotTimer.unref?.();
    }
  }

  async stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.flushTimer = null;
    this.snapshotTimer = null;
    await this.flush();
  }

  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this._flushOnce().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async checkpoint() {
    if (this.checkpointing) return this.checkpointing;
    this.checkpointing = this._checkpointOnce().finally(() => {
      this.checkpointing = null;
    });
    return this.checkpointing;
  }

  getStats() {
    return {
      pendingScopes: this.pending.size,
      pendingOps: [...this.pending.values()].reduce((sum, ops) => sum + ops.length, 0),
      pendingDatabases: this.pendingDatabases.size,
      pendingMetadata: this.pendingMeta.size,
      pendingCollectionDrops: this.pendingCollectionDrops.size,
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
      for (const op of change.ops || []) this._queueOp(op);
      return;
    }
    if (change.kind === "snapshot") {
      this.checkpoint().catch((err) => (this.lastError = err));
    }
  }

  _queueDatabase(change) {
    if (!change.database || !change.meta) return;
    this.pendingDatabases.set(change.database, clone(change.meta));
  }

  _queueMeta(change) {
    if (!change.database || !change.collection || !change.meta) return;
    this.pendingMeta.set(collectionKey(change.database, change.collection), clone(change.meta));
  }

  _queueCollectionDrop(change) {
    if (!change.database || !change.collection) return;
    const key = collectionKey(change.database, change.collection);
    this.pendingCollectionDrops.add(key);
    this.pendingMeta.delete(key);
    for (const pendingKey of [...this.pending.keys()]) {
      const scope = parseScopeKey(pendingKey);
      if (scope.database === change.database && scope.collection === change.collection) {
        this.pending.delete(pendingKey);
      }
    }
  }

  _queueOp(op) {
    if (!op?.db || !op.coll || !op.id || !op.shard) return;
    const scope = { database: op.db, collection: op.coll, shard: op.shard };
    const key = scopeKey(scope);
    const pending = this.pending.get(key) || [];
    pending.push(clone(op));
    this.pending.set(key, pending);
    if (pending.length >= this.opBatchSize) {
      this.flush().catch((err) => (this.lastError = err));
    }
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

  async _checkpointOnce() {
    await this.flush();
    this.flushPaused = true;
    const scopes = this._snapshotScopes();
    const stats = { scopes: 0, objects: 0, segments: 0 };
    try {
      for (const scope of scopes) {
        const written = await this._writeSnapshot(scope);
        stats.scopes++;
        stats.objects += written.objects;
        stats.segments += written.segments;
      }
    } finally {
      this.flushPaused = false;
    }
    return stats;
  }

  _snapshotScopes() {
    const scopes = [];
    const ownedShards = this._ownedShardNames();
    for (const collection of this.node.db.snapshot()) {
      const shards = ownedShards.length ? ownedShards : this.node.shardMap.shardsForCollection(collection.db, collection.coll);
      for (const shard of shards.length ? shards : [DEFAULT_SHARD]) {
        scopes.push({ database: collection.db, collection: collection.coll, shard });
      }
    }
    return scopes;
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
    const snapshot = this.node.snapshot(scope);
    const collection = snapshot.collections.find((item) => {
      return item.db === scope.database && item.coll === scope.collection;
    });
    const objects = collection?.objects || [];
    const id = snapshotId();
    const base = `${scopePrefix(this.prefix, scope)}/snapshots/${id}`;
    const chunks = chunkJsonArray(objects, this.segmentBytes, `${scopeKey(scope)} snapshot`);
    const segments = [];

    for (let i = 0; i < chunks.length; i++) {
      const key = `${base}/segment-${String(i).padStart(6, "0")}.json`;
      await this.storage.put(key, chunks[i].body, "application/json");
      segments.push({ key, count: chunks[i].count, bytes: chunks[i].bytes });
    }

    const manifest = {
      version: 1,
      id,
      node: snapshot.node,
      seq: snapshot.lastSeq,
      createdAt: new Date().toISOString(),
      database: scope.database,
      collection: scope.collection,
      shard: scope.shard,
      objectCount: objects.length,
      segments,
    };
    await this.storage.put(`${base}/manifest.json`, JSON.stringify(manifest), "application/json");
    await this.storage.put(`${scopePrefix(this.prefix, scope)}/latest.json`, JSON.stringify(manifest), "application/json");
    if (this.compactJournals) await this._compactJournals(scope);
    return { objects: objects.length, segments: segments.length };
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
      this.node.applySnapshot(manifest.node || "persistence", {
        node: manifest.node || "persistence",
        lastSeq: manifest.seq || 0,
        collections: [{ db: scope.database, coll: scope.collection, objects: rows }],
      }, `persistence:${scopeKey(scope)}:snapshot`);
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
    restoreMode: config.restoreMode || "scoped",
    restoreScopes: config.restoreScopes,
  });
}

function chunkJsonArray(rows, maxBytes, label) {
  const chunks = [];
  let current = [];
  let bytes = 2;

  function flush() {
    if (!current.length) return;
    chunks.push({ body: `[${current.join(",")}]`, count: current.length, bytes });
    current = [];
    bytes = 2;
  }

  for (let i = 0; i < rows.length; i++) {
    const row = stringifyJson(rows[i], `${label} row ${i}`);
    const rowBytes = Buffer.byteLength(row);
    const nextBytes = bytes + (current.length ? 1 : 0) + rowBytes;
    if (current.length && nextBytes > maxBytes) flush();
    current.push(row);
    bytes += (current.length > 1 ? 1 : 0) + rowBytes;
  }

  flush();
  if (!chunks.length) chunks.push({ body: "[]", count: 0, bytes: 2 });
  return chunks;
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

function normalizePrefix(prefix) {
  return String(prefix || "").replace(/^\/+|\/+$/g, "");
}
