import { randomUUID } from "node:crypto";
import { USERS_COLLECTION } from "../auth.js";
import { aggregateObjects, isObjectDbAggregateSpec } from "../aggregate.js";
import { collectClusterStatus } from "../cluster-status.js";
import { json, readJson } from "../http-router.js";
import { compareSortValues, getPathValue, matchesQuery, splitQueryControls, stableKey } from "../query.js";
import { QUERY_PATH_HEADER } from "../query-planner.js";
import {
  baseCriteriaForReferenceQuery,
  expandReferences,
  normalizeRefDepth,
  pathHasReferenceObject,
  prepareReferenceValue,
  referenceDepthForAggregateSpec,
  referenceDepthForQuery,
  stripReferenceObjects,
} from "../references.js";
import { objectPath, ok } from "../shard-router.js";
import { isValidVector } from "../vector.js";

export function createPublicObjectInterface() {
  return {
    name: "public-object",
    register(router, { node, auth, routing, durability }) {
      const secure = secureRoute(auth);

      router.get("/api/databases", secure((req, res) => {
        const databases = node.listDatabases().sort();
        if (auth.enabled && req.auth?.claims?.globalUser !== true) {
          return json(res, 200, { databases: databases.filter((database) => database === req.auth?.claims?.database) });
        }
        json(res, 200, { databases });
      }));

      router.get("/api/config", secure(async (req, res) => {
        if (auth.enabled && req.auth?.claims?.globalUser !== true) {
          return json(res, 403, { error: "global user token required" });
        }
        json(res, 200, await collectClusterStatus(node));
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
        let adminUser;
        try {
          adminUser = routing.isForwarded(req) ? null : parseDatabaseAdminUser(body);
        } catch (err) {
          return json(res, err.status || 400, errorBody(err));
        }
        const created = node.getDatabaseMeta(name) === null;
        try {
          const meta = node.createDatabase(name, body.meta || {});
          let adminResult = null;
          let adminCollectionMeta = null;
          if (adminUser) {
            adminCollectionMeta = ensureAdminUserCollection(node, name, adminUser.collection);
          }
          await afterLocalWrite(durability);
          if (!routing.isForwarded(req)) {
            const remote = await routing.forwardToAllPeers(req, "/api/databases", { method: "POST", body: databaseCreateFanoutBody(name, body) });
            if (!ok(remote.status)) throw remoteError(remote, "database metadata fan-out failed");
            if (adminUser) {
              const collectionRemote = await routing.forwardToAllPeers(
                req,
                `/api/${encodeURIComponent(name)}/collections`,
                {
                  method: "POST",
                  body: { name: adminUser.collection, meta: adminCollectionMeta },
                },
              );
              if (!ok(collectionRemote.status)) throw remoteError(collectionRemote, "admin users collection metadata fan-out failed");
            }
          }
          if (adminUser) {
            await assertCanCreateDatabaseAdmin({ req, routing, database: name, adminUser });
            const written = await routedWriteMany({
              req,
              routing,
              auth,
              node,
              database: name,
              collection: adminUser.collection,
              objects: [adminUser.user],
              method: "POST",
              resultKey: "inserted",
              partial: false,
              localWrite: (items) => {
                const rows = node.insertMany(name, adminUser.collection, items);
                return { inserted: rows.length, items: rows };
              },
              durability,
            });
            adminResult = {
              collection: adminUser.collection,
              user: auth.redactObject(name, adminUser.collection, written.items[0]),
            };
          }
          json(res, created ? 201 : 200, {
            name,
            created,
            meta,
            ...(adminResult ? { adminUser: adminResult } : {}),
          });
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err));
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
          await afterLocalWrite(durability);
          if (!routing.isForwarded(req)) {
            const remote = await routing.forwardToAllPeers(
              req,
              `/api/${encodeURIComponent(req.params.database)}/collections`,
              { method: "POST", body },
            );
            if (!ok(remote.status)) throw remoteError(remote, "collection metadata fan-out failed");
          }
          json(res, created ? 201 : 200, { name, created, meta });
        } catch (err) {
          json(res, err.status || 400, errorBody(err));
        }
      }));

      router.delete("/api/:database/collections/:collection", secure(async (req, res) => {
        try {
          const removed = node.removeCollection(req.params.database, req.params.collection);
          if (!removed) {
            return routing.isForwarded(req)
              ? json(res, 204)
              : json(res, 404, { error: "collection not found" });
          }
          await afterLocalWrite(durability);
          if (!routing.isForwarded(req)) {
            const remote = await routing.forwardToAllPeers(
              req,
              `/api/${encodeURIComponent(req.params.database)}/collections/${encodeURIComponent(req.params.collection)}`,
              { method: "DELETE" },
            );
            if (!ok(remote.status)) throw remoteError(remote, "collection delete fan-out failed");
          }
          json(res, 204);
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err));
        }
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
          const meta = node.setCollectionMeta(req.params.database, req.params.collection, body);
          await afterLocalWrite(durability);
          if (!routing.isForwarded(req)) {
            const remote = await routing.forwardToAllPeers(
              req,
              `/api/${encodeURIComponent(req.params.database)}/${encodeURIComponent(req.params.collection)}/meta`,
              { method: "PUT", body },
            );
            if (!ok(remote.status)) throw remoteError(remote, "collection metadata fan-out failed");
          }
          json(res, 200, meta);
        } catch (err) {
          json(res, err.status || 400, errorBody(err));
        }
      }));

      router.post("/api/:database/:collection/search", secure(async (req, res) => {
        const query = await readJson(req);
        if (!isPlainObject(query)) return json(res, 400, { error: "search body must be a JSON object" });
        await executeCollectionQuery(req, res, { node, auth, routing, query });
      }));

      router.get("/api/:database/:collection/object", secure(async (req, res) => {
        let query;
        try {
          query = parseQueryParam(req);
        } catch (err) {
          json(res, 400, { error: err.message });
          return;
        }
        await executeCollectionQuery(req, res, { node, auth, routing, query });
      }));

      router.get("/api/:database/:collection/object/:id", secure(async (req, res) => {
        const refDepth = refDepthParam(req);
        try {
          if (!routing.shouldHandleObjectLocally(req, req.params.database, req.params.collection, req.params.id)) {
            const remote = await routing.forwardToObject(
              req,
              req.params.database,
              req.params.collection,
              req.params.id,
              objectPath(req.params.database, req.params.collection, req.params.id),
              { method: "GET", query: refDepthQuery(0), retryStatuses: [404, 409, 503] },
            );
            if (!ok(remote.status)) return proxyJson(res, remote);
            const object = await expandObjectForRead({
              req,
              node,
              routing,
              database: req.params.database,
              object: stripReferenceObjects(remote.body),
              refDepth,
            });
            return json(res, 200, auth.redactObject(req.params.database, req.params.collection, object));
          }
        } catch (err) {
          return json(res, err.status || 400, err.body || errorBody(err));
        }

        const object = node.get(req.params.database, req.params.collection, req.params.id);
        if (!object) {
          json(res, 404, { error: "not found" });
          return;
        }
        const expanded = await expandObjectForRead({
          req,
          node,
          routing,
          database: req.params.database,
          object,
          refDepth,
        });
        json(res, 200, auth.redactObject(req.params.database, req.params.collection, expanded));
      }));

      router.post("/api/:database/:collection/object", secure(async (req, res) => {
        const body = await readJson(req);
        const isBulk = Array.isArray(body);
        const rawItems = isBulk ? body : [body || {}];
        const error = validatePlainObjects(rawItems);
        if (error) return json(res, 400, error);
        const items = withInsertIds(rawItems);

        const rows = [];
        let inserted = 0;
        let wroteLocally = false;
        try {
          for (const group of routing.groupByShard(req, req.params.database, req.params.collection, items, (item) => item.id)) {
            if (group.local) {
              const prepared = auth.prepareWriteObjects(req.params.database, req.params.collection, group.items, { partial: false });
              const localRows = node.insertMany(req.params.database, req.params.collection, prepared);
              rows.push(...localRows);
              inserted += localRows.length;
              wroteLocally = true;
              continue;
            }

            const remote = await routing.forwardToShard(
                req,
                group.shard,
                objectPath(req.params.database, req.params.collection),
                {
                  method: "POST",
                  body: isBulk ? group.items : group.items[0],
                  query: refDepthQuery(0),
                },
            );
            if (!ok(remote.status)) throw remoteError(remote, `POST failed on shard ${group.shard}`);
            const remoteRows = remoteInsertedItems(remote.body);
            rows.push(...remoteRows);
            inserted += remoteInsertedCount(remote.body, remoteRows.length);
          }
          if (wroteLocally) await afterLocalWrite(durability);
        } catch (err) {
          if (wroteLocally) await afterLocalWrite(durability).catch((flushErr) => {
            err = flushErr;
          });
          return json(res, err.status || 400, err.body || errorBody(err));
        }

        if (isBulk && prefersMinimalReturn(req)) {
          return json(res, 201, { inserted });
        }
        const expandedRows = await expandObjectsForRead({
          req,
          node,
          routing,
          database: req.params.database,
          objects: orderLikeInput(items, rows).map(stripReferenceObjects),
          refDepth: refDepthParam(req),
        });
        const safeRows = auth.redactObjects(req.params.database, req.params.collection, expandedRows);
        json(res, 201, isBulk ? { inserted: safeRows.length, items: safeRows } : safeRows[0]);
      }));

      router.put("/api/:database/:collection/object", secure(async (req, res) => {
        const body = await readJson(req);
        if (!Array.isArray(body)) return json(res, 400, { error: "body must be an array of objects with id" });
        const error = validatePlainObjects(body, { requireId: true });
        if (error) return json(res, 400, error);
        try {
          const result = await routedWriteMany({
            req,
            routing,
            auth,
            node,
            database: req.params.database,
            collection: req.params.collection,
            objects: body,
            method: "PUT",
            resultKey: "replaced",
            partial: false,
            localWrite: (prepared) => node.replaceMany(req.params.database, req.params.collection, prepared),
            durability,
          });
          json(res, 200, auth.redactResult(req.params.database, req.params.collection, result));
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err));
        }
      }));

      router.patch("/api/:database/:collection/object", secure(async (req, res) => {
        const body = await readJson(req);
        if (!Array.isArray(body)) return json(res, 400, { error: "body must be an array of objects with id" });
        const error = validatePlainObjects(body, { requireId: true });
        if (error) return json(res, 400, error);
        try {
          const result = await routedWriteMany({
            req,
            routing,
            auth,
            node,
            database: req.params.database,
            collection: req.params.collection,
            objects: body,
            method: "PATCH",
            resultKey: "updated",
            partial: true,
            localWrite: (prepared) => node.updateMany(req.params.database, req.params.collection, prepared),
            durability,
          });
          json(res, 200, auth.redactResult(req.params.database, req.params.collection, result));
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err));
        }
      }));

      router.delete("/api/:database/:collection/object", secure(async (req, res) => {
        let ids;
        try {
          ids = parseBulkIds(await readJson(req, null));
        } catch (err) {
          return json(res, 400, errorBody(err));
        }
        try {
          json(res, 200, await routedRemoveMany(req, routing, node, durability, req.params.database, req.params.collection, ids));
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err));
        }
      }));

      router.put("/api/:database/:collection/object/:id", secure(async (req, res) => {
        const body = await readJson(req);
        const error = validatePlainObjects([body || {}]);
        if (error) return json(res, 400, error);
        const refDepth = refDepthParam(req);
        try {
          if (!routing.shouldHandleObjectLocally(req, req.params.database, req.params.collection, req.params.id)) {
            const remote = await routing.forwardToObject(
              req,
              req.params.database,
              req.params.collection,
              req.params.id,
              objectPath(req.params.database, req.params.collection, req.params.id),
              { method: "PUT", body, query: refDepthQuery(0) },
            );
            if (!ok(remote.status)) return proxyJson(res, remote);
            const object = await expandObjectForRead({
              req,
              node,
              routing,
              database: req.params.database,
              object: stripReferenceObjects(remote.body),
              refDepth,
            });
            return json(res, remote.status, auth.redactObject(req.params.database, req.params.collection, object));
          }
          const [prepared] = auth.prepareWriteObjects(
            req.params.database,
            req.params.collection,
            [{ ...(body || {}), id: req.params.id }],
            { partial: false },
          );
          node.replace(req.params.database, req.params.collection, req.params.id, prepared);
          await afterLocalWrite(durability);
          const object = node.get(req.params.database, req.params.collection, req.params.id) || { id: req.params.id };
          const expanded = await expandObjectForRead({
            req,
            node,
            routing,
            database: req.params.database,
            object,
            refDepth,
          });
          json(res, 200, auth.redactObject(req.params.database, req.params.collection, expanded));
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err));
        }
      }));

      router.patch("/api/:database/:collection/object/:id", secure(async (req, res) => {
        const body = await readJson(req);
        const error = validatePlainObjects([body || {}]);
        if (error) return json(res, 400, error);
        const refDepth = refDepthParam(req);
        try {
          if (!routing.shouldHandleObjectLocally(req, req.params.database, req.params.collection, req.params.id)) {
            const remote = await routing.forwardToObject(
              req,
              req.params.database,
              req.params.collection,
              req.params.id,
              objectPath(req.params.database, req.params.collection, req.params.id),
              { method: "PATCH", body, query: refDepthQuery(0) },
            );
            if (!ok(remote.status)) return proxyJson(res, remote);
            const object = await expandObjectForRead({
              req,
              node,
              routing,
              database: req.params.database,
              object: stripReferenceObjects(remote.body),
              refDepth,
            });
            return json(res, remote.status, auth.redactObject(req.params.database, req.params.collection, object));
          }
          const [prepared] = auth.prepareWriteObjects(
            req.params.database,
            req.params.collection,
            [{ ...(body || {}), id: req.params.id }],
            { partial: true },
          );
          node.update(req.params.database, req.params.collection, req.params.id, prepared);
          await afterLocalWrite(durability);
          const object = node.get(req.params.database, req.params.collection, req.params.id) || { id: req.params.id };
          const expanded = await expandObjectForRead({
            req,
            node,
            routing,
            database: req.params.database,
            object,
            refDepth,
          });
          json(res, 200, auth.redactObject(req.params.database, req.params.collection, expanded));
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err));
        }
      }));

      router.delete("/api/:database/:collection/object/:id", secure(async (req, res) => {
        try {
          if (!routing.shouldHandleObjectLocally(req, req.params.database, req.params.collection, req.params.id)) {
            const remote = await routing.forwardToObject(
              req,
              req.params.database,
              req.params.collection,
              req.params.id,
              objectPath(req.params.database, req.params.collection, req.params.id),
              { method: "DELETE" },
            );
            return proxyJson(res, remote);
          }
        } catch (err) {
          return json(res, err.status || 400, err.body || errorBody(err));
        }
        const ok = node.remove(req.params.database, req.params.collection, req.params.id);
        if (!ok) return json(res, 404, { error: "not found" });
        await afterLocalWrite(durability);
        json(res, 204);
      }));
    },
  };
}

