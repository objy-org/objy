import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { ObjectRowStore } from "./object-store.js";
import { ShapeStore } from "./shape.js";
import { gt } from "./clock.js";
import {
  aggregateObjects,
  aggregatePartialObjects,
  isObjectDbAggregateSpec,
  mergeAggregatePartials,
} from "./aggregate.js";
import { HNSWIndex } from "./hnsw.js";
import { compareSortValues, getPathValue, matchesQuery, stableKey, stripQueryControls } from "./query.js";
import { AGGREGATE_PATH, planAggregate, planCount, planRead, READ_PATH } from "./query-planner.js";
import { cloneVector, isValidVector, normalizeVectorConfig, rankBySimilarity } from "./vector.js";

const COLUMN_BUILD_BATCH_SIZE = 4096;

class Collection {
  constructor(name, options = {}) {
    this.name = name;
    this.vectorConfig = normalizeVectorConfig(options.vector);
    this.vectorField = this.vectorConfig.enabled ? this.vectorConfig.field : null;
    this.store = createPhysicalStore(options);
    this.vectors = new Map();
    this.vectorIndexes = new Map();
    this.meta = new Map();
    this.indexes = new Map();
    this.columnIndexes = new Map();
    this.columnBuilds = new Set();
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

  putObject(id, value, ts) {
    return this.putObjects([{ id, value, ts }]).length === 1;
  }

  putObjects(rows) {
    const applied = [];
    for (const row of rows || []) {
      if (this._putObject(row.id, row.value, row.ts)) applied.push(row);
    }
    return applied;
  }

  _putObject(id, value, ts) {
    const m = this._ensureMeta(id);
    if (m.deleted && !gt(ts, m.deleted)) return false;
    const wasLive = Boolean(m.ts && !m.deleted);
    const before = wasLive ? this.read(id) : undefined;
    if (m.ts && !gt(ts, m.ts)) return false;
    const prepared = this._prepareStoredValue(value);
    m.ts = ts;
    m.deleted = null;
    this.store.rebuild(id, Object.entries(prepared.value).filter(([key]) => key !== "id"));
    this._applyVectorUpdate(id, prepared.vector);
    const after = this.read(id);
    this._refreshIndexes(id, before, after);
    this._refreshColumnIndexes(id, after);
    if (!wasLive) this.liveCount++;
    return true;
  }

  deleteObject(id, ts) {
    return this.deleteObjects([{ id, ts }]).length === 1;
  }

  deleteObjects(rows) {
    const applied = [];
    for (const row of rows || []) {
      if (this._deleteObject(row.id, row.ts)) applied.push(row);
    }
    return applied;
  }

  _deleteObject(id, ts) {
    const m = this._ensureMeta(id);
    const last = m.deleted || m.ts;
    if (last && !gt(ts, last)) return false;
    const wasLive = Boolean(m.ts && !m.deleted);
    const before = wasLive ? this.read(id) : undefined;
    m.deleted = ts;
    this.store.removeObject(id);
    this._removeVector(id);
    this._refreshIndexes(id, before, undefined);
    this._refreshColumnIndexes(id, undefined);
    if (wasLive) this.liveCount--;
    return true;
  }

  read(id) {
    const m = this.meta.get(id);
    if (!m || m.deleted) return undefined;
    const vals = this.store.read(id) || {};
    return { id, ...vals };
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
      for (const id of this._idsForPlan(plan.idPlan, criteria)) {
        if (includeId && !includeId(id)) continue;
        const obj = this.read(id);
        if (!obj || (plan.idPlan?.verify ? !matchesQuery(obj, criteria) : false)) continue;
        if (!plan.idPlan?.verify && plan.path === READ_PATH.SCAN && !matchesQuery(obj, criteria)) continue;
        if (skipped < offset) {
          skipped++;
          continue;
        }
        results.push(obj);
        if (results.length >= limit) break;
      }
      return results;
    }

    const indexed = plan.path === READ_PATH.ORDERED_INDEX ? this._findWithOrderedIndex(criteria, options, plan) : null;
    if (indexed) return indexed;

    return sortObjects(
      [...this._idsForPlan(plan.idPlan, criteria)]
        .filter((id) => !includeId || includeId(id))
        .map((id) => this.read(id))
        .filter((obj) => obj && matchesQuery(obj, criteria)),
      options,
    ).slice(offset, offset + limit);
  }

  all(options = {}) {
    return this.find({}, options);
  }

