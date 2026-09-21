import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { json, readJson } from "../http-router.js";
import { localClusterStatus } from "../cluster-status.js";
import { acceptsNdjson, isNdjsonContentType, NDJSON_CONTENT_TYPE, parseNdjsonBatches } from "../ndjson.js";

export const CLUSTER_SECRET_HEADER = "x-spread-db-cluster-secret";
export const DEFAULT_REPLICATION_TIMEOUT_MS = 60_000;

export function createClusterInterface() {
  return {
    name: "cluster",
    register(router, { node, shardMapStore, memoryGuard, restoreStatus, clusterSecret, replicationScheduler }) {
      const secure = secureClusterRoute(clusterSecret);

      router.get("/health", (req, res) => {
        json(res, 200, { ok: true, node: node.id, restore: restoreStatus?.snapshot?.() || null });
      });

      router.get("/cluster/shards", secure((req, res) => {
        json(res, 200, { node: node.id, shardMap: node.shardMapSnapshot() });
      }));

      router.get("/cluster/status", secure((req, res) => {
        json(res, 200, localClusterStatus(node, memoryGuard, replicationScheduler, restoreStatus, {
          details: req.query.get("details") === "1",
        }));
      }));

      router.put("/cluster/shards", secure(async (req, res) => {
        const body = await readJson(req);
        node.replaceShardMap(shardMapFromHttp(body.shardMap || body, node.id, { secret: clusterSecret }));
        await shardMapStore?.save(node.shardMapSnapshot());
        json(res, 200, { ok: true, node: node.id, shardMap: node.shardMapSnapshot() });
      }));

      router.post("/cluster/peers", secure(async (req, res) => {
        const body = await readJson(req);
        if (!body.url) {
          json(res, 400, { error: "url is required" });
          return;
        }
        node.addPeerToShard({
          shard: String(body.shard || "default"),
          peer: httpPeer(String(body.url), node.id, { secret: clusterSecret }),
        });
        await shardMapStore?.save(node.shardMapSnapshot());
        json(res, 201, { ok: true, node: node.id, shardMap: node.shardMapSnapshot() });
      }));

      router.get("/replicate", secure(async (req, res) => {
        const after = Number(req.query.get("after") || 0);
        const limit = Number(req.query.get("limit") || 0);
        const scope = scopeFromParams(req.query);
        if (node.needsSnapshot(after, scope)) {
          json(res, 410, {
            error: "log truncated, durable catch-up required",
            node: node.id,
            lastSeq: node.seq,
            trimmed: node.trimmed,
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

      router.post("/replicate", secure(async (req, res) => {
        if (isNdjsonContentType(req.headers["content-type"])) {
          const from = String(req.headers["x-spread-db-node"] || req.query.get("node") || "");
          let applied = 0;
          let batches = 0;
          for await (const ops of parseNdjsonBatches(req, {
            maxBatchObjects: replicationBatchObjects(node.syncBatchSize),
            label: "replication stream",
          })) {
            applied += node.applyRemote(from, ops);
            batches++;
          }
          json(res, 200, { ok: true, lastSeq: node.seq, applied, batches });
          return;
        }
        const body = await readJson(req);
        node.applyRemote(String(body.node || ""), Array.isArray(body.ops) ? body.ops : []);
        json(res, 200, { ok: true, lastSeq: node.seq });
      }));
    },
  };
}

export function httpPeer(url, nodeId, { secret = null, timeoutMs = DEFAULT_REPLICATION_TIMEOUT_MS } = {}) {
  const base = url.replace(/\/+$/, "");
  const timeout = positiveInt(timeoutMs, DEFAULT_REPLICATION_TIMEOUT_MS);
  return {
    key: base,
    url: base,
    secret: normalizeSecret(secret),
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
          node: r.headers.get("x-spread-db-node") || undefined,
          lastSeq: numberHeader(r.headers, "x-spread-db-last-seq"),
          opBatches: parseNdjsonBatches(r.body, {
            maxBatchObjects: replicationBatchObjects(limit),
            label: "replication stream",
          }),
        };
      }
      const body = await r.json().catch(() => null);
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
    "x-spread-db-node": node.id,
    "x-spread-db-last-seq": String(node.seq),
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
  const normalized = normalizeSecret(secret);
  return (handler) => async (req, res) => {
    if (normalized && !secretMatches(clusterSecretFromRequest(req), normalized)) {
      return json(res, 401, { error: "invalid cluster secret" });
    }
    return handler(req, res);
  };
}

function clusterSecretFromRequest(req) {
  const header = req.headers[CLUSTER_SECRET_HEADER];
  if (typeof header === "string" && header.length > 0) return header;
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return null;
}

function secretMatches(actual, expected) {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

function clusterHeaders(secret, hasBody = false) {
  return {
    ...(hasBody ? { "content-type": "application/json" } : {}),
    ...(normalizeSecret(secret) ? { [CLUSTER_SECRET_HEADER]: normalizeSecret(secret) } : {}),
  };
}

function normalizeSecret(secret) {
  return typeof secret === "string" && secret.length > 0 ? secret : null;
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
