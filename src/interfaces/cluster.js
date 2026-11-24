import { once } from "node:events";
import {
  CLUSTER_SECRET_HEADER,
  clusterSecretFromRequest,
  clusterSecretMatches,
  normalizeClusterSecret,
} from "../cluster-secret.js";
import { json, readJson, remoteHttpError, requestAbortSignal } from "../http-router.js";
import { localClusterStatus } from "../cluster-status.js";
import { acceptsNdjson, isNdjsonContentType, NDJSON_CONTENT_TYPE, parseNdjsonBatches } from "../ndjson.js";
import { publishShardMap, TOPOLOGY_RESHARDING } from "../shard-map.js";
import { CLUSTER_ADMINISTRATION, isPrimary, primaryFor } from "../primary-state.js";
import { ADMIN_APPLY_HEADER, ok } from "../shard-router.js";

export { CLUSTER_SECRET_HEADER } from "../cluster-secret.js";
export const DEFAULT_REPLICATION_TIMEOUT_MS = 60_000;

export function createClusterInterface() {
  return {
    name: "cluster",
    register(router, { node, lifecycle, routing, shardMapStore, persistence, memoryGuard, restoreStatus, clusterSecret, replicationScheduler, migration }) {
      const secure = secureClusterRoute(clusterSecret);
      const administration = (handler) => secure(async (req, res) => {
        if (routing.isForwarded(req) && req.headers[ADMIN_APPLY_HEADER] === "1") return handler(req, res);
        if (!isPrimary(node)) {
          const owner = primaryFor(node);
          if (!owner?.url || routing.isForwarded(req)) return json(res, 503, { error: "topology primary is unavailable or changed" });
          try {
            const remote = await routing.forwardJson(req, owner, null, req.path, { method: req.method, body: await readJson(req), forwardedOnly: true });
            return json(res, remote.status, remote.body);
          } catch (error) { return json(res, error.status || 503, { error: error.message }); }
        }
        return lifecycle.administer(CLUSTER_ADMINISTRATION, () => handler(req, res));
      });
      const publishOnline = async (req, change) => {
        const update = async (stored) => {
          const current = stored || node.shardMapSnapshot();
          const next = publishShardMap(current, await change(structuredClone(current)));
          const startsReshard = next.topology.state === TOPOLOGY_RESHARDING && current.topology?.id !== next.topology.id;
          if (startsReshard) {
            throw Object.assign(new Error(!shardMapStore?.durable || !persistence?.durable
              ? "resharding requires S3 persistence and an S3 shard map store"
              : "partition changes must be published while the cluster is stopped"), { status: 409 });
          }
          if ((next.ownershipEpoch || 0) !== (current.ownershipEpoch || 0) || next.topology.state === TOPOLOGY_RESHARDING) {
            throw Object.assign(new Error("partition or primary changes must be published while the cluster is stopped"), { status: 409 });
          }
          return next;
        };
        const published = shardMapStore ? (await shardMapStore.update(update)).shardMap : await update();
        node.replaceShardMap(shardMapFromHttp(published, node.id, { secret: clusterSecret }));
        const result = await routing.forwardToAllPeers(req, "/cluster/shards", {
          method: "PUT", body: { shardMap: published }, adminApply: true, allowUnavailable: true,
        });
        if (!ok(result.status)) throw remoteHttpError(result, "topology propagation failed; retry the update");
      };

      router.post("/cluster/context", secure(async (req, res) => {
        json(res, 200, await lifecycle.command(await readJson(req)));
      }));

      router.get("/health", (req, res) => {
        json(res, 200, { ok: true, node: node.id, restore: restoreStatus?.snapshot?.() || null });
      });

      router.get("/cluster/shards", secure((req, res) => {
        json(res, 200, { node: node.id, shardMap: node.shardMapSnapshot(), migration: migration?.status() || null });
      }));

      router.post("/cluster/migration", secure(async (req, res) => {
        if (!migration) throw Object.assign(new Error("migration service is unavailable"), { status: 503 });
        if (isNdjsonContentType(req.headers["content-type"])) {
          return json(res, 200, await migration.receive(req.query.get("id"), req.query.get("mode"), req, requestAbortSignal(req, res), req.headers["x-objydb-migration-instance"]));
        }
        const body = await readJson(req);
        const result = body.phase === "finished" ? await migration.finish(body.map) : await migration.command(body);
        json(res, 200, result || { ok: true });
      }));

      router.get("/cluster/status", secure((req, res) => {
        json(res, 200, localClusterStatus(node, memoryGuard, replicationScheduler, restoreStatus, {
          details: req.query.get("details") === "1",
        }));
      }));

      router.put("/cluster/shards", administration(async (req, res) => {
        try {
          await lifecycle.assertTopologyMutable();
          const body = await readJson(req);
          const desired = body.shardMap || body;
          if (routing.isForwarded(req) && req.headers[ADMIN_APPLY_HEADER] === "1") {
            if (node.shardMap.migration?.phase === "committed" && !desired.migration && desired.topology?.id === node.shardMap.topology.id) {
              await migration.finish(desired);
              return json(res, 200, { ok: true });
            }
            const checked = publishShardMap(node.shardMapSnapshot(), desired);
            if ((checked.ownershipEpoch || 0) !== (node.shardMapSnapshot().ownershipEpoch || 0) || checked.topology.state === TOPOLOGY_RESHARDING) {
              return json(res, 409, { error: "partition or primary changes require a stopped cluster" });
            }
            node.replaceShardMap(shardMapFromHttp(desired, node.id, { secret: clusterSecret }));
            return json(res, 200, { ok: true });
          }
          const current = node.shardMapSnapshot();
          if (current.migration) return json(res, 202, { ok: true, migration: await migration.start(desired) });
          const proposed = publishShardMap(current, desired);
          if (proposed.topology.state === TOPOLOGY_RESHARDING || (proposed.ownershipEpoch || 0) !== (current.ownershipEpoch || 0)) {
            return json(res, 202, { ok: true, migration: await migration.start(desired) });
          }
          await publishOnline(req, () => desired);
          json(res, 200, { ok: true, node: node.id, shardMap: node.shardMapSnapshot() });
        } catch (err) {
          json(res, err.status || 409, { error: err.message });
        }
      }));

      router.post("/cluster/peers", administration(async (req, res) => {
        migration?.assertSchema();
        await lifecycle.assertTopologyMutable();
        const body = await readJson(req);
        if (!body.url) {
          json(res, 400, { error: "url is required" });
          return;
        }
        const shard = String(body.shard || "default");
        await publishOnline(req, (desired) => {
          desired.shards[shard] ||= { peers: [] };
          if (!desired.shards[shard].peers.some((peer) => peer.url === body.url)) desired.shards[shard].peers.push({ url: String(body.url) });
          return desired;
        });
        json(res, 201, { ok: true, node: node.id, shardMap: node.shardMapSnapshot() });
      }));

      router.get("/replicate", secure(async (req, res) => {
        const after = Number(req.query.get("after") || 0);
        const limit = Number(req.query.get("limit") || 0);
        const scope = scopeFromParams(req.query);
        if (node.needsSnapshot(after, scope)) {
          const durableThrough = persistence?.durable ? await persistence.flushThrough() : null;
          json(res, 410, {
            error: "log truncated, durable catch-up required",
            node: node.id,
            lastSeq: node.seq,
            trimmed: node.trimmed,
            ...(durableThrough !== null ? { durableThrough } : {}),
            contextRevision: lifecycle.revision,
          });
          return;
        }
        if (acceptsNdjson(req.headers)) {
          await writeReplicationNdjson(res, node, after, limit, scope);
          return;
        }
        json(res, 200, {
          node: node.id,
          lastSeq: node.seq,
          contextRevision: lifecycle.revision,
          ops: node._opsAfter(after, limit, scope),
        });
      }));

      router.post("/replicate/ack", secure(async (req, res) => {
        const body = await readJson(req);
        const trimmed = node.receiveAck(String(body.node || ""), Number(body.after || 0), scopeFromBody(body));
        json(res, 200, { ok: true, trimmed });
      }));

      router.post("/replicate/hint", secure(async (req, res) => {
        try {
          const body = await readJson(req);
          const result = replicationScheduler?.receiveHint(body) || { accepted: 0, matchedPeer: false };
          if (!result.matchedPeer) {
            json(res, 403, { error: "hint sender is not a shard peer" });
            return;
          }
          json(res, 202, { ok: true, ...result });
        } catch (err) {
          json(res, err.status || 400, { error: err.message });
        }
      }));

      router.post("/replicate", secure((req, res) => lifecycle.track(null, async () => {
        const signal = requestAbortSignal(req, res);
        if (isNdjsonContentType(req.headers["content-type"])) {
          const from = String(req.headers["x-objydb-node"] || req.query.get("node") || "");
          let applied = 0;
          let batches = 0;
          for await (const ops of parseNdjsonBatches(req, {
            maxBatchObjects: replicationBatchObjects(node.syncBatchSize),
            label: "replication stream",
          })) {
            applied += await node.applyRemoteBatch(from, ops, from, { signal });
            batches++;
          }
          json(res, 200, { ok: true, lastSeq: node.seq, applied, batches });
          return;
        }
        const body = await readJson(req);
        const from = String(body.node || "");
        await node.applyRemoteBatch(from, Array.isArray(body.ops) ? body.ops : [], from, { signal, bytes: req._bodyBytes || 0 });
        json(res, 200, { ok: true, lastSeq: node.seq });
      })));
    },
  };
}

