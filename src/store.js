import { getHeapStatistics } from "node:v8";
import { constants as zlibConstants, deflateSync, inflateSync } from "node:zlib";
import { ObjectRowStore } from "./object-store.js";
import { ShapeStore } from "./shape.js";
import { gt } from "./clock.js";
import { percentOf, summarizeCompression } from "./compression-stats.js";
import { DerivedStateScheduler } from "./derived-state-scheduler.js";
import {
  aggregateLegacyObjects,
  aggregateObjects,
  aggregatePartialObjects,
  isObjectDbAggregateSpec,
  mergeAggregatePartials,
} from "./aggregate.js";
import { HNSWIndex } from "./hnsw.js";
import { normalizeObjectHooksMeta } from "./object-hooks.js";
import { compareSortValues, getPathValue, matchesQuery, stableKey, stripQueryControls } from "./query.js";
import { AGGREGATE_PATH, planAggregate, planCount, planRead, READ_PATH } from "./query-planner.js";
import { cloneVector, isValidVector, normalizeVectorConfig, rankBySimilarity, VectorIndexWarmingError } from "./vector.js";

const COLUMN_BUILD_BATCH_SIZE = 4096;
const FIELD_BUILD_BATCH_SIZE = 4096;
const INDEX_DEFER_MIN_ROWS = 5000;
const INDEX_DIRTY_BUILD_BATCH_SIZE = 4096;
const INDEX_WARMUP_MAX_HEAP_RATIO = 0.9;
const INDEX_WARMUP_RETRY_MS = 30_000;
const VECTOR_BUILD_BATCH_SIZE = 4096;
const DEFAULT_TIERING_MIN_BYTES = 4096;
const TIERING_DEFLATE_OPTIONS = Object.freeze({ level: zlibConstants.Z_BEST_SPEED });

class Collection {
  constructor(name, options = {}) {
    this.name = name;
    this.disposed = false;
    this.vectorConfig = normalizeVectorConfig(options.vector);
    this.vectorField = this.vectorConfig.enabled ? this.vectorConfig.field : null;
    this.store = createPhysicalStore(options);
    this.vectors = new Map();
    this.vectorIndexes = new Map();
    this.vectorBuilds = new Set();
    this.meta = new Map();
    this.idByRid = [];
    this.indexes = new Map();
    this.fieldBuilds = new Map();
    this.columns = new Map();
    this.columnBuilds = new Set();
    this.indexDirtyRids = new RidBitmapQueue();
    this.indexDirtyBuild = null;
    this.indexBuildPending = false;
    this.derivedStateScheduler = options.derivedStateScheduler || new DerivedStateScheduler(options.derivedState);
    this.derivedStateOwner = {};
    this.shardIds = new Map();
    this.unshardedLiveCount = 0;
    this.compressedCold = [];
    this.compressionTotals = emptyCompressionTotals();
    this.collectionMeta = normalizeCollectionMeta();
    this.liveCount = 0;
  }

  _ensureMeta(id) {
    const key = String(id);
    let m = this.meta.get(key);
    if (!m) {
      m = { ts: null, deleted: null, rid: this._allocateRid(key) };
      this.meta.set(key, m);
    } else if (!Number.isInteger(m.rid)) {
      m.rid = this._allocateRid(key);
    }
    return m;
  }

  _allocateRid(id) {
    const rid = this.idByRid.length;
    this.idByRid.push(String(id));
    return rid;
  }

  _ridForId(id) {
    return this.meta.get(String(id))?.rid;
  }

  _idForRid(rid) {
    return this.idByRid[rid];
  }

  ensure(id, ts) {
    return this.putObjects([{ id, value: {}, ts }]).length === 1;
  }

  putObject(id, value, ts, shard = null, options = {}) {
    return this.putObjects([{ id, value, ts, shard }], options).length === 1;
  }

  putObjects(rows, options = {}) {
    const applied = [];
    const indexDeltas = [];
    const inputRows = rows || [];
    const writeOptions = this._shouldDeferIndexDeltasForCount(inputRows.length)
      ? { ...options, keepColumnFields: true }
      : options;
    for (const row of inputRows) {
      if (this._putObject(row.id, row.value, row.ts, row.shard, writeOptions, indexDeltas)) applied.push(row);
    }
    this._applyIndexDeltas(indexDeltas);
    return applied;
  }

  applySnapshotObjects(rows, options = {}) {
    let applied = 0;
    for (const row of rows || []) {
      if (this._applySnapshotObject(row, options)) applied++;
    }
    if (applied && !options.deferDerivedIndexes) this.rebuildDerivedState();
    return applied;
  }

  _applySnapshotObject(row = {}, options = {}) {
    if (row.id === undefined || row.id === null) return false;
    const id = String(row.id);
    const m = this._ensureMeta(id);

    if (row.deleted) {
      const last = m.deleted || m.ts;
      if (last && !gt(row.deleted, last)) return false;
      if (row.ts) m.ts = row.ts;
      m.deleted = row.deleted;
      m.shard = normalizeShard(row.shard) || m.shard || null;
      this.store.removeObject(id);
      this._clearCompressedCold(m.rid);
      this._removeVector(id);
      this._refreshColumns(m.rid, undefined);
      return true;
    }

    if (!row.ts) return false;
    if (m.deleted && !gt(row.ts, m.deleted)) return false;
    if (m.ts && !gt(row.ts, m.ts)) return false;
    const prepared = this._prepareStoredValue(row.value || {});
    const baseValue = options.deferDerivedIndexes ? prepared.value : this._baseValueForStorage(prepared.value);
    m.ts = row.ts;
    m.deleted = null;
    m.shard = normalizeShard(row.shard) || m.shard || null;
    this._writeBaseValue(id, m.rid, baseValue, { trusted: options.trustedValues === true });
    this._applyVectorUpdate(id, prepared.vector);
    this._refreshColumns(m.rid, prepared.value);
    return true;
  }

  _putObject(id, value, ts, shard = null, options = {}, indexDeltas = null) {
    const key = String(id);
    const m = this._ensureMeta(key);
    const rid = m.rid;
    if (m.deleted && !gt(ts, m.deleted)) return false;
    const wasLive = Boolean(m.ts && !m.deleted);
    const previousShard = wasLive ? m.shard : null;
    const before = wasLive ? this.readForQuery(key) : undefined;
    if (m.ts && !gt(ts, m.ts)) return false;
    const nextShard = normalizeShard(shard) || m.shard || null;
    const prepared = this._prepareStoredValue(value);
    const baseValue = options.keepColumnFields || this._hasDirtyIndexes()
      ? prepared.value
      : this._baseValueForStorage(prepared.value);
    m.ts = ts;
    m.deleted = null;
    m.shard = nextShard;
    this._writeBaseValue(key, rid, baseValue, { trusted: options.trustedValues === true });
    this._applyVectorUpdate(key, prepared.vector);
    const after = queryObjectFromStoredValue(key, prepared.value);
    this._recordIndexDelta({ rid, before, after }, indexDeltas);
    if (!wasLive) {
      this.liveCount++;
      this._addShardRid(rid, nextShard);
    } else if (previousShard !== nextShard) {
      this._removeShardRid(rid, previousShard);
      this._addShardRid(rid, nextShard);
    }
    return true;
  }

  _baseValueForStorage(value = {}, paths = null) {
    let base = value || {};
    if (paths) {
      for (const path of paths) base = unsetPath(base, path);
      return base;
    }
    for (const [path, column] of this.columns) {
      if (column.ready) base = unsetPath(base, path);
    }
    return base;
  }

  _writeBaseValue(id, rid, value = {}, options = {}) {
    const baseValue = this._tierBaseValue(rid, value);
    this.store.rebuild(id, Object.entries(baseValue).filter(([field]) => field !== "_id"), {
      trusted: options.trusted === true,
    });
  }

  _tierBaseValue(rid, value = {}) {
    const tiering = this.collectionMeta.tiering;
    if (!tiering || tiering.mode !== "compressedMemory") {
      this._clearCompressedCold(rid);
      return value || {};
    }

    const split = splitTieredValue(value || {}, tiering, this._forcedHotTieringPaths());
    if (!split.cold) {
      this._clearCompressedCold(rid);
      return value || {};
    }

    const json = JSON.stringify(split.cold);
    const rawBytes = Buffer.byteLength(json);
    if (rawBytes < tiering.minBytes) {
      this._clearCompressedCold(rid);
      return value || {};
    }

    const compressed = deflateSync(Buffer.from(json), TIERING_DEFLATE_OPTIONS);
    const compact = new Uint8Array(compressed.byteLength);
    compact.set(compressed);
    this._setCompressedCold(rid, {
      bytes: rawBytes,
      compressed: compact,
    });
    return split.hot;
  }

  _forcedHotTieringPaths() {
    return unique([
      ...this.collectionMeta.indexes,
      ...this.collectionMeta.columns,
    ]);
  }

  _clearCompressedCold(rid) {
    this._setCompressedCold(rid, undefined);
  }

  _setCompressedCold(rid, entry) {
    if (!Number.isInteger(rid)) return;
    const previous = this.compressedCold[rid];
    if (!previous && !entry) return;
    if (previous) {
      this.compressionTotals.objects--;
      this.compressionTotals.uncompressedBytes -= previous.bytes;
      this.compressionTotals.compressedBytes -= previous.compressed.byteLength;
    }
    this.compressedCold[rid] = entry;
    if (entry) {
      this.compressionTotals.objects++;
      this.compressionTotals.uncompressedBytes += entry.bytes;
      this.compressionTotals.compressedBytes += entry.compressed.byteLength;
    }
  }

  _hydrateCompressedCold(value = {}, rid) {
    const entry = this.compressedCold[rid];
    if (!entry) return value || {};
    const cold = JSON.parse(inflateSync(entry.compressed).toString("utf8"));
    return mergePlainObjects(cold, value || {});
  }

