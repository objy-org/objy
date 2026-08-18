import { randomUUID } from "node:crypto";
import { Store } from "./store.js";
import { makeClock, nextTs, touch } from "./clock.js";
import { DEFAULT_SHARD, GLOBAL_COLLECTION, GLOBAL_DATABASE, ShardMap } from "./shard-map.js";
import { aggregateRows } from "./aggregate.js";
import { matchesQuery } from "./query.js";
import {
  baseCriteriaForReferenceQuery,
  expandReferencesSync,
  normalizeRefDepth,
  paginateReferencePairs,
  pathHasReferenceObject,
  referenceDepthForAggregateSpec,
  referenceDepthForQuery,
  referenceReadPlan,
  sortReferencePairs,
  stripReferenceObjects,
} from "./references.js";
import { createObjectId } from "./object-id.js";

export class CRDTNode {
  constructor({ id = randomUUID(), url, clock, retainOps = 256, syncBatchSize = 1024, shardMap, storage, vector } = {}) {
    this.id = id;
    this.url = normalizeUrl(url);
    this.db = new Store({ ...(storage || {}), vector });
    this.clock = clock || makeClock(id);
    this.log = [];
    this.seq = 0;
    this.trimmed = 0;
    this.scopeTrimmed = new Map();
    this.retainOps = retainOps;
    this.lastSeen = new Map();
    this.acks = new Map();
    this.peers = [];
    this.shardMap = new ShardMap(shardMap);
    this.syncBatchSize = syncBatchSize;
    this.changeListeners = new Set();
    this.vectorWarmupEnabled = false;
    this.vectorWarmupScheduled = false;
    this.vectorWarmupPromise = Promise.resolve([]);
    this.logTruncatedHandler = null;
  }

  nextTs() {
    return nextTs(this.clock);
  }

  _logOp(op) {
    op.shard = op.shard || this.shardForObject(op.db, op.coll, op.id);
    op.from = this.id;
    op.seq = ++this.seq;
    this.log.push(op);
    return op;
  }

  _logOps(ops) {
    return (ops || []).map((op) => this._logOp(op));
  }

  _applyOp(op) {
    return this._applyOps([op]).length === 1;
  }

  _applyOps(ops) {
    return this.db.applyOps((ops || []).filter((op) => {
      return op?.db && op.coll && op.id && (op.kind === "touch" || op.kind === "putObj" || op.kind === "delObj");
    }));
  }

  _notifyOps(ops) {
    if (!ops.length) return;
    this._notifyChange({ kind: "ops", ops });
  }

  _commitLocalOps(ops) {
    const logged = this._logOps(ops);
    const applied = this._applyOps(logged);
    this._notifyOps(applied);
    if (applied.length) this._scheduleVectorIndexWarmup();
    return { ops: logged, applied };
  }

  applyRemote(fromId, ops, cursorKey = fromId) {
    const incoming = Array.isArray(ops) ? ops : [];
    for (const op of incoming) {
      touch(this.clock, op.ts);
      op.shard = op.shard || this.shardForObject(op.db, op.coll, op.id);
    }
    const applied = this._applyOps(incoming);
    this._notifyOps(applied);
    if (applied.length) this._scheduleVectorIndexWarmup();
    this.lastSeen.set(cursorKey, Math.max(this.lastSeen.get(cursorKey) || 0, incoming.length ? incoming[incoming.length - 1].seq : 0));
    return applied.length;
  }

  _write(db, coll, id, entries) {
    return this._writeMany(db, coll, [{ id, value: Object.fromEntries(entries) }]).ops;
  }

  _writeObject(db, coll, id, value) {
    return this._writeMany(db, coll, [{ id, value }]).ops[0];
  }

  _writeMany(db, coll, items) {
    return this._commitLocalOps((items || []).map(({ id, value }) => ({
      kind: Object.keys(value || {}).length ? "putObj" : "touch",
      db,
      coll,
      id: String(id),
      value: this._prepareWriteValue(db, coll, value),
      ts: this.nextTs(),
    })));
  }

  insert(db, coll, obj) {
    return this.insertMany(db, coll, [obj])[0]._id;
  }