export function httpPeer(url, nodeId, { secret = null, timeoutMs = DEFAULT_REPLICATION_TIMEOUT_MS } = {}) {
  const base = url.replace(/\/+$/, "");
  const timeout = positiveInt(timeoutMs, DEFAULT_REPLICATION_TIMEOUT_MS);
  return {
    key: base,
    url: base,
    secret: normalizeClusterSecret(secret),
    nodeId: null,
    pull: async (after, limit, scope) => {
      const params = new URLSearchParams({ after: String(after), node: nodeId });
      if (limit) params.set("limit", String(limit));
      addScopeParams(params, scope);
      const r = await fetchWithTimeout(`${base}/replicate?${params}`, {
        headers: {
          ...clusterHeaders(secret),
          accept: NDJSON_CONTENT_TYPE,
        },
      }, timeout);
      if (r.status === 200 && isNdjsonResponse(r)) {
        return {
          status: r.status,
          node: r.headers.get("x-objydb-node") || undefined,
          lastSeq: numberHeader(r.headers, "x-objydb-last-seq"),
          contextRevision: r.headers.get("x-objydb-context-revision"),
          opBatches: parseNdjsonBatches(r.body, {
            maxBatchObjects: replicationBatchObjects(limit),
            label: "replication stream",
          }),
        };
      }
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = null; }
      if (Array.isArray(body?.ops)) Object.defineProperty(body.ops, "byteLength", { value: Buffer.byteLength(text) });
      return { status: r.status, ...(body || {}) };
    },
    ack: async (id, after, scope) => {
      await fetchWithTimeout(`${base}/replicate/ack`, {
        method: "POST",
        headers: clusterHeaders(secret, true),
        body: JSON.stringify({ node: id, after, ...scopeBody(scope) }),
      }, timeout);
    },
    hint: async (body) => {
      const r = await fetchWithTimeout(`${base}/replicate/hint`, {
        method: "POST",
        headers: clusterHeaders(secret, true),
        body: JSON.stringify(body),
      }, timeout);
      const responseBody = await r.json().catch(() => null);
      return { status: r.status, ...(responseBody || {}) };
    },
  };
}

