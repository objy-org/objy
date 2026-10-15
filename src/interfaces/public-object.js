import { GLOBAL_DATABASE, USERS_COLLECTION } from "../auth.js";
import { aggregateRows } from "../aggregate.js";
import { collectClusterStatus } from "../cluster-status.js";
import { isNdjsonRequest, json, readJson, readNdjson } from "../http-router.js";
import {
  buildMultipartObjectFile,
  isMultipartRequest,
  readMultipartObjectFile,
  writeBlobResponse,
} from "../files.js";
import { createObjectId } from "../object-id.js";
import { applyPatchToObject, patchUnsetsPath } from "../patch.js";
import {
  canCreate,
  canDelete,
  canRead,
  canUpdate,
  isPermissionBypass,
  mergeReadPermissionQuery,
  permissionError,
} from "../permissions.js";
import { DEFAULT_IMPORT_CONFIG } from "../config.js";
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

const DEFAULT_PUBLIC_QUERY_LIMIT = 250;
const MAX_PUBLIC_QUERY_LIMIT = 250;
const READ_ONLY_DATABASES = new Set([GLOBAL_DATABASE]);
const NDJSON_MINIMAL_REQUIRED = "NDJSON write streams require Prefer: return=minimal";

export function createPublicObjectInterface() {
  return {
    name: "public-object",
    register(router, { node, auth, routing, durability, memoryGuard, restoreStatus, replicationScheduler, files, imports, objectHooks }) {
      const secure = secureRoute(auth);
      const importLimits = normalizeImportLimits(imports);

      router.get("/api/databases", secure((req, res) => {
        const databases = node.listDatabases().sort();
        if (auth.enabled && !isGlobalAdminRequest(req, auth)) {
          return json(res, 200, { databases: databases.filter((database) => database === req.auth?.claims?.database) });
        }
        json(res, 200, { databases });
      }));

      router.get("/api/config", secure(async (req, res) => {
        if (rejectUnlessGlobalAdmin(req, res, auth)) return;
        json(res, 200, await collectClusterStatus(node, {
          memoryGuard,
          replicationScheduler,
          restoreStatus,
          details: req.query.get("details") === "1",
        }));
      }));

      router.post("/api/databases", secure(async (req, res) => {
        if (rejectUnlessGlobalAdmin(req, res, auth)) return;
        const body = await readJson(req);
        const name = body?.name;
        if (typeof name !== "string" || name.length === 0) {
          return json(res, 400, { error: "body.name must be a non-empty string" });
        }
        if (rejectIfReadOnlyDatabaseWrite(res, name)) return;
        if (rejectIfMemoryGuardBlocked(res, memoryGuard)) return;
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
            await forwardSchemaChange(routing, req, "/api/databases", {
              method: "POST",
              body: databaseCreateFanoutBody(name, body),
            }, "database metadata fan-out failed");
            if (adminUser) {
              await forwardSchemaChange(
                routing,
                req,
                `/api/${encodeURIComponent(name)}/collections`,
                {
                  method: "POST",
                  body: { name: adminUser.collection, meta: adminCollectionMeta },
                },
                "admin users collection metadata fan-out failed",
              );
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
              imports: importLimits,
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

      router.delete("/api/databases/:database", secure(async (req, res) => {
        if (rejectUnlessGlobalAdmin(req, res, auth)) return;
        if (rejectIfReadOnlyDatabaseWrite(res, req.params.database)) return;
        try {
          const existed = node.getDatabaseMeta(req.params.database) !== null;
          const alreadyDeleted = node.db.isDatabaseDeleted(req.params.database);
          if (!existed && !alreadyDeleted && !routing.isForwarded(req)) {
            return json(res, 404, { error: "database not found" });
          }
          const removed = node.removeDatabase(req.params.database);
          if (removed || !alreadyDeleted) await afterLocalWrite(durability);
          if (removed) await deleteDatabaseFilesBestEffort(files, req.params.database);
          if (!routing.isForwarded(req)) {
            await forwardSchemaChange(
              routing,
              req,
              `/api/databases/${encodeURIComponent(req.params.database)}`,
              { method: "DELETE", allowUnavailable: false },
              "database delete fan-out failed",
            );
          }
          json(res, 204);
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
        if (rejectIfReadOnlyDatabaseWrite(res, req.params.database)) return;
        if (rejectUnlessDatabaseAdmin(req, res, auth)) return;
        if (rejectIfMemoryGuardBlocked(res, memoryGuard)) return;
        const body = await readJson(req);
        const name = body?.name;
        if (typeof name !== "string" || name.length === 0) {
          return json(res, 400, { error: "body.name must be a non-empty string" });
        }
        const created = node.getCollectionMeta(req.params.database, name) === null;
        try {
          const collectionMeta = collectionMetaFromBody(body);
          objectHooks.validateMeta(collectionMeta);
          const meta = node.createCollection(req.params.database, name, collectionMeta);
          await afterLocalWrite(durability);
          if (!routing.isForwarded(req)) {
            await forwardSchemaChange(
              routing,
              req,
              `/api/${encodeURIComponent(req.params.database)}/collections`,
              { method: "POST", body },
              "collection metadata fan-out failed",
            );
          }
          json(res, created ? 201 : 200, { name, created, meta });
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
      }));

      router.delete("/api/:database/collections/:collection", secure(async (req, res) => {
        if (rejectIfReadOnlyDatabaseWrite(res, req.params.database)) return;
        if (rejectUnlessDatabaseAdmin(req, res, auth)) return;
        try {
          const existed = node.getCollectionMeta(req.params.database, req.params.collection) !== null;
          const alreadyDeleted = node.db.isCollectionDeleted(req.params.database, req.params.collection);
          if (!existed && !alreadyDeleted && !routing.isForwarded(req)) {
            return json(res, 404, { error: "collection not found" });
          }
          const removed = node.removeCollection(req.params.database, req.params.collection);
          if (removed || !alreadyDeleted) await afterLocalWrite(durability);
          if (removed) await deleteCollectionFilesBestEffort(files, req.params.database, req.params.collection);
          if (!routing.isForwarded(req)) {
            await forwardSchemaChange(
              routing,
              req,
              `/api/${encodeURIComponent(req.params.database)}/collections/${encodeURIComponent(req.params.collection)}`,
              { method: "DELETE", allowUnavailable: false },
              "collection delete fan-out failed",
            );
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
        if (rejectIfReadOnlyDatabaseWrite(res, req.params.database)) return;
        if (rejectUnlessDatabaseAdmin(req, res, auth)) return;
        if (rejectIfMemoryGuardBlocked(res, memoryGuard)) return;
        const body = await readJson(req);
        if (!isPlainObject(body)) return json(res, 400, { error: "collection meta must be a plain object" });
        try {
          objectHooks.validateMeta(body);
          const meta = node.setCollectionMeta(req.params.database, req.params.collection, body);
          await afterLocalWrite(durability);
          if (!routing.isForwarded(req)) {
            await forwardSchemaChange(
              routing,
              req,
              `/api/${encodeURIComponent(req.params.database)}/${encodeURIComponent(req.params.collection)}/meta`,
              { method: "PUT", body },
              "collection metadata fan-out failed",
            );
          }
          json(res, 200, meta);
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
      }));

      router.post("/api/:database/:collection/search", secure(async (req, res) => {
        const query = await readJson(req);
        if (!isPlainObject(query)) return json(res, 400, { error: "search body must be a JSON object" });
        try {
          const result = await runObjectOperation({
            req, node, routing, auth, objectHooks, operation: "read", variant: "query", input: { query },
          }, ({ query: hookedQuery }) => {
            if (!isPlainObject(hookedQuery)) throw httpError(400, "search body must be a JSON object");
            return executeCollectionQuery(req, { node, routing, query: hookedQuery });
          });
          jsonWithQueryPath(
            res,
            200,
            publicQueryResult(req, auth, req.params.database, req.params.collection, result),
            result.path,
          );
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
      }));

      router.get("/api/:database/:collection/object", secure(async (req, res) => {
        let query;
        try {
          query = parseQueryParam(req);
        } catch (err) {
          json(res, 400, { error: err.message });
          return;
        }
        try {
          const result = await runObjectOperation({
            req, node, routing, auth, objectHooks, operation: "read", variant: "query", input: { query },
          }, ({ query: hookedQuery }) => {
            if (!isPlainObject(hookedQuery)) throw httpError(400, "q must be a JSON object");
            return executeCollectionQuery(req, { node, routing, query: hookedQuery });
          });
          jsonWithQueryPath(
            res,
            200,
            publicQueryResult(req, auth, req.params.database, req.params.collection, result),
            result.path,
          );
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
      }));

      router.get("/api/:database/:collection/object/:id", secure(async (req, res) => {
        const refDepth = refDepthParam(req);
        try {
          const result = await runObjectOperation({
            req,
            node,
            routing,
            objectHooks,
            operation: "read",
            variant: "single",
            auth,
            input: { ids: [req.params.id], options: { refDepth } },
          }, async () => {
            if (!routing.shouldHandleObjectLocally(req, req.params.database, req.params.collection, req.params.id)) {
              const remote = await routing.forwardToObject(
                req,
                req.params.database,
                req.params.collection,
                req.params.id,
                objectPath(req.params.database, req.params.collection, req.params.id),
                { method: "GET", query: refDepthQuery(0), retryStatuses: [404, 409, 503] },
              );
              if (!ok(remote.status)) return { status: remote.status, body: remote.body, headers: remote.headers };
              const object = await expandObjectForRead({
                req,
                node,
                routing,
                database: req.params.database,
                object: stripReferenceObjects(remote.body),
                refDepth,
              });
              return { status: 200, body: object };
            }

            const object = node.get(req.params.database, req.params.collection, req.params.id);
            if (!object) return { status: 404, body: { error: "not found" } };
            assertReadAllowed(req, object);
            return {
              status: 200,
              body: await expandObjectForRead({
                req,
                node,
                routing,
                database: req.params.database,
                object,
                refDepth,
              }),
            };
          });
          if (result.status !== 200) return json(res, result.status, result.body, result.headers || {});
          assertReadAllowed(req, result.body);
          json(res, 200, auth.redactObject(req.params.database, req.params.collection, result.body));
        } catch (err) {
          return json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
      }));

      router.get("/api/:database/:collection/object/:id/blob", secure(async (req, res) => {
        if (!files) return json(res, 404, { error: "file storage is not configured" });
        try {
          const result = await runObjectOperation({
            req,
            node,
            routing,
            objectHooks,
            operation: "read",
            variant: "blob",
            auth,
            input: { ids: [req.params.id] },
          }, async () => {
            const object = await readableObjectForFile({ req, node, routing });
            if (!object) return { status: 404, body: { error: "not found" } };
            if (!object._file) return { status: 404, body: { error: "object has no file" } };
            const blob = await files.get(req.params.database, req.params.collection, req.params.id, object._file);
            if (!blob) return { status: 404, body: { error: "file not found" } };
            return { status: 200, blob, mimeType: object._file.mimeType };
          });
          if (result.status !== 200) return json(res, result.status, result.body);
          await writeBlobResponse(res, result.blob, result.mimeType);
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
      }));

      router.post("/api/:database/:collection/object", secure(async (req, res) => {
        if (rejectIfReadOnlyDatabaseWrite(res, req.params.database)) return;
        if (isMultipartRequest(req)) {
          return multipartCreateObject({ req, res, node, auth, routing, durability, memoryGuard, files, imports: importLimits, objectHooks });
        }
        if (isNdjsonRequest(req)) {
          return streamCreateObjects({ req, res, node, auth, routing, durability, memoryGuard, files, imports: importLimits, objectHooks });
        }
        const body = await readJson(req);
        const isBulk = Array.isArray(body);
        const rawItems = isBulk ? body : [body || {}];
        try {
          const items = prepareCreateObjects(files, req.params.database, req.params.collection, rawItems);
          const minimalBulkReturn = isBulk && prefersMinimalReturn(req);
          const result = await runObjectOperation({
            req, node, routing, auth, objectHooks, operation: "create", variant: isBulk ? "bulk" : "single", input: { objects: items },
          }, ({ objects }, context) => routedCreateMany({
            req,
            routing,
            auth,
            node,
            database: req.params.database,
            collection: req.params.collection,
            objects: context ? prepareCreateObjects(files, req.params.database, req.params.collection, objects) : objects,
            durability,
            memoryGuard,
            imports: importLimits,
            minimalReturn: minimalBulkReturn,
          }));
          if (minimalBulkReturn && !Object.hasOwn(result, "responseOverride")) {
            return json(res, 201, { inserted: result.inserted });
          }
          const safeRows = auth.redactObjects(req.params.database, req.params.collection, result.items);
          json(res, 201, writeResponse(req, auth, result,
            isBulk ? { inserted: safeRows.length, items: safeRows } : safeRows[0]));
        } catch (err) {
          return json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
      }));

      router.put("/api/:database/:collection/object", secure(async (req, res) => {
        if (rejectIfReadOnlyDatabaseWrite(res, req.params.database)) return;
        if (isNdjsonRequest(req)) {
          return streamReplaceObjects({ req, res, node, auth, routing, durability, memoryGuard, files, imports: importLimits, objectHooks });
        }
        const body = await readJson(req);
        if (!Array.isArray(body)) return json(res, 400, { error: "body must be an array of objects with _id" });
        const error = validatePlainObjects(body, { requireId: true });
        if (error) return json(res, 400, error);
        try {
          const objects = normalizeFileObjects(files, req.params.database, req.params.collection, body);
          const result = await runObjectOperation({
            req, node, routing, auth, objectHooks, operation: "update", variant: "bulk-replace", input: { objects },
          }, ({ objects: hookedObjects }, context) => routedWriteMany({
            req,
            routing,
            auth,
            node,
            database: req.params.database,
            collection: req.params.collection,
            objects: context
              ? validateAndNormalizeObjects(files, req.params.database, req.params.collection, hookedObjects)
              : hookedObjects,
            method: "PUT",
            resultKey: "replaced",
            partial: false,
            localWrite: (prepared) => node.replaceMany(req.params.database, req.params.collection, prepared),
            durability,
            memoryGuard,
            files,
            imports: importLimits,
            localWriteCount: (prepared) => node.replaceManyCount(req.params.database, req.params.collection, prepared),
            minimalReturn: prefersMinimalReturn(req),
          }));
          json(res, 200, writeResponse(req, auth, result, result.items
            ? auth.redactResult(req.params.database, req.params.collection, result)
            : result));
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
      }));

      router.patch("/api/:database/:collection/object", secure(async (req, res) => {
        if (rejectIfReadOnlyDatabaseWrite(res, req.params.database)) return;
        if (isNdjsonRequest(req)) {
          return streamPatchObjects({ req, res, node, auth, routing, durability, memoryGuard, files, imports: importLimits, objectHooks });
        }
        const body = await readJson(req);
        if (!Array.isArray(body)) return json(res, 400, { error: "body must be an array of objects with _id" });
        const error = validatePlainObjects(body, { requireId: true });
        if (error) return json(res, 400, error);
        try {
          const result = await runObjectOperation({
            req, node, routing, auth, objectHooks, operation: "update", variant: "bulk-patch", input: { patches: body },
          }, ({ patches }, context) => routedPatchMany({
            req,
            routing,
            auth,
            node,
            database: req.params.database,
            collection: req.params.collection,
            patches: context ? validatePatches(patches) : patches,
            durability,
            memoryGuard,
            files,
            imports: importLimits,
            minimalReturn: prefersMinimalReturn(req),
          }));
          json(res, 200, writeResponse(req, auth, result, result.items
            ? auth.redactResult(req.params.database, req.params.collection, result)
            : result));
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
      }));

      router.delete("/api/:database/:collection/object", secure(async (req, res) => {
        if (rejectIfReadOnlyDatabaseWrite(res, req.params.database)) return;
        if (isNdjsonRequest(req)) {
          return streamRemoveObjects({
            req,
            res,
            node,
            routing,
            durability,
            files,
            imports: importLimits,
            database: req.params.database,
            collection: req.params.collection,
            objectHooks,
            auth,
          });
        }
        let ids;
        try {
          ids = parseBulkIds(await readJson(req, null));
        } catch (err) {
          return json(res, 400, errorBody(err));
        }
        try {
          const result = await runObjectOperation({
            req, node, routing, auth, objectHooks, operation: "delete", variant: "bulk", input: { ids },
          }, ({ ids: hookedIds }) => routedRemoveMany(
            req,
            routing,
            node,
            durability,
            req.params.database,
            req.params.collection,
            normalizeHookIds(hookedIds),
            files,
            { minimalReturn: prefersMinimalReturn(req) },
          ));
          json(res, 200, writeResponse(req, auth, result, result));
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
      }));

      router.put("/api/:database/:collection/object/:id", secure(async (req, res) => {
        if (rejectIfReadOnlyDatabaseWrite(res, req.params.database)) return;
        if (isMultipartRequest(req)) {
          return multipartReplaceObject({ req, res, node, auth, routing, durability, memoryGuard, files, imports: importLimits, objectHooks });
        }
        const body = await readJson(req);
        const error = validatePlainObjects([body || {}]);
        if (error) return json(res, 400, error);
        const refDepth = refDepthParam(req);
        try {
          const result = await runObjectOperation({
            req,
            node,
            routing,
            objectHooks,
            auth,
            operation: "update",
            variant: "single-replace",
            input: { objects: [{ ...(body || {}), _id: req.params.id }] },
          }, async ({ objects }) => {
            const object = singlePathObject(objects, req.params.id);
            if (!routing.shouldHandleObjectLocally(req, req.params.database, req.params.collection, req.params.id)) {
              const remote = await routing.forwardToObject(
                req,
                req.params.database,
                req.params.collection,
                req.params.id,
                objectPath(req.params.database, req.params.collection, req.params.id),
                { method: "PUT", body: object, query: refDepthQuery(0) },
              );
              if (!ok(remote.status)) return { status: remote.status, body: remote.body, headers: remote.headers };
              return {
                status: remote.status,
                body: await expandObjectForRead({
                  req,
                  node,
                  routing,
                  database: req.params.database,
                  object: stripReferenceObjects(remote.body),
                  refDepth,
                }),
              };
            }
            const [prepared] = auth.prepareWriteObjects(
              req.params.database,
              req.params.collection,
              [object],
              { partial: false },
            );
            const preparedObject = normalizeFileObject(files, req.params.database, req.params.collection, prepared);
            assertImportWriteAccepts({ req, imports: importLimits, durability, objects: [preparedObject] });
            assertUpsertAllowed(req, node, req.params.database, req.params.collection, [preparedObject], { partial: false });
            assertMemoryGuardAcceptsWrites(memoryGuard);
            const before = node.get(req.params.database, req.params.collection, req.params.id);
            node.replace(req.params.database, req.params.collection, req.params.id, preparedObject);
            await afterLocalWrite(durability);
            const written = node.get(req.params.database, req.params.collection, req.params.id) || { _id: req.params.id };
            await deleteRemovedFiles(files, req.params.database, req.params.collection, [before], [written]);
            return {
              status: 200,
              body: await expandObjectForRead({
                req,
                node,
                routing,
                database: req.params.database,
                object: written,
                refDepth,
              }),
            };
          });
          if (!ok(result.status)) return json(res, result.status, result.body, result.headers || {});
          json(res, result.status, writeResponse(req, auth, result,
            auth.redactObject(req.params.database, req.params.collection, result.body)));
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
      }));

      router.patch("/api/:database/:collection/object/:id", secure(async (req, res) => {
        if (rejectIfReadOnlyDatabaseWrite(res, req.params.database)) return;
        const body = await readJson(req);
        const error = validatePlainObjects([body || {}]);
        if (error) return json(res, 400, error);
        const refDepth = refDepthParam(req);
        try {
          const result = await runObjectOperation({
            req,
            node,
            routing,
            objectHooks,
            operation: "update",
            variant: "single-patch",
            auth,
            input: { patches: [{ ...(body || {}), _id: req.params.id }] },
          }, async ({ patches }) => {
            const patch = singlePathObject(patches, req.params.id);
            if (!routing.shouldHandleObjectLocally(req, req.params.database, req.params.collection, req.params.id)) {
              const remote = await routing.forwardToObject(
                req,
                req.params.database,
                req.params.collection,
                req.params.id,
                objectPath(req.params.database, req.params.collection, req.params.id),
                { method: "PATCH", body: withoutObjectId(patch), query: refDepthQuery(0) },
              );
              if (!ok(remote.status)) return { status: remote.status, body: remote.body, headers: remote.headers };
              return {
                status: remote.status,
                body: await expandObjectForRead({
                  req,
                  node,
                  routing,
                  database: req.params.database,
                  object: stripReferenceObjects(remote.body),
                  refDepth,
                }),
              };
            }
            const patchedObject = compilePatchedObject({
              node,
              database: req.params.database,
              collection: req.params.collection,
              id: req.params.id,
              patch: withoutObjectId(patch),
              files,
            });
            if (!patchedObject) return { status: 404, body: { error: "not found" } };
            const [prepared] = auth.prepareWriteObjects(
              req.params.database,
              req.params.collection,
              [patchedObject],
              { partial: true },
            );
            const preparedObject = normalizeFileObject(files, req.params.database, req.params.collection, prepared);
            assertImportWriteAccepts({ req, imports: importLimits, durability, objects: [preparedObject] });
            assertUpdateAllowed(req, node, req.params.database, req.params.collection, [preparedObject]);
            assertMemoryGuardAcceptsWrites(memoryGuard);
            const before = node.get(req.params.database, req.params.collection, req.params.id);
            node.replace(req.params.database, req.params.collection, req.params.id, preparedObject);
            await afterLocalWrite(durability);
            const written = node.get(req.params.database, req.params.collection, req.params.id) || { _id: req.params.id };
            await deleteRemovedFiles(files, req.params.database, req.params.collection, [before], [written]);
            return {
              status: 200,
              body: await expandObjectForRead({
                req,
                node,
                routing,
                database: req.params.database,
                object: written,
                refDepth,
              }),
            };
          });
          if (!ok(result.status)) return json(res, result.status, result.body, result.headers || {});
          json(res, result.status, writeResponse(req, auth, result,
            auth.redactObject(req.params.database, req.params.collection, result.body)));
        } catch (err) {
          json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
      }));

      router.delete("/api/:database/:collection/object/:id", secure(async (req, res) => {
        if (rejectIfReadOnlyDatabaseWrite(res, req.params.database)) return;
        try {
          const result = await runObjectOperation({
            req,
            node,
            routing,
            objectHooks,
            operation: "delete",
            variant: "single",
            auth,
            input: { ids: [req.params.id] },
          }, async () => {
            if (!routing.shouldHandleObjectLocally(req, req.params.database, req.params.collection, req.params.id)) {
              return routing.forwardToObject(
                req,
                req.params.database,
                req.params.collection,
                req.params.id,
                objectPath(req.params.database, req.params.collection, req.params.id),
                { method: "DELETE" },
              );
            }
            const existing = node.get(req.params.database, req.params.collection, req.params.id);
            if (!existing) return { status: 404, body: { error: "not found" } };
            assertDeleteAllowed(req, [existing], req.params.database);
            const removed = node.remove(req.params.database, req.params.collection, req.params.id);
            if (!removed) return { status: 404, body: { error: "not found" } };
            await afterLocalWrite(durability);
            await deleteObjectFiles(files, req.params.database, req.params.collection, [existing]);
            return { status: 204, body: null };
          });
          json(res, Object.hasOwn(result, "responseOverride") ? 200 : result.status,
            writeResponse(req, auth, result, result.body), result.headers || {});
        } catch (err) {
          return json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
        }
      }));
    },
  };
}

function runObjectOperation({
  req,
  node,
  routing,
  auth,
  objectHooks,
  operation,
  variant,
  input,
  batch = null,
}, execute) {
  if (!objectHooks || routing.isForwarded(req)) return execute(input, null);
  return objectHooks.run({
    operation,
    variant,
    database: req.params.database,
    collection: req.params.collection,
    input,
    principal: req.auth?.user || null,
    batch,
    lookup: createHookLookup(req, node, routing, auth),
  }, execute);
}

function writeResponse(req, auth, result, ordinaryBody) {
  return Object.hasOwn(result, "responseOverride")
    ? auth.redactObject(req.params.database, req.params.collection, result.responseOverride)
    : ordinaryBody;
}

function createHookLookup(req, node, routing, auth) {
  const database = req.params.database;
  const find = async (collection, criteria = {}, options = {}) => {
    if (typeof collection !== "string" || !collection) throw httpError(400, "lookup collection is required");
    const access = readCriteriaForRequest(req, criteria, collection);
    if (access.denied) return [];
    const result = await routing.find(req, database, collection, access.query, {
      limit: options.limit ?? 250,
      offset: options.offset ?? 0,
      refDepth: 0,
    });
    const readable = (result.objects || []).filter((object) => canRead(permissionUser(req), object, collection));
    return auth.redactObjects(database, collection, readable);
  };
  return Object.freeze({
    find,
    async get(collection, id) {
      if (typeof collection !== "string" || !collection) throw httpError(400, "lookup collection is required");
      const object = await resolveReferencedObject({
        req, node, routing, database, collection, id: String(id),
      });
      return object ? auth.redactObject(database, collection, object) : null;
    },
  });
}

function publicQueryResult(req, auth, database, collection, result) {
  if (!result.objectRows) return result.body;
  const readable = (result.body || []).filter((object) => canRead(permissionUser(req), object, collection));
  return auth.redactObjects(database, collection, readable);
}

function validateAndNormalizeObjects(files, database, collection, objects) {
  const error = validatePlainObjects(objects || [], { requireId: true });
  if (error) throw validationError(error);
  return normalizeFileObjects(files, database, collection, objects);
}

function validatePatches(patches) {
  const error = validatePlainObjects(patches || [], { requireId: true });
  if (error) throw validationError(error);
  return patches;
}

function normalizeHookIds(ids) {
  if (!Array.isArray(ids)) throw httpError(400, "hook input.ids must be an array");
  return parseNdjsonIds(ids);
}

function singleObject(objects) {
  if (!Array.isArray(objects) || objects.length !== 1) {
    throw httpError(400, "single-object hook input must contain exactly one object");
  }
  const error = validatePlainObjects(objects, { requireId: true });
  if (error) throw validationError(error);
  return objects[0];
}

function singlePathObject(objects, id) {
  if (!Array.isArray(objects) || objects.length !== 1) {
    throw httpError(400, "single-object hook input must contain exactly one object");
  }
  const error = validatePlainObjects(objects);
  if (error) throw validationError(error);
  return { ...objects[0], _id: String(id) };
}

function withoutObjectId(object = {}) {
  const { _id, ...rest } = object;
  return rest;
}

async function multipartCreateObject({ req, res, node, auth, routing, durability, memoryGuard, files, imports, objectHooks }) {
  if (!files) return json(res, 404, { error: "file storage is not configured" });
  try {
    assertMemoryGuardAcceptsWrites(memoryGuard);
    const { object, file } = await readMultipartObjectFile(req, {
      maxBytes: files.maxUploadBytes,
      assertCanBuffer: () => assertMemoryGuardAcceptsWrites(memoryGuard),
    });
    const error = validatePlainObjects([object]);
    if (error) return json(res, 400, error);
    const item = withObjectIds([object])[0];
    const result = await runObjectOperation({
      req,
      node,
      routing,
      objectHooks,
      operation: "create",
      variant: "file",
      auth,
      input: { objects: [item], file },
    }, async ({ objects, file: hookedFile }) => {
      const hookedItem = singleObject(objects);
      if (!routing.shouldHandleObjectLocally(req, req.params.database, req.params.collection, hookedItem._id)) {
        const forwarded = buildMultipartObjectFile({ object: hookedItem, file: hookedFile });
        const remote = await routing.forwardToObjectRaw(
          req,
          req.params.database,
          req.params.collection,
          hookedItem._id,
          objectPath(req.params.database, req.params.collection),
          {
            method: "POST",
            body: forwarded.body,
            contentType: forwarded.contentType,
            query: refDepthQuery(0),
          },
        );
        if (!ok(remote.status)) return { status: remote.status, body: remote.body, headers: remote.headers };
        return {
          status: remote.status,
          body: await expandObjectForRead({
            req,
            node,
            routing,
            database: req.params.database,
            object: stripReferenceObjects(remote.body),
            refDepth: refDepthParam(req),
          }),
        };
      }

      if (node.get(req.params.database, req.params.collection, hookedItem._id)) {
        throw httpError(409, `object already exists: ${hookedItem._id}`);
      }
      const objectWithFile = files.attach(req.params.database, req.params.collection, hookedItem, hookedFile);
      const [prepared] = auth.prepareWriteObjects(req.params.database, req.params.collection, [objectWithFile], { partial: false });
      assertImportWriteAccepts({ req, imports, durability, objects: [prepared], ignoreBodyBytes: true });
      assertCreateAllowed(req, [prepared], req.params.database);
      await files.put(req.params.database, req.params.collection, hookedItem._id, objectWithFile._file, hookedFile);
      const [row] = node.insertMany(req.params.database, req.params.collection, [prepared]);
      await afterLocalWrite(durability);
      return {
        status: 201,
        body: await expandObjectForRead({
          req,
          node,
          routing,
          database: req.params.database,
          object: stripReferenceObjects(row),
          refDepth: refDepthParam(req),
        }),
      };
    });
    if (!ok(result.status)) return json(res, result.status, result.body, result.headers || {});
    return json(res, result.status, writeResponse(req, auth, result,
      auth.redactObject(req.params.database, req.params.collection, result.body)));
  } catch (err) {
    return json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
  }
}

async function multipartReplaceObject({ req, res, node, auth, routing, durability, memoryGuard, files, imports, objectHooks }) {
  if (!files) return json(res, 404, { error: "file storage is not configured" });
  try {
    assertMemoryGuardAcceptsWrites(memoryGuard);
    const { object, file } = await readMultipartObjectFile(req, {
      maxBytes: files.maxUploadBytes,
      assertCanBuffer: () => assertMemoryGuardAcceptsWrites(memoryGuard),
    });
    const error = validatePlainObjects([object]);
    if (error) return json(res, 400, error);
    const item = { ...object, _id: req.params.id };
    const result = await runObjectOperation({
      req,
      node,
      routing,
      objectHooks,
      operation: "update",
      variant: "file",
      auth,
      input: { objects: [item], file },
    }, async ({ objects, file: hookedFile }) => {
      const hookedItem = singlePathObject(objects, req.params.id);
      if (!routing.shouldHandleObjectLocally(req, req.params.database, req.params.collection, req.params.id)) {
        const forwarded = buildMultipartObjectFile({ object: hookedItem, file: hookedFile });
        const remote = await routing.forwardToObjectRaw(
          req,
          req.params.database,
          req.params.collection,
          req.params.id,
          objectPath(req.params.database, req.params.collection, req.params.id),
          {
            method: "PUT",
            body: forwarded.body,
            contentType: forwarded.contentType,
            query: refDepthQuery(0),
          },
        );
        if (!ok(remote.status)) return { status: remote.status, body: remote.body, headers: remote.headers };
        return {
          status: remote.status,
          body: await expandObjectForRead({
            req,
            node,
            routing,
            database: req.params.database,
            object: stripReferenceObjects(remote.body),
            refDepth: refDepthParam(req),
          }),
        };
      }

      const objectWithFile = files.attach(req.params.database, req.params.collection, hookedItem, hookedFile);
      const [prepared] = auth.prepareWriteObjects(req.params.database, req.params.collection, [objectWithFile], { partial: false });
      assertImportWriteAccepts({ req, imports, durability, objects: [prepared], ignoreBodyBytes: true });
      assertUpsertAllowed(req, node, req.params.database, req.params.collection, [prepared], { partial: false });
      const before = node.get(req.params.database, req.params.collection, req.params.id);
      await files.put(req.params.database, req.params.collection, req.params.id, objectWithFile._file, hookedFile);
      node.replace(req.params.database, req.params.collection, req.params.id, prepared);
      await afterLocalWrite(durability);
      const row = node.get(req.params.database, req.params.collection, req.params.id) || { _id: req.params.id };
      await deleteRemovedFiles(files, req.params.database, req.params.collection, [before], [row]);
      return {
        status: 200,
        body: await expandObjectForRead({
          req,
          node,
          routing,
          database: req.params.database,
          object: stripReferenceObjects(row),
          refDepth: refDepthParam(req),
        }),
      };
    });
    if (!ok(result.status)) return json(res, result.status, result.body, result.headers || {});
    return json(res, result.status, writeResponse(req, auth, result,
      auth.redactObject(req.params.database, req.params.collection, result.body)));
  } catch (err) {
    return json(res, err.status || 400, err.body || errorBody(err), err.headers || {});
  }
}

async function readableObjectForFile({ req, node, routing }) {
  if (!routing.shouldHandleObjectLocally(req, req.params.database, req.params.collection, req.params.id)) {
    const remote = await routing.forwardToObject(
      req,
      req.params.database,
      req.params.collection,
      req.params.id,
      objectPath(req.params.database, req.params.collection, req.params.id),
      { method: "GET", query: refDepthQuery(0), retryStatuses: [404, 409, 503] },
    );
    if (remote.status === 404) return null;
    if (!ok(remote.status)) throw remoteError(remote, "file object lookup failed");
    return stripReferenceObjects(remote.body);
  }

  const object = node.get(req.params.database, req.params.collection, req.params.id);
  if (object) assertReadAllowed(req, object);
  return object || null;
}

async function executeCollectionQuery(req, { node, routing, query }) {
  const { criteria, controls } = splitQueryControls(query);
  const database = req.params.database;
  const collection = req.params.collection;

  const access = readCriteriaForRequest(req, criteria);
  if (access.denied) return { body: [], path: "permission-denied" };
  const securedCriteria = access.query;
  const options = queryOptions(req, controls);
  if (controls.$aggregate !== undefined) {
    if (controls.$vector !== undefined) {
      throw httpError(400, "$aggregate and $vector are mutually exclusive");
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
      return { body: aggregateRows(rows.rows, controls.$aggregate), path: aggregateReferencePath(rows.path) };
    }
    const result = await routing.aggregate(req, database, collection, securedCriteria, controls.$aggregate);
    return { body: result.rows, path: result.path };
  }

  if (controls.$vector !== undefined) {
    if (referenceDepthForQuery(securedCriteria) > 0) {
      throw httpError(400, "$vector cannot be combined with reference object paths yet");
    }
    const vector = parseVectorSearch(controls.$vector);
    const rows = await routing.vectorSearch(req, database, collection, securedCriteria, vector, options);
    const expanded = await expandObjectsForRead({
      req,
      node,
      routing,
      database,
      collection,
      objects: rows,
      refDepth: options.refDepth,
    });
    return {
      body: expanded,
      path: Object.keys(securedCriteria || {}).length > 0 ? "vector-filter" : "vector-index",
      objectRows: true,
    };
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
  return { body: result.objects, path: result.path, objectRows: true };
}

async function streamCreateObjects({ req, res, node, auth, routing, durability, memoryGuard, files, imports, objectHooks }) {
  if (rejectNdjsonWithoutMinimal(req, res)) return;
  const result = { inserted: 0 };
  try {
    await consumeNdjsonChunks({
      req,
      imports,
      prepare: (objects) => prepareCreateObjects(
        files,
        req.params.database,
        req.params.collection,
        objects,
        { mutateIds: true },
      ),
      write: async (objects, batchIndex) => {
        const written = await runObjectOperation({
          req,
          node,
          routing,
          objectHooks,
          operation: "create",
          variant: "stream",
          auth,
          input: { objects },
          batch: { index: batchIndex, streaming: true },
        }, ({ objects: hookedObjects }, context) => routedCreateMany({
          req,
          routing,
          auth,
          node,
          database: req.params.database,
          collection: req.params.collection,
          objects: context
            ? prepareCreateObjects(files, req.params.database, req.params.collection, hookedObjects)
            : hookedObjects,
          durability,
          memoryGuard,
          imports,
          minimalReturn: true,
          ignoreBodyBytes: true,
          validatedObjectBytes: !context,
        }));
        result.inserted += written.inserted;
      },
    });
    json(res, 201, result);
  } catch (err) {
    json(res, err.status || 400, streamErrorBody(err, result), err.headers || {});
  }
}

async function streamReplaceObjects({ req, res, node, auth, routing, durability, memoryGuard, files, imports, objectHooks }) {
  if (rejectNdjsonWithoutMinimal(req, res)) return;
  const result = { replaced: 0 };
  try {
    await consumeNdjsonChunks({
      req,
      imports,
      prepare: (objects) => {
        const error = validatePlainObjects(objects, { requireId: true });
        if (error) throw validationError(error);
        return normalizeFileObjects(files, req.params.database, req.params.collection, objects);
      },
      write: async (objects, batchIndex) => {
        const written = await runObjectOperation({
          req,
          node,
          routing,
          objectHooks,
          operation: "update",
          variant: "stream-replace",
          auth,
          input: { objects },
          batch: { index: batchIndex, streaming: true },
        }, ({ objects: hookedObjects }, context) => routedWriteMany({
          req,
          routing,
          auth,
          node,
          database: req.params.database,
          collection: req.params.collection,
          objects: context
            ? validateAndNormalizeObjects(files, req.params.database, req.params.collection, hookedObjects)
            : hookedObjects,
          method: "PUT",
          resultKey: "replaced",
          partial: false,
          localWrite: (prepared) => node.replaceMany(req.params.database, req.params.collection, prepared),
          localWriteCount: (prepared) => node.replaceManyCount(req.params.database, req.params.collection, prepared),
          durability,
          memoryGuard,
          files,
          imports,
          minimalReturn: true,
          ignoreBodyBytes: true,
          validatedObjectBytes: !context,
        }));
        result.replaced += written.replaced;
      },
    });
    json(res, 200, result);
  } catch (err) {
    json(res, err.status || 400, streamErrorBody(err, result), err.headers || {});
  }
}

async function streamPatchObjects({ req, res, node, auth, routing, durability, memoryGuard, files, imports, objectHooks }) {
  if (rejectNdjsonWithoutMinimal(req, res)) return;
  const result = { updated: 0, skipped: 0 };
  try {
    await consumeNdjsonChunks({
      req,
      imports,
      prepare: (objects) => {
        const error = validatePlainObjects(objects, { requireId: true });
        if (error) throw validationError(error);
        return objects;
      },
      write: async (patches, batchIndex) => {
        const written = await runObjectOperation({
          req,
          node,
          routing,
          objectHooks,
          operation: "update",
          variant: "stream-patch",
          auth,
          input: { patches },
          batch: { index: batchIndex, streaming: true },
        }, ({ patches: hookedPatches }, context) => routedPatchMany({
          req,
          routing,
          auth,
          node,
          database: req.params.database,
          collection: req.params.collection,
          patches: context ? validatePatches(hookedPatches) : hookedPatches,
          durability,
          memoryGuard,
          files,
          imports,
          minimalReturn: true,
          ignoreBodyBytes: true,
          validatedObjectBytes: !context,
        }));
        result.updated += written.updated;
        result.skipped += written.skipped;
      },
    });
    json(res, 200, result);
  } catch (err) {
    json(res, err.status || 400, streamErrorBody(err, result), err.headers || {});
  }
}

async function streamRemoveObjects({ req, res, node, routing, auth, durability, files, imports, database, collection, objectHooks }) {
  if (rejectNdjsonWithoutMinimal(req, res)) return;
  const result = { deleted: 0, skipped: 0 };
  try {
    await consumeNdjsonChunks({
      req,
      imports,
      prepare: parseNdjsonIds,
      write: async (ids, batchIndex) => {
        const removed = await runObjectOperation({
          req,
          node,
          routing,
          objectHooks,
          operation: "delete",
          variant: "stream",
          auth,
          input: { ids },
          batch: { index: batchIndex, streaming: true },
        }, ({ ids: hookedIds }, context) => {
          const normalizedIds = normalizeHookIds(hookedIds);
          assertImportWriteAccepts({
            req,
            imports,
            durability,
            objects: normalizedIds.map((id) => ({ _id: id })),
            ignoreBodyBytes: true,
            validatedObjectBytes: !context,
          });
          return routedRemoveMany(
            req,
            routing,
            node,
            durability,
            database,
            collection,
            normalizedIds,
            files,
            { minimalReturn: true },
          );
        });
        result.deleted += removed.deleted;
        result.skipped += removed.skipped;
      },
    });
    json(res, 200, result);
  } catch (err) {
    json(res, err.status || 400, streamErrorBody(err, result), err.headers || {});
  }
}

async function routedCreateMany({
  req,
  routing,
  auth,
  node,
  database,
  collection,
  objects,
  durability,
  memoryGuard,
  imports,
  minimalReturn = false,
  ignoreBodyBytes = false,
  validatedObjectBytes = false,
}) {
  assertImportWriteAccepts({ req, imports, durability, objects, ignoreBodyBytes, validatedObjectBytes });
  const rows = [];
  let inserted = 0;
  let wroteLocally = false;
  const groups = routing.groupByShard(req, database, collection, objects, (item) => item._id);
  const preparedByGroup = new Map();

  for (const group of groups) {
    if (!group.local) continue;
    const prepared = auth.prepareWriteObjects(database, collection, group.items, { partial: false });
    assertCreateAllowed(req, prepared, database);
    preparedByGroup.set(group, prepared);
  }
  if (preparedByGroup.size) assertMemoryGuardAcceptsWrites(memoryGuard);

  try {
    for (const group of groups) {
      if (group.local) {
        const prepared = preparedByGroup.get(group);
        if (minimalReturn) {
          inserted += node.insertManyCount(database, collection, prepared);
        } else {
          const localRows = node.insertMany(database, collection, prepared);
          rows.push(...localRows);
          inserted += localRows.length;
        }
        wroteLocally = true;
        continue;
      }

      const remote = await forwardShardBulkWrite(routing, req, group.shard, objectPath(database, collection), {
        method: "POST",
        items: group.items,
        query: refDepthQuery(0),
        minimalReturn,
      });
      if (!ok(remote.status)) throw remoteError(remote, `POST failed on shard ${group.shard}`);
      const remoteRows = remoteInsertedItems(remote.body);
      if (!minimalReturn) rows.push(...remoteRows);
      inserted += remoteInsertedCount(remote.body, remoteRows.length);
    }
    if (wroteLocally) await afterLocalWrite(durability);
  } catch (err) {
    if (wroteLocally) await afterLocalWrite(durability).catch((flushErr) => {
      err = flushErr;
    });
    throw err;
  }

  if (minimalReturn) return { inserted };
  return {
    inserted,
    items: await expandObjectsForRead({
      req,
      node,
      routing,
      database,
      collection,
      objects: orderLikeInput(objects, rows).map(stripReferenceObjects),
      refDepth: refDepthParam(req),
    }),
  };
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
  localWriteCount,
  durability,
  memoryGuard,
  files,
  imports,
  minimalReturn = false,
  ignoreBodyBytes = false,
  validatedObjectBytes = false,
}) {
  assertImportWriteAccepts({ req, imports, durability, objects, ignoreBodyBytes, validatedObjectBytes });
  const rows = [];
  const removedFileObjects = [];
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
        const before = files ? existingObjectMap(node, database, collection, prepared.map((object) => object._id)) : null;
        if (minimalReturn && !files && localWriteCount) {
          total += Number(localWriteCount(prepared)) || 0;
        } else {
          const localResult = localWrite(prepared);
          total += Number(localResult[resultKey]) || 0;
          if (!minimalReturn) rows.push(...(localResult.items || []));
          removedFileObjects.push(...removedFiles(before, localResult.items));
        }
        wroteLocally = true;
        continue;
      }

      const remote = await forwardShardBulkWrite(routing, req, group.shard, objectPath(database, collection), {
        method,
        items: group.items,
        query: refDepthQuery(0),
        minimalReturn,
      });
      if (!ok(remote.status)) throw remoteError(remote, `${method} failed on shard ${group.shard}`);
      total += Number(remote.body?.[resultKey]) || 0;
      if (!minimalReturn) rows.push(...(Array.isArray(remote.body?.items) ? remote.body.items : []));
    }
    if (wroteLocally) {
      await afterLocalWrite(durability);
      await deleteObjectFiles(files, database, collection, removedFileObjects);
    }
  } catch (err) {
    if (wroteLocally) await afterLocalWrite(durability).catch((flushErr) => {
      err = flushErr;
    });
    throw err;
  }

  if (minimalReturn) return { [resultKey]: total };
  return {
    [resultKey]: total,
    items: await expandObjectsForRead({
      req,
      node,
      routing,
      database,
      collection,
      objects: orderLikeInput(objects, rows).map(stripReferenceObjects),
      refDepth: refDepthParam(req),
    }),
  };
}

async function routedPatchMany({
  req,
  routing,
  auth,
  node,
  database,
  collection,
  patches,
  durability,
  memoryGuard,
  files,
  imports,
  minimalReturn = false,
  ignoreBodyBytes = false,
  validatedObjectBytes = false,
}) {
  assertImportWriteAccepts({ req, imports, durability, objects: patches, ignoreBodyBytes, validatedObjectBytes });
  const rows = [];
  const skipped = [];
  let skippedCount = 0;
  const removedFileObjects = [];
  let updated = 0;
  let wroteLocally = false;
  const groups = routing.groupByShard(req, database, collection, patches, (item) => item._id);
  const preparedByGroup = new Map();

  for (const group of groups) {
    if (!group.local) continue;
    const compiled = [];
    for (const item of group.items) {
      const { _id, ...patch } = item;
      const patched = compilePatchedObject({ node, database, collection, id: _id, patch, files });
      if (!patched) {
        if (minimalReturn) skippedCount += 1;
        else skipped.push(String(_id));
        continue;
      }
      compiled.push(patched);
    }
    if (!compiled.length) continue;
    const prepared = normalizeFileObjects(
      files,
      database,
      collection,
      auth.prepareWriteObjects(database, collection, compiled, { partial: true }),
    );
    assertUpdateAllowed(req, node, database, collection, prepared);
    preparedByGroup.set(group, prepared);
  }
  if (preparedByGroup.size) assertMemoryGuardAcceptsWrites(memoryGuard);

  try {
    for (const group of groups) {
      if (group.local) {
        const prepared = preparedByGroup.get(group) || [];
        if (!prepared.length) continue;
        const before = files ? existingObjectMap(node, database, collection, prepared.map((object) => object._id)) : null;
        if (minimalReturn && !files) {
          updated += node.replaceManyCount(database, collection, prepared);
        } else {
          const localResult = node.replaceMany(database, collection, prepared);
          updated += Number(localResult.replaced) || 0;
          if (!minimalReturn) rows.push(...(localResult.items || []));
          removedFileObjects.push(...removedFiles(before, localResult.items));
        }
        wroteLocally = true;
        continue;
      }

      const remote = await forwardShardBulkWrite(routing, req, group.shard, objectPath(database, collection), {
        method: "PATCH",
        items: group.items,
        query: refDepthQuery(0),
        minimalReturn,
      });
      if (!ok(remote.status)) throw remoteError(remote, `PATCH failed on shard ${group.shard}`);
      updated += Number(remote.body?.updated) || 0;
      if (!minimalReturn) {
        rows.push(...(Array.isArray(remote.body?.items) ? remote.body.items : []));
        skipped.push(...(Array.isArray(remote.body?.skipped) ? remote.body.skipped.map(String) : []));
      } else {
        skippedCount += responseSkippedCount(remote.body);
      }
    }
    if (wroteLocally) {
      await afterLocalWrite(durability);
      await deleteObjectFiles(files, database, collection, removedFileObjects);
    }
  } catch (err) {
    if (wroteLocally) await afterLocalWrite(durability).catch((flushErr) => {
      err = flushErr;
    });
    throw err;
  }

  if (minimalReturn) return { updated, skipped: skippedCount };
  return {
    updated,
    skipped,
    items: await expandObjectsForRead({
      req,
      node,
      routing,
      database,
      collection,
      objects: orderLikeInput(patches, rows).map(stripReferenceObjects),
      refDepth: refDepthParam(req),
    }),
  };
}

function compilePatchedObject({ node, database, collection, id, patch }) {
  const objectId = String(id);
  const current = node.get(database, collection, objectId);
  if (!current) return null;
  const next = applyPatchToObject(current, patch);
  const vectorField = collectionVectorField(node, database, collection);
  if (vectorField && patchUnsetsPath(patch, vectorField)) next[vectorField] = null;
  return { ...next, _id: objectId };
}

function collectionVectorField(node, database, collection) {
  try {
    return node.db.collection(database, collection).vectorField || null;
  } catch {
    return null;
  }
}

async function routedRemoveMany(req, routing, node, durability, database, collection, ids, files = null, {
  minimalReturn = false,
} = {}) {
  const result = {
    deleted: 0,
    ...(minimalReturn ? { skipped: 0 } : { ids: [], skipped: [] }),
  };
  let wroteLocally = false;
  const existingByGroup = new Map();
  const removedFileObjects = [];
  const groups = routing.groupByShard(req, database, collection, ids, (id) => id);
  for (const group of groups) {
    if (!group.local) continue;
    const existing = existingObjectsForIds(node, database, collection, group.items);
    assertDeleteAllowed(req, existing, database);
    existingByGroup.set(group, new Map(existing.map((object) => [String(object._id), object])));
  }
  try {
    for (const group of groups) {
      if (group.local) {
        const local = node.removeMany(database, collection, group.items);
        result.deleted += local.deleted;
        if (minimalReturn) result.skipped += local.skipped.length;
        else {
          result.ids.push(...local.ids);
          result.skipped.push(...local.skipped);
        }
        const existing = existingByGroup.get(group) || new Map();
        removedFileObjects.push(...local.ids.map((id) => existing.get(String(id))).filter(Boolean));
        wroteLocally = wroteLocally || local.deleted > 0;
        continue;
      }

      const remote = await forwardShardBulkWrite(routing, req, group.shard, objectPath(database, collection), {
        method: "DELETE",
        items: group.items,
        body: { ids: group.items },
        minimalReturn,
      });
      if (!ok(remote.status)) throw remoteError(remote, `DELETE failed on shard ${group.shard}`);
      result.deleted += Number(remote.body?.deleted) || 0;
      if (minimalReturn) {
        result.skipped += responseSkippedCount(remote.body);
      } else {
        result.ids.push(...(Array.isArray(remote.body?.ids) ? remote.body.ids : []));
        result.skipped.push(...(Array.isArray(remote.body?.skipped) ? remote.body.skipped : []));
      }
    }
    if (wroteLocally) {
      await afterLocalWrite(durability);
      await deleteObjectFiles(files, database, collection, removedFileObjects);
    }
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
      collection,
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
    collection,
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

async function expandObjectsForRead({ req, node, routing, database, collection, objects, refDepth }) {
  const out = [];
  for (const object of objects || []) {
    let row = object;
    if (collection && object?._id !== undefined) {
      const shard = routing.shardForObject(database, collection, object._id);
      if (routing.ownsShard(shard)) {
        row = mergeResponseOnlyFields(node.get(database, collection, object._id, { refDepth: 0 }) || object, object);
      }
    }
    out.push(await expandObjectForRead({ req, node, routing, database, object: row, refDepth }));
  }
  return out;
}

function mergeResponseOnlyFields(base = {}, source = {}) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(source || {})) {
    if (key === "_id" || key === "_vec") continue;
    if (key.startsWith("_") && out[key] === undefined) out[key] = value;
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
    if (object) assertReadAllowed(req, object, collection);
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

function rejectIfReadOnlyDatabaseWrite(res, database) {
  if (!isReadOnlyDatabase(database)) return false;
  json(res, 403, { error: `database is read-only: ${database}` });
  return true;
}

function isReadOnlyDatabase(database) {
  return READ_ONLY_DATABASES.has(database);
}

function isGlobalAdminRequest(req, auth) {
  return auth.enabled === false || (req.auth?.claims?.globalUser === true && isAdminRequest(req, auth));
}

function isAdminRequest(req, auth) {
  return auth.enabled === false || isPermissionBypass(permissionUser(req));
}

function readCriteriaForRequest(req, criteria = {}, collection = req.params?.collection) {
  return mergeReadPermissionQuery(criteria, permissionUser(req), collection);
}

function assertReadAllowed(req, object, collection = req.params?.collection) {
  if (!canRead(permissionUser(req), object, collection)) throw permissionError("read", object?._id);
}

function assertCreateAllowed(req, objects = [], database = null) {
  assertDatabaseWritable(database);
  const user = permissionUser(req);
  for (const object of objects || []) {
    if (!canCreate(user, object, req.params?.collection)) throw permissionError("create", object?._id);
  }
}

function assertUpsertAllowed(req, node, database, collection, objects = [], { partial = false } = {}) {
  assertDatabaseWritable(database);
  const user = permissionUser(req);
  const existing = existingObjectMap(node, database, collection, objects.map((object) => object._id));
  for (const object of objects || []) {
    const before = existing.get(String(object._id));
    const after = partial && before ? { ...before, ...object, _id: object._id } : object;
    const allowed = before ? canUpdate(user, before, after, collection) : canCreate(user, after, collection);
    if (!allowed) throw permissionError(before ? "update" : "create", object?._id);
  }
}

function assertUpdateAllowed(req, node, database, collection, objects = []) {
  assertDatabaseWritable(database);
  const user = permissionUser(req);
  const existing = existingObjectMap(node, database, collection, objects.map((object) => object._id));
  for (const object of objects || []) {
    const before = existing.get(String(object._id));
    if (!before || !canUpdate(user, before, object, collection)) throw permissionError("update", object?._id);
  }
}

function assertDeleteAllowed(req, objects = [], database = null) {
  assertDatabaseWritable(database);
  const user = permissionUser(req);
  for (const object of objects || []) {
    if (!canDelete(user, object, req.params?.collection)) throw permissionError("delete", object?._id);
  }
}

function assertDatabaseWritable(database) {
  if (isReadOnlyDatabase(database)) throw permissionError("write", database);
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

async function forwardShardBulkWrite(routing, req, shard, path, {
  method,
  items,
  body = items,
  query,
  minimalReturn = false,
}) {
  if (minimalReturn && typeof routing.forwardToShardNdjson === "function") {
    return routing.forwardToShardNdjson(req, shard, path, { method, items, query });
  }
  return routing.forwardToShard(req, shard, path, { method, body, query });
}

async function forwardSchemaChange(routing, req, path, options, message) {
  const { allowUnavailable = true, ...forwardOptions } = options;
  const remote = await routing.forwardToAllPeers(req, path, {
    ...forwardOptions,
    allowUnavailable,
  });
  if (!ok(remote.status)) throw remoteError(remote, message);
  return remote;
}

async function consumeNdjsonChunks({ req, imports, prepare, write }) {
  let entries = [];
  let bytes = 0;
  let batchIndex = 0;
  const maxObjects = Math.max(1, Number(imports.maxBulkObjects) || DEFAULT_IMPORT_CONFIG.maxBulkObjects);
  const maxBytes = Math.max(1, Number(imports.maxBulkBytes) || DEFAULT_IMPORT_CONFIG.maxBulkBytes);

  for await (const entry of readNdjson(req, { maxObjectBytes: imports.maxObjectBytes })) {
    if (entry.bytes > maxBytes) {
      throw httpError(413, "bulk write is too large", {
        error: "bulk write is too large",
        line: entry.line,
        bytes: entry.bytes,
        maxBulkBytes: maxBytes,
      });
    }
    if (entries.length && bytes + entry.bytes > maxBytes) {
      await flushNdjsonChunk(entries, prepare, write, batchIndex++);
      entries = [];
      bytes = 0;
    }
    entries.push(entry);
    bytes += entry.bytes;
    if (entries.length >= maxObjects || bytes >= maxBytes) {
      await flushNdjsonChunk(entries, prepare, write, batchIndex++);
      entries = [];
      bytes = 0;
    }
  }

  if (entries.length) await flushNdjsonChunk(entries, prepare, write, batchIndex);
}

async function flushNdjsonChunk(entries, prepare, write, batchIndex) {
  const lines = entries.map((entry) => entry.line);
  try {
    const values = entries.map((entry) => entry.value);
    await write(prepare(values), batchIndex);
  } catch (err) {
    throw annotateStreamLine(err, lines);
  }
}

function annotateStreamLine(err, lines) {
  if (err.line === undefined && err.index !== undefined && lines[err.index] !== undefined) {
    err.line = lines[err.index];
  }
  if (err.line !== undefined) {
    err.body = { ...(err.body || errorBody(err)), line: err.line };
  }
  return err;
}

function prepareCreateObjects(files, database, collection, rawItems, { mutateIds = false } = {}) {
  const error = validatePlainObjects(rawItems);
  if (error) throw validationError(error);
  return normalizeFileObjects(files, database, collection, withObjectIds(rawItems, { mutate: mutateIds }));
}

function validationError(error) {
  const err = httpError(400, error.error, error);
  err.index = error.index;
  return err;
}

function parseNdjsonIds(items) {
  return items.map((item, index) => {
    if (typeof item === "string" && item.length > 0) return item;
    if (item && typeof item === "object" && !Array.isArray(item) && item._id !== undefined && item._id !== null) {
      const id = String(item._id);
      if (id.length > 0) return id;
    }
    const err = new TypeError(`id at index ${index} must be a non-empty string or object with _id`);
    err.index = index;
    throw err;
  });
}

function rejectNdjsonWithoutMinimal(req, res) {
  if (prefersMinimalReturn(req)) return false;
  json(res, 400, { error: NDJSON_MINIMAL_REQUIRED });
  return true;
}

function streamErrorBody(err, progress = {}) {
  return {
    ...(err.body || errorBody(err)),
    ...progress,
  };
}

function withObjectIds(items, { mutate = false } = {}) {
  return items.map((item) => {
    const id = item._id !== undefined && item._id !== null ? String(item._id) : createObjectId();
    if (mutate) {
      item._id = id;
      return item;
    }
    return { ...item, _id: id };
  });
}

function normalizeFileObjects(files, database, collection, objects = []) {
  return files ? objects.map((object) => normalizeFileObject(files, database, collection, object)) : objects;
}

function normalizeFileObject(files, database, collection, object) {
  return files ? files.normalizeObject(database, collection, object) : object;
}

function removedFiles(beforeMap, afterObjects = []) {
  if (!beforeMap) return [];
  const removed = [];
  for (const after of afterObjects || []) {
    const before = beforeMap.get(String(after?._id));
    if (before?._file && before._file.key !== after?._file?.key) removed.push(before);
  }
  return removed;
}

async function deleteRemovedFiles(files, database, collection, beforeObjects = [], afterObjects = []) {
  if (!files) return;
  const beforeMap = new Map((beforeObjects || []).filter(Boolean).map((object) => [String(object._id), object]));
  await deleteObjectFiles(files, database, collection, removedFiles(beforeMap, afterObjects));
}

async function deleteCollectionFilesBestEffort(files, database, collection) {
  if (!files) return;
  try {
    await files.deleteCollectionFiles(database, collection);
  } catch {
    // File cleanup is best-effort; the collection delete is already durable.
  }
}

async function deleteDatabaseFilesBestEffort(files, database) {
  if (!files) return;
  try {
    await files.deleteDatabaseFiles(database);
  } catch {
    // File cleanup is best-effort; the database delete is already durable.
  }
}

async function deleteObjectFiles(files, database, collection, objects = []) {
  if (!files) return;
  for (const object of objects || []) {
    try {
      await files.deleteObjectFile(database, collection, object);
    } catch {
      // File cleanup is best-effort; the database delete/replace is already durable.
    }
  }
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

function responseSkippedCount(body) {
  if (Number.isFinite(body?.skipped)) return body.skipped;
  if (Number.isFinite(body?.skippedCount)) return body.skippedCount;
  if (Array.isArray(body?.skipped)) return body.skipped.length;
  return 0;
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

function httpError(status, message, body, headers) {
  const err = new Error(message);
  err.status = status;
  if (body) err.body = body;
  if (headers) err.headers = headers;
  return err;
}

function normalizeImportLimits(config = {}) {
  return {
    maxBulkObjects: positiveInt(config.maxBulkObjects, DEFAULT_IMPORT_CONFIG.maxBulkObjects),
    maxBulkBytes: positiveInt(config.maxBulkBytes, DEFAULT_IMPORT_CONFIG.maxBulkBytes),
    maxObjectBytes: positiveInt(config.maxObjectBytes, DEFAULT_IMPORT_CONFIG.maxObjectBytes),
    maxPendingPersistenceBytes: positiveInt(config.maxPendingPersistenceBytes, DEFAULT_IMPORT_CONFIG.maxPendingPersistenceBytes),
    retryAfterMs: positiveInt(config.retryAfterMs, DEFAULT_IMPORT_CONFIG.retryAfterMs),
  };
}

function assertImportWriteAccepts({ req, imports, durability, objects = [], ignoreBodyBytes = false, validatedObjectBytes = false }) {
  if (objects.length > imports.maxBulkObjects) {
    throw httpError(413, "bulk write contains too many objects", {
      error: "bulk write contains too many objects",
      count: objects.length,
      maxBulkObjects: imports.maxBulkObjects,
    });
  }

  const bodyBytes = ignoreBodyBytes ? 0 : jsonRequestBytes(req);
  if (bodyBytes > imports.maxBulkBytes) {
    throw httpError(413, "bulk write is too large", {
      error: "bulk write is too large",
      bytes: bodyBytes,
      maxBulkBytes: imports.maxBulkBytes,
    });
  }

  if (!validatedObjectBytes) assertObjectByteLimit(objects, imports.maxObjectBytes);
  const pendingBytes = pendingPersistenceBytes(durability);
  if (pendingBytes > imports.maxPendingPersistenceBytes) {
    const retryAfterSeconds = Math.max(1, Math.ceil(imports.retryAfterMs / 1000));
    throw httpError(503, "persistence backlog is full", {
      error: "persistence backlog is full",
      pendingBytes,
      maxPendingPersistenceBytes: imports.maxPendingPersistenceBytes,
    }, {
      "retry-after": String(retryAfterSeconds),
      "x-spread-db-pressure": "persistence",
    });
  }
}

function assertObjectByteLimit(objects, maxObjectBytes) {
  if (!maxObjectBytes) return;
  for (let i = 0; i < objects.length; i++) {
    const bytes = jsonByteLength(objects[i], `write object ${i}`);
    if (bytes <= maxObjectBytes) continue;
    const err = httpError(413, "object is too large", {
      error: "object is too large",
      index: i,
      bytes,
      maxObjectBytes,
    });
    err.index = i;
    throw err;
  }
}

function jsonRequestBytes(req) {
  const type = String(req.headers?.["content-type"] || "");
  return type.includes("application/json") ? Number(req._bodyBytes) || 0 : 0;
}

function pendingPersistenceBytes(durability) {
  const stats = durability?.getStats?.() || {};
  return (Number(stats.pendingBytes) || 0) + (Number(stats.localWal?.pendingBytes) || 0);
}

function jsonByteLength(value, label) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch (err) {
    if (err instanceof RangeError) {
      throw httpError(413, "object is too large", { error: "object is too large", label });
    }
    throw err;
  }
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
    if (!result.ok) return json(res, result.status, { error: result.error, code: result.code, operationStarted: false });
    res.operationStarted = true;
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
  const limit = publicQueryLimit(firstNumberParam(
    req.query.get("limit"),
    req.query.get("$limit"),
    controls.$limit,
    controls.$pageSize,
  ));
  const offset = firstNumberParam(
    req.query.get("offset"),
    req.query.get("skip"),
    req.query.get("$offset"),
    req.query.get("$skip"),
    controls.$offset,
    controls.$skip,
    pageOffset(controls.$page, limit),
  );
  return {
    sortBy: req.query.get("sortBy") || parsedSort.sortBy || undefined,
    sort: req.query.get("sort") || parsedSort.sort || undefined,
    limit,
    offset,
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

function firstNumberParam(...values) {
  for (const value of values) {
    const parsed = numberParam(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function pageOffset(page, pageSize) {
  const parsedPage = numberParam(page);
  if (parsedPage === undefined || pageSize === undefined) return undefined;
  return Math.max(0, parsedPage - 1) * pageSize;
}

function publicQueryLimit(value) {
  const limit = value === undefined ? DEFAULT_PUBLIC_QUERY_LIMIT : value;
  return Math.min(limit, MAX_PUBLIC_QUERY_LIMIT);
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