  insertMany(db, coll, objects) {
    const { items } = this._commitInsertMany(db, coll, objects);
    return items.map(({ id }) => this.get(db, coll, id) || { _id: id });
  }

  insertManyCount(db, coll, objects) {
    return this._commitInsertMany(db, coll, objects).applied.length;
  }

  _commitInsertMany(db, coll, objects) {
    const items = normalizeInsertObjects(objects);
    assertInsertTargetsMissing(this.db.collection(db, coll), items);
    return { items, ...this._writeMany(db, coll, items) };
  }

  update(db, coll, id, obj) {
    return this.updateMany(db, coll, [{ ...withoutObjectId(obj), _id: id }]).items[0]?._id || id;
  }

  replace(db, coll, id, obj) {
    return this.replaceMany(db, coll, [{ ...withoutObjectId(obj), _id: id }]).items[0]?._id || id;
  }

  remove(db, coll, id) {
    return this.removeMany(db, coll, [id]).deleted === 1;
  }

  replaceMany(db, coll, objects) {
    const items = normalizeObjectsWithIds(objects);
    this._writeMany(db, coll, items.map((object) => ({
      id: object._id,
      value: this.db.preserveVector(db, coll, object._id, withoutObjectId(object)),
    })));
    return {
      replaced: items.length,
      items: this.getMany(db, coll, items.map((item) => item._id)),
    };
  }

  replaceManyCount(db, coll, objects) {
    const items = normalizeObjectsWithIds(objects);
    this._writeMany(db, coll, items.map((object) => ({
      id: object._id,
      value: this.db.preserveVector(db, coll, object._id, withoutObjectId(object)),
    })));
    return items.length;
  }

  updateMany(db, coll, objects) {
    const items = normalizeObjectsWithIds(objects).map((object) => {
      const current = this.get(db, coll, object._id) || { _id: object._id };
      return {
        _id: object._id,
        value: this.db.preserveVector(db, coll, object._id, { ...withoutObjectId(current), ...withoutObjectId(object) }),
      };
    });
    this._writeMany(db, coll, items.map((item) => ({ id: item._id, value: item.value })));
    return {
      updated: items.length,
      items: this.getMany(db, coll, items.map((item) => item._id)),
    };
  }

  removeMany(db, coll, ids) {
    const skipped = [];
    const ops = [];
    const normalized = normalizeIds(ids);
    for (const id of normalized) {
      if (!this.db.collection(db, coll).has(id)) {
        skipped.push(id);
        continue;
      }
      ops.push({ kind: "delObj", db, coll, id, ts: this.nextTs() });
    }
    const { applied } = this._commitLocalOps(ops);
    return {
      deleted: applied.length,
      ids: applied.map((op) => op.id),
      skipped,
    };
  }

  get(db, coll, id, options = {}) {
    const object = this.db.collection(db, coll).read(id);
    if (!object) return object;
    const depth = normalizeRefDepth(options.refDepth, 0);
    return depth > 0 ? this.expandReferences(db, object, depth) : object;
  }

  getMany(db, coll, ids, options = {}) {
    const objects = this.db.readObjects(db, coll, ids);
    const depth = normalizeRefDepth(options.refDepth, 0);
    return depth > 0 ? objects.map((object) => this.expandReferences(db, object, depth)) : objects;
  }

  list(db, coll) {
    return this.db.collection(db, coll).list();
  }

  find(db, coll, query = {}, options = {}) {
    if (this._needsReferenceRead(query, options)) return this._findWithReferences(db, coll, query, options);
    return this.db.collection(db, coll).find(query, options);
  }

  findShards(db, coll, query = {}, options = {}, shards = []) {
    const includeId = this._includeShardId(db, coll, shards);
    return this.find(db, coll, query, includeId ? { ...options, includeId } : options);
  }

  queryPath(db, coll, query = {}, options = {}) {
    return this.db.queryPath(db, coll, query, options);
  }

  queryPathShards(db, coll, query = {}, options = {}, shards = []) {
    const includeId = this._includeShardId(db, coll, shards);
    return this.queryPath(db, coll, query, includeId ? { ...options, includeId } : options);
  }

