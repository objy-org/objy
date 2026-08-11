import { json, readJson } from "../http-router.js";
import { splitQueryControls } from "../query.js";

export function createPublicObjectInterface() {
  return {
    name: "public-object",
    register(router, { node, auth }) {
      const secure = secureRoute(auth);

      router.get("/api/databases", secure((req, res) => {
        const databases = node.listDatabases().sort();
        if (auth.enabled && req.auth?.claims?.globalUser !== true) {
          return json(res, 200, { databases: databases.filter((database) => database === req.auth?.claims?.database) });
        }
        json(res, 200, { databases });
      }));

      router.post("/api/databases", secure(async (req, res) => {
        if (auth.enabled && req.auth?.claims?.globalUser !== true) {
          return json(res, 403, { error: "global user token required" });
        }
        const body = await readJson(req);
        const name = body?.name;
        if (typeof name !== "string" || name.length === 0) {
          return json(res, 400, { error: "body.name must be a non-empty string" });
        }
        if (body.meta !== undefined && !isPlainObject(body.meta)) {
          return json(res, 400, { error: "body.meta must be a plain object" });
        }
        const created = node.getDatabaseMeta(name) === null;
        try {
          const meta = node.createDatabase(name, body.meta || {});
          json(res, created ? 201 : 200, { name, created, meta });
        } catch (err) {
          json(res, 400, { error: err.message });
        }
      }));

      router.get("/api/:database/collections", secure((req, res) => {
        json(res, 200, {
          database: req.params.database,
          collections: node.listCollections(req.params.database).sort(),
        });
      }));

      router.post("/api/:database/collections", secure(async (req, res) => {
        const body = await readJson(req);
        const name = body?.name;
        if (typeof name !== "string" || name.length === 0) {
          return json(res, 400, { error: "body.name must be a non-empty string" });
        }
        const created = node.getCollectionMeta(req.params.database, name) === null;
        try {
          const meta = node.createCollection(req.params.database, name, collectionMetaFromBody(body));
          json(res, created ? 201 : 200, { name, created, meta });
        } catch (err) {
          json(res, 400, { error: err.message });
        }
      }));

      router.delete("/api/:database/collections/:collection", secure((req, res) => {
        const removed = node.removeCollection(req.params.database, req.params.collection);
        if (!removed) return json(res, 404, { error: "collection not found" });
        json(res, 204);
      }));

      router.get("/api/:database/:collection/meta", secure((req, res) => {
        const meta = node.getCollectionMeta(req.params.database, req.params.collection);
        if (!meta) {
          json(res, 404, { error: "collection not found" });
          return;
        }
        json(res, 200, meta);
      }));

      router.put("/api/:database/:collection/meta", secure(async (req, res) => {
        const body = await readJson(req);
        if (!isPlainObject(body)) return json(res, 400, { error: "collection meta must be a plain object" });
        try {
          json(res, 200, node.setCollectionMeta(req.params.database, req.params.collection, body));
        } catch (err) {
          json(res, 400, { error: err.message });
        }
      }));

      router.get("/api/:database/:collection/object", secure((req, res) => {
        let query;
        try {
          query = parseQueryParam(req);
        } catch (err) {
          json(res, 400, { error: err.message });
          return;
        }
        const { criteria, controls } = splitQueryControls(query);

        try {
          if (controls.$aggregate !== undefined) {
            if (controls.$vector !== undefined) {
              return json(res, 400, { error: "$aggregate and $vector are mutually exclusive" });
            }
            return json(res, 200, node.aggregate(req.params.database, req.params.collection, criteria, controls.$aggregate));
          }

          const options = queryOptions(req);
          const objects = node.find(req.params.database, req.params.collection, criteria, options);
          json(res, 200, {
            database: req.params.database,
            collection: req.params.collection,
            count: node.count(req.params.database, req.params.collection, criteria),
            objects: auth.redactObjects(req.params.database, req.params.collection, objects),
          });
        } catch (err) {
          json(res, 400, { error: err.message });
        }
      }));

      router.get("/api/:database/:collection/object/:id", secure((req, res) => {
        const object = node.get(req.params.database, req.params.collection, req.params.id);
        if (!object) {
          json(res, 404, { error: "not found" });
          return;
        }
        json(res, 200, auth.redactObject(req.params.database, req.params.collection, object));
      }));

      router.post("/api/:database/:collection/object", secure(async (req, res) => {
        const body = await readJson(req);
        const isBulk = Array.isArray(body);
        const items = isBulk ? body : [body || {}];
        const error = validatePlainObjects(items);
        if (error) return json(res, 400, error);
        let prepared;
        try {
          prepared = auth.prepareWriteObjects(req.params.database, req.params.collection, items, { partial: false });
        } catch (err) {
          return json(res, err.status || 400, errorBody(err));
        }
        const rows = node.insertMany(req.params.database, req.params.collection, prepared);
        if (isBulk && prefersMinimalReturn(req)) {
          return json(res, 201, { inserted: rows.length });
        }
        const safeRows = auth.redactObjects(req.params.database, req.params.collection, rows);
        json(res, 201, isBulk ? { inserted: safeRows.length, items: safeRows } : safeRows[0]);
      }));

      router.put("/api/:database/:collection/object", secure(async (req, res) => {
        const body = await readJson(req);
        if (!Array.isArray(body)) return json(res, 400, { error: "body must be an array of objects with id" });
        const error = validatePlainObjects(body, { requireId: true });
        if (error) return json(res, 400, error);
        try {
          const prepared = auth.prepareWriteObjects(req.params.database, req.params.collection, body, { partial: false });
          const result = node.replaceMany(req.params.database, req.params.collection, prepared);
          json(res, 200, auth.redactResult(req.params.database, req.params.collection, result));
        } catch (err) {
          json(res, err.status || 400, errorBody(err));
        }
      }));

      router.patch("/api/:database/:collection/object", secure(async (req, res) => {
        const body = await readJson(req);
        if (!Array.isArray(body)) return json(res, 400, { error: "body must be an array of objects with id" });
        const error = validatePlainObjects(body, { requireId: true });
        if (error) return json(res, 400, error);
        try {
          const prepared = auth.prepareWriteObjects(req.params.database, req.params.collection, body, { partial: true });
          const result = node.updateMany(req.params.database, req.params.collection, prepared);
          json(res, 200, auth.redactResult(req.params.database, req.params.collection, result));
        } catch (err) {
          json(res, err.status || 400, errorBody(err));
        }
      }));

      router.delete("/api/:database/:collection/object", secure(async (req, res) => {
        let ids;
        try {
          ids = parseBulkIds(await readJson(req, null));
        } catch (err) {
          return json(res, 400, errorBody(err));
        }
        json(res, 200, node.removeMany(req.params.database, req.params.collection, ids));
      }));

      router.put("/api/:database/:collection/object/:id", secure(async (req, res) => {
        const body = await readJson(req);
        const error = validatePlainObjects([body || {}]);
        if (error) return json(res, 400, error);
        try {
          const [prepared] = auth.prepareWriteObjects(
            req.params.database,
            req.params.collection,
            [{ ...(body || {}), id: req.params.id }],
            { partial: false },
          );
          node.replace(req.params.database, req.params.collection, req.params.id, prepared);
          const object = node.get(req.params.database, req.params.collection, req.params.id) || { id: req.params.id };
          json(res, 200, auth.redactObject(req.params.database, req.params.collection, object));
        } catch (err) {
          json(res, err.status || 400, errorBody(err));
        }
      }));

      router.patch("/api/:database/:collection/object/:id", secure(async (req, res) => {
        const body = await readJson(req);
        const error = validatePlainObjects([body || {}]);
        if (error) return json(res, 400, error);
        try {
          const [prepared] = auth.prepareWriteObjects(
            req.params.database,
            req.params.collection,
            [{ ...(body || {}), id: req.params.id }],
            { partial: true },
          );
          node.update(req.params.database, req.params.collection, req.params.id, prepared);
          const object = node.get(req.params.database, req.params.collection, req.params.id) || { id: req.params.id };
          json(res, 200, auth.redactObject(req.params.database, req.params.collection, object));
        } catch (err) {
          json(res, err.status || 400, errorBody(err));
        }
      }));

      router.delete("/api/:database/:collection/object/:id", secure((req, res) => {
        const ok = node.remove(req.params.database, req.params.collection, req.params.id);
        if (!ok) return json(res, 404, { error: "not found" });
        json(res, 204);
      }));
    },
  };
}