async function executeCollectionQuery(req, res, { node, auth, routing, query }) {
  const { criteria, controls } = splitQueryControls(query);
  const database = req.params.database;
  const collection = req.params.collection;

  try {
    const options = queryOptions(req, controls);
    if (controls.$aggregate !== undefined) {
      if (controls.$vector !== undefined) {
        return json(res, 400, { error: "$aggregate and $vector are mutually exclusive" });
      }
      const queryDepth = referenceDepthForQuery(criteria);
      const aggregateDepth = referenceDepthForAggregateSpec(controls.$aggregate);
      if (queryDepth > 0 || aggregateDepth > 0) {
        const rows = await findReferenceAwareRows({
          req,
          node,
          routing,
          database,
          collection,
          criteria,
          options: { refDepth: Math.max(queryDepth, aggregateDepth) },
        });
        return jsonWithQueryPath(res, 200, aggregateRows(rows.rows, controls.$aggregate), aggregateReferencePath(rows.path));
      }
      const result = await routing.aggregate(req, database, collection, criteria, controls.$aggregate);
      return jsonWithQueryPath(res, 200, result.rows, result.path);
    }

    if (controls.$vector !== undefined) {
      if (referenceDepthForQuery(criteria) > 0) {
        return json(res, 400, { error: "$vector cannot be combined with reference object paths yet" });
      }
      const vector = parseVectorSearch(controls.$vector);
      const rows = await routing.vectorSearch(req, database, collection, criteria, vector, options);
      const expanded = await expandObjectsForRead({
        req,
        node,
        routing,
        database,
        objects: rows,
        refDepth: options.refDepth,
      });
      return jsonWithQueryPath(
        res,
        200,
        auth.redactObjects(database, collection, expanded),
        Object.keys(criteria || {}).length > 0 ? "vector-filter" : "vector-index",
      );
    }

    const result = await findPublicObjects({
      req,
      node,
      routing,
      database,
      collection,
      criteria,
      options,
    });
    jsonWithQueryPath(res, 200, auth.redactObjects(database, collection, result.objects), result.path);
  } catch (err) {
    json(res, err.status || 400, err.body || errorBody(err));
  }
}

