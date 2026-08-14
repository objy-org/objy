import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { ObjectRowStore } from "./object-store.js";
import { ShapeStore } from "./shape.js";
import { gt } from "./clock.js";
import {
  aggregateLegacyObjects,
  aggregateObjects,
  aggregatePartialObjects,
  isObjectDbAggregateSpec,
  mergeAggregatePartials,
} from "./aggregate.js";
import { HNSWIndex } from "./hnsw.js";
import { compareSortValues, getPathValue, matchesQuery, stableKey, stripQueryControls } from "./query.js";
import { AGGREGATE_PATH, planAggregate, planCount, planRead, READ_PATH } from "./query-planner.js";
import { cloneVector, isValidVector, normalizeVectorConfig, rankBySimilarity, VectorIndexWarmingError } from "./vector.js";

const COLUMN_BUILD_BATCH_SIZE = 4096;
const VECTOR_BUILD_BATCH_SIZE = 4096;
const ALL_COUNT_SCOPE = "";

class Collection {
  constructor(name, options = {}) {
    this.name = name;
    this.vectorConfig = normalizeVectorConfig(options.vector);
    this.vectorField = this.vectorConfig.enabled ? this.vectorConfig.field : null;
    this.store = createPhysicalStore(options);
    this.vectors = new Map();
    this.vectorIndexes = new Map();
    this.vectorBuilds = new Set();
    this.meta = new Map();
    this.indexes = new Map();
    this.columnIndexes = new Map();
    this.columnBuilds = new Set();
    this.groupCounts = new GroupCountIndex();
    this.shardIds = new Map();
    this.unshardedLiveCount = 0;
    this.collectionMeta = normalizeCollectionMeta();
    this.liveCount = 0;
  }

  _ensureMeta(id) {
    let m = this.meta.get(id);
    if (!m) {
      m = { ts: null, deleted: null };
      this.meta.set(id, m);
    }
    return m;
  }

  ensure(id, ts) {
    return this.putObjects([{ id, value: {}, ts }]).length === 1;
  }

  putObject(id, value, ts, shard = null) {
    return this.putObjects([{ id, value, ts, shard }]).length === 1;
  }

  putObjects(rows) {
    const applied = [];
    for (const row of rows || []) {
      if (this._putObject(row.id, row.value, row.ts, row.shard)) applied.push(row);
    }
    return applied;
  }

  _putObject(id, value, ts, shard = null) {
    const m = this._ensureMeta(id);
    if (m.deleted && !gt(ts, m.deleted)) return false;
    const wasLive = Boolean(m.ts && !m.deleted);
    const previousShard = wasLive ? m.shard : null;
    const before = wasLive ? this.readForQuery(id) : undefined;
    if (m.ts && !gt(ts, m.ts)) return false;
    const nextShard = normalizeShard(shard) || m.shard || null;
    const prepared = this._prepareStoredValue(value);
    m.ts = ts;
    m.deleted = null;
    m.shard = nextShard;
    this.store.rebuild(id, Object.entries(prepared.value).filter(([key]) => key !== "_id"));
    this._applyVectorUpdate(id, prepared.vector);
    const after = this.readForQuery(id);
    this._refreshIndexes(id, before, after);
    this._refreshColumnIndexes(id, after);
    this._refreshGroupCounts(before, after, previousShard, nextShard);
    if (!wasLive) {
      this.liveCount++;
      this._addShardId(id, nextShard);
    } else if (previousShard !== nextShard) {
      this._removeShardId(id, previousShard);
      this._addShardId(id, nextShard);
    }
    return true;
  }

  deleteObject(id, ts, shard = null) {
    return this.deleteObjects([{ id, ts, shard }]).length === 1;
  }

  deleteObjects(rows) {
    const applied = [];
    for (const row of rows || []) {
      if (this._deleteObject(row.id, row.ts, row.shard)) applied.push(row);
    }
    return applied;
  }

  _deleteObject(id, ts, shard = null) {
    const m = this._ensureMeta(id);
    const last = m.deleted || m.ts;
    if (last && !gt(ts, last)) return false;
    const wasLive = Boolean(m.ts && !m.deleted);
    const previousShard = wasLive ? m.shard : null;
    const before = wasLive ? this.readForQuery(id) : undefined;
    m.deleted = ts;
    if (shard) m.shard = normalizeShard(shard);
    this.store.removeObject(id);
    this._removeVector(id);
    this._refreshIndexes(id, before, undefined);
    this._refreshColumnIndexes(id, undefined);
    this._refreshGroupCounts(before, undefined, previousShard, null);
    if (wasLive) {
      this.liveCount--;
      this._removeShardId(id, previousShard);
    }
    return true;
  }

  read(id) {
    const m = this.meta.get(id);
    if (!m || m.deleted) return undefined;
    const vals = this.store.read(id) || {};
    return { ...vals, _id: id };
  }

  readForQuery(id) {
    const m = this.meta.get(id);
    if (!m || m.deleted) return undefined;
    const vals = typeof this.store.readForQuery === "function"
      ? this.store.readForQuery(id) || {}
      : this.store.read(id) || {};
    return { ...vals, _id: id };
  }

  readObjects(ids) {
    return (ids || []).map((id) => this.read(id)).filter(Boolean);
  }

  has(id) {
    const m = this.meta.get(id);
    return !!m && !m.deleted;
  }

  list(options = {}) {
    return this.find({}, options);
  }

  find(query = {}, options = {}) {
    const criteria = stripQueryControls(query);
    const offset = options.offset || 0;
    const limit = options.limit ?? Infinity;
    const includeId = typeof options.includeId === "function" ? options.includeId : null;
    const plan = this._planRead(criteria, options);

    if (!options.sortBy) {
      if (limit <= 0) return [];
      const results = [];
      let skipped = 0;
      const verifyScan = plan.path === READ_PATH.SCAN && !isEmptyCriteria(criteria);
      for (const id of this._idsForPlan(plan.idPlan, criteria)) {
        if (includeId && !includeId(id)) continue;
        if (verifyScan) {
          const obj = this.readForQuery(id);
          if (!obj || !matchesQuery(obj, criteria)) continue;
        }
        if (skipped < offset) {
          skipped++;
          continue;
        }
        const safe = this.read(id);
        if (safe) results.push(safe);
        if (results.length >= limit) break;
      }
      return results;
    }

    const indexed = plan.path === READ_PATH.ORDERED_INDEX ? this._findWithOrderedIndex(criteria, options, plan) : null;
    if (indexed) return indexed;

    const matched = [];
    for (const id of this._idsForPlan(plan.idPlan, criteria)) {
      if (includeId && !includeId(id)) continue;
      const obj = this.readForQuery(id);
      if (obj && matchesQuery(obj, criteria)) matched.push(obj);
    }
    return sortObjects(matched, options)
      .slice(offset, offset + limit)
      .map((obj) => this.read(obj._id))
      .filter(Boolean);
  }

  all(options = {}) {
    return this.find({}, options);
  }

  findForQuery(query = {}, options = {}) {
    const criteria = stripQueryControls(query);
    const offset = options.offset || 0;
    const limit = options.limit ?? Infinity;
    const includeId = typeof options.includeId === "function" ? options.includeId : null;
    const plan = this._planRead(criteria, options);

    if (!options.sortBy) {
      if (limit <= 0) return [];
      const results = [];
      let skipped = 0;
      const verifyScan = plan.path === READ_PATH.SCAN && !isEmptyCriteria(criteria);
      for (const id of this._idsForPlan(plan.idPlan, criteria)) {
        if (includeId && !includeId(id)) continue;
        const object = this.readForQuery(id);
        if (!object) continue;
        if (verifyScan && !matchesQuery(object, criteria)) continue;
        if (skipped < offset) {
          skipped++;
          continue;
        }
        results.push(object);
        if (results.length >= limit) break;
      }
      return results;
    }

    const matched = [];
    for (const id of this._idsForPlan(plan.idPlan, criteria)) {
      if (includeId && !includeId(id)) continue;
      const object = this.readForQuery(id);
      if (object && matchesQuery(object, criteria)) matched.push(object);
    }
    return sortObjects(matched, options).slice(offset, offset + limit);
  }

  count(query = {}, options = {}) {
    const criteria = stripQueryControls(query);
    const includeId = typeof options.includeId === "function" ? options.includeId : null;
    const includeIds = options.includeIds instanceof Set ? options.includeIds : null;
    if (!criteria || Object.keys(criteria).length === 0) {
      if (includeIds && includeId) {
        let n = 0;
        for (const id of includeIds) if (includeId(id)) n++;
        return n;
      }
      if (includeIds) return includeIds.size;
      if (includeId) {
        let n = 0;
        for (const [id, m] of this.meta) if (!m.deleted && includeId(id)) n++;
        return n;
      }
      return this.liveCount;
    }
    const plan = this._planCount(criteria, options);
    if (plan.path === READ_PATH.INDEX_EXACT && !plan.idPlan?.verify) {
      if (includeIds && includeId) {
        let n = 0;
        for (const id of smallerSet(plan.idPlan.ids, includeIds)) {
          if (plan.idPlan.ids.has(id) && includeIds.has(id) && includeId(id)) n++;
        }
        return n;
      }
      if (includeIds) return countIntersection(plan.idPlan.ids, includeIds);
      if (!includeId) return plan.idPlan.ids.size;
      let n = 0;
      for (const id of plan.idPlan.ids) if (includeId(id)) n++;
      return n;
    }

    let n = 0;
    const verifyScan = plan.path === READ_PATH.SCAN && !isEmptyCriteria(criteria);
    for (const id of this._idsForPlan(plan.idPlan, criteria)) {
      if (includeIds && !includeIds.has(id)) continue;
      if (includeId && !includeId(id)) continue;
      if (verifyScan) {
        const obj = this.readForQuery(id);
        if (!obj || !matchesQuery(obj, criteria)) continue;
      }
      n++;
    }
    return n;
  }

