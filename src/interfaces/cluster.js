import { json, readJson } from "../http-router.js";

export function createClusterInterface() {
  return {
    name: "cluster",
    register(router, { node, shardMapStore }) {
      router.get("/health", (req, res) => {
        json(res, 200, { ok: true, node: node.id });
      });

      router.get("/cluster/shards", (req, res) => {
        json(res, 200, { node: node.id, shardMap: node.shardMapSnapshot() });
      });

      router.put("/cluster/shards", async (req, res) => {
        const body = await readJson(req);
        node.replaceShardMap(shardMapFromHttp(body.shardMap || body, node.id));
        await shardMapStore?.save(node.shardMapSnapshot());
        json(res, 200, { ok: true, node: node.id, shardMap: node.shardMapSnapshot() });
      });

      router.post("/cluster/peers", async (req, res) => {
        const body = await readJson(req);
        if (!body.url) {
          json(res, 400, { error: "url is required" });
          return;
        }
        node.addPeerToShard({
          shard: String(body.shard || "default"),
          peer: httpPeer(String(body.url), node.id),
        });
        await shardMapStore?.save(node.shardMapSnapshot());
        json(res, 201, { ok: true, node: node.id, shardMap: node.shardMapSnapshot() });
      });

      router.get("/replicate", (req, res) => {
        const after = Number(req.query.get("after") || 0);
        const limit = Number(req.query.get("limit") || 0);
        const scope = scopeFromParams(req.query);
        if (after < node.trimmed) {
          json(res, 410, {
            error: "log truncated, snapshot required",
            node: node.id,
            lastSeq: node.seq,
            trimmed: node.trimmed,
          });
          return;
        }
        json(res, 200, {
          node: node.id,
          lastSeq: node.seq,
          ops: node._opsAfter(after, limit, scope),
        });
      });

      router.post("/replicate/ack", async (req, res) => {
        const body = await readJson(req);
        const trimmed = node.receiveAck(String(body.node || ""), Number(body.after || 0), scopeFromBody(body));
        json(res, 200, { ok: true, trimmed });
      });

      router.get("/replicate/snapshot", (req, res) => {
        json(res, 200, node.snapshot(scopeFromParams(req.query)));
      });

      router.post("/replicate", async (req, res) => {
        const body = await readJson(req);
        node.applyRemote(String(body.node || ""), Array.isArray(body.ops) ? body.ops : []);
        json(res, 200, { ok: true, lastSeq: node.seq });
      });
    },
  };
}

export function httpPeer(url, nodeId) {
  const base = url.replace(/\/+$/, "");
  return {
    key: base,
    url: base,
    nodeId: null,
    pull: async (after, limit, scope) => {
      const params = new URLSearchParams({ after: String(after), node: nodeId });
      if (limit) params.set("limit", String(limit));
      addScopeParams(params, scope);
      const r = await fetch(`${base}/replicate?${params}`);
      const body = await r.json().catch(() => null);
      return { status: r.status, ...(body || {}) };
    },
    snapshot: async (scope) => {
      const params = new URLSearchParams();
      addScopeParams(params, scope);
      const suffix = params.size ? `?${params}` : "";
      const r = await fetch(`${base}/replicate/snapshot${suffix}`);
      return r.ok ? await r.json() : null;
    },
    ack: async (id, after, scope) => {
      await fetch(`${base}/replicate/ack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ node: id, after, ...scopeBody(scope) }),
      });
    },
  };
}

export function shardMapFromHttp(map, nodeId) {
  return {
    shards: Object.fromEntries(
      Object.entries(map.shards || {}).map(([shard, shardConfig]) => [
        shard,
        {
          peers: (shardConfig.peers || []).map((peer) => (peer.url ? httpPeer(peer.url, nodeId) : peer)),
        },
      ]),
    ),
  };
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