  count(db, coll, query = {}, options = {}) {
    if (referenceDepthForQuery(query) > 0) return this._countWithReferences(db, coll, query, options);
    return this.db.collection(db, coll).count(query, options);
  }

  countShards(db, coll, query = {}, shards = []) {
    return this.count(db, coll, query, this._shardQueryOptions(db, coll, shards));
  }

  aggregate(db, coll, query = {}, spec = {}, options = {}) {
    if (referenceDepthForQuery(query) > 0 || referenceDepthForAggregateSpec(spec) > 0) {
      return this._aggregateWithReferences(db, coll, query, spec);
    }
    return this.db.collection(db, coll).aggregate(query, spec, options);
  }

  aggregateShards(db, coll, query = {}, spec = {}, shards = []) {
    return this.aggregate(db, coll, query, spec, this._shardQueryOptions(db, coll, shards));
  }

  aggregatePath(db, coll, query = {}, spec = {}, options = {}) {
    return this.db.aggregatePath(db, coll, query, spec, options);
  }

  aggregatePathShards(db, coll, query = {}, spec = {}, shards = []) {
    return this.aggregatePath(db, coll, query, spec, this._shardQueryOptions(db, coll, shards));
  }

  expandReferences(database, object, depth = 1) {
    return expandReferencesSync(object, {
      database,
      depth,
      getObject: (targetDatabase, targetCollection, id) => this.get(targetDatabase, targetCollection, id, { refDepth: 0 }),
    });
  }

  createIndex(db, coll, path) {
    const result = this.db.collection(db, coll).createIndex(path);
    this._notifyCollectionMeta(db, coll);
    return result;
  }

  dropIndex(db, coll, path) {
    const result = this.db.collection(db, coll).dropIndex(path);
    this._notifyCollectionMeta(db, coll);
    return result;
  }

  getCollectionMeta(db, coll) {
    return this.db.getCollectionMeta(db, coll);
  }

  createDatabase(db, meta = {}) {
    const next = this.db.createDatabase(db, meta);
    this._notifyChange({ kind: "database", database: db, meta: next });
    return next;
  }

  getDatabaseMeta(db) {
    return this.db.getDatabaseMeta(db);
  }

  removeDatabase(db) {
    const removed = this.db.deleteDatabase(db);
    if (removed) this._notifyChange({ kind: "dropDatabase", database: db });
    return removed;
  }

  createCollection(db, coll, meta = {}) {
    const next = this.db.createCollection(db, coll, meta);
    this._notifyChange({ kind: "meta", database: db, collection: coll, meta: next });
    return next;
  }

  setCollectionMeta(db, coll, meta) {
    const next = this.db.setCollectionMeta(db, coll, meta);
    this._notifyChange({ kind: "meta", database: db, collection: coll, meta: next });
    return next;
  }

  removeCollection(db, coll) {
    const removed = this.db.deleteCollection(db, coll);
    if (removed) this._notifyChange({ kind: "dropCollection", database: db, collection: coll });
    return removed;
  }

  listDatabases() {
    return this.db.dbNames();
  }

  listCollections(db) {
    return this.db.collectionNames(db);
  }

  stats(db, coll) {
    return this.db.collection(db, coll).shapeStats();
  }

  indexStats(db, coll) {
    return this.db.collection(db, coll).indexStats();
  }

  indexReadiness() {
    return this.db.indexReadiness();
  }

  awaitColumnIndexes(db, coll) {
    return this.db.awaitColumnIndexes(db, coll);
  }

  awaitFieldIndexes(db, coll) {
    return this.db.awaitFieldIndexes(db, coll);
  }

  awaitIndexes(db, coll) {
    return this.db.awaitIndexes(db, coll);
  }

  startIndexWarmup() {
    return this.db.startIndexWarmup();
  }

  vectorSearch(db, coll, queryVec, limit = 20, options = {}) {
    return this.db.vectorSearch(db, coll, queryVec, limit, options);
  }

  vectorSearchShards(db, coll, queryVec, limit = 20, shards = [], options = {}) {
    const includeId = this._includeShardId(db, coll, shards);
    return this.vectorSearch(db, coll, queryVec, limit, includeId
      ? { includeId, indexKey: vectorShardIndexKey(shards), ...options }
      : options);
  }