async function routedWriteMany({
  req,
  routing,
  auth,
  node,
  database,
  collection,
  objects,
  method,
  resultKey,
  partial,
  localWrite,
  durability,
}) {
  const rows = [];
  let total = 0;
  let wroteLocally = false;

  try {
    for (const group of routing.groupByShard(req, database, collection, objects, (item) => item.id)) {
      if (group.local) {
        const prepared = auth.prepareWriteObjects(database, collection, group.items, { partial });
        const localResult = localWrite(prepared);
        total += Number(localResult[resultKey]) || 0;
        rows.push(...(localResult.items || []));
        wroteLocally = true;
        continue;
      }

      const remote = await routing.forwardToShard(req, group.shard, objectPath(database, collection), {
        method,
        body: group.items,
        query: refDepthQuery(0),
      });
      if (!ok(remote.status)) throw remoteError(remote, `${method} failed on shard ${group.shard}`);
      total += Number(remote.body?.[resultKey]) || 0;
      rows.push(...(Array.isArray(remote.body?.items) ? remote.body.items : []));
    }
    if (wroteLocally) await afterLocalWrite(durability);
  } catch (err) {
    if (wroteLocally) await afterLocalWrite(durability).catch((flushErr) => {
      err = flushErr;
    });
    throw err;
  }

  return {
    [resultKey]: total,
    items: await expandObjectsForRead({
      req,
      node,
      routing,
      database,
      objects: orderLikeInput(objects, rows).map(stripReferenceObjects),
      refDepth: refDepthParam(req),
    }),
  };
}