  aggregate(query = {}, spec = {}, options = {}) {
    if (isObjectDbAggregateSpec(spec)) {
      const criteria = stripQueryControls(query);
      const indexed = this._executeAggregatePlan(this._planAggregate(criteria, spec, options), criteria, spec, options);
      if (indexed) return indexed;

      const rows = this.findForQuery(criteria, options);
      return spec?.$partial === true ? aggregatePartialObjects(rows, spec) : aggregateObjects(rows, spec);
    }

    return aggregateLegacyObjects(this.findForQuery(query, options), spec);
  }

  createIndex(path) {
    const key = String(path);
    const index = new FieldIndex(key);
    for (const id of this._liveIdIterator()) {
      const object = this.readForQuery(id);
      index.add(object);
    }
    this.indexes.set(key, index);
    this.collectionMeta = normalizeCollectionMeta({
      ...this.collectionMeta,
      indexes: unique([...this.collectionMeta.indexes, key]),
    });
    this._rebuildGroupCounts();
  }

  dropIndex(path) {
    const key = String(path);
    const removed = this.indexes.delete(key);
    this.collectionMeta = normalizeCollectionMeta({
      ...this.collectionMeta,
      indexes: this.collectionMeta.indexes.filter((index) => index !== key),
    });
    this._rebuildGroupCounts();
    return removed;
  }

  getMeta() {
    return clone(this.collectionMeta);
  }

  setMeta(meta = {}) {
    this.collectionMeta = normalizeCollectionMeta(meta);
    this._applyMetaIndexes();
    this._applyMetaColumnIndexes();
    return this.getMeta();
  }

  indexStats() {
    return [
      ...[...this.indexes.entries()].map(([path, index]) => ({
        type: "field",
        path,
        keys: index.lookupKeys,
        entries: index.lookupEntries,
        orderedKeys: index.orderedKeys,
        orderedEntries: index.orderedEntries,
      })),
      ...[...this.columnIndexes.entries()].map(([path, index]) => ({
        type: "column",
        path,
        status: index.status,
        entries: index.entries,
        scalarEntries: index.scalarEntries,
        nonScalarEntries: index.nonScalarEntries,
        pendingEntries: index.pendingEntries,
        ...(index.error ? { error: index.error } : {}),
      })),
      {
        type: "aggregateCount",
        status: "ready",
        fields: this.groupCounts.fieldCount,
        pairs: this.groupCounts.pairCount,
        entries: this.groupCounts.entries,
      },
    ];
  }

  async awaitColumnIndexes() {
    for (;;) {
      const builds = [...this.columnBuilds];
      if (!builds.length) return;
      await Promise.allSettled(builds);
    }
  }

  shapeStats() {
    return this.store.shapeStats();
  }

  *snapshotObjects({ includeId } = {}) {
    const allow = typeof includeId === "function" ? includeId : () => true;
    for (const [id, m] of this.meta) {
      if (!allow(id)) continue;
      if (m.deleted) {
        yield { id, ts: m.ts, deleted: m.deleted, ...(m.shard ? { shard: m.shard } : {}) };
        continue;
      }
      const value = this.store.read(id) || {};
      const vector = this.getVector(id);
      if (vector && this.vectorField) value[this.vectorField] = vector;
      yield { id, ts: m.ts, deleted: null, value, ...(m.shard ? { shard: m.shard } : {}) };
    }
  }

  getVector(id) {
    const vector = this.vectors.get(String(id));
    return vector ? [...vector] : null;
  }

  preserveVector(id, value = {}) {
    if (!this.vectorField || Object.prototype.hasOwnProperty.call(value || {}, this.vectorField)) return value;
    const vector = this.getVector(id);
    return vector ? { ...value, [this.vectorField]: vector } : value;
  }

  validateWriteValue(value = {}) {
    this._extractVector(value);
    return value;
  }

  vectorSearch(queryVec, limit = 20, options = {}) {
    if (!this.vectorField || !isValidVector(queryVec)) return [];
    if (this.vectors.size === 0) return [];
    const index = this._readyVectorIndex(options.indexKey || "all", options.includeId);
    const k = Math.max(0, Number.isFinite(limit) ? Math.floor(limit) : 20);
    if (k <= 0) return [];
    return index.search(queryVec, k, options.ef).map(({ id, dist }) => ({
      _id: id,
      dist,
      _score: 1 - dist,
    }));
  }

  rankVectorRows(rows, queryVec, limit = 20) {
    return rankBySimilarity(rows, queryVec, {
      limit,
      getVec: (id) => this.getVector(id),
      idOf: (row) => row?._id,
    });
  }

  vectorStats() {
    let nodes = 0;
    const entries = [];
    for (const [key, entry] of this.vectorIndexes) {
      nodes += entry.index.size;
      entries.push({
        key,
        status: entry.status,
        nodes: entry.index.size,
        scanned: entry.scanned,
        inserted: entry.inserted,
        ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
        ...(entry.readyAt ? { readyAt: entry.readyAt } : {}),
        ...(entry.error ? { error: entry.error } : {}),
      });
    }
    return {
      field: this.vectorField,
      stored: this.vectors.size,
      indexes: this.vectorIndexes.size,
      nodes,
      status: this._vectorIndexStatus(),
      indexStates: entries,
    };
  }

  indexReadiness() {
    const fieldIndexes = this.collectionMeta.indexes.map((path) => ({
      path,
      status: this.indexes.has(path) ? "ready" : "missing",
    }));
    const columnIndexes = this.collectionMeta.columnIndexes.map((path) => {
      const index = this.columnIndexes.get(path);
      return {
        path,
        status: index?.status || "missing",
        pendingEntries: index?.pendingEntries || 0,
        ...(index?.error ? { error: index.error } : {}),
      };
    });
    const vector = this.vectorStats();
    const workers = {
      columnIndex: {
        type: "worker_thread",
        active: this.columnBuilds.size,
        background: true,
      },
      vectorIndex: {
        type: "same_thread_task",
        active: this.vectorBuilds.size,
        background: true,
      },
    };

    return {
      status: overallIndexStatus([
        ...fieldIndexes.map((index) => index.status),
        ...columnIndexes.map((index) => index.status),
        vector.status,
      ]),
      fieldIndexes,
      columnIndexes,
      vector,
      workers,
    };
  }

  clearVectorIndexes() {
    this.vectorIndexes.clear();
    this.vectorBuilds.clear();
  }

  assertVectorIndexReady(key = "all", includeId = null) {
    if (!this.vectorField || this.vectors.size === 0) return true;
    this._readyVectorIndex(key, includeId);
    return true;
  }

  warmVectorIndex(key = "all", includeId = null) {
    if (!this.vectorField || this.vectors.size === 0) return Promise.resolve(null);
    const indexKey = String(key || "all");
    const current = this.vectorIndexes.get(indexKey);
    if (current?.status === "ready") return Promise.resolve(current);
    if (current?.status === "building" && current.promise) return current.promise;
    return this._startVectorIndexWarmup(indexKey, includeId);
  }

  async awaitVectorIndexes() {
    for (;;) {
      const builds = [...this.vectorBuilds];
      if (!builds.length) return;
      await Promise.allSettled(builds);
    }
  }

  snapshot(options = {}) {
    const out = [];
    for (const object of this.snapshotObjects(options)) out.push(object);
    return out;
  }

  *_liveIdIterator() {
    for (const [id, m] of this.meta) {
      if (!m.deleted) yield id;
    }
  }

  _planRead(criteria, options = {}) {
    return planRead(criteria, options, this._plannerAdapter());
  }

  _planCount(criteria, options = {}) {
    return planCount(criteria, options, this._plannerAdapter());
  }

  _planAggregate(criteria, spec, options = {}) {
    return planAggregate(criteria, spec, options, this._plannerAdapter());
  }

  readPath(criteria = {}, options = {}) {
    return this._planRead(stripQueryControls(criteria), options).path;
  }

  aggregatePath(criteria = {}, spec = {}, options = {}) {
    if (!isObjectDbAggregateSpec(spec)) return AGGREGATE_PATH.SCAN;
    return this._planAggregate(stripQueryControls(criteria), spec, options).path;
  }

  _plannerAdapter() {
    return {
      idsForCriteria: (criteria) => this._idsForCriteria(criteria),
      partialIdsForCriteria: (criteria) => this._partialIdsForCriteria(criteria),
      hasOrderedIndex: (path) => this.indexes.has(String(path)),
      hasGroupIndex: (path) => this.indexes.has(String(path)),
      hasGroupForwardIndex: (path) => this.indexes.get(String(path))?.canReadValuesById === true,
      fieldIndex: (path) => this.indexes.get(String(path)) || null,
      columnIndex: (path) => this.columnIndexes.get(String(path)) || null,
      groupCountIndex: (criteria, groupBy, options) => this._groupCountPlan(criteria, groupBy, options),
      idsForAll: (includeId) => this._idSetForAll(includeId),
      filterIds: (ids, includeId) => filterIds(ids, includeId),
    };
  }