  assertVectorIndexReady(db, coll, options = {}) {
    return this.db.assertVectorIndexReady(db, coll, options);
  }

  assertVectorIndexReadyShards(db, coll, shards = []) {
    const includeId = this._includeShardId(db, coll, shards);
    return this.assertVectorIndexReady(db, coll, includeId
      ? { includeId, indexKey: vectorShardIndexKey(shards) }
      : {});
  }

  rankVectorRows(db, coll, rows, queryVec, limit = 20) {
    return this.db.rankVectorRows(db, coll, rows, queryVec, limit);
  }

  getVector(db, coll, id) {
    return this.db.getVector(db, coll, id);
  }

  vectorStats() {
    return this.db.vectorStats();
  }

  startVectorIndexWarmup() {
    this.vectorWarmupEnabled = true;
    this.vectorWarmupPromise = this.db.warmVectorIndexes((database, collection) => this._vectorWarmupPlans(database, collection));
    return this.vectorWarmupPromise;
  }

  async awaitVectorIndexes() {
    this.vectorWarmupEnabled = true;
    await this.startVectorIndexWarmup();
    await this.db.awaitVectorIndexes();
  }

  async syncPeer(peer, scope) {
    let total = 0;

    for (;;) {
      const key = this._peerKey(peer);
      const cursorKey = this._cursorKey(key, scope);
      const after = this.lastSeen.get(cursorKey) || 0;
      const res = await peer.pull(after, this.syncBatchSize, scope);
      if (!res) return total;

      if (res.status === 410) {
        const remoteId = res.nodeId || res.node || peer.nodeId;
        if (remoteId) this._bindPeer(peer, remoteId, key);
        const remoteKey = this._cursorKey(remoteId || key, scope);
        const before = this.lastSeen.get(remoteKey) || after;
        const restored = await this._handleLogTruncated({ peer, scope, after, response: res, remoteId });
        const seen = this.lastSeen.get(remoteKey) || 0;
        if (!restored || seen <= before) {
          const err = new Error("replication log truncated and durable catch-up did not advance");
          err.code = "LOG_TRUNCATED";
          err.scope = scope;
          err.peer = peer;
          err.response = res;
          throw err;
        }
        total += Number(restored.applied || restored.snapshotObjects || restored.journalOps || 0);
        continue;
      }

      const remoteId = res.nodeId || res.node || peer.nodeId;
      if (!remoteId || remoteId === this.id) return total;

      this._bindPeer(peer, remoteId, key);
      const ops = Array.isArray(res.ops) ? res.ops : [];
      const remoteKey = this._cursorKey(remoteId, scope);
      total += this.applyRemote(remoteId, ops, remoteKey);
      const seen = ops.length ? ops[ops.length - 1].seq : res.lastSeq || after;
      this.lastSeen.set(remoteKey, Math.max(this.lastSeen.get(remoteKey) || 0, seen));
      await this._ack(peer, seen, scope);

      if (!ops.length || seen >= (res.lastSeq || seen)) return total;
    }
  }

  setLogTruncatedHandler(handler) {
    this.logTruncatedHandler = typeof handler === "function" ? handler : null;
  }

  async _handleLogTruncated(event) {
    if (!this.logTruncatedHandler) return null;
    return this.logTruncatedHandler(event);
  }

  async _ack(peer, lastSeq, scope) {
    if (!peer.ack) return;
    try {
      await peer.ack(this.id, lastSeq, scope);
    } catch {
      // ack is best-effort; unpruned ops are safe
    }
  }

  applySnapshot(fromId, snap, cursorKey = fromId) {
    const batches = new Map();
    for (const c of snap.collections || []) {
      for (const obj of c.objects || []) {
        const shard = obj.shard || c.shard || this.shardForObject(c.db, c.coll, obj.id);
        if (obj.deleted) {
          if (obj.ts) touch(this.clock, obj.ts);
          touch(this.clock, obj.deleted);
        } else if (obj.ts) {
          touch(this.clock, obj.ts);
        }
        const key = `${c.db}\0${c.coll}`;
        let batch = batches.get(key);
        if (!batch) {
          batch = { db: c.db, coll: c.coll, objects: [] };
          batches.set(key, batch);
        }
        batch.objects.push({ ...obj, shard });
      }
    }
    let count = 0;
    for (const batch of batches.values()) {
      count += this.db.applySnapshotObjects(batch.db, batch.coll, batch.objects, { trustedValues: true });
    }
    this.lastSeen.set(cursorKey, snap.lastSeq || 0);
    if (count) this._notifyChange({ kind: "snapshot", snapshot: snap });
    return count;
  }