  _hydrateStoredValue(value = {}, rid, id) {
    return this._hydrateColumns(this._hydrateCompressedCold(value, rid), rid, id);
  }

  _hydrateColumns(value = {}, rid, id) {
    let out = { ...(value || {}), _id: id };
    for (const [path, column] of this.columns) {
      if (!column.hasValue(rid)) continue;
      out = setPath(out, path, column.valueFor(rid));
    }
    return out;
  }

  _rewriteBaseValueForColumns(rid, object = {}, paths = null) {
    const id = this._idForRid(rid);
    if (id === undefined) return;
    const { _id, ...value } = object || {};
    const baseValue = this._baseValueForStorage(value, paths);
    this._writeBaseValue(id, rid, baseValue, { trusted: true });
  }

  deleteObject(id, ts, shard = null) {
    return this.deleteObjects([{ id, ts, shard }]).length === 1;
  }

  deleteObjects(rows) {
    const applied = [];
    const indexDeltas = [];
    const inputRows = rows || [];
    for (const row of inputRows) {
      if (this._deleteObject(row.id, row.ts, row.shard, indexDeltas)) applied.push(row);
    }
    this._applyIndexDeltas(indexDeltas);
    return applied;
  }

  _deleteObject(id, ts, shard = null, indexDeltas = null) {
    const key = String(id);
    const m = this._ensureMeta(key);
    const rid = m.rid;
    const last = m.deleted || m.ts;
    if (last && !gt(ts, last)) return false;
    const wasLive = Boolean(m.ts && !m.deleted);
    const previousShard = wasLive ? m.shard : null;
    const before = wasLive ? this.readForQuery(key) : undefined;
    m.deleted = ts;
    if (shard) m.shard = normalizeShard(shard);
    this.store.removeObject(key);
    this._clearCompressedCold(rid);
    this._removeVector(key);
    this._recordIndexDelta({ rid, before, after: undefined }, indexDeltas);
    if (wasLive) {
      this.liveCount--;
      this._removeShardRid(rid, previousShard);
    }
    return true;
  }

  read(id) {
    const key = String(id);
    const m = this.meta.get(key);
    if (!m || m.deleted) return undefined;
    const vals = this.store.read(key) || {};
    return this._hydrateStoredValue(vals, m.rid, key);
  }

  readForQuery(id) {
    const key = String(id);
    const m = this.meta.get(key);
    if (!m || m.deleted) return undefined;
    const vals = typeof this.store.readForQuery === "function"
      ? this.store.readForQuery(key) || {}
      : this.store.read(key) || {};
    return this._hydrateStoredValue(vals, m.rid, key);
  }

  readRid(rid) {
    const id = this._idForRid(rid);
    return id === undefined ? undefined : this.read(id);
  }

  readRidForQuery(rid) {
    const id = this._idForRid(rid);
    return id === undefined ? undefined : this.readForQuery(id);
  }

  dispose() {
    this.disposed = true;
    this.derivedStateScheduler.cancel(this.derivedStateOwner);
    this.indexes.clear();
    this.fieldBuilds.clear();
    this.columns.clear();
    this.columnBuilds.clear();
    this.indexDirtyRids.clear();
    this.indexDirtyBuild = null;
    this.indexBuildPending = false;
    this.clearVectorIndexes();
    this.vectors.clear();
    this.meta.clear();
    this.idByRid = [];
    this.compressedCold = [];
    this.compressionTotals = emptyCompressionTotals();
    this.shardIds.clear();
    this.unshardedLiveCount = 0;
    this.liveCount = 0;
    this.collectionMeta = normalizeCollectionMeta();
    this.store.clear?.();
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
      for (const rid of this._ridsForPlan(plan.idPlan, criteria)) {
        const id = includeId ? this._idForRid(rid) : null;
        if (includeId && !includeId(id)) continue;
        if (verifyScan) {
          const obj = this.readRidForQuery(rid);
          if (!obj || !matchesQuery(obj, criteria)) continue;
        }
        if (skipped < offset) {
          skipped++;
          continue;
        }
        const safe = this.readRid(rid);
        if (safe) results.push(safe);
        if (results.length >= limit) break;
      }
      return results;
    }

    const indexed = plan.path === READ_PATH.ORDERED_INDEX ? this._findWithOrderedIndex(criteria, options, plan) : null;
    if (indexed) return indexed;