async function routedRemoveMany(req, routing, node, durability, database, collection, ids) {
  const result = {
    deleted: 0,
    ids: [],
    skipped: [],
  };
  let wroteLocally = false;

  try {
    for (const group of routing.groupByShard(req, database, collection, ids, (id) => id)) {
      if (group.local) {
        const local = node.removeMany(database, collection, group.items);
        result.deleted += local.deleted;
        result.ids.push(...local.ids);
        result.skipped.push(...local.skipped);
        wroteLocally = wroteLocally || local.deleted > 0;
        continue;
      }

      const remote = await routing.forwardToShard(req, group.shard, objectPath(database, collection), {
        method: "DELETE",
        body: { ids: group.items },
      });
      if (!ok(remote.status)) throw remoteError(remote, `DELETE failed on shard ${group.shard}`);
      result.deleted += Number(remote.body?.deleted) || 0;
      result.ids.push(...(Array.isArray(remote.body?.ids) ? remote.body.ids : []));
      result.skipped.push(...(Array.isArray(remote.body?.skipped) ? remote.body.skipped : []));
    }
    if (wroteLocally) await afterLocalWrite(durability);
  } catch (err) {
    if (wroteLocally) await afterLocalWrite(durability).catch((flushErr) => {
      err = flushErr;
    });
    throw err;
  }

  return result;
}

