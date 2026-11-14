import { ADAPTER_METHODS } from "./adapters.js";
import { objectValue, sameJSON } from "./values.js";
import { collectionPage } from "./collection-page.js";
export { objectValue } from "./values.js";
export { createServerAdapter } from "./adapters.js";
const clone = (value) => structuredClone(value);

// One store per connection. No database SDK handles escape the adapter.
export class ObjyStore {
  constructor(adapter, { pageSize = 50 } = {}) {
    if (!adapter)
      throw new Error("Connect to an OBJY server before opening a store.");
    for (const method of ADAPTER_METHODS)
      if (typeof adapter[method] !== "function")
        throw new Error(`Database adapter is missing ${method}.`);
    if (!Number.isInteger(pageSize) || pageSize < 1)
      throw new Error("Page size must be a positive integer.");
    this.adapter = adapter;
    this.connection = adapter.info;
    this.pageSize = pageSize;
    this.databases = [];
    this.queue = Promise.resolve();
    this.refreshErrors = new Map();
  }
  async open() {
    try {
      await this.adapter.open();
      await this.refresh();
      return this;
    } catch (error) {
      await this.adapter.close();
      throw error;
    }
  }
  getClusterStatus(options) {
    return this.adapter.getClusterStatus(options);
  }
  get refreshError() {
    return this.refreshErrors.values().next().value || null;
  }
  collectionRefreshError(database, collection) {
    return this.refreshErrors.get(JSON.stringify([database, collection]));
  }
  assertDatabase(name) {
    const db = this.databases.find((db) => db.name === name);
    if (!db) throw new Error(`Database "${name}" does not exist.`);
    return db;
  }
  assertCollection(database, name) {
    const c = this.assertDatabase(database).collections.find(
      (c) => c.name === name,
    );
    if (!c)
      throw new Error(`Collection "${name}" does not exist in "${database}".`);
    return c;
  }
  enqueue(operation) {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }
  mutate(operation, scope = null) {
    return this.enqueue(async () => {
      // A refresh failure must never turn a confirmed write into a retryable write.
      let result, failure;
      try {
        result = await operation();
      } catch (error) {
        failure = error;
      }
      if (scope) {
        const key = JSON.stringify(scope);
        try {
          await this._refreshScope(scope);
          this.refreshErrors.delete(key);
        } catch (error) {
          this.refreshErrors.set(key, error);
        }
      }
      if (failure) throw failure;
      return result;
    });
  }
  createDatabase(name, meta = {}) {
    return this.mutate(async () => {
      if ((await this.adapter.listDatabases()).includes(name))
        throw new Error(`Database "${name}" already exists.`);
      return this.adapter.createDatabase(name, clone(objectValue(meta)));
    }, []);
  }
  createCollections(database, names) {
    if (
      !Array.isArray(names) ||
      !names.length ||
      names.some((name) => typeof name !== "string" || !name.trim())
    )
      throw new Error("Provide collection names.");
    return this.mutate(async () => {
      this.assertDatabase(database);
      const existing = await this.adapter.listCollections(database);
      const added = [...new Set(names)].filter(
        (name) => !existing.includes(name),
      );
      const completed = [];
      try {
        for (const name of added) {
          await this.adapter.createCollection(database, name);
          completed.push(name);
        }
      } catch (error) {
        if (completed.length) {
          error.message = `Created collections: ${completed.join(", ")}. ${error.message} Inspect the database before repeating this request.`;
          error.writeMayHaveSucceeded = true;
        }
        throw error;
      }
      return added;
    }, [database]);
  }
  insertObjects(database, collection, objects) {
    if (!Array.isArray(objects) || !objects.length)
      throw new Error("Provide an object or a nonempty array of objects.");
    objects.forEach(objectValue);
    return this.mutate(() => {
      this.assertCollection(database, collection);
      return this.adapter.insertMany(database, collection, clone(objects));
    }, [database, collection]);
  }
  patchObject(database, collection, id, patch) {
    objectValue(patch);
    if (Object.keys(patch).some((k) => !["$set", "$unset"].includes(k)))
      throw new Error("Use $set and/or $unset for a partial update.");
    if (patch.$set !== undefined) objectValue(patch.$set);
    const paths = [
      ...Object.keys(patch.$set || {}),
      ...(Array.isArray(patch.$unset)
        ? patch.$unset
        : Object.keys(patch.$unset || {})),
    ];
    if (
      paths.some(
        (path) => typeof path !== "string" || path.split(".")[0] === "_id",
      )
    )
      throw new Error("_id identifies the object and cannot be patched.");
    if (
      paths.some((path) =>
        path
          .split(".")
          .some((key) =>
            ["__proto__", "constructor", "prototype"].includes(key),
          ),
      )
    )
      throw new Error("Unsafe property path.");
    return this.mutate(async () => {
      this.assertCollection(database, collection);
      if (!(await this.adapter.get(database, collection, id)))
        throw new Error("Object not found. Use its exact _id.");
      return this.adapter.patch(database, collection, id, clone(patch));
    }, [database, collection]);
  }
  insertFile(database, collection, object, file) {
    objectValue(object);
    return this.mutate(() => {
      this.assertCollection(database, collection);
      return this.adapter.insertFile(database, collection, clone(object), file);
    }, [database, collection]);
  }
  replaceFile(database, collection, id, file, { expected } = {}) {
    return this.mutate(async () => {
      this.assertCollection(database, collection);
      const current = await this.adapter.get(database, collection, id);
      if (!current) throw new Error("Object not found.");
      if (expected !== undefined && !sameJSON(current, expected))
        throw new Error("Object changed on the server. Refresh before replacing its file.");
      // Multipart replacement expects the object's data, without its old server-owned pointer.
      const { _file, ...object } = current;
      return this.adapter.replaceFile(database, collection, id, object, file);
    }, [database, collection]);
  }
  downloadFile(database, collection, id, options) {
    return this.enqueue(() => {
      this.assertCollection(database, collection);
      return this.adapter.downloadFile(database, collection, id, options);
    });
  }
  replaceObject(database, collection, id, object, { expected } = {}) {
    objectValue(object);
    if (Object.hasOwn(object, "_id") && object._id !== id)
      throw new Error("_id cannot be changed.");
    return this.mutate(async () => {
      this.assertCollection(database, collection);
      const current = await this.adapter.get(database, collection, id);
      if (!current) throw new Error("Object not found.");
      if (expected !== undefined && !sameJSON(current, expected))
        throw new Error(
          "Object changed on the server. Use Undo to load the latest version before editing again.",
        );
      return this.adapter.replace(database, collection, id, clone(object));
    }, [database, collection]);
  }
  removeObjects(database, collection, ids, { expected } = {}) {
    return this.mutate(async () => {
      this.assertCollection(database, collection);
      if (expected !== undefined) {
        if (ids.length !== 1)
          throw new Error("An expected object requires exactly one ID.");
        const current = await this.adapter.get(database, collection, ids[0]);
        if (!current || !sameJSON(current, expected))
          throw new Error(
            "Object changed or was deleted on the server. Use Undo to load the latest version.",
          );
      }
      return this.adapter.removeMany(database, collection, ids);
    }, [database, collection]);
  }
  query(database, collection, query = {}, options = {}) {
    return this.enqueue(() => {
      this.assertCollection(database, collection);
      return this.adapter.search(database, collection, objectValue(query), {
        refDepth: 0,
        ...options,
      });
    });
  }
  getMeta(database, collection) {
    return this.enqueue(() => {
      this.assertCollection(database, collection);
      return this.adapter.getMeta(database, collection);
    });
  }
  setMeta(database, collection, meta, { expected } = {}) {
    return this.mutate(async () => {
      this.assertCollection(database, collection);
      if (
        expected !== undefined &&
        !sameJSON(await this.adapter.getMeta(database, collection), expected)
      )
        throw new Error(
          "Collection metadata changed on the server. Close and reopen this editor to load the latest version.",
        );
      return this.adapter.setMeta(
        database,
        collection,
        clone(objectValue(meta)),
      );
    });
  }
  dropCollection(database, collection) {
    return this.mutate(async () => {
      this.assertCollection(database, collection);
      await this.adapter.dropCollection(database, collection);
      this.databases = this.databases.map((db) => db.name !== database ? db : {
        ...db, collections: db.collections.filter((c) => c.name !== collection),
      });
      this.refreshErrors.delete(JSON.stringify([database, collection]));
    }, [database]);
  }
  dropDatabase(database) {
    return this.mutate(async () => {
      this.assertDatabase(database);
      await this.adapter.dropDatabase(database);
      this.databases = this.databases.filter((db) => db.name !== database);
      for (const key of this.refreshErrors.keys())
        if (key !== "full" && JSON.parse(key)[0] === database)
          this.refreshErrors.delete(key);
    }, []);
  }
  _replaceCollection(database, collection, page) {
    this.databases = this.databases.map((db) =>
      db.name !== database
        ? db
        : {
            ...db,
            collections: db.collections.map((c) =>
              c.name !== collection ? c : { ...c, ...page },
            ),
          },
    );
  }
  loadCollection(database, collection, { more = false, query } = {}) {
    const supplied =
      query === undefined
        ? undefined
        : query === null
          ? null
          : clone(objectValue(query));
    return this.enqueue(async () => {
      const current = this.assertCollection(database, collection);
      const append =
        more &&
        supplied === undefined &&
        current.loaded &&
        !current.directQuery;
      if (append && !current.hasMore) return current;
      const selected =
        supplied === undefined
          ? current.query || null
          : supplied && Object.keys(supplied).length
            ? supplied
            : null;
      const page = await collectionPage(
        this.adapter,
        database,
        collection,
        this.pageSize,
        selected,
        { previous: append ? current : undefined },
      );
      this._replaceCollection(database, collection, page);
      if (!append)
        this.refreshErrors.delete(JSON.stringify([database, collection]));
      return page;
    });
  }
  refresh() {
    return this.enqueue(async () => {
      try {
        this.databases = await this._catalog(true);
        this.refreshErrors.clear();
      } catch (error) {
        this.refreshErrors.set("full", error);
        throw error;
      }
    });
  }
  async _refreshScope([database, collection]) {
    if (collection !== undefined) {
      const current = this.assertCollection(database, collection);
      if (current.loaded)
        this._replaceCollection(
          database,
          collection,
          await this._reloadCollection(database, current),
        );
    } else if (database !== undefined) {
      const next = await this._database(database);
      this.databases = this.databases.map((db) =>
        db.name === database ? next : db,
      );
    } else this.databases = await this._catalog(false);
  }
  _reloadCollection(database, current) {
    return collectionPage(
      this.adapter,
      database,
      current.name,
      Math.max(this.pageSize, current.nextOffset || current.objects.length),
      current.query || null,
    );
  }
  async _database(name, reload = false) {
    const previous = new Map(
      this.databases
        .find((db) => db.name === name)
        ?.collections.map((c) => [c.name, c]),
    );
    const collections = [];
    for (const collection of await this.adapter.listCollections(name)) {
      const current = previous.get(collection);
      const page =
        reload && current?.loaded
          ? await this._reloadCollection(name, current)
          : current || {
              objects: [],
              count: null,
              loaded: false,
              hasMore: false,
            };
      collections.push({ id: collection, name: collection, ...page });
    }
    return { id: name, name, collections };
  }
  async _catalog(reload) {
    const previous = new Map(this.databases.map((db) => [db.name, db])),
      databases = [];
    for (const name of await this.adapter.listDatabases()) {
      databases.push(
        !reload && previous.has(name)
          ? previous.get(name)
          : await this._database(name, reload),
      );
    }
    // Callers commit only complete snapshots; failed reads retain the previous view.
    return databases;
  }
  async close() {
    await this.queue;
    await this.adapter.close();
  }
}
