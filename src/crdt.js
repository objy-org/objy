import { randomUUID } from "node:crypto";
import { Store } from "./store.js";
import { makeClock, nextTs, touch } from "./clock.js";
import { DEFAULT_SHARD, GLOBAL_COLLECTION, GLOBAL_DATABASE, ShardMap } from "./shard-map.js";

export class CRDTNode {
  constructor({ id = randomUUID(), url, clock, retainOps = 256, syncBatchSize = 1024, shardMap } = {}) {
    this.id = id;
    this.url = normalizeUrl(url);
    this.db = new Store();
    this.clock = clock || makeClock(id);
    this.log = [];
    this.seq = 0;
    this.trimmed = 0;
    this.retainOps = retainOps;
    this.lastSeen = new Map();
    this.acks = new Map();
    this.peers = [];
    this.shardMap = new ShardMap(shardMap);
    this.syncBatchSize = syncBatchSize;
    this.changeListeners = new Set();
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
      value: withoutId(value),
      ts: this.nextTs(),
    })));
  }

  insert(db, coll, obj) {
    return this.insertMany(db, coll, [obj])[0].id;
  }

  insertMany(db, coll, objects) {
    const items = (objects || []).map((obj = {}) => {
      const id = obj && obj.id ? String(obj.id) : randomUUID();
      return { id, value: withoutId(obj) };
    });
    this._writeMany(db, coll, items);
    return items.map(({ id }) => this.get(db, coll, id) || { id });
  }

  update(db, coll, id, obj) {
    return this.updateMany(db, coll, [{ ...withoutId(obj), id }]).items[0]?.id || id;
  }

  replace(db, coll, id, obj) {
    return this.replaceMany(db, coll, [{ ...withoutId(obj), id }]).items[0]?.id || id;
  }

  remove(db, coll, id) {
    return this.removeMany(db, coll, [id]).deleted === 1;
  }

  replaceMany(db, coll, objects) {
    const items = normalizeObjectsWithIds(objects);
    this._writeMany(db, coll, items.map((object) => ({ id: object.id, value: withoutId(object) })));
    return {
      replaced: items.length,
      items: this.getMany(db, coll, items.map((item) => item.id)),
    };
  }

  updateMany(db, coll, objects) {
    const items = normalizeObjectsWithIds(objects).map((object) => {
      const current = this.get(db, coll, object.id) || { id: object.id };
      return { id: object.id, value: { ...withoutId(current), ...withoutId(object) } };
    });
    this._writeMany(db, coll, items);
    return {
      updated: items.length,
      items: this.getMany(db, coll, items.map((item) => item.id)),
    };
  }

  removeMany(db, coll, ids) {
    const skipped = [];
    const ops = [];
    const seen = new Set();
    for (const rawId of ids || []) {
      const id = String(rawId);
      if (seen.has(id) || !this.db.collection(db, coll).has(id)) {
        skipped.push(id);
        continue;
      }
      seen.add(id);
      ops.push({ kind: "delObj", db, coll, id, ts: this.nextTs() });
    }
    const { applied } = this._commitLocalOps(ops);
    return {
      deleted: applied.length,
      ids: applied.map((op) => op.id),
      skipped,
    };
  }

  get(db, coll, id) {
    return this.db.collection(db, coll).read(id);
  }

  getMany(db, coll, ids) {
    return this.db.readObjects(db, coll, ids);
  }

  list(db, coll) {
    return this.db.collection(db, coll).list();
  }

  find(db, coll, query = {}, options = {}) {
    return this.db.collection(db, coll).find(query, options);
  }

  count(db, coll, query = {}) {
    return this.db.collection(db, coll).count(query);
  }

  aggregate(db, coll, query = {}, spec = {}) {
    return this.db.collection(db, coll).aggregate(query, spec);
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

  async syncPeer(peer, scope) {
    let total = 0;

    for (;;) {
      const key = this._peerKey(peer);
      const cursorKey = this._cursorKey(key, scope);
      const after = this.lastSeen.get(cursorKey) || 0;
      const res = await peer.pull(after, this.syncBatchSize, scope);
      if (!res) return total;

      if (res.status === 410) {
        const snap = await peer.snapshot(scope);
        if (!snap) return total;
        this._bindPeer(peer, snap.node, key);
        const remoteKey = this._cursorKey(snap.node, scope);
        const applied = this.applySnapshot(snap.node, snap, remoteKey);
        await this._ack(peer, snap.lastSeq || 0, scope);
        return total + applied;
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

  async _ack(peer, lastSeq, scope) {
    if (!peer.ack) return;
    try {
      await peer.ack(this.id, lastSeq, scope);
    } catch {
      // ack is best-effort; unpruned ops are safe
    }
  }

  applySnapshot(fromId, snap, cursorKey = fromId) {
    let count = 0;
    for (const c of snap.collections || []) {
      for (const obj of c.objects || []) {
        const coll = this.db.collection(c.db, c.coll);
        if (obj.deleted) {
          if (obj.ts) touch(this.clock, obj.ts);
          touch(this.clock, obj.deleted);
          if (coll.deleteObject(obj.id, obj.deleted)) count++;
        } else if (obj.ts) {
          touch(this.clock, obj.ts);
          if (coll.putObject(obj.id, obj.value || {}, obj.ts)) count++;
        }
      }
    }
    this.lastSeen.set(cursorKey, snap.lastSeq || 0);
    if (count) this._notifyChange({ kind: "snapshot", snapshot: snap });
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

  receiveAck(peerNodeId, after, scope) {
    this.acks.set(this._cursorKey(peerNodeId, scope), Math.min(after, this.seq));
    return this.prune();
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
      this.log.splice(0, removed);
      this.trimmed = cut;
    }
    return removed;
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

  replaceShardMap(shardMap) {
    this.shardMap.replace(shardMap);
    this.peers = this.shardMap.allPeers();
  }

  shardMapSnapshot() {
    return this.shardMap.snapshot();
  }

  shardForObject(database, collection, objectId) {
    return this.shardMap.shardForObject(database, collection, objectId);
  }

  _snapshotCollections(scope) {
    const collections = this.db.snapshot();
    if (!scope) return collections;

    return collections
      .filter((collection) => {
        return (
          (scope.database === GLOBAL_DATABASE || collection.db === scope.database) &&
          (scope.collection === GLOBAL_COLLECTION || collection.coll === scope.collection)
        );
      })
      .map((collection) => ({
        ...collection,
        objects: collection.objects.filter((object) => {
          return this.shardForObject(collection.db, collection.coll, object.id) === scope.shard;
        }),
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

function withoutId(object) {
  const { id, ...rest } = object || {};
  return rest;
}

function normalizeObjectsWithIds(objects) {
  if (!Array.isArray(objects)) throw new TypeError("objects must be an array");
  return objects.map((object, index) => {
    if (!object || typeof object !== "object" || Array.isArray(object)) {
      const err = new TypeError(`item at index ${index} must be an object`);
      err.index = index;
      throw err;
    }
    if (object.id === undefined || object.id === null || String(object.id).length === 0) {
      const err = new TypeError(`item at index ${index} must include id`);
      err.index = index;
      throw err;
    }
    return { ...object, id: String(object.id) };
  });
}

function normalizeUrl(url) {
  return url ? String(url).replace(/\/+$/, "") : null;
}

export function localPeer(node) {
  return {
    key: node.id,
    nodeId: node.id,
    pull: async (after, limit, scope) => {
      if (after < node.trimmed) {
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
    snapshot: async (scope) => node.snapshot(scope),
    ack: async (id, seq, scope) => node.receiveAck(id, seq, scope),
  };
}