async function findPublicObjects({ req, node, routing, database, collection, criteria, options }) {
  if (referenceDepthForQuery(criteria) > 0 || pathHasReferenceObject(options.sortBy)) {
    const result = await findReferenceAwarePairs({ req, node, routing, database, collection, criteria, options });
    const objects = await expandObjectsForRead({
      req,
      node,
      routing,
      database,
      objects: result.pairs.map(({ raw }) => raw),
      refDepth: options.refDepth,
    });
    return {
      objects,
      path: referencePath(result.path),
    };
  }

  const result = await routing.find(req, database, collection, criteria, { ...options, refDepth: 0 });
  const objects = await expandObjectsForRead({
    req,
    node,
    routing,
    database,
    objects: result.objects,
    refDepth: options.refDepth,
  });
  return {
    objects,
    path: result.path,
  };
}

async function findReferenceAwareRows({ req, node, routing, database, collection, criteria, options = {} }) {
  const result = await findReferenceAwarePairs({ req, node, routing, database, collection, criteria, options });
  return {
    rows: result.pairs.map(({ matchObject }) => matchObject),
    path: result.path,
  };
}

async function findReferenceAwarePairs({ req, node, routing, database, collection, criteria, options = {} }) {
  const queryDepth = referenceDepthForQuery(criteria);
  const sortDepth = pathHasReferenceObject(options.sortBy) ? 1 : 0;
  const depth = Math.max(queryDepth, sortDepth, normalizeRefDepth(options.refDepth, 0));
  const fetchOptions = {
    refDepth: 0,
    ...(typeof options.includeId === "function" ? { includeId: options.includeId } : {}),
  };
  const result = await routing.find(req, database, collection, baseCriteriaForReferenceQuery(criteria), fetchOptions);
  const resolver = createReferenceResolver({ req, node, routing });
  const pairs = [];

  for (const raw of result.objects || []) {
    const compact = stripReferenceObjects(raw);
    const matchObject = depth > 0
      ? await expandReferences(compact, { database, depth, getObject: resolver })
      : compact;
    if (matchesQuery(matchObject, criteria)) pairs.push({ raw: compact, matchObject });
  }

  return {
    pairs: paginateReferencePairs(sortReferencePairs(pairs, options), options),
    path: result.path,
  };
}

