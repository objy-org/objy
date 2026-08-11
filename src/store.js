import { ShapeStore } from "./shape.js";
import { gt } from "./clock.js";
import { aggregateObjects, isObjectDbAggregateSpec } from "./aggregate.js";
import { compareSortValues, getPathValue, matchesQuery, stableKey, stripQueryControls } from "./query.js";

class Collection {
  constructor(name) {
    this.name = name;
    this.store = new ShapeStore();
    this.meta = new Map();
    this.indexes = new Map();
    this.collectionMeta = normalizeCollectionMeta();
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
    const before = this.read(id);
    if (m.ts && !gt(ts, m.ts)) return false;
    m.ts = ts;
    m.deleted = null;
    this.store.rebuild(id, Object.entries(value || {}).filter(([key]) => key !== "id"));
    this._refreshIndexes(id, before, this.read(id));
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
    const before = this.read(id);
    m.deleted = ts;
    this.store.removeObject(id);
    this._refreshIndexes(id, before, undefined);
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

    if (!options.sortBy) {
      if (limit <= 0) return [];
      const results = [];
      let skipped = 0;
      for (const id of this._candidateIds(criteria)) {
        const obj = this.read(id);
        if (!obj || !matchesQuery(obj, criteria)) continue;
        if (skipped < offset) {
          skipped++;
          continue;
        }
        results.push(obj);
        if (results.length >= limit) break;
      }
      return results;
    }

    let results = [...this._candidateIds(criteria)]
      .map((id) => this.read(id))
      .filter((obj) => obj && matchesQuery(obj, criteria));

    const direction = options.sort === "desc" ? -1 : 1;
    results = [...results].sort((left, right) => {
      return compareSortValues(getPathValue(left, options.sortBy), getPathValue(right, options.sortBy)) * direction;
    });

    return results.slice(offset, offset + limit);
  }

  all(options = {}) {
    return this.find({}, options);
  }

  count(query = {}) {
    const criteria = stripQueryControls(query);
    if (!criteria || Object.keys(criteria).length === 0) {
      let n = 0;
      for (const m of this.meta.values()) if (!m.deleted) n++;
      return n;
    }
    const plan = this._planIndexedIds(criteria);
    if (plan?.exact) return plan.ids.size;

    let n = 0;
    for (const id of this._candidateIds(criteria)) {
      const obj = this.read(id);
      if (obj && matchesQuery(obj, criteria)) n++;
    }
    return n;
  }

  aggregate(query = {}, spec = {}) {
    if (isObjectDbAggregateSpec(spec)) return aggregateObjects(this.find(query), spec);

    const groupBy = spec.groupBy;
    const metrics = normalizeMetrics(spec);
    const groups = new Map();

    for (const object of this.find(query)) {
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
    const index = new Map();
    for (const id of this._liveIds()) {
      const object = this.read(id);
      this._addIndexEntry(index, key, object);
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
    return this.getMeta();
  }

  indexStats() {
    return [...this.indexes.entries()].map(([path, index]) => ({
      path,
      keys: index.size,
      entries: [...index.values()].reduce((sum, ids) => sum + ids.size, 0),
    }));
  }

  shapeStats() {
    return this.store.shapeStats();
  }

  snapshot() {
    const out = [];
    for (const [id, m] of this.meta) {
      if (m.deleted) {
        out.push({ id, ts: m.ts, deleted: m.deleted });
        continue;
      }
      out.push({ id, ts: m.ts, deleted: null, value: this.store.read(id) || {} });
    }
    return out;
  }

  _liveIds() {
    const ids = [];
    for (const [id, m] of this.meta) if (!m.deleted) ids.push(id);
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
    return idsForIndexedValues(index, values);
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

  _addToIndexes(object) {
    for (const [path, index] of this.indexes) this._addIndexEntry(index, path, object);
  }

  _removeFromIndexes(id, object) {
    for (const [path, index] of this.indexes) {
      for (const key of indexKeysForObjectPath(object, path)) {
        const ids = index.get(key);
        ids?.delete(id);
        if (ids?.size === 0) index.delete(key);
      }
    }
  }

  _addIndexEntry(index, path, object) {
    for (const key of indexKeysForObjectPath(object, path)) {
      const ids = index.get(key) || new Set();
      ids.add(object.id);
      index.set(key, ids);
    }
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
    const index = new Map();
    for (const id of this._liveIds()) {
      const object = this.read(id);
      this._addIndexEntry(index, path, object);
    }
    this.indexes.set(path, index);
  }
}

function idsForIndexedValues(index, values) {
  let ids = new Set();
  for (const value of uniqueIndexValues(values)) {
    ids = setUnion(ids, index.get(indexValueKey(value)) || new Set());
  }
  return ids;
}

function indexKeysForObjectPath(object, path) {
  return indexedStoredValues(getPathValue(object, path)).map(indexValueKey);
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
    indexes: normalizeIndexList(meta.indexes),
  };
}

function normalizeIndexList(indexes = []) {
  if (indexes === undefined || indexes === null) return [];
  if (!Array.isArray(indexes)) throw new TypeError("collection meta indexes must be an array");
  return unique(indexes.map((entry) => {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object" && typeof entry.path === "string") return entry.path;
    throw new TypeError("collection meta indexes must contain strings or { path } objects");
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
  constructor(name) {
    this.name = name;
    this.collections = new Map();
    this.meta = {};
  }

  collection(name) {
    let c = this.collections.get(name);
    if (!c) {
      c = new Collection(name);
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
  constructor() {
    this.dbs = new Map();
  }

  db(name) {
    let d = this.dbs.get(name);
    if (!d) {
      d = new Database(name);
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

  dbNames() {
    return [...this.dbs.keys()];
  }

  snapshot() {
    const collections = [];
    for (const [dbName, d] of this.dbs) {
      for (const [collName, c] of d.collections) {
        collections.push({ db: dbName, coll: collName, objects: c.snapshot() });
      }
    }
    return collections;
  }
}