  count(query = {}, options = {}) {
    const criteria = stripQueryControls(query);
    const includeId = typeof options.includeId === "function" ? options.includeId : null;
    if (!criteria || Object.keys(criteria).length === 0) {
      if (includeId) {
        let n = 0;
        for (const [id, m] of this.meta) if (!m.deleted && includeId(id)) n++;
        return n;
      }
      return this.liveCount;
    }
    const plan = this._planCount(criteria, options);
    if (plan.path === READ_PATH.INDEX_EXACT && !plan.idPlan?.verify) {
      if (!includeId) return plan.idPlan.ids.size;
      let n = 0;
      for (const id of plan.idPlan.ids) if (includeId(id)) n++;
      return n;
    }

    let n = 0;
    for (const id of this._idsForPlan(plan.idPlan, criteria)) {
      if (includeId && !includeId(id)) continue;
      const obj = this.read(id);
      if (obj && (!plan.idPlan?.verify || matchesQuery(obj, criteria)) && (plan.path !== READ_PATH.SCAN || matchesQuery(obj, criteria))) n++;
    }
    return n;
  }

  aggregate(query = {}, spec = {}, options = {}) {
    if (isObjectDbAggregateSpec(spec)) {
      const criteria = stripQueryControls(query);
      const indexed = this._executeAggregatePlan(this._planAggregate(criteria, spec, options), criteria, spec, options);
      if (indexed) return indexed;

      const rows = this.find(criteria, options);
      return spec?.$partial === true ? aggregatePartialObjects(rows, spec) : aggregateObjects(rows, spec);
    }

    const groupBy = spec.groupBy;
    const metrics = normalizeMetrics(spec);
    const groups = new Map();

    for (const object of this.find(query, options)) {
      const key = groupBy ? stableKey(getPathValue(object, groupBy)) : "__all__";
      let bucket = groups.get(key);
      if (!bucket) {
        bucket = makeBucket(groupBy ? getPathValue(object, groupBy) : undefined, metrics);
        groups.set(key, bucket);
      }
      addToBucket(bucket, object, metrics);
    }

    if (!groupBy) return finishBucket(groups.get("__all__") || makeBucket(undefined, metrics), metrics);

    return [...groups.values()].map((bucket) => finishBucket(bucket, metrics));
  }

  createIndex(path) {
    const key = String(path);
    const index = new FieldIndex(key);
    for (const id of this._liveIds()) {
      const object = this.read(id);
      index.add(object);
    }
    this.indexes.set(key, index);
    this.collectionMeta = normalizeCollectionMeta({
      ...this.collectionMeta,
      indexes: unique([...this.collectionMeta.indexes, key]),
    });
  }