async function expandObjectForRead({ req, node, routing, database, object, refDepth }) {
  if (!object) return object;
  const depth = normalizeRefDepth(refDepth, 1);
  const prepared = prepareReferenceValue(object);
  if (depth <= 0 || !prepared.hasReference) return prepared.value;
  return expandReferences(prepared.value, {
    database,
    depth,
    getObject: createReferenceResolver({ req, node, routing }),
  });
}

async function expandObjectsForRead({ req, node, routing, database, objects, refDepth }) {
  const out = [];
  for (const object of objects || []) {
    out.push(await expandObjectForRead({ req, node, routing, database, object, refDepth }));
  }
  return out;
}

function createReferenceResolver({ req, node, routing }) {
  const cache = new Map();
  return async (database, collection, id) => {
    const key = `${database}\0${collection}\0${id}`;
    if (!cache.has(key)) {
      cache.set(key, resolveReferencedObject({ req, node, routing, database, collection, id }));
    }
    return cache.get(key);
  };
}

async function resolveReferencedObject({ req, node, routing, database, collection, id }) {
  const shard = routing.shardForObject(database, collection, id);
  if (routing.ownsShard(shard)) return node.get(database, collection, id, { refDepth: 0 }) || null;

  const remote = await routing.forwardToObject(req, database, collection, id, objectPath(database, collection, id), {
    method: "GET",
    query: refDepthQuery(0),
    retryStatuses: [404, 409, 503],
  });
  if (remote.status === 404) return null;
  if (!ok(remote.status)) throw remoteError(remote, `reference lookup failed for ${database}/${collection}/${id}`);
  return remote.body ? stripReferenceObjects(remote.body) : null;
}

function sortReferencePairs(pairs, options = {}) {
  if (!options.sortBy) return pairs;
  const direction = options.sort === "desc" ? -1 : 1;
  return [...pairs].sort((left, right) => {
    return compareSortValues(
      getPathValue(left.matchObject, options.sortBy),
      getPathValue(right.matchObject, options.sortBy),
    ) * direction;
  });
}