  _groupCountPlan(criteria, groupBy, options = {}) {
    return this.groupCounts.plan(criteria, groupBy, {
      indexes: this.indexes,
      scopeShards: options.scopeShards,
    });
  }

  _idSetForAll(includeId = null) {
    const ids = new Set();
    for (const [id, m] of this.meta) {
      if (!m.deleted && (!includeId || includeId(id))) ids.add(id);
    }
    return ids;
  }

  idsForShards(shards = []) {
    if (this.unshardedLiveCount > 0) return null;
    const names = [...new Set((shards || []).map(normalizeShard).filter(Boolean))];
    if (!names.length) return null;
    if (names.length === 1) return this.shardIds.get(names[0]) || new Set();
    let ids = new Set();
    for (const shard of names) ids = setUnion(ids, this.shardIds.get(shard) || new Set());
    return ids;
  }

  *_idsForPlan(idPlan, criteria = {}) {
    const ids = idPlan?.ids === null || idPlan?.ids === undefined
      ? this._liveIdIterator()
      : idPlan.ids;
    for (const id of ids) {
      if (idPlan?.scopeIds && !idPlan.scopeIds.has(id)) continue;
      if (!idPlan?.verify) {
        yield id;
        continue;
      }
      const object = this.readForQuery(id);
      if (object && matchesQuery(object, criteria)) yield id;
    }
  }

  _idSetForPlan(idPlan, criteria = {}) {
    if (!idPlan || idPlan.ids === null) return null;
    if (!idPlan.verify) return idPlan.scopeIds ? setIntersection(idPlan.ids, idPlan.scopeIds) : idPlan.ids;
    const ids = new Set();
    for (const id of this._idsForPlan(idPlan, criteria)) ids.add(id);
    return ids;
  }

  _planIndexedIds(query) {
    if (!query || Object.keys(query).length === 0) return null;
    const exact = this._idsForCriteria(query);
    if (exact) return { ids: exact, exact: true };
    const partial = this._partialIdsForCriteria(query);
    return partial ? { ids: partial, exact: false } : null;
  }

  _idsForCriteria(query) {
    const entries = Object.entries(query || {});
    if (!entries.length) return null;

    let current = null;
    for (const [path, expected] of entries) {
      let ids = null;

      if (path === "$and" && Array.isArray(expected)) {
        const childSets = expected
          .filter((child) => !isEmptyCriteria(child))
          .map((child) => this._idsForCriteria(child));
        if (childSets.some((set) => set === null)) return null;
        ids = childSets.length ? childSets.reduce((left, right) => setIntersection(left, right)) : null;
      } else if (path === "$or" && Array.isArray(expected)) {
        const childSets = expected.map((child) => this._idsForCriteria(child));
        if (childSets.some((set) => set === null)) return null;
        ids = childSets.length ? childSets.reduce((left, right) => setUnion(left, right)) : new Set();
      } else if (path.startsWith("$")) {
        return null;
      } else {
        ids = this._idsForFieldConstraint(path, expected);
        if (ids === null) return null;
      }

      if (ids === null) continue;
      current = current === null ? ids : setIntersection(current, ids);
    }

    return current;
  }

  _partialIdsForCriteria(query) {
    const entries = Object.entries(query || {});
    if (!entries.length) return null;

    let current = null;
    for (const [path, expected] of entries) {
      if (path === "$and" && Array.isArray(expected)) {
        for (const child of expected) {
          if (isEmptyCriteria(child)) continue;
          const ids = this._idsForCriteria(child) || this._partialIdsForCriteria(child);
          if (ids) current = current === null ? ids : setIntersection(current, ids);
        }
        continue;
      }

      if (path === "$or" && Array.isArray(expected)) {
        const ids = this._idsForCriteria({ $or: expected });
        if (ids) current = current === null ? ids : setIntersection(current, ids);
        continue;
      }

      if (path.startsWith("$")) continue;

      const ids = this._idsForFieldConstraint(path, expected);
      if (ids !== null) current = current === null ? ids : setIntersection(current, ids);
    }

    return current;
  }

  _idsForFieldConstraint(path, expected) {
    if (path === "_id") return this._idsForObjectIdConstraint(expected);

    const index = this.indexes.get(path);
    if (!index) return null;

    const containsValue = indexableContainsValue(expected);
    if (containsValue !== null) return index.idsForContains(containsValue);

    const values = indexableConstraintValues(expected);
    if (values === null) return null;
    return index.idsForValues(values);
  }

  _idsForObjectIdConstraint(expected) {
    const values = indexableConstraintValues(expected);
    if (values === null) return null;

    const ids = new Set();
    for (const value of values) {
      const id = String(value);
      if (this.has(id)) ids.add(id);
    }
    return ids;
  }

  *_candidateIds(query) {
    if (!query || Object.keys(query).length === 0) {
      for (const [id, m] of this.meta) if (!m.deleted) yield id;
      return;
    }
    const plan = this._planIndexedIds(query);
    yield* (plan?.ids || this._liveIdIterator());
  }

  _refreshIndexes(id, before, after) {
    if (!this.indexes.size) return;
    if (before) this._removeFromIndexes(id, before);
    if (after) this._addToIndexes(after);
  }

  _refreshColumnIndexes(id, after) {
    if (!this.columnIndexes.size) return;
    for (const index of this.columnIndexes.values()) {
      if (after) index.updateFromObject(after);
      else index.remove(id);
    }
  }

  _refreshGroupCounts(before, after, beforeShard, afterShard) {
    if (!this.groupCounts.fieldCount) return;
    if (before) this.groupCounts.remove(before, beforeShard);
    if (after) this.groupCounts.add(after, afterShard);
  }

  _addToIndexes(object) {
    for (const index of this.indexes.values()) index.add(object);
  }

  _removeFromIndexes(id, object) {
    for (const index of this.indexes.values()) index.remove(id, object);
  }

  _addShardId(id, shard) {
    if (!shard) {
      this.unshardedLiveCount++;
      return;
    }
    const key = String(shard);
    const ids = this.shardIds.get(key) || new Set();
    ids.add(String(id));
    this.shardIds.set(key, ids);
  }

  _removeShardId(id, shard) {
    if (!shard) {
      if (this.unshardedLiveCount > 0) this.unshardedLiveCount--;
      return;
    }
    const ids = this.shardIds.get(String(shard));
    ids?.delete(String(id));
    if (ids?.size === 0) this.shardIds.delete(String(shard));
  }

  _applyMetaIndexes() {
    const wanted = new Set(this.collectionMeta.indexes);
    for (const path of [...this.indexes.keys()]) {
      if (!wanted.has(path)) this.indexes.delete(path);
    }
    for (const path of wanted) {
      if (!this.indexes.has(path)) this._createIndexFromMeta(path);
    }
    this._rebuildGroupCounts();
  }

  _createIndexFromMeta(path) {
    const index = new FieldIndex(path);
    for (const id of this._liveIdIterator()) {
      const object = this.readForQuery(id);
      index.add(object);
    }
    this.indexes.set(path, index);
  }

  _rebuildGroupCounts() {
    this.groupCounts.reset([...this.indexes.keys()]);
    if (!this.groupCounts.fieldCount) return;
    for (const id of this._liveIdIterator()) {
      const object = this.readForQuery(id);
      if (object) this.groupCounts.add(object, this.meta.get(id)?.shard || null);
    }
  }

  _applyMetaColumnIndexes() {
    const wanted = new Set(this.collectionMeta.columnIndexes);
    for (const path of [...this.columnIndexes.keys()]) {
      if (!wanted.has(path)) this.columnIndexes.delete(path);
    }

    const toBuild = [];
    for (const path of wanted) {
      if (this.columnIndexes.has(path)) continue;
      const index = new ColumnIndex(path);
      this.columnIndexes.set(path, index);
      if (this.liveCount === 0) index.install(new Map(), new Set(), index.buildId);
      else toBuild.push(path);
    }

    if (toBuild.length) this._startColumnIndexBuild(toBuild);
  }

  _startColumnIndexBuild(paths) {
    const targets = [];
    for (const path of paths) {
      const index = this.columnIndexes.get(path);
      if (!index) continue;
      const buildId = index.startBuild();
      targets.push({ path, buildId });
    }
    if (!targets.length) return null;

    const build = this._runColumnIndexBuild(targets);
    this.columnBuilds.add(build);
    build.then(
      () => this.columnBuilds.delete(build),
      () => this.columnBuilds.delete(build),
    );
    return build;
  }