  dropIndex(path) {
    const key = String(path);
    const removed = this.indexes.delete(key);
    this.collectionMeta = normalizeCollectionMeta({
      ...this.collectionMeta,
      indexes: this.collectionMeta.indexes.filter((index) => index !== key),
    });
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
        yield { id, ts: m.ts, deleted: m.deleted };
        continue;
      }
      const value = this.store.read(id) || {};
      const vector = this.getVector(id);
      if (vector && this.vectorField) value[this.vectorField] = vector;
      yield { id, ts: m.ts, deleted: null, value };
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
    const index = this._vectorIndex(options.indexKey || "all", options.includeId);
    const k = Math.max(0, Number.isFinite(limit) ? Math.floor(limit) : 20);
    if (k <= 0) return [];
    return index.search(queryVec, k, options.ef).map(({ id, dist }) => ({
      id,
      dist,
      _score: 1 - dist,
    }));
  }

  rankVectorRows(rows, queryVec, limit = 20) {
    return rankBySimilarity(rows, queryVec, {
      limit,
      getVec: (id) => this.getVector(id),
      idOf: (row) => row?.id,
    });
  }

  vectorStats() {
    let nodes = 0;
    for (const index of this.vectorIndexes.values()) nodes += index.index.size;
    return {
      field: this.vectorField,
      stored: this.vectors.size,
      indexes: this.vectorIndexes.size,
      nodes,
    };
  }

  clearVectorIndexes() {
    this.vectorIndexes.clear();
  }

  snapshot(options = {}) {
    const out = [];
    for (const object of this.snapshotObjects(options)) out.push(object);
    return out;
  }

  _liveIds() {
    const ids = [];
    for (const [id, m] of this.meta) if (!m.deleted) ids.push(id);
    return ids;
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

  _plannerAdapter() {
    return {
      idsForCriteria: (criteria) => this._idsForCriteria(criteria),
      partialIdsForCriteria: (criteria) => this._partialIdsForCriteria(criteria),
      hasOrderedIndex: (path) => this.indexes.has(String(path)),
      hasGroupIndex: (path) => this.indexes.has(String(path)),
      fieldIndex: (path) => this.indexes.get(String(path)) || null,
      columnIndex: (path) => this.columnIndexes.get(String(path)) || null,
      idsForAll: (includeId) => this._idSetForAll(includeId),
      filterIds: (ids, includeId) => filterIds(ids, includeId),
    };
  }

  _idSetForAll(includeId = null) {
    const ids = new Set();
    for (const [id, m] of this.meta) {
      if (!m.deleted && (!includeId || includeId(id))) ids.add(id);
    }
    return ids;
  }

  *_idsForPlan(idPlan, criteria = {}) {
    const ids = idPlan?.ids || this._liveIds();
    for (const id of ids) {
      if (!idPlan?.verify) {
        yield id;
        continue;
      }
      const object = this.read(id);
      if (object && matchesQuery(object, criteria)) yield id;
    }
  }

  _idSetForPlan(idPlan, criteria = {}) {
    if (!idPlan || idPlan.ids === null) return null;
    if (!idPlan.verify) return idPlan.ids;
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
    if (path === "id" || path === "_id") return this._idsForObjectIdConstraint(expected);

    const index = this.indexes.get(path);
    if (!index) return null;

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
    yield* (plan?.ids || this._liveIds());
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

  _addToIndexes(object) {
    for (const index of this.indexes.values()) index.add(object);
  }

  _removeFromIndexes(id, object) {
    for (const index of this.indexes.values()) index.remove(id, object);
  }

  _applyMetaIndexes() {
    const wanted = new Set(this.collectionMeta.indexes);
    for (const path of [...this.indexes.keys()]) {
      if (!wanted.has(path)) this.indexes.delete(path);
    }
    for (const path of wanted) {
      if (!this.indexes.has(path)) this._createIndexFromMeta(path);
    }
  }

  _createIndexFromMeta(path) {
    const index = new FieldIndex(path);
    for (const id of this._liveIds()) {
      const object = this.read(id);
      index.add(object);
    }
    this.indexes.set(path, index);
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
      const ids = this._liveIds();
      for (let offset = 0; offset < ids.length; offset += COLUMN_BUILD_BATCH_SIZE) {
        const rows = [];
        for (const id of ids.slice(offset, offset + COLUMN_BUILD_BATCH_SIZE)) {
          const object = this.read(id);
          if (!object) continue;
          rows.push(columnWorkerRow(object, paths));
        }
        await postWorkerBatch(worker, ackResolvers, rows);
        await yieldToEventLoop();
      }

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
    const filterIds = this._idSetForPlan(plan.idPlan, criteria);
    const groups = [];
    let rowsSeen = 0;

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
      read: (id) => this.read(id),
      matches: (object) => filterProven ? true : matchesQuery(object, criteria),
    });
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
      if (!entry.includeId || entry.includeId(key)) entry.index.insert(key, vector);
    }
  }

  _removeVector(id) {
    const key = String(id);
    this.vectors.delete(key);
    for (const entry of this.vectorIndexes.values()) entry.index.remove(key);
  }

  _vectorIndex(key = "all", includeId = null) {
    const indexKey = String(key || "all");
    let entry = this.vectorIndexes.get(indexKey);
    if (entry) return entry.index;

    const filter = typeof includeId === "function" ? includeId : null;
    const index = new HNSWIndex({
      ...this.vectorConfig.hnsw,
      getVec: (id) => this.vectors.get(String(id)) || null,
    });
    entry = { index, includeId: filter };
    this.vectorIndexes.set(indexKey, entry);
    for (const [id, vector] of this.vectors) {
      if (!filter || filter(id)) index.insert(id, vector);
    }
    return index;
  }
}

function createPhysicalStore(options = {}) {
  const engine = options.engine || "shape";
  if (engine === "shape") return new ShapeStore();
  if (engine === "object") return new ObjectRowStore(options.object);
  throw new TypeError(`unsupported storage engine: ${engine}`);
}

function indexKeysForObjectPath(object, path) {
  return indexedStoredValues(getPathValue(object, path)).map(indexValueKey);
}