function paginateReferencePairs(pairs, options = {}) {
  const offset = options.offset || 0;
  const limit = options.limit ?? Infinity;
  if (limit <= 0) return [];
  return pairs.slice(offset, offset + limit);
}

function aggregateRows(rows, spec = {}) {
  if (isObjectDbAggregateSpec(spec)) return aggregateObjects(rows, spec);

  const groupBy = spec.groupBy;
  const metrics = {
    sum: asArray(spec.sum),
    avg: asArray(spec.avg),
    min: asArray(spec.min),
    max: asArray(spec.max),
  };
  const groups = new Map();

  for (const object of rows || []) {
    const key = groupBy ? stableKey(getPathValue(object, groupBy)) : "__all__";
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = makeAggregateBucket(groupBy ? getPathValue(object, groupBy) : undefined, metrics);
      groups.set(key, bucket);
    }
    addAggregateRow(bucket, object, metrics);
  }

  if (!groupBy) return finishAggregateBucket(groups.get("__all__") || makeAggregateBucket(undefined, metrics), metrics);
  return [...groups.values()].map((bucket) => finishAggregateBucket(bucket, metrics));
}

function makeAggregateBucket(key, metrics) {
  return {
    key,
    count: 0,
    sum: Object.fromEntries(metrics.sum.map((field) => [field, 0])),
    avg: Object.fromEntries(metrics.avg.map((field) => [field, { sum: 0, count: 0 }])),
    min: Object.fromEntries(metrics.min.map((field) => [field, undefined])),
    max: Object.fromEntries(metrics.max.map((field) => [field, undefined])),
  };
}