  async _runColumnIndexBuild(targets) {
    const paths = targets.map((target) => target.path);
    const built = new Map(paths.map((path) => [path, { values: new Map(), nonScalar: new Set() }]));
    const worker = new Worker(new URL("./column-index-worker.js", import.meta.url), {
      workerData: { paths },
    });
    const ackResolvers = [];
    let settled = false;

    const done = new Promise((resolve, reject) => {
      worker.on("message", (message = {}) => {
        if (message.type === "batch-ack") {
          const resolveAck = ackResolvers.shift();
          if (resolveAck) resolveAck();
          return;
        }

        if (message.type === "values-batch") {
          const column = built.get(message.path);
          if (column) for (const [id, value] of message.entries || []) column.values.set(String(id), value);
          return;
        }

        if (message.type === "non-scalar-batch") {
          const column = built.get(message.path);
          if (column) for (const id of message.ids || []) column.nonScalar.add(String(id));
          return;
        }

        if (message.type === "done") {
          settled = true;
          resolve();
        }
      });
      worker.once("error", (error) => {
        settled = true;
        reject(error);
      });
      worker.once("exit", (code) => {
        if (!settled && code !== 0) reject(new Error(`column index worker exited with code ${code}`));
      });
    });

    try {
      let rows = [];
      for (const id of this._liveIdIterator()) {
        const object = this.readForQuery(id);
        if (object) rows.push(columnWorkerRow(object, paths));
        if (rows.length < COLUMN_BUILD_BATCH_SIZE) continue;
        await postWorkerBatch(worker, ackResolvers, rows);
        rows = [];
        await yieldToEventLoop();
      }
      if (rows.length) await postWorkerBatch(worker, ackResolvers, rows);

      worker.postMessage({ type: "finish" });
      await done;

      for (const { path, buildId } of targets) {
        const index = this.columnIndexes.get(path);
        const column = built.get(path);
        if (index && column) index.install(column.values, column.nonScalar, buildId);
      }
    } catch (error) {
      for (const { path, buildId } of targets) {
        const index = this.columnIndexes.get(path);
        if (index) index.fail(error, buildId);
      }
    } finally {
      await worker.terminate().catch(() => {});
    }
  }

  _executeAggregatePlan(plan, criteria, spec) {
    switch (plan.path) {
      case AGGREGATE_PATH.COLUMN_SUMMARY:
        return this._aggregateFlatFromColumnSummary(spec, plan.normalized, plan.columns);
      case AGGREGATE_PATH.COLUMN_SCAN:
        return finishFlatColumnAggregate(
          scanFlatColumnAggregate(this._idsForPlan(plan.idPlan, criteria), plan.normalized, plan.columns),
          spec,
          plan.normalized,
        );
      case AGGREGATE_PATH.GROUP_COUNT_INDEX:
        return this._aggregateGroupCountIndex(plan, spec);
      case AGGREGATE_PATH.GROUP_FORWARD_INDEX:
        return this._aggregateGroupForwardIndex(plan, criteria, spec);
      case AGGREGATE_PATH.GROUP_INDEX:
        return this._aggregateGroupIndex(plan, criteria, spec);
      case AGGREGATE_PATH.GROUP_COLUMN_SCAN: {
        const grouped = scanGroupedColumnAggregate(this._idsForPlan(plan.idPlan, criteria), plan.normalized, plan.columns);
        return grouped ? finishGroupedColumnAggregate(grouped, spec, plan.normalized) : null;
      }
      default:
        return null;
    }
  }

  _aggregateFlatFromColumnSummary(spec, normalized, columns) {
    if (this.liveCount === 0) return [];

    const state = {};
    for (const field of normalized.fields) {
      switch (field.operator) {
        case "$sum": {
          state[field.resultKey] = { sum: columns.get(field.operand).numberSum };
          break;
        }
        case "$avg": {
          const column = columns.get(field.operand);
          state[field.resultKey] = { sum: column.numberSum, count: column.numberCount };
          break;
        }
        case "$count": {
          state[field.resultKey] = { count: field.operand === true ? this.liveCount : columns.get(field.operand).entries };
          break;
        }
      }
    }

    return finishFlatColumnAggregate({ rowsSeen: this.liveCount, state }, spec, normalized);
  }

  _aggregateGroupIndex(plan, criteria, spec) {
    const groups = [];
    let rowsSeen = 0;

    if (isRowCountOnlyAggregate(plan.normalized)) {
      const filterIds = plan.idPlan?.verify ? this._idSetForPlan(plan.idPlan, criteria) : plan.idPlan?.ids || null;
      const scopeIds = plan.idPlan?.verify ? null : plan.idPlan?.scopeIds || null;
      for (const [groupValue, count] of plan.groupIndex.iterateGroupCounts(filterIds, scopeIds)) {
        if (count <= 0) continue;
        rowsSeen += count;
        groups.push({
          groupValues: { [plan.groupBy]: groupValue === undefined ? null : groupValue },
          state: rowCountOnlyState(plan.normalized, count),
        });
      }
      return finishGroupedColumnAggregate({ rowsSeen, groups }, spec, plan.normalized);
    }

    const filterIds = this._idSetForPlan(plan.idPlan, criteria);
    for (const [groupValue, ids] of plan.groupIndex.iterateGroups(filterIds)) {
      const scanned = scanFlatColumnAggregate(ids, plan.normalized, plan.columns);
      if (!scanned.rowsSeen) continue;
      rowsSeen += scanned.rowsSeen;
      groups.push({
        groupValues: { [plan.groupBy]: groupValue === undefined ? null : groupValue },
        state: scanned.state,
      });
    }

    return finishGroupedColumnAggregate({ rowsSeen, groups }, spec, plan.normalized);
  }

  _aggregateGroupForwardIndex(plan, criteria, spec) {
    const grouped = scanForwardGroupedColumnAggregate(
      this._idsForPlan(plan.idPlan, criteria),
      plan.normalized,
      plan.groupBy,
      plan.groupIndex,
      plan.columns,
    );
    return finishGroupedColumnAggregate(grouped, spec, plan.normalized);
  }

  _aggregateGroupCountIndex(plan, spec) {
    const groups = [];
    let rowsSeen = 0;
    for (const [groupValue, count] of this.groupCounts.counts(plan.groupCountIndex)) {
      if (count <= 0) continue;
      rowsSeen += count;
      groups.push({
        groupValues: { [plan.groupBy]: groupValue === undefined ? null : groupValue },
        state: rowCountOnlyState(plan.normalized, count),
      });
    }
    return finishGroupedColumnAggregate({ rowsSeen, groups }, spec, plan.normalized);
  }

  _findWithOrderedIndex(criteria, options, plan = this._planRead(criteria, options)) {
    const index = this.indexes.get(String(options.sortBy));
    if (!index) return null;
    const filterProven = Boolean(plan.idPlan && !plan.idPlan.verify && plan.path !== READ_PATH.SCAN);
    return index.find({
      candidateIds: plan.idPlan?.ids || null,
      includeId: typeof options.includeId === "function" ? options.includeId : null,
      desc: options.sort === "desc",
      offset: options.offset || 0,
      limit: options.limit ?? Infinity,
      read: (id) => this.readForQuery(id),
      matches: (object) => filterProven ? true : matchesQuery(object, criteria),
    }).map((object) => this.read(object._id)).filter(Boolean);
  }

  _prepareStoredValue(value = {}) {
    const extracted = this._extractVector(value);
    return {
      value: extracted.value,
      vector: extracted.vector,
    };
  }

  _extractVector(value = {}) {
    const source = value || {};
    if (!this.vectorField || !Object.prototype.hasOwnProperty.call(source, this.vectorField)) {
      return { value: source, vector: { present: false } };
    }

    const { [this.vectorField]: rawVector, ...rest } = source;
    if (rawVector === null) return { value: rest, vector: { present: true, remove: true } };
    const vector = cloneVector(rawVector);
    if (!vector) throw new TypeError(`${this.vectorField} must be an array of finite numbers`);
    return { value: rest, vector: { present: true, value: vector } };
  }

  _applyVectorUpdate(id, vector) {
    if (!this.vectorField) return;
    if (vector.present && !vector.remove) {
      this._setVector(id, vector.value);
      return;
    }
    this._removeVector(id);
  }

  _setVector(id, vector) {
    const key = String(id);
    this.vectors.set(key, [...vector]);
    for (const entry of this.vectorIndexes.values()) {
      if (entry.status === "failed") continue;
      if (!entry.includeId || entry.includeId(key)) entry.index.insert(key, vector);
    }
  }

  _removeVector(id) {
    const key = String(id);
    this.vectors.delete(key);
    for (const entry of this.vectorIndexes.values()) {
      if (entry.status !== "failed") entry.index.remove(key);
    }
  }

  _readyVectorIndex(key = "all", includeId = null) {
    const indexKey = String(key || "all");
    const entry = this.vectorIndexes.get(indexKey);
    if (entry?.status === "ready") return entry.index;
    if (!entry || entry.status === "failed") this._startVectorIndexWarmup(indexKey, includeId);
    throw new VectorIndexWarmingError({
      collection: this.name,
      indexKey,
      indexStatus: this.vectorIndexes.get(indexKey)?.status || "pending",
    });
  }

  _startVectorIndexWarmup(key = "all", includeId = null) {
    const indexKey = String(key || "all");
    const filter = typeof includeId === "function" ? includeId : null;
    const index = new HNSWIndex({
      ...this.vectorConfig.hnsw,
      getVec: (id) => this.vectors.get(String(id)) || null,
    });
    const entry = {
      index,
      includeId: filter,
      status: "building",
      startedAt: new Date().toISOString(),
      readyAt: null,
      error: null,
      scanned: 0,
      inserted: 0,
      promise: null,
    };
    this.vectorIndexes.set(indexKey, entry);
    const build = this._runVectorIndexBuild(indexKey, entry);
    entry.promise = build;
    this.vectorBuilds.add(build);
    build.then(
      () => this.vectorBuilds.delete(build),
      () => this.vectorBuilds.delete(build),
    );
    return build;
  }

