import { CRDTNode } from "./crdt.js";
import { applyPatchToObject, patchUnsetsPath } from "./patch.js";
import { firstQueryInteger, parseQuerySort, queryPageOffset, splitQueryControls } from "./query.js";
import { normalizeRefDepth } from "./references.js";
import { isValidVector } from "./vector.js";

export function createDatabaseWithRuntime(options = {}, runtime = {}) {
  return new LocalDatabase(options, runtime);
}

export class LocalDatabase {
  #node;

  constructor({ storage, vector } = {}, { compression, readHeapUsageRatio } = {}) {
    this.#node = new CRDTNode({
      storage: {
        ...(compression ? { compression } : {}),
        ...(readHeapUsageRatio ? { readHeapUsageRatio } : {}),
        ...(storage || {}),
      },
      vector,
      operationLog: false,
    });
    this.#node.startVectorIndexWarmup().catch(() => {});
  }

  database(name) {
    return new DatabaseHandle(this.#node, requiredName(name, "database"));
  }

  async listDatabases() {
    return { databases: this.#node.listDatabases() };
  }

  async createDatabase(name, { meta = {} } = {}) {
    return this.#node.createDatabase(requiredName(name, "database"), meta);
  }

  async ready() {
    this.#node.startIndexWarmup();
    for (const database of this.#node.listDatabases()) {
      for (const collection of this.#node.listCollections(database)) {
        await this.#node.awaitIndexes(database, collection);
      }
    }
    await this.#node.awaitVectorIndexes();
  }

  stats() {
    return {
      indexes: this.#node.indexReadiness(),
      compression: this.#node.compressionSummary(),
      vectors: this.#node.vectorSummary(),
    };
  }

  close() {
    this.#node.db.dispose();
  }
}

class DatabaseHandle {
  #node;
  #name;

  constructor(node, name) {
    this.#node = node;
    this.#name = name;
  }

  collection(name) {
    return new CollectionHandle(this.#node, this.#name, requiredName(name, "collection"));
  }

  async listCollections() {
    return { database: this.#name, collections: this.#node.listCollections(this.#name) };
  }

  async createCollection(name, meta = {}) {
    return this.#node.createCollection(this.#name, requiredName(name, "collection"), meta);
  }

  async getMeta() {
    return this.#node.getDatabaseMeta(this.#name);
  }

  async drop() {
    this.#node.removeDatabase(this.#name);
  }
}

class CollectionHandle {
  #node;
  #database;
  #name;

  constructor(node, database, name) {
    this.#node = node;
    this.#database = database;
    this.#name = name;
  }

  async get(id, options = {}) {
    return this.#node.get(this.#database, this.#name, requiredName(id, "object id"), {
      refDepth: normalizeRefDepth(options.refDepth, 1),
    });
  }

  async insert(object, options = {}) {
    const result = await this.insertMany([object], options);
    return result.items?.[0];
  }

  async insertMany(objects, options = {}) {
    assertArray(objects, "objects");
    if (options.minimal) {
      return { inserted: this.#node.insertManyCount(this.#database, this.#name, objects) };
    }
    const items = this.#node.insertMany(this.#database, this.#name, objects);
    return { inserted: items.length, items };
  }

  async replace(id, object, options = {}) {
    const result = await this.replaceMany([{ ...(object || {}), _id: requiredName(id, "object id") }], options);
    return result.items?.[0];
  }

  async replaceMany(objects, options = {}) {
    assertArray(objects, "objects");
    if (options.minimal) {
      return { replaced: this.#node.replaceManyCount(this.#database, this.#name, objects) };
    }
    return this.#node.replaceMany(this.#database, this.#name, objects);
  }

  async patch(id, patch, options = {}) {
    const result = await this.patchMany([{ ...(patch || {}), _id: requiredName(id, "object id") }], options);
    return result.items?.[0];
  }

  async patchMany(patches, options = {}) {
    assertArray(patches, "patches");
    const objects = [];
    const skipped = [];
    for (const patch of patches) {
      const id = requiredName(patch?._id, "object id");
      const current = this.#node.get(this.#database, this.#name, id, { refDepth: 0 });
      if (!current) {
        skipped.push(id);
        continue;
      }
      const { _id, ...body } = patch;
      const next = applyPatchToObject(current, body);
      const vectorField = this.#node.db.getCollection(this.#database, this.#name)?.vectorField;
      if (vectorField && patchUnsetsPath(body, vectorField)) next[vectorField] = null;
      objects.push({ ...next, _id: id });
    }
    if (!objects.length) return { updated: 0, skipped: options.minimal ? skipped.length : skipped, ...(options.minimal ? {} : { items: [] }) };
    if (options.minimal) {
      return {
        updated: this.#node.replaceManyCount(this.#database, this.#name, objects),
        skipped: skipped.length,
      };
    }
    const result = this.#node.replaceMany(this.#database, this.#name, objects);
    return { updated: result.replaced, skipped, items: result.items };
  }

  async remove(id) {
    await this.removeMany([id]);
  }

  async removeMany(ids, options = {}) {
    assertArray(ids, "ids");
    const normalized = ids.map((id) => requiredName(id?._id ?? id, "object id"));
    const result = this.#node.removeMany(this.#database, this.#name, normalized);
    return options.minimal
      ? { deleted: result.deleted, skipped: result.skipped.length }
      : result;
  }

  async find(query = {}, options = {}) {
    return this.search(query, options);
  }

  async search(query = {}, options = {}) {
    const { criteria, controls } = splitQueryControls(query);
    const readOptions = queryOptions(controls, options);
    if (controls.$aggregate !== undefined) {
      if (controls.$vector !== undefined) throw new TypeError("$aggregate and $vector are mutually exclusive");
      return this.#node.aggregate(this.#database, this.#name, criteria, controls.$aggregate);
    }
    if (controls.$vector !== undefined) {
      return this._vectorSearch(criteria, controls.$vector, readOptions);
    }
    return this.#node.find(this.#database, this.#name, criteria, readOptions);
  }

  async count(query = {}) {
    const { criteria } = splitQueryControls(query);
    return this.#node.count(this.#database, this.#name, criteria);
  }

  async *iterate(query = {}, options = {}) {
    if (query.$aggregate || query.$vector) throw new TypeError("iterate supports ordinary object queries only");
    const pageSize = positiveInteger(options.pageSize, 250);
    const limit = options.limit ?? Infinity;
    let offset = options.offset || 0;
    let emitted = 0;
    while (emitted < limit) {
      const size = Math.min(pageSize, limit - emitted);
      const rows = await this.search(query, { ...options, offset, limit: size });
      if (!rows.length) return;
      for (const row of rows) {
        yield row;
        emitted++;
      }
      if (rows.length < size) return;
      offset += rows.length;
    }
  }

  async getMeta() {
    return this.#node.getCollectionMeta(this.#database, this.#name);
  }

  async setMeta(meta) {
    return this.#node.setCollectionMeta(this.#database, this.#name, meta);
  }

  async drop() {
    this.#node.removeCollection(this.#database, this.#name);
  }

  async ready() {
    await this.#node.awaitIndexes(this.#database, this.#name);
    await this.#node.awaitVectorIndexes();
  }

  stats() {
    return {
      storage: this.#node.stats(this.#database, this.#name),
      indexes: this.#node.indexStats(this.#database, this.#name),
      compression: this.#node.db.getCollection(this.#database, this.#name)?.compressionStats() || null,
    };
  }

  _vectorSearch(criteria, value, options) {
    if (!value || typeof value !== "object" || !isValidVector(value.vector)) {
      throw new TypeError("$vector must contain a non-empty vector of finite numbers");
    }
    const limit = positiveInteger(value.limit, 20);
    let rows;
    if (Object.keys(criteria).length) {
      rows = this.#node.rankVectorRows(
        this.#database,
        this.#name,
        this.#node.find(this.#database, this.#name, criteria, { refDepth: 0 }),
        value.vector,
        limit,
      );
    } else {
      rows = this.#node.vectorSearch(this.#database, this.#name, value.vector, limit, { ef: value.ef })
        .map((hit) => {
          const object = this.#node.get(this.#database, this.#name, hit._id, { refDepth: 0 });
          return object ? { ...object, _score: hit._score } : null;
        })
        .filter(Boolean);
    }
    const depth = normalizeRefDepth(options.refDepth, 1);
    return depth > 0 ? rows.map((row) => this.#node.expandReferences(this.#database, row, depth)) : rows;
  }
}

function queryOptions(controls, options) {
  const sorted = parseQuerySort(options.sortBy ? undefined : controls.$sort);
  const limit = firstQueryInteger(options.limit, controls.$limit, controls.$pageSize);
  const offset = firstQueryInteger(
    options.offset,
    controls.$offset,
    controls.$skip,
    queryPageOffset(controls.$page, limit),
  );
  return {
    sortBy: options.sortBy || sorted.sortBy,
    sort: options.sort || sorted.sort,
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
    refDepth: normalizeRefDepth(options.refDepth ?? controls.$refDepth, 1),
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function requiredName(value, label) {
  if (value === undefined || value === null || String(value).length === 0) {
    throw new TypeError(`${label} must be non-empty`);
  }
  return String(value);
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
}