function addAggregateRow(bucket, object, metrics) {
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

function finishAggregateBucket(bucket, metrics) {
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

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function parseDatabaseAdminUser(body = {}) {
  if (body?.adminUser === undefined) return null;
  if (!isPlainObject(body.adminUser)) throw httpError(400, "body.adminUser must be a plain object");

  const rawCollection = body.adminUser.collection;
  const collection = rawCollection === undefined || rawCollection === null || rawCollection === ""
    ? USERS_COLLECTION
    : rawCollection;
  if (typeof collection !== "string" || collection.length === 0) {
    throw httpError(400, "body.adminUser.collection must be a non-empty string when provided");
  }

  if (typeof body.adminUser.username !== "string" || body.adminUser.username.length === 0) {
    throw httpError(400, "body.adminUser.username must be a non-empty string");
  }
  if (typeof body.adminUser.password !== "string" || body.adminUser.password.length === 0) {
    throw httpError(400, "body.adminUser.password must be a non-empty string");
  }
  if (
    body.adminUser.id !== undefined &&
    body.adminUser.id !== null &&
    String(body.adminUser.id).length === 0
  ) {
    throw httpError(400, "body.adminUser.id must be a non-empty string when provided");
  }

  const { collection: _collection, ...user } = body.adminUser;
  return {
    collection,
    user: {
      ...user,
      ...(user.id !== undefined && user.id !== null ? { id: String(user.id) } : { id: randomUUID() }),
      admin: true,
    },
  };
}

function ensureAdminUserCollection(node, database, collection) {
  const existing = node.getCollectionMeta(database, collection);
  const meta = {
    ...(existing || {}),
    indexes: uniqueStrings([...(existing?.indexes || []), "username"]),
  };
  return existing === null
    ? node.createCollection(database, collection, meta)
    : node.setCollectionMeta(database, collection, meta);
}

async function assertCanCreateDatabaseAdmin({ req, routing, database, adminUser }) {
  const existingAdmins = await routing.find(req, database, adminUser.collection, { admin: true }, { limit: 1 });
  if ((existingAdmins.objects || []).length > 0) {
    throw httpError(409, `database already has an admin user in ${adminUser.collection}`);
  }

  const existingUsername = await routing.find(req, database, adminUser.collection, { username: adminUser.user.username }, { limit: 1 });
  if ((existingUsername.objects || []).length > 0) {
    throw httpError(409, `username already exists in ${adminUser.collection}`);
  }
}

function databaseCreateFanoutBody(name, body = {}) {
  return {
    name,
    ...(body.meta !== undefined ? { meta: body.meta } : {}),
  };
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

async function afterLocalWrite(durability) {
  try {
    await durability?.afterWrite?.();
  } catch (err) {
    err.status = err.status || 500;
    throw err;
  }
}

function withInsertIds(items) {
  return items.map((item) => ({
    ...item,
    id: item.id ? String(item.id) : randomUUID(),
  }));
}

function remoteInsertedItems(body) {
  if (Array.isArray(body?.items)) return body.items;
  if (body && typeof body === "object" && body.id !== undefined) return [body];
  return [];
}

function remoteInsertedCount(body, fallback) {
  if (Number.isFinite(body?.inserted)) return body.inserted;
  return fallback;
}

function orderLikeInput(input, rows) {
  const byId = new Map();
  for (const row of rows) {
    if (row?.id !== undefined && !byId.has(String(row.id))) byId.set(String(row.id), row);
  }
  return input.map((item) => byId.get(String(item.id))).filter(Boolean);
}

function remoteError(remote, fallback) {
  const err = new Error(remote.body?.error || fallback);
  err.status = remote.status;
  err.body = remote.body;
  return err;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function proxyJson(res, remote) {
  return json(res, remote.status, remote.body === null ? undefined : remote.body);
}

function jsonWithQueryPath(res, status, body, path) {
  const value = normalizeQueryPath(path);
  return json(res, status, body, value ? { [QUERY_PATH_HEADER]: value } : {});
}

function referencePath(path) {
  const value = normalizeQueryPath(path);
  return value ? `reference-${value}` : "reference-scan";
}

function aggregateReferencePath(path) {
  const value = normalizeQueryPath(path);
  return value ? `aggregate-reference-${value}` : "aggregate-reference-scan";
}

function normalizeQueryPath(path) {
  const value = String(path || "").trim();
  return value.length ? value : null;
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

function queryOptions(req, controls = {}) {
  const parsedSort = parseSortControl(controls.$sort);
  return {
    sortBy: req.query.get("sortBy") || parsedSort.sortBy || undefined,
    sort: req.query.get("sort") || parsedSort.sort || undefined,
    limit: numberParam(req.query.get("limit")),
    offset: numberParam(req.query.get("offset")),
    refDepth: refDepthParam(req, controls),
  };
}

function parseVectorSearch(value) {
  if (!isPlainObject(value)) {
    throw httpError(400, "$vector must be an object with .vector");
  }
  if (!isValidVector(value.vector)) {
    throw httpError(400, "$vector.vector must be a non-empty array of finite numbers");
  }
  return {
    queryVec: value.vector,
    limit: Number.isFinite(value.limit) && value.limit > 0 ? Math.floor(value.limit) : 20,
    ef: Number.isFinite(value.ef) && value.ef > 0 ? Math.floor(value.ef) : undefined,
  };
}

function parseSortControl(value) {
  if (typeof value === "string" && value.length > 0) {
    return value.startsWith("-")
      ? { sortBy: value.slice(1), sort: "desc" }
      : { sortBy: value.replace(/^\+/, ""), sort: "asc" };
  }
  if (isPlainObject(value)) {
    const [field, direction] = Object.entries(value)[0] || [];
    if (!field) return {};
    return { sortBy: field, sort: direction === -1 || direction === "desc" ? "desc" : "asc" };
  }
  return {};
}

function refDepthParam(req, controls = {}) {
  if (req?.query?.has("$refDepth")) return normalizeRefDepth(req.query.get("$refDepth"), 1);
  if (req?.query?.has("refDepth")) return normalizeRefDepth(req.query.get("refDepth"), 1);
  if (Object.prototype.hasOwnProperty.call(controls, "$refDepth")) return normalizeRefDepth(controls.$refDepth, 1);
  return 1;
}

function refDepthQuery(depth) {
  const params = new URLSearchParams();
  params.set("$refDepth", String(normalizeRefDepth(depth, 0)));
  return params.toString();
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