  async _runVectorIndexBuild(indexKey, entry) {
    await yieldToEventLoop();
    try {
      for (const [id, vector] of this.vectors) {
        entry.scanned++;
        if (!entry.includeId || entry.includeId(id)) {
          entry.index.insert(id, vector);
          entry.inserted++;
        }
        if (entry.scanned % VECTOR_BUILD_BATCH_SIZE === 0) await yieldToEventLoop();
      }
      if (this.vectorIndexes.get(indexKey) === entry) {
        entry.status = "ready";
        entry.readyAt = new Date().toISOString();
      }
      return entry;
    } catch (error) {
      if (this.vectorIndexes.get(indexKey) === entry) {
        entry.status = "failed";
        entry.error = error.message;
      }
      throw error;
    }
  }

  _vectorIndexStatus() {
    if (!this.vectorField) return "disabled";
    if (this.vectors.size === 0) return "ready";
    const entries = [...this.vectorIndexes.values()];
    if (!entries.length) return "pending";
    if (entries.some((entry) => entry.status === "failed")) return "failed";
    if (entries.some((entry) => entry.status === "building")) return "building";
    return "ready";
  }
}

function createPhysicalStore(options = {}) {
  const engine = options.engine || "shape";
  if (engine === "shape") return new ShapeStore();
  if (engine === "object") return new ObjectRowStore(options.object);
  throw new TypeError(`unsupported storage engine: ${engine}`);
}

class FieldIndex {
  constructor(path) {
    this.path = String(path);
    this.lookup = new Map();
    this.ordered = new Map();
    this.forward = new Map();
    this.containsStringIds = new Set();
    this.containsScalarIds = new Set();
    this.containsNestedArrayIds = new Set();
    this.sortedOrderedKeys = null;
  }

  get canReadValuesById() {
    return true;
  }

  get lookupKeys() {
    return this.lookup.size;
  }

  get lookupEntries() {
    return [...this.lookup.values()].reduce((sum, ids) => sum + ids.size, 0);
  }

  get orderedKeys() {
    return this.ordered.size;
  }

  get orderedEntries() {
    return [...this.ordered.values()].reduce((sum, bucket) => sum + bucket.ids.size, 0);
  }

  add(object) {
    if (!object?._id) return;
    const value = getPathValue(object, this.path);
    this.forward.set(object._id, value);
    for (const key of indexedStoredValues(value).map(indexValueKey)) {
      const ids = this.lookup.get(key) || new Set();
      ids.add(object._id);
      this.lookup.set(key, ids);
    }
    this._addOrdered(object._id, value);
    this._addContainsState(object._id, value);
  }

  remove(id, object) {
    const value = getPathValue(object, this.path);
    this.forward.delete(id);
    for (const key of indexedStoredValues(value).map(indexValueKey)) {
      const ids = this.lookup.get(key);
      ids?.delete(id);
      if (ids?.size === 0) this.lookup.delete(key);
    }
    this._removeOrdered(id, value);
    this._removeContainsState(id, value);
  }

  idsForValues(values) {
    const unique = uniqueIndexValues(values);
    if (unique.length === 1) return this.lookup.get(indexValueKey(unique[0])) || new Set();

    let ids = new Set();
    for (const value of unique) {
      ids = setUnion(ids, this.lookup.get(indexValueKey(value)) || new Set());
    }
    return ids;
  }

  idsForContains(value) {
    if (!isScalarIndexValue(value)) return null;
    if (this.containsStringIds.size || this.containsScalarIds.size || this.containsNestedArrayIds.size) return null;
    return this.lookup.get(indexValueKey(value)) || new Set();
  }

  valueForId(id) {
    return this.forward.get(id);
  }

  *iterateGroups(filterIds = null) {
    for (const bucket of this.ordered.values()) {
      const ids = filterIds ? setIntersection(filterIds, bucket.ids) : bucket.ids;
      if (ids.size > 0) yield [bucket.value, ids];
    }
  }

  *iterateGroupCounts(filterIds = null, scopeIds = null) {
    for (const bucket of this.ordered.values()) {
      const count = countIntersectingSets(bucket.ids, filterIds, scopeIds);
      if (count > 0) yield [bucket.value, count];
    }
  }

  find({ candidateIds, includeId, desc = false, offset = 0, limit = Infinity, read, matches }) {
    if (limit <= 0) return [];
    const results = [];
    let skipped = 0;
    for (const id of this.orderedIds(desc)) {
      if (candidateIds && !candidateIds.has(id)) continue;
      if (includeId && !includeId(id)) continue;
      const object = read(id);
      if (!object || !matches(object)) continue;
      if (skipped < offset) {
        skipped++;
        continue;
      }
      results.push(object);
      if (results.length >= limit) break;
    }
    return results;
  }

  *orderedIds(desc = false) {
    const keys = this._sortedOrderedKeys();
    const start = desc ? keys.length - 1 : 0;
    const end = desc ? -1 : keys.length;
    const step = desc ? -1 : 1;
    for (let i = start; i !== end; i += step) {
      const bucket = this.ordered.get(keys[i]);
      if (!bucket) continue;
      yield* bucket.ids;
    }
  }

  _addOrdered(id, value) {
    const key = orderedValueKey(value);
    let bucket = this.ordered.get(key);
    if (!bucket) {
      bucket = { value, ids: new Set() };
      this.ordered.set(key, bucket);
      this.sortedOrderedKeys = null;
    }
    bucket.ids.add(id);
  }

  _addContainsState(id, value) {
    if (typeof value === "string") this.containsStringIds.add(id);
    else if (typeof value === "number" || typeof value === "boolean") this.containsScalarIds.add(id);
    else if (Array.isArray(value) && value.some(Array.isArray)) this.containsNestedArrayIds.add(id);
  }

  _removeContainsState(id, value) {
    if (typeof value === "string") this.containsStringIds.delete(id);
    else if (typeof value === "number" || typeof value === "boolean") this.containsScalarIds.delete(id);
    else if (Array.isArray(value) && value.some(Array.isArray)) this.containsNestedArrayIds.delete(id);
  }

  _removeOrdered(id, value) {
    const key = orderedValueKey(value);
    const bucket = this.ordered.get(key);
    bucket?.ids.delete(id);
    if (bucket?.ids.size === 0) {
      this.ordered.delete(key);
      this.sortedOrderedKeys = null;
    }
  }

  _sortedOrderedKeys() {
    if (!this.sortedOrderedKeys) {
      this.sortedOrderedKeys = [...this.ordered.entries()]
        .sort((left, right) => {
          const compared = compareSortValues(left[1].value, right[1].value);
          return compared || String(left[0]).localeCompare(String(right[0]));
        })
        .map(([key]) => key);
    }
    return this.sortedOrderedKeys;
  }
}

class GroupCountIndex {
  constructor(fields = []) {
    this.reset(fields);
  }

  reset(fields = []) {
    this.fields = unique((fields || []).map(String).filter(Boolean));
    this.groups = new Map();
    this.pairs = new Map();
    this.entries = 0;
  }

  get fieldCount() {
    return this.fields.length;
  }

  get pairCount() {
    return this.pairs.size;
  }

  add(object, shard = null) {
    this._apply(object, shard, 1);
  }

  remove(object, shard = null) {
    this._apply(object, shard, -1);
  }

  plan(criteria, groupBy, { indexes, scopeShards } = {}) {
    const groupField = String(groupBy || "");
    if (!this.fields.includes(groupField)) return null;
    const filter = aggregateCountFilter(criteria, indexes);
    if (!filter) return null;
    if (filter.path && !this.fields.includes(filter.path)) return null;
    return {
      groupField,
      filterField: filter.path,
      filterValue: filter.value,
      scopeShards: normalizeScopeShards(scopeShards),
    };
  }

  *counts(plan) {
    const scopes = readCountScopes(plan.scopeShards);
    if (!plan.filterField) {
      yield* this._countsFromScopeMap(this.groups.get(plan.groupField), scopes);
      return;
    }

    const pair = this.pairs.get(pairKey(plan.groupField, plan.filterField));
    const filter = pair?.get(indexValueKey(plan.filterValue));
    yield* this._countsFromScopeMap(filter, scopes);
  }

  _apply(object, shard, delta) {
    if (!object?._id || !this.fields.length) return;
    const values = new Map();
    for (const field of this.fields) {
      const value = getPathValue(object, field);
      values.set(field, {
        groupValue: value,
        groupKey: orderedValueKey(value),
        filterValues: uniqueIndexValues(indexedStoredValues(value)),
      });
    }

    const scopes = writeCountScopes(shard);
    for (const groupField of this.fields) {
      const group = values.get(groupField);
      for (const scope of scopes) {
        this._incrementGroup(groupField, scope, group.groupKey, group.groupValue, delta);
      }

      for (const filterField of this.fields) {
        const filter = values.get(filterField);
        for (const filterValue of filter.filterValues) {
          const filterKey = indexValueKey(filterValue);
          for (const scope of scopes) {
            this._incrementPair(groupField, filterField, filterKey, scope, group.groupKey, group.groupValue, delta);
          }
        }
      }
    }
  }