async function writeReplicationNdjson(res, node, after, limit, scope) {
  res.writeHead(200, {
    "content-type": NDJSON_CONTENT_TYPE,
    "x-objydb-node": node.id,
    "x-objydb-last-seq": String(node.seq),
    "x-objydb-context-revision": node.lifecycle?.revision || "",
  });
  for (const op of node._opsAfterIterable(after, limit, scope)) {
    if (!res.write(`${JSON.stringify(op)}\n`)) await once(res, "drain");
  }
  res.end();
}

function isNdjsonResponse(response) {
  return String(response.headers.get("content-type") || "").toLowerCase().includes("application/x-ndjson") ||
    String(response.headers.get("content-type") || "").toLowerCase().includes("application/ndjson");
}

function numberHeader(headers, name) {
  const n = Number(headers.get(name));
  return Number.isFinite(n) ? n : 0;
}

function replicationBatchObjects(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return 1000;
  return Math.max(1, Math.min(Math.floor(n), 5000));
}

export function shardMapFromHttp(map, nodeId, { secret = null, timeoutMs = DEFAULT_REPLICATION_TIMEOUT_MS } = {}) {
  return {
    ...(map.version ? { version: map.version } : {}),
    ...(map.topology ? { topology: map.topology } : {}),
    ...(map.ownershipEpoch ? { ownershipEpoch: map.ownershipEpoch } : {}),
    ...(map.migration ? { migration: map.migration } : {}),
    ...(map.originSequences ? { originSequences: map.originSequences } : {}),
    shards: Object.fromEntries(
      Object.entries(map.shards || {}).map(([shard, shardConfig]) => [
        shard,
        {
          peers: (shardConfig.peers || []).map((peer) => (
            peer.url ? httpPeer(peer.url, nodeId, { secret, timeoutMs }) : peer
          )),
        },
      ]),
    ),
  };
}

function secureClusterRoute(secret) {
  const normalized = normalizeClusterSecret(secret);
  return (handler) => async (req, res) => {
    if (normalized && !clusterSecretMatches(clusterSecretFromRequest(req, { allowBearer: true }), normalized)) {
      return json(res, 401, { error: "invalid cluster secret" });
    }
    return handler(req, res);
  };
}

function clusterHeaders(secret, hasBody = false) {
  return {
    ...(hasBody ? { "content-type": "application/json" } : {}),
    ...(normalizeClusterSecret(secret) ? { [CLUSTER_SECRET_HEADER]: normalizeClusterSecret(secret) } : {}),
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_REPLICATION_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`replication timeout after ${timeoutMs}ms`);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function scopeFromParams(params) {
  const database = params.get("database");
  const collection = params.get("collection");
  const shard = params.get("shard");
  return database && collection && shard ? { database, collection, shard } : undefined;
}

function scopeFromBody(body) {
  return body.database && body.collection && body.shard
    ? { database: String(body.database), collection: String(body.collection), shard: String(body.shard) }
    : undefined;
}

function addScopeParams(params, scope) {
  if (!scope) return;
  params.set("database", scope.database);
  params.set("collection", scope.collection);
  params.set("shard", scope.shard);
}

function scopeBody(scope) {
  return scope ? { database: scope.database, collection: scope.collection, shard: scope.shard } : {};
}