function secureRoute(auth) {
  return (handler) => async (req, res) => {
    const result = auth.authenticateRequest(req);
    if (!result.ok) return json(res, result.status, { error: result.error });
    return handler(req, res);
  };
}

function parseQueryParam(req) {
  const raw = req.query.get("q");
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("q must be a JSON object");
  }
  return parsed;
}

function queryOptions(req) {
  return {
    sortBy: req.query.get("sortBy") || undefined,
    sort: req.query.get("sort") || undefined,
    limit: numberParam(req.query.get("limit")),
    offset: numberParam(req.query.get("offset")),
  };
}

function numberParam(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function validatePlainObjects(items, { requireId = false } = {}) {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: `item at index ${i} must be a plain object`, index: i };
    }
    if (requireId && (item.id === undefined || item.id === null || String(item.id).length === 0)) {
      return { error: `item at index ${i} must include id`, index: i };
    }
  }
  return null;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectionMetaFromBody(body) {
  if (body.meta !== undefined) {
    if (!isPlainObject(body.meta)) throw new TypeError("body.meta must be a plain object");
    return body.meta;
  }
  const { name, ...meta } = body || {};
  return meta;
}

function parseBulkIds(body) {
  const source = Array.isArray(body) ? body : body?.ids;
  if (!Array.isArray(source)) throw new TypeError("body must be an array of ids or { ids: [...] }");
  return source.map((item, index) => {
    if (typeof item === "string" && item.length > 0) return item;
    if (item && typeof item === "object" && item.id !== undefined && item.id !== null) return String(item.id);
    const err = new TypeError(`id at index ${index} must be a non-empty string or object with id`);
    err.index = index;
    throw err;
  });
}

function errorBody(err) {
  return {
    error: err.message,
    ...(err.index !== undefined ? { index: err.index } : {}),
  };
}

function prefersMinimalReturn(req) {
  return /\breturn=minimal\b/i.test(req.headers.prefer || "");
}