  applySnapshotObjects(fromId, { database, collection, objects, lastSeq = 0, scope } = {}, cursorKey = fromId) {
    if (!database || !collection) return 0;
    const rows = Array.isArray(objects) ? objects : [];
    for (const obj of rows) {
      const shard = obj.shard || scope?.shard || this.shardForObject(database, collection, obj.id);
      if (!obj.shard) obj.shard = shard;
      if (obj.deleted) {
        if (obj.ts) touch(this.clock, obj.ts);
        touch(this.clock, obj.deleted);
      } else if (obj.ts) {
        touch(this.clock, obj.ts);
      }
    }
    const count = this.db.applySnapshotObjects(database, collection, rows, { trustedValues: true });
    this.lastSeen.set(cursorKey, lastSeq || 0);
    if (count) this._notifyChange({
      kind: "snapshot",
      snapshot: {
        node: fromId,
        lastSeq,
        collections: [{ db: database, coll: collection, objects: rows }],
      },
    });
    return count;
  }

  onChange(listener) {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  _notifyChange(change) {
    for (const listener of this.changeListeners) {
      try {
        listener(change);
      } catch {
        // durability listeners should never break the mutation path
      }
    }
  }

  _notifyCollectionMeta(db, coll) {
    const meta = this.getCollectionMeta(db, coll);
    if (meta) this._notifyChange({ kind: "meta", database: db, collection: coll, meta });
  }

  snapshot(scope) {
    return {
      node: this.id,
      lastSeq: this.seq,
      collections: this._snapshotCollections(scope),
    };
  }

  *snapshotScopeObjects(scope) {
    if (!scope || scope.database === GLOBAL_DATABASE || scope.collection === GLOBAL_COLLECTION) {
      for (const collection of this._snapshotCollections(scope)) {
        yield* collection.objects;
      }
      return;
    }

    yield* this.db.collectionSnapshotObjects(scope.database, scope.collection, {
      includeId: (id) => this.shardForObject(scope.database, scope.collection, id) === scope.shard,
    });
  }

  receiveAck(peerNodeId, after, scope) {
    this.acks.set(this._cursorKey(peerNodeId, scope), Math.min(after, this.seq));
    return this.prune();
  }

  needsSnapshot(after, scope) {
    if (!scope) return after < this.trimmed;
    for (const [key, trimmed] of this.scopeTrimmed) {
      if (trimmed > after && scopeMatches(parseScopeKey(key), scope)) return true;
    }
    return false;
  }

  prune() {
    if (!this.acks.size) return 0;
    let watermark = Infinity;
    for (const a of this.acks.values()) if (a < watermark) watermark = a;
    const safe = Math.max(0, watermark - this.retainOps);
    if (safe <= this.trimmed) return 0;
    const cut = Math.min(safe, this.seq);
    const removed = cut - this.trimmed;
    if (removed > 0) {
      const removedOps = this.log.splice(0, removed);
      for (const op of removedOps) this._rememberScopeTrim(op);
      this.trimmed = cut;
    }
    return removed;
  }

  _rememberScopeTrim(op) {
    if (!op?.db || !op.coll || !op.shard || !Number.isFinite(op.seq)) return;
    const key = scopeKey({ database: op.db, collection: op.coll, shard: op.shard });
    this.scopeTrimmed.set(key, Math.max(this.scopeTrimmed.get(key) || 0, op.seq));
  }

  getStats() {
    return {
      node: this.id,
      logLength: this.log.length,
      trimmed: this.trimmed,
      retainOps: this.retainOps,
      syncBatchSize: this.syncBatchSize,
      acks: [...this.acks.entries()],
      lastSeen: [...this.lastSeen.entries()],
      scopeTrimmed: [...this.scopeTrimmed.entries()],
    };
  }

  async syncAll() {
    let total = 0;
    for (const target of this.ownedShardTargets()) {
      const scope = this._scope(target.database, target.collection, target.shard);
      for (const peer of this._syncPeersForTarget(target)) {
        try {
          total += await this.syncPeer(peer, scope);
        } catch {
          // peer unreachable; will retry on next sync
        }
      }
    }
    return total;
  }

  syncScopeForShard(shard = DEFAULT_SHARD) {
    return this._scope(GLOBAL_DATABASE, GLOBAL_COLLECTION, shard);
  }

  ownedShardTargets() {
    const targets = this.shardMap.syncTargets();
    if (!this.url) return targets;
    return targets.filter((target) => target.peers.some((peer) => this._isSelfPeer(peer)));
  }

  addPeer(peer) {
    return this.addPeerToShard({
      shard: DEFAULT_SHARD,
      peer,
    });
  }

  addPeerToShard({ shard = DEFAULT_SHARD, peer }) {
    const added = this.shardMap.addPeer(shard, peer);
    this.peers = this.shardMap.allPeers();
    return added;
  }

  removePeerFromShard({ shard = DEFAULT_SHARD, peer }) {
    const removed = this.shardMap.removePeer(shard, peer);
    this.peers = this.shardMap.allPeers();
    return removed;
  }

  peersForShard(shard = DEFAULT_SHARD) {
    return this.shardMap.peersFor(shard);
  }

  ownsShard(shard = DEFAULT_SHARD) {
    if (!this.url) return true;
    const peers = this.peersForShard(shard);
    if (!peers.length) return true;
    return peers.some((peer) => this._isSelfPeer(peer));
  }

  routingPeersForShard(shard = DEFAULT_SHARD) {
    return this.peersForShard(shard).filter((peer) => peer.url && !this._isSelfPeer(peer));
  }

  replaceShardMap(shardMap) {
    this.shardMap.replace(shardMap);
    this.peers = this.shardMap.allPeers();
    this.db.clearVectorIndexes();
    this._scheduleVectorIndexWarmup();
  }

  shardMapSnapshot() {
    return this.shardMap.snapshot();
  }

  shardForObject(database, collection, objectId) {
    return this.shardMap.shardForObject(database, collection, objectId);
  }

  _includeShardId(database, collection, shards = []) {
    const shardSet = new Set((shards || []).filter(Boolean));
    if (!shardSet.size) return null;
    return (id) => shardSet.has(this.shardForObject(database, collection, id));
  }

  _shardQueryOptions(database, collection, shards = []) {
    const shardSet = new Set((shards || []).filter(Boolean));
    if (!shardSet.size) return {};
    const scopeShards = [...shardSet];
    const includeIds = this.db.idsForShards(database, collection, [...shardSet]);
    if (includeIds) return { includeIds, scopeShards };
    const includeId = this._includeShardId(database, collection, [...shardSet]);
    return includeId ? { includeId, scopeShards } : {};
  }

  _scheduleVectorIndexWarmup() {
    if (!this.vectorWarmupEnabled || this.vectorWarmupScheduled) return;
    this.vectorWarmupScheduled = true;
    setImmediate(() => {
      this.vectorWarmupScheduled = false;
      this.startVectorIndexWarmup().catch(() => {});
    });
  }

  _vectorWarmupPlans(database, collection) {
    const shards = this.shardMap.shardsForCollection(database, collection).filter((shard) => this.ownsShard(shard));
    const plans = this.url ? [] : [{ key: "all" }];
    if (!shards.length) return plans.length ? plans : [{ key: "all" }];
    plans.push({
      key: vectorShardIndexKey(shards),
      includeId: this._includeShardId(database, collection, shards),
    });
    for (const shard of shards) {
      plans.push({
        key: vectorShardIndexKey([shard]),
        includeId: this._includeShardId(database, collection, [shard]),
      });
    }
    return plans;
  }

  _needsReferenceRead(query = {}, options = {}) {
    return referenceDepthForQuery(query) > 0 ||
      pathHasReferenceObject(options.sortBy) ||
      normalizeRefDepth(options.refDepth, 0) > 0;
  }

  _findWithReferences(db, coll, query = {}, options = {}) {
    const criteria = query || {};
    const { matchDepth, responseDepth } = referenceReadPlan(criteria, options);
    if (matchDepth <= 0) {
      return this.db.collection(db, coll)
        .find(criteria, withoutReferenceOptions(options))
        .map((object) => this.expandReferences(db, object, responseDepth));
    }
    const fetchOptions = {
      ...(typeof options.includeId === "function" ? { includeId: options.includeId } : {}),
    };
    const candidates = this.db.collection(db, coll).find(
      matchDepth > 0 ? baseCriteriaForReferenceQuery(criteria) : criteria,
      fetchOptions,
    );
    const matched = [];
    for (const object of candidates) {
      const matchObject = matchDepth > 0 ? this.expandReferences(db, object, matchDepth) : object;
      if (matchesQuery(matchObject, criteria)) matched.push({ raw: object, matchObject });
    }
    const sorted = sortReferencePairs(matched, options);
    const paged = paginateReferencePairs(sorted, options);
    return paged.map(({ raw }) => responseDepth > 0 ? this.expandReferences(db, raw, responseDepth) : raw);
  }

  _countWithReferences(db, coll, query = {}, options = {}) {
    const criteria = query || {};
    const depth = referenceDepthForQuery(criteria);
    let n = 0;
    const candidates = this.db.collection(db, coll).find(baseCriteriaForReferenceQuery(criteria), {
      ...(typeof options.includeId === "function" ? { includeId: options.includeId } : {}),
    });
    for (const object of candidates) {
      if (matchesQuery(this.expandReferences(db, object, depth), criteria)) n++;
    }
    return n;
  }

  _aggregateWithReferences(db, coll, query = {}, spec = {}) {
    const depth = Math.max(referenceDepthForQuery(query), referenceDepthForAggregateSpec(spec));
    const rows = this._findWithReferences(db, coll, query, { refDepth: depth });
    return aggregateRows(rows, spec);
  }

  _prepareWriteValue(db, coll, value) {
    const prepared = stripReferenceObjects(withoutObjectId(value));
    this.db.validateWriteValue(db, coll, prepared);
    return prepared;
  }

  _snapshotCollections(scope) {
    if (!scope) return this.db.snapshot();

    return this.db.snapshot({
      database: scope.database,
      collection: scope.collection,
      includeObject: (database, collection, id) => {
        return this.shardForObject(database, collection, id) === scope.shard;
      },
    }).map((collection) => ({
      ...collection,
      shard: scope.shard,
      objects: collection.objects.map((object) => ({ ...object, shard: object.shard || scope.shard })),
    }));
  }

  _opsAfter(after, limit, scope) {
    const out = [];
    for (const op of this.log) {
      if (op.seq <= after) continue;
      if (scope && !this._opMatchesScope(op, scope)) continue;
      out.push(op);
      if (limit && out.length >= limit) break;
    }
    return out;
  }

  _opMatchesScope(op, scope) {
    return (
      (scope.database === GLOBAL_DATABASE || op.db === scope.database) &&
      (scope.collection === GLOBAL_COLLECTION || op.coll === scope.collection) &&
      op.shard === scope.shard
    );
  }

  _peerKey(peer) {
    return peer.nodeId || peer.key;
  }

  _syncPeersForTarget(target) {
    return this.url ? target.peers.filter((peer) => !this._isSelfPeer(peer)) : target.peers;
  }

  _isSelfPeer(peer) {
    return normalizeUrl(peer.url) === this.url || peer.nodeId === this.id || peer.key === this.id;
  }

  _scope(database, collection, shard) {
    if (database === GLOBAL_DATABASE && collection === GLOBAL_COLLECTION && shard === DEFAULT_SHARD) return undefined;
    return { database, collection, shard };
  }

  _cursorKey(peerKey, scope) {
    return scope ? `${peerKey}|${scope.database}/${scope.collection}/${scope.shard}` : peerKey;
  }

  _bindPeer(peer, nodeId, previousKey) {
    if (!nodeId) return;
    if (previousKey && previousKey !== nodeId && this.lastSeen.has(previousKey)) {
      const seen = Math.max(this.lastSeen.get(nodeId) || 0, this.lastSeen.get(previousKey) || 0);
      this.lastSeen.set(nodeId, seen);
      this.lastSeen.delete(previousKey);
    }
    peer.nodeId = nodeId;
  }
}

function withoutObjectId(object) {
  const { _id, ...rest } = object || {};
  return rest;
}

function withoutReferenceOptions(options = {}) {
  const { refDepth, ...rest } = options;
  return rest;
}

function vectorShardIndexKey(shards = []) {
  const shardList = [...new Set((shards || []).filter(Boolean).map(String))].sort();
  return shardList.length ? `shards:${shardList.join(",")}` : "all";
}

function normalizeObjectsWithIds(objects) {
  if (!Array.isArray(objects)) throw new TypeError("objects must be an array");
  const normalized = objects.map((object, index) => {
    if (!object || typeof object !== "object" || Array.isArray(object)) {
      const err = new TypeError(`item at index ${index} must be an object`);
      err.index = index;
      throw err;
    }
    if (object._id === undefined || object._id === null || String(object._id).length === 0) {
      const err = new TypeError(`item at index ${index} must include _id`);
      err.index = index;
      throw err;
    }
    return { ...object, _id: String(object._id) };
  });
  assertUniqueIds(normalized.map((object) => object._id));
  return normalized;
}

function normalizeInsertObjects(objects) {
  const normalized = (objects || []).map((obj = {}, index) => {
    const hasId = obj && obj._id !== undefined && obj._id !== null;
    const id = hasId ? String(obj._id) : createObjectId();
    if (id.length === 0) {
      const err = new TypeError(`item at index ${index} must include a non-empty _id when _id is provided`);
      err.index = index;
      throw err;
    }
    return { id, value: withoutObjectId(obj) };
  });
  assertUniqueIds(normalized.map((item) => item.id));
  return normalized;
}

function normalizeIds(ids) {
  if (!Array.isArray(ids)) throw new TypeError("ids must be an array");
  const normalized = ids.map((rawId, index) => {
    const id = String(rawId);
    if (id.length === 0) {
      const err = new TypeError(`id at index ${index} must be non-empty`);
      err.index = index;
      throw err;
    }
    return id;
  });
  assertUniqueIds(normalized);
  return normalized;
}

function assertUniqueIds(ids) {
  const seen = new Set();
  for (let i = 0; i < ids.length; i++) {
    const id = String(ids[i]);
    if (seen.has(id)) {
      const err = new TypeError(`duplicate _id in bulk request: ${id}`);
      err.index = i;
      err.id = id;
      throw err;
    }
    seen.add(id);
  }
}

function assertInsertTargetsMissing(collection, items) {
  for (const item of items || []) {
    if (!collection.has(item.id)) continue;
    const err = new Error(`object already exists: ${item.id}`);
    err.status = 409;
    err.id = item.id;
    throw err;
  }
}

function normalizeUrl(url) {
  return url ? String(url).replace(/\/+$/, "") : null;
}

function scopeKey(scope) {
  return `${scope.database}\n${scope.collection}\n${scope.shard}`;
}

function parseScopeKey(key) {
  const [database, collection, shard] = key.split("\n");
  return { database, collection, shard };
}

function scopeMatches(opScope, requested) {
  return (
    (requested.database === GLOBAL_DATABASE || requested.database === opScope.database) &&
    (requested.collection === GLOBAL_COLLECTION || requested.collection === opScope.collection) &&
    requested.shard === opScope.shard
  );
}

export function localPeer(node) {
  return {
    key: node.id,
    nodeId: node.id,
    pull: async (after, limit, scope) => {
      if (node.needsSnapshot(after, scope)) {
        return { status: 410, nodeId: node.id, lastSeq: node.seq, trimmed: node.trimmed };
      }
      const ops = node._opsAfter(after, limit, scope);
      return {
        status: 200,
        nodeId: node.id,
        lastSeq: node.seq,
        ops,
      };
    },
    ack: async (id, seq, scope) => node.receiveAck(id, seq, scope),
  };
}
