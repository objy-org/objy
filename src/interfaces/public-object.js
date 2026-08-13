import { USERS_COLLECTION } from "../auth.js";
import { aggregateRows } from "../aggregate.js";
import { collectClusterStatus } from "../cluster-status.js";
import { json, readJson } from "../http-router.js";
import { createObjectId } from "../object-id.js";
import {
  canCreate,
  canDelete,
  canRead,
  canUpdate,
  isPermissionBypass,
  mergeReadPermissionQuery,
  permissionError,
} from "../permissions.js";
import { matchesQuery, splitQueryControls } from "../query.js";
import { QUERY_PATH_HEADER } from "../query-planner.js";
import {
  baseCriteriaForReferenceQuery,
  expandReferences,
  normalizeRefDepth,
  paginateReferencePairs,
  pathHasReferenceObject,
  prepareReferenceValue,
  referenceDepthForAggregateSpec,
  referenceDepthForQuery,
  referenceReadPlan,
  sortReferencePairs,
  stripReferenceObjects,
} from "../references.js";
import { objectPath, ok } from "../shard-router.js";
import { isValidVector } from "../vector.js";

export function createPublicObjectInterface() {
  return {
    name: "public-object",
    register(router, { node, auth, routing, durability, memoryGuard, replicationScheduler }) {
      const secure = secureRoute(auth);

      router.get("/api/databases", secure((req, res) => {
        const databases = node.listDatabases().sort();
        if (auth.enabled && !isGlobalAdminRequest(req, auth)) {
          return json(res, 200, { databases: databases.filter((database) => database === req.auth?.claims?.database) });
        }
        json(res, 200, { databases });
      }));

      router.get("/api/config", secure(async (req, res) => {
        if (rejectUnlessGlobalAdmin(req, res, auth)) return;
        json(res, 200, await collectClusterStatus(node, { memoryGuard, replicationScheduler }));
      }));

      router.post("/api/databases", secure(async (req, res) => {
        if (rejectUnlessGlobalAdmin(req, res, auth)) return;
        if (rejectIfMemoryGuardBlocked(res, memoryGuard)) return;
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
          return json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
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
              memoryGuard,
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
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
      }));

      router.get("/api/:database/collections", secure((req, res) => {
        if (rejectUnlessDatabaseAdmin(req, res, auth)) return;
        json(res, 200, {
          database: req.params.database,
          collections: node.listCollections(req.params.database).sort(),
        });
      }));

      router.post("/api/:database/collections", secure(async (req, res) => {
        if (rejectUnlessDatabaseAdmin(req, res, auth)) return;
        if (rejectIfMemoryGuardBlocked(res, memoryGuard)) return;
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
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
      }));

      router.delete("/api/:database/collections/:collection", secure(async (req, res) => {
        if (rejectUnlessDatabaseAdmin(req, res, auth)) return;
        if (rejectIfMemoryGuardBlocked(res, memoryGuard)) return;
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
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
      }));

      router.get("/api/:database/:collection/meta", secure((req, res) => {
        if (rejectUnlessDatabaseAdmin(req, res, auth)) return;
        const meta = node.getCollectionMeta(req.params.database, req.params.collection);
        if (!meta) {
          json(res, 404, { error: "collection not found" });
          return;
        }
        json(res, 200, meta);
      }));

      router.put("/api/:database/:collection/meta", secure(async (req, res) => {
        if (rejectUnlessDatabaseAdmin(req, res, auth)) return;
        if (rejectIfMemoryGuardBlocked(res, memoryGuard)) return;
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
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
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
          return json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }

        const object = node.get(req.params.database, req.params.collection, req.params.id);
        if (!object) {
          json(res, 404, { error: "not found" });
          return;
        }
        assertReadAllowed(req, object);
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
        const items = withObjectIds(rawItems);
        const minimalBulkReturn = isBulk && prefersMinimalReturn(req);
        let groups;
        const preparedByGroup = new Map();
        try {
          groups = routing.groupByShard(req, req.params.database, req.params.collection, items, (item) => item._id);
          for (const group of groups) {
            if (!group.local) continue;
            const prepared = auth.prepareWriteObjects(req.params.database, req.params.collection, group.items, { partial: false });
            assertCreateAllowed(req, prepared);
            preparedByGroup.set(group, prepared);
          }
          if (preparedByGroup.size && rejectIfMemoryGuardBlocked(res, memoryGuard)) return;
        } catch (err) {
          return json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }

        const rows = [];
        let inserted = 0;
        let wroteLocally = false;
        try {
          for (const group of groups) {
            if (group.local) {
              const prepared = preparedByGroup.get(group);
              if (minimalBulkReturn) {
                inserted += node.insertManyCount(req.params.database, req.params.collection, prepared);
              } else {
                const localRows = node.insertMany(req.params.database, req.params.collection, prepared);
                rows.push(...localRows);
                inserted += localRows.length;
              }
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
          return json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }

        if (minimalBulkReturn) {
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
        if (!Array.isArray(body)) return json(res, 400, { error: "body must be an array of objects with _id" });
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
            memoryGuard,
          });
          json(res, 200, auth.redactResult(req.params.database, req.params.collection, result));
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
      }));

      router.patch("/api/:database/:collection/object", secure(async (req, res) => {
        const body = await readJson(req);
        if (!Array.isArray(body)) return json(res, 400, { error: "body must be an array of objects with _id" });
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
            memoryGuard,
          });
          json(res, 200, auth.redactResult(req.params.database, req.params.collection, result));
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
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
          json(res, 200, await routedRemoveMany(req, routing, node, durability, memoryGuard, req.params.database, req.params.collection, ids));
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
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
            [{ ...(body || {}), _id: req.params.id }],
            { partial: false },
          );
          assertUpsertAllowed(req, node, req.params.database, req.params.collection, [prepared], { partial: false });
          assertMemoryGuardAcceptsWrites(memoryGuard);
          node.replace(req.params.database, req.params.collection, req.params.id, prepared);
          await afterLocalWrite(durability);
          const object = node.get(req.params.database, req.params.collection, req.params.id) || { _id: req.params.id };
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
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
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
            [{ ...(body || {}), _id: req.params.id }],
            { partial: true },
          );
          assertUpsertAllowed(req, node, req.params.database, req.params.collection, [prepared], { partial: true });
          assertMemoryGuardAcceptsWrites(memoryGuard);
          node.update(req.params.database, req.params.collection, req.params.id, prepared);
          await afterLocalWrite(durability);
          const object = node.get(req.params.database, req.params.collection, req.params.id) || { _id: req.params.id };
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
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
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
          return json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
        const existing = node.get(req.params.database, req.params.collection, req.params.id);
        if (!existing) return json(res, 404, { error: "not found" });
        assertDeleteAllowed(req, [existing]);
        if (rejectIfMemoryGuardBlocked(res, memoryGuard)) return;
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
    const access = readCriteriaForRequest(req, criteria);
    if (access.denied) return jsonWithQueryPath(res, 200, [], "permission-denied");
    const securedCriteria = access.query;
    const options = queryOptions(req, controls);
    if (controls.$aggregate !== undefined) {
      if (controls.$vector !== undefined) {
        return json(res, 400, { error: "$aggregate and $vector are mutually exclusive" });
      }
      const queryDepth = referenceDepthForQuery(securedCriteria);
      const aggregateDepth = referenceDepthForAggregateSpec(controls.$aggregate);
      if (queryDepth > 0 || aggregateDepth > 0) {
        const rows = await findReferenceAwareRows({
          req,
          node,
          routing,
          database,
          collection,
          criteria: securedCriteria,
          options: { refDepth: Math.max(queryDepth, aggregateDepth) },
        });
        return jsonWithQueryPath(res, 200, aggregateRows(rows.rows, controls.$aggregate), aggregateReferencePath(rows.path));
      }
      const result = await routing.aggregate(req, database, collection, securedCriteria, controls.$aggregate);
      return jsonWithQueryPath(res, 200, result.rows, result.path);
    }

    if (controls.$vector !== undefined) {
      if (referenceDepthForQuery(securedCriteria) > 0) {
        return json(res, 400, { error: "$vector cannot be combined with reference object paths yet" });
      }
      const vector = parseVectorSearch(controls.$vector);
      const rows = await routing.vectorSearch(req, database, collection, securedCriteria, vector, options);
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
        Object.keys(securedCriteria || {}).length > 0 ? "vector-filter" : "vector-index",
      );
    }

    const result = await findPublicObjects({
      req,
      node,
      routing,
      database,
      collection,
      criteria: securedCriteria,
      options,
    });
    jsonWithQueryPath(res, 200, auth.redactObjects(database, collection, result.objects), result.path);
  } catch (err) {
    json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
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
  memoryGuard,
}) {
  const rows = [];
  let total = 0;
  let wroteLocally = false;
  const groups = routing.groupByShard(req, database, collection, objects, (item) => item._id);
  const preparedByGroup = new Map();
  for (const group of groups) {
    if (!group.local) continue;
    const prepared = auth.prepareWriteObjects(database, collection, group.items, { partial });
    assertUpsertAllowed(req, node, database, collection, prepared, { partial });
    preparedByGroup.set(group, prepared);
  }
  if (preparedByGroup.size) assertMemoryGuardAcceptsWrites(memoryGuard);

  try {
    for (const group of groups) {
      if (group.local) {
        const prepared = preparedByGroup.get(group);
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

async function routedRemoveMany(req, routing, node, durability, memoryGuard, database, collection, ids) {
  const result = {
    deleted: 0,
    ids: [],
    skipped: [],
  };
  let wroteLocally = false;
  const groups = routing.groupByShard(req, database, collection, ids, (id) => id);
  for (const group of groups) {
    if (!group.local) continue;
    assertDeleteAllowed(req, existingObjectsForIds(node, database, collection, group.items));
  }
  if (groups.some((group) => group.local)) assertMemoryGuardAcceptsWrites(memoryGuard);

  try {
    for (const group of groups) {
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
  const { expansionDepth } = referenceReadPlan(criteria, options);
  const fetchOptions = {
    refDepth: 0,
    ...(typeof options.includeId === "function" ? { includeId: options.includeId } : {}),
  };
  const result = await routing.find(req, database, collection, baseCriteriaForReferenceQuery(criteria), fetchOptions);
  const resolver = createReferenceResolver({ req, node, routing });
  const pairs = [];

  for (const raw of result.objects || []) {
    const compact = stripReferenceObjects(raw);
    const matchObject = expansionDepth > 0
      ? await expandReferences(compact, { database, depth: expansionDepth, getObject: resolver })
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
  if (routing.ownsShard(shard)) {
    const object = node.get(database, collection, id, { refDepth: 0 }) || null;
    if (object) assertReadAllowed(req, object);
    return object;
  }

  const remote = await routing.forwardToObject(req, database, collection, id, objectPath(database, collection, id), {
    method: "GET",
    query: refDepthQuery(0),
    retryStatuses: [404, 409, 503],
  });
  if (remote.status === 404) return null;
  if (!ok(remote.status)) throw remoteError(remote, `reference lookup failed for ${database}/${collection}/${id}`);
  return remote.body ? stripReferenceObjects(remote.body) : null;
}

function permissionUser(req) {
  return req.auth?.user || null;
}

function rejectUnlessGlobalAdmin(req, res, auth) {
  if (isGlobalAdminRequest(req, auth)) return false;
  json(res, 403, { error: "global admin token required" });
  return true;
}

function rejectUnlessDatabaseAdmin(req, res, auth) {
  if (isAdminRequest(req, auth)) return false;
  json(res, 403, { error: "database admin token required" });
  return true;
}

function isGlobalAdminRequest(req, auth) {
  return auth.enabled === false || (req.auth?.claims?.globalUser === true && isAdminRequest(req, auth));
}

function isAdminRequest(req, auth) {
  return auth.enabled === false || isPermissionBypass(permissionUser(req));
}

function readCriteriaForRequest(req, criteria = {}) {
  return mergeReadPermissionQuery(criteria, permissionUser(req));
}

function assertReadAllowed(req, object) {
  if (!canRead(permissionUser(req), object)) throw permissionError("read", object?._id);
}

function assertCreateAllowed(req, objects = []) {
  const user = permissionUser(req);
  for (const object of objects || []) {
    if (!canCreate(user, object)) throw permissionError("create", object?._id);
  }
}

function assertUpsertAllowed(req, node, database, collection, objects = [], { partial = false } = {}) {
  const user = permissionUser(req);
  const existing = existingObjectMap(node, database, collection, objects.map((object) => object._id));
  for (const object of objects || []) {
    const before = existing.get(String(object._id));
    const after = partial && before ? { ...before, ...object, _id: object._id } : object;
    const allowed = before ? canUpdate(user, before, after) : canCreate(user, after);
    if (!allowed) throw permissionError(before ? "update" : "create", object?._id);
  }
}

function assertDeleteAllowed(req, objects = []) {
  const user = permissionUser(req);
  for (const object of objects || []) {
    if (!canDelete(user, object)) throw permissionError("delete", object?._id);
  }
}

function existingObjectsForIds(node, database, collection, ids = []) {
  return node.getMany(database, collection, ids);
}

function existingObjectMap(node, database, collection, ids = []) {
  return new Map(existingObjectsForIds(node, database, collection, ids).map((object) => [String(object._id), object]));
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
    body.adminUser._id !== undefined &&
    body.adminUser._id !== null &&
    String(body.adminUser._id).length === 0
  ) {
    throw httpError(400, "body.adminUser._id must be a non-empty string when provided");
  }

  const { collection: _collection, ...user } = body.adminUser;
  return {
    collection,
    user: {
      ...user,
      ...(user._id !== undefined && user._id !== null ? { _id: String(user._id) } : { _id: createObjectId() }),
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

function withObjectIds(items) {
  return items.map((item) => ({
    ...item,
    _id: item._id !== undefined && item._id !== null ? String(item._id) : createObjectId(),
  }));
}

function remoteInsertedItems(body) {
  if (Array.isArray(body?.items)) return body.items;
  if (body && typeof body === "object" && body._id !== undefined) return [body];
  return [];
}

function remoteInsertedCount(body, fallback) {
  if (Number.isFinite(body?.inserted)) return body.inserted;
  return fallback;
}

function orderLikeInput(input, rows) {
  const byId = new Map();
  for (const row of rows) {
    if (row?._id !== undefined && !byId.has(String(row._id))) byId.set(String(row._id), row);
  }
  return input.map((item) => byId.get(String(item._id))).filter(Boolean);
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

function rejectIfMemoryGuardBlocked(res, memoryGuard) {
  const rejection = memoryGuard?.writeRejection?.();
  if (!rejection) return false;
  json(res, rejection.status, rejection.body, rejection.headers || {});
  return true;
}

function assertMemoryGuardAcceptsWrites(memoryGuard) {
  memoryGuard?.assertCanWrite?.();
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
    if (!requireId && item._id !== undefined && item._id !== null && String(item._id).length === 0) {
      return { error: `item at index ${i} must include a non-empty _id when _id is provided`, index: i };
    }
    if (requireId && (item._id === undefined || item._id === null || String(item._id).length === 0)) {
      return { error: `item at index ${i} must include _id`, index: i };
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
    if (item && typeof item === "object" && item._id !== undefined && item._id !== null) return String(item._id);
    const err = new TypeError(`id at index ${index} must be a non-empty string or object with _id`);
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