  *_countsFromScopeMap(scopeMap, scopes) {
    if (!scopeMap) return;
    if (scopes.length === 1) {
      for (const bucket of scopeMap.get(scopes[0])?.values() || []) yield [bucket.value, bucket.count];
      return;
    }

    const merged = new Map();
    for (const scope of scopes) {
      for (const [groupKey, bucket] of scopeMap.get(scope)?.entries() || []) {
        const current = merged.get(groupKey);
        if (current) current.count += bucket.count;
        else merged.set(groupKey, { value: bucket.value, count: bucket.count });
      }
    }
    for (const bucket of merged.values()) yield [bucket.value, bucket.count];
  }

  _incrementGroup(groupField, scope, groupKey, groupValue, delta) {
    let scopeMap = this.groups.get(groupField);
    if (!scopeMap) {
      scopeMap = new Map();
      this.groups.set(groupField, scopeMap);
    }
    this._incrementScopeBucket(scopeMap, scope, groupKey, groupValue, delta);
  }

  _incrementPair(groupField, filterField, filterKey, scope, groupKey, groupValue, delta) {
    const key = pairKey(groupField, filterField);
    let pair = this.pairs.get(key);
    if (!pair) {
      pair = new Map();
      this.pairs.set(key, pair);
    }

    let scopeMap = pair.get(filterKey);
    if (!scopeMap) {
      scopeMap = new Map();
      pair.set(filterKey, scopeMap);
    }
    this._incrementScopeBucket(scopeMap, scope, groupKey, groupValue, delta);

    if (isEmptyScopeMap(scopeMap)) pair.delete(filterKey);
    if (pair.size === 0) this.pairs.delete(key);
  }

  _incrementScopeBucket(scopeMap, scope, groupKey, groupValue, delta) {
    let buckets = scopeMap.get(scope);
    if (!buckets) {
      buckets = new Map();
      scopeMap.set(scope, buckets);
    }

    const bucket = buckets.get(groupKey);
    if (!bucket) {
      if (delta <= 0) return;
      buckets.set(groupKey, { value: groupValue, count: delta });
      this.entries++;
    } else {
      bucket.count += delta;
      if (bucket.count <= 0) {
        buckets.delete(groupKey);
        this.entries--;
      }
    }

    if (buckets.size === 0) scopeMap.delete(scope);
  }
}

class ColumnIndex {
  constructor(path) {
    this.path = String(path);
    this.values = new Map();
    this.nonScalar = new Set();
    this.pending = null;
    this.status = "ready";
    this.error = null;
    this.buildId = 0;
    this.numberSum = 0;
    this.numberCount = 0;
  }

  get ready() {
    return this.status === "ready";
  }

  get entries() {
    return this.values.size + this.nonScalar.size;
  }

  get scalarEntries() {
    return this.values.size;
  }

  get nonScalarEntries() {
    return this.nonScalar.size;
  }

  get pendingEntries() {
    return this.pending?.size || 0;
  }

  startBuild() {
    this.status = "building";
    this.error = null;
    this.pending = new Map();
    return ++this.buildId;
  }

  install(values, nonScalar, buildId) {
    if (buildId !== this.buildId) return false;
    this.values = new Map(values);
    this.nonScalar = new Set(nonScalar);
    this._rebuildNumberSummary();
    for (const [id, state] of this.pending || []) this._applyState(id, state);
    this.pending = null;
    this.status = "ready";
    this.error = null;
    return true;
  }

  fail(error, buildId) {
    if (buildId !== this.buildId) return;
    this.status = "error";
    this.error = error?.message || String(error);
    this.pending = null;
  }

  updateFromObject(object) {
    if (!object?._id) return;
    this.updateScalarState(object._id, columnScalarState(getPathValue(object, this.path)));
  }

  updateScalarState(id, state) {
    const key = String(id);
    if (this.status === "building") {
      this.pending.set(key, state);
      return;
    }
    this._applyState(key, state);
  }

  remove(id) {
    this.updateScalarState(id, { kind: "absent" });
  }

  hasScalar(id) {
    return this.values.has(String(id));
  }

  hasNonScalar(id) {
    return this.nonScalar.has(String(id));
  }

  valueFor(id) {
    return this.values.get(String(id));
  }

  _applyState(id, state) {
    if (this.values.has(id)) this._removeNumber(this.values.get(id));
    this.values.delete(id);
    this.nonScalar.delete(id);

    if (state.kind === "scalar") {
      this.values.set(id, state.value);
      this._addNumber(state.value);
      return;
    }
    if (state.kind === "nonScalar") {
      this.nonScalar.add(id);
      return;
    }
  }

  _rebuildNumberSummary() {
    this.numberSum = 0;
    this.numberCount = 0;
    for (const value of this.values.values()) this._addNumber(value);
  }

  _addNumber(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    this.numberSum += value;
    this.numberCount++;
  }

  _removeNumber(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    this.numberSum -= value;
    this.numberCount--;
  }
}

function columnWorkerRow(object, paths) {
  const row = { id: object._id, values: {}, nonScalar: [] };
  for (const path of paths) {
    const state = columnScalarState(getPathValue(object, path));
    if (state.kind === "scalar") row.values[path] = state.value;
    else if (state.kind === "nonScalar") row.nonScalar.push(path);
  }
  return row;
}

function columnScalarState(value) {
  if (isScalarColumnValue(value)) return { kind: "scalar", value };
  if (value !== undefined && value !== null) return { kind: "nonScalar" };
  return { kind: "absent" };
}

function isScalarColumnValue(value) {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" || typeof value === "boolean";
}

function scanFlatColumnAggregate(ids, normalized, columns) {
  const state = Object.fromEntries(normalized.fields.map((field) => [field.resultKey, flatFieldState(field)]));
  const rowCount = idSetSize(ids);
  if (rowCount !== null) {
    for (const field of normalized.fields) {
      if (isRowCountField(field)) state[field.resultKey].count += rowCount;
    }

    const fieldsNeedingIds = normalized.fields.filter((field) => !isRowCountField(field));
    if (fieldsNeedingIds.length === 0) return { rowsSeen: rowCount, state };

    for (const id of ids) {
      for (const field of fieldsNeedingIds) stepFlatField(state[field.resultKey], field, id, columns);
    }
    return { rowsSeen: rowCount, state };
  }

  let rowsSeen = 0;

  for (const id of ids) {
    rowsSeen++;
    for (const field of normalized.fields) {
      stepFlatField(state[field.resultKey], field, id, columns);
    }
  }

  return { rowsSeen, state };
}

function isRowCountOnlyAggregate(normalized) {
  return normalized.fields.length > 0 && normalized.fields.every(isRowCountField);
}

function isRowCountField(field) {
  return field.operator === "$count" && field.operand === true;
}

function rowCountOnlyState(normalized, count) {
  const state = Object.fromEntries(normalized.fields.map((field) => [field.resultKey, flatFieldState(field)]));
  for (const field of normalized.fields) state[field.resultKey].count = count;
  return state;
}

function idSetSize(ids) {
  return ids instanceof Set ? ids.size : null;
}

function flatFieldState(field) {
  switch (field.operator) {
    case "$sum":
      return { sum: 0 };
    case "$avg":
      return { sum: 0, count: 0 };
    case "$min":
    case "$max":
      return { value: undefined };
    case "$count":
      return { count: 0 };
    default:
      return {};
  }
}

function stepFlatField(state, field, id, columns) {
  switch (field.operator) {
    case "$sum": {
      const value = columns.get(field.operand).valueFor(id);
      if (typeof value === "number" && Number.isFinite(value)) state.sum += value;
      return;
    }
    case "$avg": {
      const value = columns.get(field.operand).valueFor(id);
      if (typeof value === "number" && Number.isFinite(value)) {
        state.sum += value;
        state.count++;
      }
      return;
    }
    case "$count": {
      if (field.operand === true) {
        state.count++;
        return;
      }
      const column = columns.get(field.operand);
      if (column.hasScalar(id) || column.hasNonScalar(id)) state.count++;
      return;
    }
    case "$min": {
      const value = columns.get(field.operand).valueFor(id);
      if (!isComparableAggregateValue(value)) return;
      if (state.value === undefined || sameAggregateTypeLessThan(value, state.value)) state.value = value;
      return;
    }
    case "$max": {
      const value = columns.get(field.operand).valueFor(id);
      if (!isComparableAggregateValue(value)) return;
      if (state.value === undefined || sameAggregateTypeLessThan(state.value, value)) state.value = value;
    }
  }
}

function finishFlatColumnAggregate(aggregate, spec, normalized) {
  if (!aggregate.rowsSeen) return [];
  const row = {};
  for (const field of normalized.fields) writeFlatField(row, aggregate.state[field.resultKey], field, spec?.$partial === true);
  return [row];
}

function writeFlatField(row, state, field, partial) {
  switch (field.operator) {
    case "$sum":
      row[field.resultKey] = state.sum;
      return;
    case "$avg":
      if (partial) {
        row[partialAvgSumKey(field.resultKey)] = state.sum;
        row[partialAvgCountKey(field.resultKey)] = state.count;
        return;
      }
      row[field.resultKey] = state.count ? state.sum / state.count : null;
      return;
    case "$count":
      row[field.resultKey] = state.count;
      return;
    case "$min":
    case "$max":
      row[field.resultKey] = state.value === undefined ? null : state.value;
  }
}