class FieldIndex {
  constructor(path) {
    this.path = String(path);
    this.lookup = new Map();
    this.ordered = new Map();
    this.sortedOrderedKeys = null;
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
    if (!object?.id) return;
    for (const key of indexKeysForObjectPath(object, this.path)) {
      const ids = this.lookup.get(key) || new Set();
      ids.add(object.id);
      this.lookup.set(key, ids);
    }
    this._addOrdered(object.id, getPathValue(object, this.path));
  }

  remove(id, object) {
    for (const key of indexKeysForObjectPath(object, this.path)) {
      const ids = this.lookup.get(key);
      ids?.delete(id);
      if (ids?.size === 0) this.lookup.delete(key);
    }
    this._removeOrdered(id, getPathValue(object, this.path));
  }

  idsForValues(values) {
    let ids = new Set();
    for (const value of uniqueIndexValues(values)) {
      ids = setUnion(ids, this.lookup.get(indexValueKey(value)) || new Set());
    }
    return ids;
  }

  *iterateGroups(filterIds = null) {
    for (const bucket of this.ordered.values()) {
      const ids = filterIds ? setIntersection(filterIds, bucket.ids) : bucket.ids;
      if (ids.size > 0) yield [bucket.value, ids];
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
    if (!object?.id) return;
    this.updateScalarState(object.id, columnScalarState(getPathValue(object, this.path)));
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
  const row = { id: object.id, values: {}, nonScalar: [] };
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
  let rowsSeen = 0;

  for (const id of ids) {
    rowsSeen++;
    for (const field of normalized.fields) {
      stepFlatField(state[field.resultKey], field, id, columns);
    }
  }

  return { rowsSeen, state };
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

function setUnion(left, right) {
  const out = new Set(left);
  for (const id of right) out.add(id);
  return out;
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

function withoutId(object) {
  const { id, ...rest } = object || {};
  return rest;
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

function normalizeMetrics(spec) {
  return {
    sum: asArray(spec.sum),
    avg: asArray(spec.avg),
    min: asArray(spec.min),
    max: asArray(spec.max),
  };
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function makeBucket(key, metrics) {
  const bucket = {
    key,
    count: 0,
    sum: Object.fromEntries(metrics.sum.map((field) => [field, 0])),
    avg: Object.fromEntries(metrics.avg.map((field) => [field, { sum: 0, count: 0 }])),
    min: Object.fromEntries(metrics.min.map((field) => [field, undefined])),
    max: Object.fromEntries(metrics.max.map((field) => [field, undefined])),
  };
  return bucket;
}

function addToBucket(bucket, object, metrics) {
  bucket.count++;
  for (const field of metrics.sum) {
    const value = getPathValue(object, field);
    if (typeof value === "number") bucket.sum[field] += value;
  }
  for (const field of metrics.avg) {
    const value = getPathValue(object, field);
    if (typeof value === "number") {
      bucket.avg[field].sum += value;
      bucket.avg[field].count++;
    }
  }
  for (const field of metrics.min) {
    const value = getPathValue(object, field);
    if (value !== undefined && (bucket.min[field] === undefined || compareSortValues(value, bucket.min[field]) < 0)) {
      bucket.min[field] = value;
    }
  }
  for (const field of metrics.max) {
    const value = getPathValue(object, field);
    if (value !== undefined && (bucket.max[field] === undefined || compareSortValues(value, bucket.max[field]) > 0)) {
      bucket.max[field] = value;
    }
  }
}

function finishBucket(bucket, metrics) {
  const out = { count: bucket.count };
  if (bucket.key !== undefined) out.key = bucket.key;
  if (metrics.sum.length) out.sum = bucket.sum;
  if (metrics.avg.length) {
    out.avg = Object.fromEntries(
      Object.entries(bucket.avg).map(([field, state]) => [field, state.count ? state.sum / state.count : null]),
    );
  }
  if (metrics.min.length) out.min = bucket.min;
  if (metrics.max.length) out.max = bucket.max;
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
        op,
      });
    }
    flush();
    return applied;
  }

  readObjects(dbName, collName, ids) {
    return this.collection(dbName, collName).readObjects(ids);
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
    return this.collection(dbName, collName).vectorSearch(queryVec, limit, options);
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

  clearVectorIndexes() {
    for (const db of this.dbs.values()) {
      for (const collection of db.collections.values()) collection.clearVectorIndexes();
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