    const matched = [];
    for (const rid of this._ridsForPlan(plan.idPlan, criteria)) {
      const id = includeId ? this._idForRid(rid) : null;
      if (includeId && !includeId(id)) continue;
      const obj = this.readRidForQuery(rid);
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
    const includeIds = options.includeIds instanceof Set ? options.includeIds : null;
    const plan = this._planRead(criteria, options);

    if (!options.sortBy) {
      if (limit <= 0) return [];
      const results = [];
      let skipped = 0;
      const verifyScan = plan.path === READ_PATH.SCAN && !isEmptyCriteria(criteria);
      for (const rid of this._ridsForPlan(plan.idPlan, criteria)) {
        if (includeIds && !includeIds.has(rid)) continue;
        const id = includeId ? this._idForRid(rid) : null;
        if (includeId && !includeId(id)) continue;
        const object = this.readRidForQuery(rid);
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
    for (const rid of this._ridsForPlan(plan.idPlan, criteria)) {
      if (includeIds && !includeIds.has(rid)) continue;
      const id = includeId ? this._idForRid(rid) : null;
      if (includeId && !includeId(id)) continue;
      const object = this.readRidForQuery(rid);
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
        for (const rid of includeIds) if (includeId(this._idForRid(rid))) n++;
        return n;
      }
      if (includeIds) return includeIds.size;
      if (includeId) {
        let n = 0;
        for (const rid of this._liveRidIterator()) if (includeId(this._idForRid(rid))) n++;
        return n;
      }
      return this.liveCount;
    }
    const plan = this._planCount(criteria, options);
    if (plan.path === READ_PATH.INDEX_EXACT && !plan.idPlan?.verify) {
      if (includeIds && includeId) {
        let n = 0;
        for (const rid of smallerSet(plan.idPlan.ids, includeIds)) {
          if (plan.idPlan.ids.has(rid) && includeIds.has(rid) && includeId(this._idForRid(rid))) n++;
        }
        return n;
      }
      if (includeIds) return countIntersection(plan.idPlan.ids, includeIds);
      if (!includeId) return plan.idPlan.ids.size;
      let n = 0;
      for (const rid of plan.idPlan.ids) if (includeId(this._idForRid(rid))) n++;
      return n;
    }

    let n = 0;
    const verifyScan = plan.path === READ_PATH.SCAN && !isEmptyCriteria(criteria);
    for (const rid of this._ridsForPlan(plan.idPlan, criteria)) {
      if (includeIds && !includeIds.has(rid)) continue;
      const id = includeId ? this._idForRid(rid) : null;
      if (includeId && !includeId(id)) continue;
      if (verifyScan) {
        const obj = this.readRidForQuery(rid);
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
    this._createIndexFromMeta(key);
    this.collectionMeta = normalizeCollectionMeta({
      ...this.collectionMeta,
      indexes: unique([...this.collectionMeta.indexes, key]),
    });
  }

  dropIndex(path) {
    const key = String(path);
    const removed = this.indexes.delete(key);
    const building = this.fieldBuilds.delete(key);
    this.collectionMeta = normalizeCollectionMeta({
      ...this.collectionMeta,
      indexes: this.collectionMeta.indexes.filter((index) => index !== key),
    });
    return removed || building;
  }

  getMeta() {
    return clone(this.collectionMeta);
  }

  setMeta(meta = {}, options = {}) {
    const previousTiering = stableKey(this.collectionMeta.tiering || null);
    this.collectionMeta = normalizeCollectionMeta(meta);
    if (options.deferIndexes) this._deferMetaIndexes();
    else {
      this._applyMetaIndexes();
      this._applyMetaColumns();
    }
    if (previousTiering !== stableKey(this.collectionMeta.tiering || null)) this._retierBaseValues();
    return this.getMeta();
  }

  indexStats() {
    return [
      ...[...this.indexes.entries()].map(([path, index]) => ({
        type: "field",
        path,
        status: this.indexDirtyRids.size ? "building" : "ready",
        keys: index.lookupKeys,
        entries: index.lookupEntries,
        orderedKeys: index.orderedKeys,
        orderedEntries: index.orderedEntries,
        dirtyEntries: this.indexDirtyRids.size,
      })),
      ...[...this.fieldBuilds.values()].map((build) => ({
        type: "field",
        path: build.path,
        status: build.status,
        pendingEntries: build.pending?.size || 0,
        ...(build.error ? { error: build.error } : {}),
      })),
      ...[...this.columns.entries()].map(([path, column]) => ({
        type: "column",
        path,
        status: column.ready && this.indexDirtyRids.size ? "building" : column.status,
        entries: column.entries,
        scalarEntries: column.scalarEntries,
        nonScalarEntries: column.nonScalarEntries,
        pendingEntries: column.pendingEntries + this.indexDirtyRids.size,
        dirtyEntries: this.indexDirtyRids.size,
        numberSum: column.numberSum,
        numberCount: column.numberCount,
        ...(column.error ? { error: column.error } : {}),
      })),
    ];
  }

  rebuildDerivedState() {
    const fieldPaths = [...this.collectionMeta.indexes];
    const columnPaths = [...this.collectionMeta.columns];
    this.liveCount = 0;
    this.shardIds.clear();
    this.unshardedLiveCount = 0;
    const fieldIndexes = new Map(fieldPaths.map((path) => [path, new FieldIndex(path)]));
    const columnData = new Map(columnPaths.map((path) => [path, new TypedRidColumn(path)]));

    for (const [id, m] of this.meta) {
      if (m.deleted) continue;
      this.liveCount++;
      this._addShardRid(m.rid, m.shard || null);
      const object = this.readForQuery(id);
      if (!object) continue;
      for (const [path, index] of fieldIndexes) index.addValue(m.rid, getPathValue(object, path));
      for (const [path, column] of columnData) column.updateScalarState(m.rid, columnScalarState(getPathValue(object, path)));
      this._rewriteBaseValueForColumns(m.rid, object, columnPaths);
    }

    this.indexes = fieldIndexes;
    this.fieldBuilds.clear();
    this.columns = columnData;
    this.columnBuilds.clear();
    this.indexDirtyRids.clear();
    this.indexDirtyBuild = null;
  }

  rebuildCoreState() {
    this.liveCount = 0;
    this.shardIds.clear();
    this.unshardedLiveCount = 0;

    for (const m of this.meta.values()) {
      if (m.deleted) continue;
      this.liveCount++;
      this._addShardRid(m.rid, m.shard || null);
    }
  }

  scheduleIndexBuildsFromMeta() {
    this._applyMetaIndexes({ background: true, rebuild: true });
    this._applyMetaColumns({ rebuild: true });
    this.indexBuildPending = false;
  }

  async awaitFieldIndexes() {
    for (;;) {
      const builds = [...this.fieldBuilds.values()]
        .filter((build) => build.status === "building" && build.promise)
        .map((build) => build.promise);
      if (!builds.length) return;
      await Promise.allSettled(builds);
    }
  }

  async awaitColumns() {
    for (;;) {
      const builds = [...this.columnBuilds];
      if (!builds.length) return;
      await Promise.allSettled(builds);
    }
  }

  async awaitDirtyIndexes() {
    for (;;) {
      const build = this.indexDirtyBuild;
      if (!build) {
        if (this.indexDirtyRids.size) {
          this._scheduleDirtyIndexCatchup();
          if (this.indexDirtyBuild) continue;
        }
        return;
      }
      await Promise.allSettled([build]);
    }
  }

  shapeStats() {
    return this.store.shapeStats().map((entry) => ({
      ...entry,
      ridTable: {
        live: this.liveCount,
        allocated: this.idByRid.length,
      },
      tiering: this.compressionStats(),
    }));
  }

  compressionStats() {
    const tiering = this.collectionMeta.tiering;
    const { objects, uncompressedBytes, compressedBytes } = this.compressionTotals;
    const savedBytes = uncompressedBytes - compressedBytes;
    return {
      mode: tiering?.mode || "off",
      objects,
      liveObjects: this.liveCount,
      compressedObjects: objects,
      coveragePercent: percentOf(objects, this.liveCount),
      rawBytes: uncompressedBytes,
      uncompressedBytes,
      compressedBytes,
      savedBytes,
      savedPercent: percentOf(savedBytes, uncompressedBytes),
      ...(tiering ? {
        policy: {
          ...(tiering.keep?.length ? { keep: [...tiering.keep] } : {}),
          ...(tiering.offload?.length ? { offload: [...tiering.offload] } : {}),
          minBytes: tiering.minBytes,
        },
      } : {}),
    };
  }

  _retierBaseValues() {
    for (const rid of this._liveRidIterator()) {
      const object = this.readRidForQuery(rid);
      if (object) this._rewriteBaseValueForColumns(rid, object);
    }
  }

  *snapshotObjects({ includeId } = {}) {
    const allow = typeof includeId === "function" ? includeId : () => true;
    for (const [id, m] of this.meta) {
      if (!allow(id)) continue;
      if (m.deleted) {
        yield { id, ts: m.ts, deleted: m.deleted, ...(m.shard ? { shard: m.shard } : {}) };
        continue;
      }
      const { _id, ...value } = this.readForQuery(id) || {};
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

  indexSummary() {
    const hasVector = this.vectors.size > 0 || this.vectorIndexes.size > 0 || this.vectorBuilds.size > 0;
    let activeFieldBuilds = this.indexDirtyBuild ? 1 : 0;
    for (const build of this.fieldBuilds.values()) {
      if (build.status === "building") activeFieldBuilds++;
    }
    const statuses = [
      ...this.collectionMeta.indexes.map((path) => this._fieldIndexStatus(path)),
      ...this.collectionMeta.columns.map((path) => {
        const column = this.columns.get(path);
        return column?.ready && this.indexDirtyRids.size
          ? "building"
          : column?.status || (this.indexBuildPending ? "pending" : "missing");
      }),
      ...(hasVector ? [this._vectorIndexStatus()] : []),
    ];
    return {
      configured: statuses.length > 0,
      status: overallIndexStatus(statuses),
      activeTasks: activeFieldBuilds + this.columnBuilds.size + this.vectorBuilds.size,
    };
  }

  indexReadiness() {
    const fieldIndexes = this.collectionMeta.indexes.map((path) => ({
      path,
      status: this._fieldIndexStatus(path),
      pendingEntries: (this.fieldBuilds.get(path)?.pending?.size || 0) + this.indexDirtyRids.size,
      dirtyEntries: this.indexDirtyRids.size,
      ...(this.fieldBuilds.get(path)?.error ? { error: this.fieldBuilds.get(path).error } : {}),
    }));
    const columns = this.collectionMeta.columns.map((path) => {
      const column = this.columns.get(path);
      return {
        path,
        status: column?.ready && this.indexDirtyRids.size ? "building" : column?.status || (this.indexBuildPending ? "pending" : "missing"),
        pendingEntries: (column?.pendingEntries || 0) + this.indexDirtyRids.size,
        dirtyEntries: this.indexDirtyRids.size,
        ...(column?.error ? { error: column.error } : {}),
      };
    });
    const vector = this.vectorStats();
    const workers = {
      fieldIndex: {
        type: "same_thread_task",
        active: [...this.fieldBuilds.values()].filter((build) => build.status === "building").length + (this.indexDirtyBuild ? 1 : 0),
        background: true,
      },
      columns: {
        type: "same_thread_task",
        active: this.columnBuilds.size,
        background: true,
      },
      vectorIndex: {
        type: "same_thread_task",
        active: this.vectorBuilds.size,
        background: true,
      },
    };
    const hasVector = hasVectorIndexValue(vector);
    const statuses = [
      ...fieldIndexes.map((index) => index.status),
      ...columns.map((column) => column.status),
      ...(hasVector ? [vector.status] : []),
    ];

    return {
      status: overallIndexStatus(statuses),
      fieldIndexes,
      columns,
      ...(hasVector ? { vector } : {}),
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

  *_liveRidIterator() {
    for (const m of this.meta.values()) {
      if (!m.deleted) yield m.rid;
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
      idsForCriteria: (criteria) => this._ridsForCriteria(criteria),
      partialIdsForCriteria: (criteria) => this._partialRidsForCriteria(criteria),
      hasOrderedIndex: (path) => !this._hasDirtyIndexes() && this.indexes.has(String(path)),
      hasGroupIndex: (path) => !this._hasDirtyIndexes() && this.indexes.has(String(path)),
      hasGroupForwardIndex: (path) => !this._hasDirtyIndexes() && this.indexes.get(String(path))?.canReadValuesById === true,
      fieldIndex: (path) => this.indexes.get(String(path)) || null,
      column: (path) => this._hasDirtyIndexes() ? null : this.columns.get(String(path)) || null,
      idsForAll: (includeId) => this._ridSetForAll(includeId),
      filterIds: (ids, includeId) => this._filterRidSet(ids, includeId),
    };
  }

  _hasDirtyIndexes() {
    return this.indexDirtyRids.size > 0;
  }

  _ridSetForAll(includeId = null) {
    const rids = new Set();
    for (const [id, m] of this.meta) {
      if (!m.deleted && (!includeId || includeId(id))) rids.add(m.rid);
    }
    return rids;
  }

  _filterRidSet(rids, includeId = null) {
    if (!includeId) return rids;
    const out = new Set();
    for (const rid of rids || []) if (includeId(this._idForRid(rid))) out.add(rid);
    return out;
  }

  idsForShards(shards = []) {
    if (this.unshardedLiveCount > 0) return null;
    const names = [...new Set((shards || []).map(normalizeShard).filter(Boolean))];
    if (!names.length) return null;
    if (names.length === 1) return this.shardIds.get(names[0]) || new Set();
    let rids = new Set();
    for (const shard of names) rids = setUnion(rids, this.shardIds.get(shard) || new Set());
    return rids;
  }

  *_ridsForPlan(idPlan, criteria = {}) {
    const rids = idPlan?.ids === null || idPlan?.ids === undefined
      ? this._liveRidIterator()
      : idPlan.ids;
    for (const rid of rids) {
      if (idPlan?.scopeIds && !idPlan.scopeIds.has(rid)) continue;
      if (!idPlan?.verify) {
        yield rid;
        continue;
      }
      const object = this.readRidForQuery(rid);
      if (object && matchesQuery(object, criteria)) yield rid;
    }
  }

  _ridSetForPlan(idPlan, criteria = {}) {
    if (!idPlan || idPlan.ids === null) return null;
    if (!idPlan.verify) return idPlan.scopeIds ? setIntersection(idPlan.ids, idPlan.scopeIds) : idPlan.ids;
    const rids = new Set();
    for (const rid of this._ridsForPlan(idPlan, criteria)) rids.add(rid);
    return rids;
  }

  _planIndexedIds(query) {
    if (!query || Object.keys(query).length === 0) return null;
    const exact = this._ridsForCriteria(query);
    if (exact) return { ids: exact, exact: true };
    const partial = this._partialRidsForCriteria(query);
    return partial ? { ids: partial, exact: false } : null;
  }

  _ridsForCriteria(query) {
    const entries = Object.entries(query || {});
    if (!entries.length) return null;

    let current = null;
    for (const [path, expected] of entries) {
      let rids = null;

      if (path === "$and" && Array.isArray(expected)) {
        const childSets = expected
          .filter((child) => !isEmptyCriteria(child))
          .map((child) => this._ridsForCriteria(child));
        if (childSets.some((set) => set === null)) return null;
        rids = childSets.length ? childSets.reduce((left, right) => setIntersection(left, right)) : null;
      } else if (path === "$or" && Array.isArray(expected)) {
        const childSets = expected.map((child) => this._ridsForCriteria(child));
        if (childSets.some((set) => set === null)) return null;
        rids = childSets.length ? childSets.reduce((left, right) => setUnion(left, right)) : new Set();
      } else if (path.startsWith("$")) {
        return null;
      } else {
        rids = this._ridsForFieldConstraint(path, expected);
        if (rids === null) return null;
      }

      if (rids === null) continue;
      current = current === null ? rids : setIntersection(current, rids);
    }

    return current;
  }

  _partialRidsForCriteria(query) {
    const entries = Object.entries(query || {});
    if (!entries.length) return null;

    let current = null;
    for (const [path, expected] of entries) {
      if (path === "$and" && Array.isArray(expected)) {
        for (const child of expected) {
          if (isEmptyCriteria(child)) continue;
          const rids = this._ridsForCriteria(child) || this._partialRidsForCriteria(child);
          if (rids) current = current === null ? rids : setIntersection(current, rids);
        }
        continue;
      }

      if (path === "$or" && Array.isArray(expected)) {
        const rids = this._ridsForCriteria({ $or: expected });
        if (rids) current = current === null ? rids : setIntersection(current, rids);
        continue;
      }

      if (path.startsWith("$")) continue;

      const rids = this._ridsForFieldConstraint(path, expected);
      if (rids !== null) current = current === null ? rids : setIntersection(current, rids);
    }

    return current;
  }

  _ridsForFieldConstraint(path, expected) {
    if (path === "_id") return this._ridsForObjectIdConstraint(expected);

    const index = this.indexes.get(path);
    if (!index) return null;

    const containsValue = indexableContainsValue(expected);
    if (containsValue !== null) return this._dirtyAwareIndexedRids(path, expected, index.idsForContains(containsValue));

    const values = indexableConstraintValues(expected);
    if (values === null) return null;
    return this._dirtyAwareIndexedRids(path, expected, index.idsForValues(values));
  }

  _dirtyAwareIndexedRids(path, expected, indexed) {
    if (indexed === null) return null;
    if (!this.indexDirtyRids.size) return indexed;

    const out = new Set();
    for (const rid of indexed) {
      if (!this.indexDirtyRids.has(rid)) out.add(rid);
    }
    for (const rid of this.indexDirtyRids) {
      const object = this.readRidForQuery(rid);
      if (object && matchesQuery(object, { [path]: expected })) out.add(rid);
    }
    return out;
  }

  _ridsForObjectIdConstraint(expected) {
    const values = indexableConstraintValues(expected);
    if (values === null) return null;

    const rids = new Set();
    for (const value of values) {
      const id = String(value);
      const rid = this._ridForId(id);
      if (rid !== undefined && this.has(id)) rids.add(rid);
    }
    return rids;
  }

  *_candidateIds(query) {
    if (!query || Object.keys(query).length === 0) {
      for (const [id, m] of this.meta) if (!m.deleted) yield id;
      return;
    }
    const plan = this._planIndexedIds(query);
    for (const rid of plan?.ids || this._liveRidIterator()) {
      const id = this._idForRid(rid);
      if (id !== undefined) yield id;
    }
  }

  _recordIndexDelta(delta, indexDeltas = null) {
    if (indexDeltas) {
      indexDeltas.push(delta);
      return;
    }
    this._applyIndexDeltas([delta]);
  }

  _refreshIndexes(rid, before, after) {
    this._applyIndexDeltas([{ rid, before, after }]);
  }

  _refreshColumns(rid, after) {
    this._applyIndexDeltas([{ rid, before: undefined, after }]);
  }

  _addToIndexes(rid, object) {
    this._applyIndexDeltas([{ rid, before: undefined, after: object }]);
  }

  _removeFromIndexes(rid, object) {
    this._applyIndexDeltas([{ rid, before: object, after: undefined }]);
  }

  _applyIndexDeltas(deltas = []) {
    if (!deltas?.length) return;
    if (this._shouldDeferIndexDeltas(deltas)) {
      for (const delta of deltas) this._markIndexDirty(delta);
      this._scheduleDirtyIndexCatchup();
      return;
    }

    for (const { rid, before, after } of deltas) {
      if (!Number.isInteger(rid)) continue;
      this._recordFieldBuildDelta(rid, before, after);
      this._recordColumnBuildDelta(rid, after);
      if (this.indexDirtyRids.has(rid)) continue;

      for (const index of this.indexes.values()) {
        if (before) index.removeValue(rid, getPathValue(before, index.path));
        if (after) index.addValue(rid, getPathValue(after, index.path));
      }

      for (const column of this.columns.values()) {
        if (column.status === "building") continue;
        if (after) column.updateScalarState(rid, columnScalarState(getPathValue(after, column.path)));
        else column.remove(rid);
      }
    }
  }

  _shouldDeferIndexDeltas(deltas = []) {
    return this._shouldDeferIndexDeltasForCount(deltas.length);
  }

  _shouldDeferIndexDeltasForCount(count = 0) {
    return count >= INDEX_DEFER_MIN_ROWS && this._hasIndexWork();
  }

  _hasIndexWork() {
    return Boolean(
      this.indexes.size ||
        this.columns.size ||
        this.fieldBuilds.size ||
        this.columnBuilds.size,
    );
  }

  _markIndexDirty({ rid, before, after } = {}) {
    if (!Number.isInteger(rid)) return;
    this._recordFieldBuildDelta(rid, before, after);
    this._recordColumnBuildDelta(rid, after);
    this.indexDirtyRids.add(rid);
  }

  _recordColumnBuildDelta(rid, after) {
    for (const column of this.columns.values()) {
      if (column.status !== "building") continue;
      if (after) column.updateScalarState(rid, columnScalarState(getPathValue(after, column.path)));
      else column.remove(rid);
    }
  }

  _scheduleDirtyIndexCatchup() {
    if (this.indexDirtyBuild || !this.indexDirtyRids.size) return;
    const build = this.derivedStateScheduler.schedule(
      `dirty-index:${this.name}`,
      (job) => this._runDirtyIndexCatchup(job),
      { owner: this.derivedStateOwner },
    );
    this.indexDirtyBuild = build;
    build.then(
      () => {
        if (this.indexDirtyBuild === build) this.indexDirtyBuild = null;
        if (this.indexDirtyRids.size) this._scheduleDirtyIndexCatchup();
      },
      () => {
        if (this.indexDirtyBuild === build) this.indexDirtyBuild = null;
      },
    );
  }

  async _runDirtyIndexCatchup(job) {
    if (this.disposed) return;
    while (this.indexDirtyRids.size) {
      if (this.disposed) return;
      const batch = this.indexDirtyRids.take(INDEX_DIRTY_BUILD_BATCH_SIZE);
      if (!batch.length) {
        this.indexDirtyRids.clear();
        break;
      }

      for (const rid of batch) {
        this._refreshReadyIndexesForRid(rid);
        this.indexDirtyRids.delete(rid);
      }

      if (this.indexDirtyRids.size) await job.checkpoint(INDEX_DIRTY_BUILD_BATCH_SIZE);
    }
  }

  _refreshReadyIndexesForRid(rid) {
    const object = this.readRidForQuery(rid);
    for (const index of this.indexes.values()) {
      index.removeRid(rid);
      if (object) index.addValue(rid, getPathValue(object, index.path));
    }
    for (const column of this.columns.values()) {
      if (object) column.updateScalarState(rid, columnScalarState(getPathValue(object, column.path)));
      else column.remove(rid);
    }
    if (object) this._rewriteBaseValueForColumns(rid, object);
  }

  _addShardRid(rid, shard) {
    if (!shard) {
      this.unshardedLiveCount++;
      return;
    }
    const key = String(shard);
    const rids = this.shardIds.get(key) || new Set();
    rids.add(rid);
    this.shardIds.set(key, rids);
  }

  _removeShardRid(rid, shard) {
    if (!shard) {
      if (this.unshardedLiveCount > 0) this.unshardedLiveCount--;
      return;
    }
    const rids = this.shardIds.get(String(shard));
    rids?.delete(rid);
    if (rids?.size === 0) this.shardIds.delete(String(shard));
  }

  _applyMetaIndexes(options = {}) {
    const background = options.background === true;
    const rebuild = options.rebuild === true;
    const wanted = new Set(this.collectionMeta.indexes);
    for (const path of [...this.indexes.keys()]) {
      if (!wanted.has(path)) this.indexes.delete(path);
    }
    for (const path of [...this.fieldBuilds.keys()]) {
      if (!wanted.has(path)) this.fieldBuilds.delete(path);
    }
    const toBuild = [];
    for (const path of wanted) {
      if (this.indexes.has(path) && !rebuild) continue;
      if (this.fieldBuilds.has(path) && !rebuild) continue;
      if (this.liveCount === 0) {
        this.fieldBuilds.delete(path);
        this.indexes.set(path, new FieldIndex(path));
        continue;
      }
      if (background) toBuild.push(path);
      else this._createIndexFromMeta(path);
    }
    if (toBuild.length) this._startFieldIndexBuild(toBuild);
  }

  _createIndexFromMeta(path) {
    this.fieldBuilds.delete(path);
    const index = new FieldIndex(path);
    for (const rid of this._liveRidIterator()) {
      const object = this.readRidForQuery(rid);
      if (object) index.addValue(rid, getPathValue(object, path));
    }
    this.indexes.set(path, index);
  }

  _deferMetaIndexes() {
    const wantedColumns = new Set(this.collectionMeta.columns);
    this.indexes.clear();
    this.fieldBuilds.clear();
    this.indexBuildPending = true;
    for (const path of [...this.columns.keys()]) {
      if (!wantedColumns.has(path)) this.columns.delete(path);
    }
  }

  _fieldIndexStatus(path) {
    if (this.indexes.has(path)) return this.indexDirtyRids.size ? "building" : "ready";
    const build = this.fieldBuilds.get(path);
    if (!build) return this.indexBuildPending ? "pending" : "missing";
    return build.status || "building";
  }

  _startFieldIndexBuild(paths) {
    const targets = [];
    for (const path of paths) {
      this.indexes.delete(path);
      const build = {
        path,
        status: "building",
        pending: new Map(),
        error: null,
        startedAt: new Date().toISOString(),
        promise: null,
      };
      this.fieldBuilds.set(path, build);
      targets.push(build);
    }
    if (!targets.length) return null;

    const promise = this.derivedStateScheduler.schedule(
      `field-index:${this.name}:${targets.map((target) => target.path).join(",")}`,
      (job) => this._runFieldIndexBuild(targets, job),
      { owner: this.derivedStateOwner },
    );
    for (const target of targets) target.promise = promise;
    promise.catch(() => {});
    return promise;
  }

  async _runFieldIndexBuild(targets, job) {
    if (this.disposed) return;
    const built = new Map(targets.map((target) => [target.path, new FieldIndex(target.path)]));
    try {
      let scanned = 0;
      for (const rid of this._liveRidIterator()) {
        if (this.disposed) return;
        const object = this.readRidForQuery(rid);
        if (object) {
          for (const target of targets) {
            if (this.fieldBuilds.get(target.path) === target) {
              built.get(target.path)?.addValue(rid, getPathValue(object, target.path));
            }
          }
        }
        scanned++;
        if (scanned % FIELD_BUILD_BATCH_SIZE === 0) await job.checkpoint(scanned);
      }

      for (const target of targets) {
        if (this.fieldBuilds.get(target.path) !== target) continue;
        const index = built.get(target.path);
        if (!index) continue;
        for (const [rid, change] of target.pending) {
          if (change.before !== NO_VALUE) index.removeValue(rid, change.before);
          if (change.after !== NO_VALUE) index.addValue(rid, change.after);
        }
        this.indexes.set(target.path, index);
        this.fieldBuilds.delete(target.path);
      }
    } catch (error) {
      for (const target of targets) {
        if (this.fieldBuilds.get(target.path) !== target) continue;
        target.status = "error";
        target.error = error?.message || String(error);
        target.pending = new Map();
      }
      throw error;
    }
  }

  _recordFieldBuildDelta(rid, before, after) {
    if (!this.fieldBuilds.size) return;
    for (const build of this.fieldBuilds.values()) {
      if (build.status !== "building") continue;
      const current = build.pending.get(rid);
      build.pending.set(rid, {
        before: current ? current.before : (before ? getPathValue(before, build.path) : NO_VALUE),
        after: after ? getPathValue(after, build.path) : NO_VALUE,
      });
    }
  }

  _applyMetaColumns(options = {}) {
    const rebuild = options.rebuild === true;
    const wanted = new Set(this.collectionMeta.columns);
    for (const path of [...this.columns.keys()]) {
      if (!wanted.has(path)) this.columns.delete(path);
    }

    const toBuild = [];
    for (const path of wanted) {
      let column = this.columns.get(path);
      const created = !column;
      if (!column) {
        column = new TypedRidColumn(path);
        this.columns.set(path, column);
      }
      if (this.liveCount === 0) {
        const buildId = column.startBuild();
        column.install(new TypedRidColumn(path), buildId);
      }
      else if (created || rebuild || column.status === "error") toBuild.push(path);
    }

    if (toBuild.length) this._startColumnBuild(toBuild);
  }

  _rebuildColumns() {
    const paths = [...this.columns.keys()];
    if (!paths.length) return;
    if (this.liveCount === 0) {
      for (const column of this.columns.values()) {
        const buildId = column.startBuild();
        column.install(new TypedRidColumn(column.path), buildId);
      }
      return;
    }
    this._startColumnBuild(paths);
  }

  _startColumnBuild(paths) {
    const targets = [];
    for (const path of paths) {
      const column = this.columns.get(path);
      if (!column) continue;
      const buildId = column.startBuild();
      targets.push({ path, buildId });
    }
    if (!targets.length) return null;

    const build = this.derivedStateScheduler.schedule(
      `column:${this.name}:${targets.map((target) => target.path).join(",")}`,
      (job) => this._runColumnBuild(targets, job),
      { owner: this.derivedStateOwner },
    );
    this.columnBuilds.add(build);
    build.then(
      () => this.columnBuilds.delete(build),
      () => this.columnBuilds.delete(build),
    );
    return build;
  }

  async _runColumnBuild(targets, job) {
    if (this.disposed) return;
    const paths = targets.map((target) => target.path);
    const built = new Map(paths.map((path) => [path, new TypedRidColumn(path)]));
    try {
      let scanned = 0;
      for (const rid of this._liveRidIterator()) {
        if (this.disposed) return;
        const object = this.readRidForQuery(rid);
        if (object) {
          for (const path of paths) {
            const column = built.get(path);
            if (!column) continue;
            column.updateScalarState(rid, columnScalarState(getPathValue(object, path)));
          }
        }
        scanned++;
        if (scanned % COLUMN_BUILD_BATCH_SIZE === 0) await job.checkpoint(scanned);
      }

      const installedPaths = [];
      for (const { path, buildId } of targets) {
        const target = this.columns.get(path);
        const column = built.get(path);
        if (target && column && target.install(column, buildId)) installedPaths.push(path);
      }
      await this._stripBaseValuesForColumns(installedPaths, job);
    } catch (error) {
      for (const { path, buildId } of targets) {
        const column = this.columns.get(path);
        if (column) column.fail(error, buildId);
      }
    }
  }

  async _stripBaseValuesForColumns(paths = [], job = null) {
    if (!paths.length) return;
    let scanned = 0;
    for (const rid of this._liveRidIterator()) {
      if (this.disposed) return;
      const object = this.readRidForQuery(rid);
      if (object) this._rewriteBaseValueForColumns(rid, object, paths);
      scanned++;
      if (scanned % COLUMN_BUILD_BATCH_SIZE === 0 && job) await job.checkpoint(scanned);
    }
  }

  _executeAggregatePlan(plan, criteria, spec) {
    switch (plan.path) {
      case AGGREGATE_PATH.COLUMN_SUMMARY:
        return this._aggregateFlatFromColumnSummary(spec, plan.normalized, plan.columns);
      case AGGREGATE_PATH.COLUMN_SCAN:
        return finishFlatColumnAggregate(
          scanFlatColumnAggregate(this._ridsForPlan(plan.idPlan, criteria), plan.normalized, plan.columns),
          spec,
          plan.normalized,
        );
      case AGGREGATE_PATH.GROUP_FORWARD_INDEX:
        return this._aggregateGroupForwardIndex(plan, criteria, spec);
      case AGGREGATE_PATH.GROUP_INDEX:
        return this._aggregateGroupIndex(plan, criteria, spec);
      case AGGREGATE_PATH.GROUP_COLUMN_SCAN: {
        const grouped = scanGroupedColumnAggregate(this._ridsForPlan(plan.idPlan, criteria), plan.normalized, plan.columns);
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
      const filterIds = plan.idPlan?.verify ? this._ridSetForPlan(plan.idPlan, criteria) : plan.idPlan?.ids || null;
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

    const filterIds = this._ridSetForPlan(plan.idPlan, criteria);
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
      this._ridsForPlan(plan.idPlan, criteria),
      plan.normalized,
      plan.groupBy,
      plan.groupIndex,
      plan.columns,
    );
    return finishGroupedColumnAggregate(grouped, spec, plan.normalized);
  }

  _findWithOrderedIndex(criteria, options, plan = this._planRead(criteria, options)) {
    const index = this.indexes.get(String(options.sortBy));
    if (!index) return null;
    const filterProven = Boolean(plan.idPlan && !plan.idPlan.verify && plan.path !== READ_PATH.SCAN);
    const includeId = typeof options.includeId === "function" ? options.includeId : null;
    return index.find({
      candidateIds: plan.idPlan?.ids || null,
      includeRid: includeId ? (rid) => includeId(this._idForRid(rid)) : null,
      desc: options.sort === "desc",
      offset: options.offset || 0,
      limit: options.limit ?? Infinity,
      read: (rid) => this.readRidForQuery(rid),
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
    const build = this.derivedStateScheduler.schedule(
      `vector-index:${this.name}:${indexKey}`,
      (job) => this._runVectorIndexBuild(indexKey, entry, job),
      { owner: this.derivedStateOwner },
    );
    entry.promise = build;
    this.vectorBuilds.add(build);
    build.then(
      () => this.vectorBuilds.delete(build),
      () => this.vectorBuilds.delete(build),
    );
    return build;
  }

  async _runVectorIndexBuild(indexKey, entry, job) {
    if (this.disposed) return;
    try {
      for (const [id, vector] of this.vectors) {
        if (this.disposed) return;
        entry.scanned++;
        if (!entry.includeId || entry.includeId(id)) {
          entry.index.insert(id, vector);
          entry.inserted++;
        }
        if (entry.scanned % VECTOR_BUILD_BATCH_SIZE === 0) await job.checkpoint(entry.scanned);
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
    if (!this.vectorIndexes.size) return "pending";
    let building = false;
    for (const entry of this.vectorIndexes.values()) {
      if (entry.status === "failed") return "failed";
      if (entry.status === "building") building = true;
    }
    return building ? "building" : "ready";
  }
}

function createPhysicalStore(options = {}) {
  const engine = options.engine || "shape";
  if (engine === "shape") return new ShapeStore();
  if (engine === "object") return new ObjectRowStore(options.object);
  throw new TypeError(`unsupported storage engine: ${engine}`);
}

class RidBitmapQueue {
  constructor() {
    this.bits = new Uint8Array(0);
    this.queue = [];
    this.head = 0;
    this.size = 0;
  }

  add(rid) {
    if (!Number.isInteger(rid) || rid < 0) return false;
    this._ensure(rid);
    if (this.bits[rid]) return false;
    this.bits[rid] = 1;
    this.size++;
    this.queue.push(rid);
    return true;
  }

  delete(rid) {
    if (!Number.isInteger(rid) || rid < 0 || rid >= this.bits.length || !this.bits[rid]) return false;
    this.bits[rid] = 0;
    this.size--;
    if (this.size === 0) this._compactQueue();
    return true;
  }

  has(rid) {
    return Number.isInteger(rid) && rid >= 0 && rid < this.bits.length && this.bits[rid] === 1;
  }

  clear() {
    this.bits.fill(0);
    this.queue = [];
    this.head = 0;
    this.size = 0;
  }

  take(limit = Infinity) {
    const max = Math.max(0, Math.floor(Number(limit) || 0));
    if (max <= 0 || this.size <= 0) return [];
    const out = [];
    while (out.length < max && this.head < this.queue.length) {
      const rid = this.queue[this.head++];
      if (this.has(rid)) out.push(rid);
    }
    this._compactQueue();
    return out;
  }

  *[Symbol.iterator]() {
    for (let i = this.head; i < this.queue.length; i++) {
      const rid = this.queue[i];
      if (this.has(rid)) yield rid;
    }
  }

  _ensure(rid) {
    if (rid < this.bits.length) return;
    let next = this.bits.length || 1024;
    while (next <= rid) next *= 2;
    const bits = new Uint8Array(next);
    bits.set(this.bits);
    this.bits = bits;
  }

  _compactQueue() {
    if (this.size === 0) {
      this.queue = [];
      this.head = 0;
      return;
    }
    if (this.head < 4096 || this.head * 2 < this.queue.length) return;
    this.queue = this.queue.slice(this.head);
    this.head = 0;
  }
}

class FieldIndex {
  constructor(path) {
    this.path = String(path);
    this.lookup = new Map();
    this.ordered = new Map();
    this.forward = new Map();
    this.containsStringRids = new Set();
    this.containsScalarRids = new Set();
    this.containsNestedArrayRids = new Set();
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

  addValue(rid, value) {
    if (!Number.isInteger(rid)) return;
    this.forward.set(rid, value);
    for (const key of indexedStoredValues(value).map(indexValueKey)) {
      const rids = this.lookup.get(key) || new Set();
      rids.add(rid);
      this.lookup.set(key, rids);
    }
    this._addOrdered(rid, value);
    this._addContainsState(rid, value);
  }

  removeValue(rid, value) {
    this.forward.delete(rid);
    for (const key of indexedStoredValues(value).map(indexValueKey)) {
      const rids = this.lookup.get(key);
      rids?.delete(rid);
      if (rids?.size === 0) this.lookup.delete(key);
    }
    this._removeOrdered(rid, value);
    this._removeContainsState(rid, value);
  }

  removeRid(rid) {
    if (!this.forward.has(rid)) return;
    this.removeValue(rid, this.forward.get(rid));
  }

  idsForValues(values) {
    const unique = uniqueIndexValues(values);
    if (unique.length === 1) return this.lookup.get(indexValueKey(unique[0])) || new Set();
    let ids = new Set();
    for (const value of unique) ids = setUnion(ids, this.lookup.get(indexValueKey(value)) || new Set());
    return ids;
  }

  idsForContains(value) {
    if (!isScalarIndexValue(value)) return null;
    if (this.containsStringRids.size || this.containsScalarRids.size || this.containsNestedArrayRids.size) return null;
    return this.lookup.get(indexValueKey(value)) || new Set();
  }

  valueForRid(rid) {
    return this.forward.get(rid);
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

  find({ candidateIds, includeRid, desc = false, offset = 0, limit = Infinity, read, matches }) {
    if (limit <= 0) return [];
    const results = [];
    let skipped = 0;
    for (const rid of this.orderedIds(desc)) {
      if (candidateIds && !candidateIds.has(rid)) continue;
      if (includeRid && !includeRid(rid)) continue;
      const object = read(rid);
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

  _addOrdered(rid, value) {
    const key = orderedValueKey(value);
    let bucket = this.ordered.get(key);
    if (!bucket) {
      bucket = { value, ids: new Set() };
      this.ordered.set(key, bucket);
      this.sortedOrderedKeys = null;
    }
    bucket.ids.add(rid);
  }

  _removeOrdered(rid, value) {
    const key = orderedValueKey(value);
    const bucket = this.ordered.get(key);
    bucket?.ids.delete(rid);
    if (bucket?.ids.size === 0) {
      this.ordered.delete(key);
      this.sortedOrderedKeys = null;
    }
  }

  _addContainsState(rid, value) {
    if (typeof value === "string") this.containsStringRids.add(rid);
    else if (typeof value === "number" || typeof value === "boolean") this.containsScalarRids.add(rid);
    else if (Array.isArray(value) && value.some(Array.isArray)) this.containsNestedArrayRids.add(rid);
  }

  _removeContainsState(rid, value) {
    if (typeof value === "string") this.containsStringRids.delete(rid);
    else if (typeof value === "number" || typeof value === "boolean") this.containsScalarRids.delete(rid);
    else if (Array.isArray(value) && value.some(Array.isArray)) this.containsNestedArrayRids.delete(rid);
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

class TypedRidColumn {
  constructor(path) {
    this.path = String(path);
    this.numberValues = new Float64Array(0);
    this.numberPresent = new Uint8Array(0);
    this.booleanValues = new Uint8Array(0);
    this.booleanPresent = new Uint8Array(0);
    this.stringCodes = new Uint32Array(0);
    this.nulls = new Uint8Array(0);
    this.strings = [];
    this.stringIds = new Map();
    this.stringRefs = [];
    this.freeStringCodes = [];
    this.overflow = new Map();
    this.pending = null;
    this.status = "ready";
    this.error = null;
    this.buildId = 0;
    this.numberSum = 0;
    this.numberCount = 0;
    this.scalarCount = 0;
    this.nullCount = 0;
  }

  get ready() {
    return this.status === "ready";
  }

  get entries() {
    return this.scalarCount + this.nullCount + this.overflow.size;
  }

  get scalarEntries() {
    return this.scalarCount;
  }

  get nonScalarEntries() {
    return this.overflow.size;
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

  install(source, buildId) {
    if (buildId !== this.buildId) return false;
    this.numberValues = source.numberValues;
    this.numberPresent = source.numberPresent;
    this.booleanValues = source.booleanValues;
    this.booleanPresent = source.booleanPresent;
    this.stringCodes = source.stringCodes;
    this.nulls = source.nulls;
    this.strings = source.strings;
    this.stringIds = source.stringIds;
    this.stringRefs = source.stringRefs;
    this.freeStringCodes = source.freeStringCodes;
    this.overflow = source.overflow;
    this.numberSum = source.numberSum;
    this.numberCount = source.numberCount;
    this.scalarCount = source.scalarCount;
    this.nullCount = source.nullCount;
    const pending = this.pending || new Map();
    for (const [rid, state] of pending) this._applyState(rid, state);
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

  updateScalarState(rid, state) {
    if (this.status === "building") {
      this.pending.set(rid, state);
      return;
    }
    this._applyState(rid, state);
  }

  remove(rid) {
    this.updateScalarState(rid, { kind: "absent" });
  }

  hasScalar(rid) {
    return Boolean(
      this.numberPresent[rid] ||
        this.booleanPresent[rid] ||
        this.stringCodes[rid],
    );
  }

  hasNonScalar(rid) {
    return this.overflow.has(rid);
  }

  hasValue(rid) {
    return this.hasScalar(rid) || this.hasNonScalar(rid) || this.nulls[rid] === 1;
  }

  valueFor(rid) {
    if (this.numberPresent[rid]) return this.numberValues[rid];
    if (this.booleanPresent[rid]) return this.booleanValues[rid] === 1;
    const code = this.stringCodes[rid] || 0;
    if (code) return this.strings[code - 1];
    if (this.nulls[rid]) return null;
    if (this.overflow.has(rid)) return clone(this.overflow.get(rid));
    return undefined;
  }

  _applyState(rid, state) {
    if (!Number.isInteger(rid) || rid < 0) return;
    this._clearRid(rid);
    if (state.kind === "absent") {
      this._resetIfEmpty();
      return;
    }
    this._ensure(rid);
    if (state.kind === "null") {
      this.nulls[rid] = 1;
      this.nullCount++;
      return;
    }
    if (state.kind === "scalar") {
      this._setScalar(rid, state.value);
      return;
    }
    if (state.kind === "nonScalar") this.overflow.set(rid, clone(state.value));
  }

  _setScalar(rid, value) {
    if (typeof value === "number") {
      this.numberValues[rid] = value;
      this.numberPresent[rid] = 1;
      this.numberSum += value;
      this.numberCount++;
      this.scalarCount++;
      return;
    }
    if (typeof value === "boolean") {
      this.booleanValues[rid] = value ? 1 : 0;
      this.booleanPresent[rid] = 1;
      this.scalarCount++;
      return;
    }
    if (typeof value === "string") {
      this.stringCodes[rid] = this._stringCode(value);
      this.scalarCount++;
    }
  }

  _clearRid(rid) {
    if (rid < this.numberPresent.length && this.numberPresent[rid]) {
      this.numberPresent[rid] = 0;
      this.numberSum -= this.numberValues[rid];
      this.numberValues[rid] = 0;
      this.numberCount--;
      this.scalarCount--;
    }
    if (rid < this.booleanPresent.length && this.booleanPresent[rid]) {
      this.booleanPresent[rid] = 0;
      this.booleanValues[rid] = 0;
      this.scalarCount--;
    }
    if (rid < this.stringCodes.length && this.stringCodes[rid]) {
      const code = this.stringCodes[rid];
      const index = code - 1;
      const refs = (this.stringRefs[index] || 1) - 1;
      this.stringRefs[index] = refs;
      if (refs === 0) {
        const value = this.strings[index];
        if (this.stringIds.get(value) === code) this.stringIds.delete(value);
        this.strings[index] = undefined;
        this.freeStringCodes.push(code);
      }
      this.stringCodes[rid] = 0;
      this.scalarCount--;
    }
    if (rid < this.nulls.length && this.nulls[rid]) {
      this.nulls[rid] = 0;
      this.nullCount--;
    }
    this.overflow.delete(rid);
  }

  _stringCode(value) {
    let code = this.stringIds.get(value);
    if (code) {
      this.stringRefs[code - 1]++;
      return code;
    }
    code = this.freeStringCodes.pop() || this.strings.length + 1;
    this.strings[code - 1] = value;
    this.stringRefs[code - 1] = 1;
    this.stringIds.set(value, code);
    return code;
  }

  _resetIfEmpty() {
    if (this.scalarCount || this.nullCount || this.overflow.size) return;
    this.numberValues = new Float64Array(0);
    this.numberPresent = new Uint8Array(0);
    this.booleanValues = new Uint8Array(0);
    this.booleanPresent = new Uint8Array(0);
    this.stringCodes = new Uint32Array(0);
    this.nulls = new Uint8Array(0);
    this.strings = [];
    this.stringIds.clear();
    this.stringRefs = [];
    this.freeStringCodes = [];
    this.numberSum = 0;
    this.numberCount = 0;
    this.scalarCount = 0;
    this.nullCount = 0;
  }

  _ensure(rid) {
    if (rid < this.numberValues.length) return;
    let next = this.numberValues.length || 1024;
    while (next <= rid) next *= 2;
    this.numberValues = growTypedArray(this.numberValues, Float64Array, next);
    this.numberPresent = growTypedArray(this.numberPresent, Uint8Array, next);
    this.booleanValues = growTypedArray(this.booleanValues, Uint8Array, next);
    this.booleanPresent = growTypedArray(this.booleanPresent, Uint8Array, next);
    this.stringCodes = growTypedArray(this.stringCodes, Uint32Array, next);
    this.nulls = growTypedArray(this.nulls, Uint8Array, next);
  }
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
    const rawGroupValue = groupIndex.valueForRid(id);
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

function sortObjects(objects, options = {}) {
  const direction = options.sort === "desc" ? -1 : 1;
  return [...objects].sort((left, right) => {
    return compareSortValues(getPathValue(left, options.sortBy), getPathValue(right, options.sortBy)) * direction;
  });
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

const NO_VALUE = Symbol("no-value");

function columnScalarState(value) {
  if (isScalarColumnValue(value)) return { kind: "scalar", value };
  if (value === null) return { kind: "null" };
  if (value !== undefined) return { kind: "nonScalar", value };
  return { kind: "absent" };
}

function isScalarColumnValue(value) {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" || typeof value === "boolean";
}

function indexedStoredValues(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(indexedStoredValues);
  return isScalarIndexValue(value) ? [value] : [];
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

function uniqueIndexValues(values = []) {
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

function smallerSet(left, right) {
  return left.size <= right.size ? left : right;
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

function setUnion(left, right) {
  const out = new Set(left);
  for (const id of right) out.add(id);
  return out;
}

function normalizeShard(shard) {
  return typeof shard === "string" && shard.length > 0 ? shard : null;
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
  const next = clone(meta);
  delete next.columnIndexes;
  delete next.tiering;
  delete next.hooks;
  const indexes = normalizeIndexList(meta.indexes, "indexes");
  const columns = normalizeIndexList(meta.columns, "columns");
  const tiering = normalizeTieringMeta(meta.tiering);
  const hooks = normalizeObjectHooksMeta(meta.hooks);
  const out = {
    ...next,
    indexes,
    columns,
  };
  if (tiering) out.tiering = tiering;
  if (hooks) out.hooks = hooks;
  return out;
}

function normalizeTieringMeta(tiering) {
  if (tiering === undefined || tiering === null || tiering === false) return null;
  if (!tiering || typeof tiering !== "object" || Array.isArray(tiering)) {
    throw new TypeError("collection meta tiering must be a plain object");
  }
  const mode = tiering.mode === undefined ? "compressedMemory" : String(tiering.mode);
  if (mode === "off") return null;
  if (mode !== "compressedMemory") throw new TypeError("collection meta tiering.mode must be compressedMemory or off");
  const keep = normalizeIndexList(tiering.keep, "tiering.keep");
  const offload = normalizeIndexList(tiering.offload, "tiering.offload");
  if (keep.length && offload.length) throw new TypeError("collection meta tiering must use keep or offload, not both");
  const minBytes = Math.max(0, Math.floor(Number(tiering.minBytes ?? DEFAULT_TIERING_MIN_BYTES) || 0));
  return {
    mode: "compressedMemory",
    ...(keep.length ? { keep } : {}),
    ...(offload.length ? { offload } : {}),
    minBytes,
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

function splitTieredValue(value = {}, tiering = {}, forcedHotPaths = []) {
  if (!isPlainObject(value)) return { hot: value || {}, cold: null };
  const forced = unique(forcedHotPaths);
  if (Array.isArray(tiering.keep) && tiering.keep.length) {
    const hotPaths = unique([...tiering.keep, ...forced]);
    const hot = pickPaths(value, hotPaths);
    const cold = unsetPaths(value, hotPaths);
    return isRemovableEmptyObject(cold) ? { hot: value, cold: null } : { hot, cold };
  }

  if (!Array.isArray(tiering.offload) || !tiering.offload.length) return { hot: value, cold: null };
  let hot = unsetPaths(value, tiering.offload);
  let cold = pickPaths(value, tiering.offload);
  for (const path of forced) {
    const current = getPathValue(value, path);
    if (current === undefined) continue;
    hot = setPath(hot, path, clone(current));
    cold = unsetPath(cold, path);
  }
  return isRemovableEmptyObject(cold) ? { hot: value, cold: null } : { hot, cold };
}

function pickPaths(value = {}, paths = []) {
  let out = {};
  for (const path of paths) {
    const current = getPathValue(value, path);
    if (current !== undefined) out = setPath(out, path, clone(current));
  }
  return out;
}

function unsetPaths(value = {}, paths = []) {
  let out = clone(value || {});
  for (const path of paths) out = unsetPath(out, path);
  return out;
}

function mergePlainObjects(base = {}, overlay = {}) {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(overlay || {})) {
    out[key] = isPlainObject(value) && isPlainObject(out[key])
      ? mergePlainObjects(out[key], value)
      : value;
  }
  return out;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function queryObjectFromStoredValue(id, value = {}) {
  const { _id, ...rest } = value || {};
  return { ...rest, _id: id };
}

function setPath(object = {}, path, value) {
  const parts = pathParts(path);
  if (!parts.length) return object;
  const root = isPlainObject(object) ? { ...object } : {};
  let target = root;
  let source = isPlainObject(object) ? object : {};
  for (const part of parts.slice(0, -1)) {
    const current = isPlainObject(source?.[part]) ? source[part] : {};
    const next = { ...current };
    target[part] = next;
    target = next;
    source = current;
  }
  target[parts[parts.length - 1]] = value;
  return root;
}

function unsetPath(object = {}, path) {
  const parts = pathParts(path);
  if (!parts.length || !isPlainObject(object)) return object;
  const [next] = unsetPathParts(object, parts, 0);
  return next || {};
}

function unsetPathParts(value, parts, index) {
  if (!isPlainObject(value)) return [value, false];
  const key = parts[index];
  if (!Object.prototype.hasOwnProperty.call(value, key)) return [value, false];
  const next = { ...value };
  if (index === parts.length - 1) {
    delete next[key];
  } else {
    const [child, changed] = unsetPathParts(value[key], parts, index + 1);
    if (!changed) return [value, false];
    if (isRemovableEmptyObject(child)) delete next[key];
    else next[key] = child;
  }
  return [next, true];
}

function isRemovableEmptyObject(value) {
  return isPlainObject(value) && Object.keys(value).length === 0;
}

function pathParts(path) {
  return String(path || "").split(".").map((part) => part.trim()).filter(Boolean);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function growTypedArray(current, Type, length) {
  const next = new Type(length);
  next.set(current);
  return next;
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

function hasCollectionIndexReadiness(readiness = {}) {
  return Boolean(
    readiness.fieldIndexes?.length ||
      readiness.columns?.length ||
      hasVectorIndexValue(readiness.vector),
  );
}

function hasVectorIndexValue(vector = null) {
  return Boolean(
    Number(vector?.stored) > 0 ||
      Number(vector?.indexes) > 0 ||
      Number(vector?.nodes) > 0 ||
      (Array.isArray(vector?.indexStates) && vector.indexStates.length > 0) ||
      (vector?.status && vector.status !== "ready"),
  );
}

function heapUsageRatio() {
  const stats = getHeapStatistics();
  const limit = Number(stats.heap_size_limit) || 0;
  if (limit <= 0) return 0;
  return (Number(stats.used_heap_size) || 0) / limit;
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
    this.derivedStateScheduler = options.derivedStateScheduler || new DerivedStateScheduler(options.derivedState);
    this.collectionOptions = { ...options, derivedStateScheduler: this.derivedStateScheduler };
    this.dbs = new Map();
    this.databaseTombstones = new Set();
    this.collectionTombstones = new Set();
    this.bulkLoadDepth = 0;
    this.bulkLoadDirty = new Set();
    this.indexWarmupPending = new Set();
    this.indexWarmupRetryTimer = null;
  }

  db(name) {
    let d = this.dbs.get(name);
    if (!d) {
      d = new Database(name, this.collectionOptions);
      this.dbs.set(name, d);
    }
    return d;
  }

  collection(dbName, collName) {
    this.assertCollectionWritable(dbName, collName);
    return this.db(dbName).collection(collName);
  }

  getCollection(dbName, collName) {
    return this.dbs.get(dbName)?.collections.get(collName) || null;
  }

  isCollectionDeleted(dbName, collName) {
    return this.collectionTombstones.has(storeCollectionKey(dbName, collName));
  }

  isDatabaseDeleted(dbName) {
    return this.databaseTombstones.has(String(dbName));
  }

  assertCollectionWritable(dbName, collName) {
    if (this.isDatabaseDeleted(dbName)) {
      const error = new Error("database was deleted; create it explicitly before writing");
      error.status = 409;
      throw error;
    }
    if (!this.isCollectionDeleted(dbName, collName)) return;
    const error = new Error("collection was deleted; create it explicitly before writing");
    error.status = 409;
    throw error;
  }

  createDatabase(dbName, meta = {}) {
    this.databaseTombstones.delete(String(dbName));
    return this.db(dbName).setMeta(meta);
  }

  getDatabaseMeta(dbName) {
    const db = this.dbs.get(dbName);
    return db ? db.getMeta() : null;
  }

  setDatabaseMeta(dbName, meta = {}) {
    this.databaseTombstones.delete(String(dbName));
    return this.db(dbName).setMeta(meta);
  }

  hasDatabase(dbName) {
    return this.dbs.has(dbName);
  }

  deleteDatabase(dbName) {
    this.databaseTombstones.add(String(dbName));
    const db = this.dbs.get(dbName);
    if (!db) return false;
    for (const collection of db.collections.values()) this._disposeCollection(collection);
    return this.dbs.delete(dbName);
  }

  createCollection(dbName, collName, meta = {}) {
    this.collectionTombstones.delete(storeCollectionKey(dbName, collName));
    const collection = this.collection(dbName, collName);
    const next = collection.setMeta(meta, { deferIndexes: this.bulkLoadDepth > 0 });
    if (this.bulkLoadDepth > 0) this.bulkLoadDirty.add(collection);
    return next;
  }

  deleteCollection(dbName, collName) {
    this.collectionTombstones.add(storeCollectionKey(dbName, collName));
    const db = this.dbs.get(dbName);
    if (!db) return false;
    const collection = db.collections.get(collName);
    const removed = db.deleteCollection(collName);
    if (removed) this._disposeCollection(collection);
    return removed;
  }

  _disposeCollection(collection) {
    if (!collection) return;
    this.bulkLoadDirty.delete(collection);
    this.indexWarmupPending.delete(collection);
    collection.dispose?.();
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
    this.collectionTombstones.delete(storeCollectionKey(dbName, collName));
    const collection = this.collection(dbName, collName);
    const next = collection.setMeta(meta, { deferIndexes: this.bulkLoadDepth > 0 });
    if (this.bulkLoadDepth > 0) this.bulkLoadDirty.add(collection);
    return next;
  }

  awaitFieldIndexes(dbName, collName) {
    return this.collection(dbName, collName).awaitFieldIndexes();
  }

  awaitColumns(dbName, collName) {
    return this.collection(dbName, collName).awaitColumns();
  }

  async awaitIndexes(dbName, collName) {
    const collection = this.collection(dbName, collName);
    if (collection.indexBuildPending) collection.scheduleIndexBuildsFromMeta();
    await Promise.all([
      collection.awaitFieldIndexes(),
      collection.awaitColumns(),
      collection.awaitDirtyIndexes(),
    ]);
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
      if (this.isDatabaseDeleted(op.db) || this.isCollectionDeleted(op.db, op.coll)) continue;
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

  beginBulkLoad() {
    this.bulkLoadDepth++;
  }

  endBulkLoad() {
    if (this.bulkLoadDepth <= 0) return;
    this.bulkLoadDepth--;
    if (this.bulkLoadDepth > 0) return;
    const dirty = [...this.bulkLoadDirty];
    this.bulkLoadDirty.clear();
    for (const collection of dirty) {
      collection.rebuildCoreState();
      collection.indexBuildPending = true;
      this.indexWarmupPending.add(collection);
    }
  }

  startIndexWarmup() {
    if (!this.indexWarmupPending.size) return 0;
    if (heapUsageRatio() >= INDEX_WARMUP_MAX_HEAP_RATIO) {
      this._scheduleIndexWarmupRetry();
      return 0;
    }

    const collection = this.indexWarmupPending.values().next().value;
    this.indexWarmupPending.delete(collection);
    collection.scheduleIndexBuildsFromMeta();
    if (this.indexWarmupPending.size) this._scheduleIndexWarmupRetry();
    return 1;
  }

  _scheduleIndexWarmupRetry() {
    if (this.indexWarmupRetryTimer || !this.indexWarmupPending.size) return;
    this.indexWarmupRetryTimer = setTimeout(() => {
      this.indexWarmupRetryTimer = null;
      this.startIndexWarmup();
    }, INDEX_WARMUP_RETRY_MS);
    this.indexWarmupRetryTimer.unref?.();
  }

  applySnapshotObjects(dbName, collName, rows, options = {}) {
    if (this.isCollectionDeleted(dbName, collName)) return 0;
    const collection = this.collection(dbName, collName);
    const applied = collection.applySnapshotObjects(rows, {
      ...options,
      deferDerivedIndexes: this.bulkLoadDepth > 0,
    });
    if (applied && this.bulkLoadDepth > 0) this.bulkLoadDirty.add(collection);
    return applied;
  }

  readObjects(dbName, collName, ids) {
    return this.getCollection(dbName, collName)?.readObjects(ids) || [];
  }

  queryPath(dbName, collName, criteria = {}, options = {}) {
    return this.getCollection(dbName, collName)?.readPath(criteria, options) || READ_PATH.SCAN;
  }

  aggregatePath(dbName, collName, criteria = {}, spec = {}, options = {}) {
    return this.getCollection(dbName, collName)?.aggregatePath(criteria, spec, options) || AGGREGATE_PATH.SCAN;
  }

  validateWriteValue(dbName, collName, value = {}) {
    return this.collection(dbName, collName).validateWriteValue(value);
  }

  preserveVector(dbName, collName, id, value = {}) {
    return this.collection(dbName, collName).preserveVector(id, value);
  }

  getVector(dbName, collName, id) {
    return this.getCollection(dbName, collName)?.getVector(id) || null;
  }

  vectorSearch(dbName, collName, queryVec, limit = 20, options = {}) {
    try {
      return this.getCollection(dbName, collName)?.vectorSearch(queryVec, limit, options) || [];
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
        if (!hasVectorIndexValue(stats)) continue;
        out.push({ database: dbName, collection: collName, ...stats });
      }
    }
    return out;
  }

  vectorSummary() {
    const summary = {
      storedVectors: 0,
      activeIndexes: 0,
      warmingIndexes: 0,
      errors: 0,
    };
    for (const db of this.dbs.values()) {
      for (const collection of db.collections.values()) {
        summary.storedVectors += collection.vectors.size;
        summary.activeIndexes += collection.vectorIndexes.size;
        for (const index of collection.vectorIndexes.values()) {
          if (index.status === "error" || index.status === "failed") summary.errors++;
          else if (index.status !== "ready") summary.warmingIndexes++;
        }
      }
    }
    return summary;
  }

  compressionStats() {
    const collections = [];
    for (const [dbName, db] of this.dbs) {
      for (const [collName, collection] of db.collections) {
        const stats = collection.compressionStats();
        if (stats.mode === "off" && stats.compressedObjects === 0) continue;
        collections.push({ database: dbName, collection: collName, ...stats });
      }
    }
    return { ...summarizeCompression(collections), collections };
  }

  compressionSummary() {
    const summary = {
      collectionCount: 0,
      liveObjects: 0,
      compressedObjects: 0,
      uncompressedBytes: 0,
      compressedBytes: 0,
    };
    for (const db of this.dbs.values()) {
      for (const collection of db.collections.values()) {
        const { objects, uncompressedBytes, compressedBytes } = collection.compressionTotals;
        if (!collection.collectionMeta.tiering && objects === 0) continue;
        summary.collectionCount++;
        summary.liveObjects += collection.liveCount;
        summary.compressedObjects += objects;
        summary.uncompressedBytes += uncompressedBytes;
        summary.compressedBytes += compressedBytes;
      }
    }
    const savedBytes = summary.uncompressedBytes - summary.compressedBytes;
    return {
      ...summary,
      coveragePercent: percentOf(summary.compressedObjects, summary.liveObjects),
      savedBytes,
      savedPercent: percentOf(savedBytes, summary.uncompressedBytes),
    };
  }

  indexSummary() {
    const summary = { ready: 0, building: 0, error: 0, activeTasks: 0 };
    for (const db of this.dbs.values()) {
      for (const collection of db.collections.values()) {
        const readiness = collection.indexSummary();
        summary.activeTasks += readiness.activeTasks;
        if (!readiness.configured) continue;
        summary[readiness.status === "ready" ? "ready" : readiness.status === "building" ? "building" : "error"]++;
      }
    }
    return summary;
  }

  indexReadiness() {
    const collections = [];
    const workers = {
      fieldIndex: {
        type: "same_thread_task",
        active: 0,
        background: true,
      },
      columns: {
        type: "same_thread_task",
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
        workers.fieldIndex.active += readiness.workers.fieldIndex.active;
        workers.columns.active += readiness.workers.columns.active;
        workers.vectorIndex.active += readiness.workers.vectorIndex.active;
        if (hasCollectionIndexReadiness(readiness)) {
          collections.push({
            database: dbName,
            collection: collName,
            ...readiness,
          });
        }
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

function emptyCompressionTotals() {
  return { objects: 0, uncompressedBytes: 0, compressedBytes: 0 };
}

function storeCollectionKey(database, collection) {
  return `${String(database)}\0${String(collection)}`;
}

function matchesSnapshotName(name, expected) {
  return !expected || expected === "*" || expected === name;
}