function scanGroupedColumnAggregate(ids, normalized, columns) {
  const groups = new Map();
  let rowsSeen = 0;

  for (const id of ids) {
    const groupValues = {};
    const keyValues = [];
    for (const path of normalized.groupBy) {
      const column = columns.get(path);
      if (column.hasNonScalar(id)) return null;
      const value = column.hasScalar(id) ? column.valueFor(id) : null;
      groupValues[path] = value;
      keyValues.push(value);
    }

    const key = stableKey(keyValues);
    let group = groups.get(key);
    if (!group) {
      group = {
        groupValues,
        state: Object.fromEntries(normalized.fields.map((field) => [field.resultKey, flatFieldState(field)])),
      };
      groups.set(key, group);
    }

    rowsSeen++;
    for (const field of normalized.fields) {
      stepFlatField(group.state[field.resultKey], field, id, columns);
    }
  }

  return { rowsSeen, groups: [...groups.values()] };
}

function scanForwardGroupedColumnAggregate(ids, normalized, groupBy, groupIndex, columns) {
  const groups = new Map();
  let rowsSeen = 0;

  for (const id of ids) {
    const rawGroupValue = groupIndex.valueForId(id);
    const groupValue = rawGroupValue === undefined ? null : rawGroupValue;
    const key = stableKey([groupValue]);
    let group = groups.get(key);
    if (!group) {
      group = {
        groupValues: { [groupBy]: groupValue },
        state: Object.fromEntries(normalized.fields.map((field) => [field.resultKey, flatFieldState(field)])),
      };
      groups.set(key, group);
    }

    rowsSeen++;
    for (const field of normalized.fields) {
      stepFlatField(group.state[field.resultKey], field, id, columns);
    }
  }

  return { rowsSeen, groups: [...groups.values()] };
}

function finishGroupedColumnAggregate(aggregate, spec, normalized) {
  if (!aggregate || !aggregate.rowsSeen) return [];
  const partialRows = aggregate.groups.map((group) => {
    const row = { ...group.groupValues };
    for (const field of normalized.fields) writeFlatField(row, group.state[field.resultKey], field, true);
    return row;
  });
  return spec?.$partial === true ? partialRows : mergeAggregatePartials(partialRows, spec);
}

function partialAvgSumKey(resultKey) {
  return `$partial.${resultKey}.sum`;
}

function partialAvgCountKey(resultKey) {
  return `$partial.${resultKey}.count`;
}

function isComparableAggregateValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" || typeof value === "boolean";
}

function sameAggregateTypeLessThan(left, right) {
  if (typeof left !== typeof right) return false;
  return compareSortValues(left, right) < 0;
}

function aggregateCountFilter(criteria = {}, indexes = new Map()) {
  if (isEmptyCriteria(criteria)) return { path: null, value: null };
  const entries = Object.entries(criteria || {});
  if (entries.length !== 1) return null;

  const [[path, expected]] = entries;
  if (path === "$and" && Array.isArray(expected)) {
    const children = expected.filter((child) => !isEmptyCriteria(child));
    if (children.length !== 1) return null;
    return aggregateCountFilter(children[0], indexes);
  }
  if (path.startsWith("$")) return null;

  const index = indexes.get(String(path));
  if (!index) return null;

  const containsValue = indexableContainsValue(expected);
  if (containsValue !== null) {
    return index.idsForContains(containsValue) === null ? null : { path: String(path), value: containsValue };
  }

  const values = indexableConstraintValues(expected);
  if (values === null) return null;
  const uniqueValues = uniqueIndexValues(values);
  return uniqueValues.length === 1 ? { path: String(path), value: uniqueValues[0] } : null;
}

function readCountScopes(scopeShards = null) {
  const shards = normalizeScopeShards(scopeShards);
  return shards.length ? shards : [ALL_COUNT_SCOPE];
}

function writeCountScopes(shard) {
  const normalized = normalizeShard(shard);
  return normalized ? [ALL_COUNT_SCOPE, normalized] : [ALL_COUNT_SCOPE];
}

function normalizeScopeShards(scopeShards = null) {
  return unique((Array.isArray(scopeShards) ? scopeShards : [])
    .map(normalizeShard)
    .filter(Boolean));
}

function pairKey(groupField, filterField) {
  return `${groupField}\0${filterField}`;
}

function isEmptyScopeMap(scopeMap) {
  for (const buckets of scopeMap.values()) {
    if (buckets.size > 0) return false;
  }
  return true;
}

function postWorkerBatch(worker, ackResolvers, rows) {
  return new Promise((resolve, reject) => {
    ackResolvers.push(resolve);
    try {
      worker.postMessage({ type: "batch", rows });
    } catch (error) {
      ackResolvers.pop();
      reject(error);
    }
  });
}

function sortObjects(objects, options = {}) {
  const direction = options.sort === "desc" ? -1 : 1;
  return [...objects].sort((left, right) => {
    return compareSortValues(getPathValue(left, options.sortBy), getPathValue(right, options.sortBy)) * direction;
  });
}

function indexedStoredValues(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(indexedStoredValues);
  return isScalarIndexValue(value) ? [value] : [];
}

function indexableConstraintValues(constraint) {
  if (constraint && typeof constraint === "object" && !Array.isArray(constraint)) {
    if (Object.prototype.hasOwnProperty.call(constraint, "$eq")) {
      return indexableEqualityValue(constraint.$eq);
    }
    if (Object.prototype.hasOwnProperty.call(constraint, "$equal")) {
      return indexableEqualityValue(constraint.$equal);
    }
    if (Array.isArray(constraint.$in)) {
      return indexableValueList(constraint.$in);
    }
    if (Array.isArray(constraint.$or)) {
      return indexableDisjunctionValues(constraint.$or);
    }
    if (Array.isArray(constraint.$any)) {
      return indexableDisjunctionValues(constraint.$any);
    }
    return null;
  }

  if (Array.isArray(constraint)) return indexableValueList(constraint);
  return indexableEqualityValue(constraint);
}

function indexableContainsValue(constraint) {
  if (!constraint || typeof constraint !== "object" || Array.isArray(constraint)) return null;
  const keys = Object.keys(constraint);
  if (keys.length !== 1 || keys[0] !== "$contains") return null;
  return isScalarIndexValue(constraint.$contains) ? constraint.$contains : null;
}

function indexableDisjunctionValues(constraints) {
  const values = [];
  for (const constraint of constraints) {
    const indexed = indexableConstraintValues(constraint);
    if (indexed === null) return null;
    values.push(...indexed);
  }
  return values;
}

function indexableValueList(values) {
  const indexed = [];
  for (const value of values) {
    const single = indexableEqualityValue(value);
    if (single === null) return null;
    indexed.push(...single);
  }
  return indexed;
}

function indexableEqualityValue(value) {
  return isScalarIndexValue(value) ? [value] : null;
}

function isScalarIndexValue(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function indexValueKey(value) {
  return `${typeof value}:${JSON.stringify(value)}`;
}

function orderedValueKey(value) {
  return `${typeof value}:${stableKey(value)}`;
}

function uniqueIndexValues(values) {
  const unique = new Map();
  for (const value of values) unique.set(indexValueKey(value), value);
  return [...unique.values()];
}

function setIntersection(left, right) {
  if (left.size > right.size) return setIntersection(right, left);
  const out = new Set();
  for (const id of left) if (right.has(id)) out.add(id);
  return out;
}

function countIntersection(left, right) {
  if (left.size > right.size) return countIntersection(right, left);
  let count = 0;
  for (const id of left) if (right.has(id)) count++;
  return count;
}

function countIntersectingSets(...sets) {
  const present = sets.filter((set) => set instanceof Set);
  if (!present.length) return 0;
  if (present.length === 1) return present[0].size;
  if (present.length === 2) return countIntersection(present[0], present[1]);
  const smallest = present.reduce((best, set) => (set.size < best.size ? set : best));
  let count = 0;
  for (const id of smallest) {
    let found = true;
    for (const set of present) {
      if (set === smallest || set.has(id)) continue;
      found = false;
      break;
    }
    if (found) count++;
  }
  return count;
}

function smallerSet(left, right) {
  return left.size <= right.size ? left : right;
}

function setUnion(left, right) {
  const out = new Set(left);
  for (const id of right) out.add(id);
  return out;
}

function normalizeShard(shard) {
  return typeof shard === "string" && shard.length > 0 ? shard : null;
}

function filterIds(ids, includeId) {
  if (!includeId) return ids;
  const out = new Set();
  for (const id of ids || []) if (includeId(id)) out.add(id);
  return out;
}

function isEmptyCriteria(criteria) {
  return Boolean(
    criteria &&
      typeof criteria === "object" &&
      !Array.isArray(criteria) &&
      Object.keys(criteria).length === 0,
  );
}

function normalizeCollectionMeta(meta = {}) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new TypeError("collection meta must be a plain object");
  }
  return {
    ...clone(meta),
    indexes: normalizeIndexList(meta.indexes, "indexes"),
    columnIndexes: normalizeIndexList(meta.columnIndexes, "columnIndexes"),
  };
}

function normalizeIndexList(indexes = [], label = "indexes") {
  if (indexes === undefined || indexes === null) return [];
  if (!Array.isArray(indexes)) throw new TypeError(`collection meta ${label} must be an array`);
  return unique(indexes.map((entry) => {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object" && typeof entry.path === "string") return entry.path;
    throw new TypeError(`collection meta ${label} must contain strings or { path } objects`);
  }).map((path) => path.trim()).filter(Boolean));
}

function unique(values) {
  return [...new Set(values)];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function annotateVectorIndexError(err, database, collection) {
  if (err?.code !== "VECTOR_INDEX_WARMING") return err;
  err.body = {
    ...(err.body || { error: err.message }),
    database,
    collection,
  };
  return err;
}

function overallIndexStatus(statuses = []) {
  if (statuses.some((status) => status === "error" || status === "failed" || status === "missing")) return "error";
  if (statuses.some((status) => status === "building" || status === "pending")) return "building";
  return "ready";
}

function normalizeVectorWarmupPlans(plans = []) {
  const source = Array.isArray(plans) && plans.length ? plans : [{ key: "all" }];
  const out = [];
  const seen = new Set();
  for (const plan of source) {
    const key = String(plan?.key || plan?.indexKey || "all");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      includeId: typeof plan?.includeId === "function" ? plan.includeId : null,
    });
  }
  return out;
}

class Database {
  constructor(name, options = {}) {
    this.name = name;
    this.options = options;
    this.collections = new Map();
    this.meta = {};
  }

  collection(name) {
    let c = this.collections.get(name);
    if (!c) {
      c = new Collection(name, this.options);
      this.collections.set(name, c);
    }
    return c;
  }

  collectionNames() {
    return [...this.collections.keys()];
  }

  getMeta() {
    return clone(this.meta);
  }

  setMeta(meta = {}) {
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      throw new TypeError("database meta must be a plain object");
    }
    this.meta = clone(meta);
    return this.getMeta();
  }

  deleteCollection(name) {
    return this.collections.delete(name);
  }
}

export class Store {
  constructor(options = {}) {
    this.options = options;
    this.dbs = new Map();
  }

  db(name) {
    let d = this.dbs.get(name);
    if (!d) {
      d = new Database(name, this.options);
      this.dbs.set(name, d);
    }
    return d;
  }

  collection(dbName, collName) {
    return this.db(dbName).collection(collName);
  }

  createDatabase(dbName, meta = {}) {
    return this.db(dbName).setMeta(meta);
  }

  getDatabaseMeta(dbName) {
    const db = this.dbs.get(dbName);
    return db ? db.getMeta() : null;
  }

  setDatabaseMeta(dbName, meta = {}) {
    return this.db(dbName).setMeta(meta);
  }

  hasDatabase(dbName) {
    return this.dbs.has(dbName);
  }

  createCollection(dbName, collName, meta = {}) {
    return this.collection(dbName, collName).setMeta(meta);
  }

  deleteCollection(dbName, collName) {
    const db = this.dbs.get(dbName);
    return db ? db.deleteCollection(collName) : false;
  }

  collectionNames(dbName) {
    const db = this.dbs.get(dbName);
    return db ? db.collectionNames() : [];
  }

  getCollectionMeta(dbName, collName) {
    const db = this.dbs.get(dbName);
    const collection = db?.collections.get(collName);
    return collection ? collection.getMeta() : null;
  }

  setCollectionMeta(dbName, collName, meta) {
    return this.collection(dbName, collName).setMeta(meta);
  }

  awaitColumnIndexes(dbName, collName) {
    return this.collection(dbName, collName).awaitColumnIndexes();
  }

  idsForShards(dbName, collName, shards = []) {
    const db = this.dbs.get(dbName);
    const collection = db?.collections.get(collName);
    return collection ? collection.idsForShards(shards) : null;
  }

  collectionMetadata() {
    const out = [];
    for (const [dbName, db] of this.dbs) {
      for (const [collName, collection] of db.collections) {
        out.push({ database: dbName, collection: collName, meta: collection.getMeta() });
      }
    }
    return out;
  }

  applyOps(ops) {
    const applied = [];
    let runKey = null;
    let run = [];

    const flush = () => {
      if (!run.length) return;
      const [dbName, collName, kind] = runKey.split("\0");
      const collection = this.collection(dbName, collName);
      const appliedRows = kind === "delObj"
        ? collection.deleteObjects(run)
        : collection.putObjects(run);
      for (const item of appliedRows) applied.push(item.op);
      run = [];
      runKey = null;
    };

    for (const op of ops || []) {
      const kind = op.kind === "delObj" ? "delObj" : "putObj";
      const key = `${op.db}\0${op.coll}\0${kind}`;
      if (runKey && runKey !== key) flush();
      runKey = key;
      run.push({
        id: op.id,
        value: op.kind === "touch" ? {} : op.value || {},
        ts: op.ts,
        shard: op.shard,
        op,
      });
    }
    flush();
    return applied;
  }

  readObjects(dbName, collName, ids) {
    return this.collection(dbName, collName).readObjects(ids);
  }

  queryPath(dbName, collName, criteria = {}, options = {}) {
    return this.collection(dbName, collName).readPath(criteria, options);
  }

  aggregatePath(dbName, collName, criteria = {}, spec = {}, options = {}) {
    return this.collection(dbName, collName).aggregatePath(criteria, spec, options);
  }

  validateWriteValue(dbName, collName, value = {}) {
    return this.collection(dbName, collName).validateWriteValue(value);
  }

  preserveVector(dbName, collName, id, value = {}) {
    return this.collection(dbName, collName).preserveVector(id, value);
  }

  getVector(dbName, collName, id) {
    return this.collection(dbName, collName).getVector(id);
  }

  vectorSearch(dbName, collName, queryVec, limit = 20, options = {}) {
    try {
      return this.collection(dbName, collName).vectorSearch(queryVec, limit, options);
    } catch (err) {
      throw annotateVectorIndexError(err, dbName, collName);
    }
  }

  assertVectorIndexReady(dbName, collName, options = {}) {
    try {
      return this.collection(dbName, collName).assertVectorIndexReady(options.indexKey || "all", options.includeId);
    } catch (err) {
      throw annotateVectorIndexError(err, dbName, collName);
    }
  }

  rankVectorRows(dbName, collName, rows, queryVec, limit = 20) {
    return this.collection(dbName, collName).rankVectorRows(rows, queryVec, limit);
  }

  vectorStats() {
    const out = [];
    for (const [dbName, db] of this.dbs) {
      for (const [collName, collection] of db.collections) {
        const stats = collection.vectorStats();
        if (!stats.field && stats.stored === 0 && stats.nodes === 0) continue;
        out.push({ database: dbName, collection: collName, ...stats });
      }
    }
    return out;
  }

  indexReadiness() {
    const collections = [];
    const workers = {
      columnIndex: {
        type: "worker_thread",
        active: 0,
        background: true,
      },
      vectorIndex: {
        type: "same_thread_task",
        active: 0,
        background: true,
      },
    };

    for (const [dbName, db] of this.dbs) {
      for (const [collName, collection] of db.collections) {
        const readiness = collection.indexReadiness();
        workers.columnIndex.active += readiness.workers.columnIndex.active;
        workers.vectorIndex.active += readiness.workers.vectorIndex.active;
        collections.push({
          database: dbName,
          collection: collName,
          ...readiness,
        });
      }
    }

    return {
      status: overallIndexStatus(collections.map((collection) => collection.status)),
      workers,
      collections,
    };
  }

  clearVectorIndexes() {
    for (const db of this.dbs.values()) {
      for (const collection of db.collections.values()) collection.clearVectorIndexes();
    }
  }

  warmVectorIndexes(plansForCollection = null) {
    const builds = [];
    for (const [dbName, db] of this.dbs) {
      for (const [collName, collection] of db.collections) {
        const plans = normalizeVectorWarmupPlans(
          typeof plansForCollection === "function"
            ? plansForCollection(dbName, collName)
            : [{ key: "all" }],
        );
        for (const plan of plans) builds.push(collection.warmVectorIndex(plan.key, plan.includeId));
      }
    }
    return Promise.all(builds);
  }

  async awaitVectorIndexes() {
    for (;;) {
      const waits = [];
      for (const db of this.dbs.values()) {
        for (const collection of db.collections.values()) waits.push(collection.awaitVectorIndexes());
      }
      await Promise.allSettled(waits);
      const stillBuilding = [];
      for (const db of this.dbs.values()) {
        for (const collection of db.collections.values()) {
          if (collection.vectorBuilds.size) stillBuilding.push(collection);
        }
      }
      if (!stillBuilding.length) return;
    }
  }

  dbNames() {
    return [...this.dbs.keys()];
  }

  *collectionSnapshotObjects(dbName, collName, options = {}) {
    const collection = this.dbs.get(dbName)?.collections.get(collName);
    if (!collection) return;
    yield* collection.snapshotObjects(options);
  }

  snapshot({ database, collection, includeObject } = {}) {
    const collections = [];
    for (const [dbName, d] of this.dbs) {
      if (!matchesSnapshotName(dbName, database)) continue;
      for (const [collName, c] of d.collections) {
        if (!matchesSnapshotName(collName, collection)) continue;
        collections.push({
          db: dbName,
          coll: collName,
          objects: c.snapshot({
            includeId: typeof includeObject === "function"
              ? (id) => includeObject(dbName, collName, id)
              : undefined,
          }),
        });
      }
    }
    return collections;
  }
}

function matchesSnapshotName(name, expected) {
  return !expected || expected === "*" || expected === name;
}
