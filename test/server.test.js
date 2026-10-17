import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRestoreStatusServer, startServer, httpPeer } from "../src/server.js";
import { CRDTNode } from "../src/crdt.js";
import { FileService, createFileService } from "../src/files.js";
import { createMemoryGuard } from "../src/memory-guard.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";
import { ShardRequestRouter } from "../src/shard-router.js";
import { ShardMapStore } from "../src/shard-map-store.js";
import { createRestoreStatus } from "../src/restore-status.js";

const TEST_AUTH = {
  jwtSecret: "test-jwt-secret",
  users: [{ _id: "admin", username: "admin", password: "123", role: "admin", admin: true }],
};
const TEST_CLUSTER_SECRET = TEST_AUTH.jwtSecret;

function startTestServer(options = {}) {
  return startServer({ auth: TEST_AUTH, ...options });
}

test("restore status server exposes health and rejects data routes", async () => {
  const node = new CRDTNode({ id: "restore-node" });
  const restoreStatus = createRestoreStatus();
  restoreStatus.start({ mode: "scoped" });
  restoreStatus.update({ phase: "snapshot", scopesTotal: 3, scopesDone: 1 });
  const state = await startRestoreStatusServer({ port: 0, node, restoreStatus });
  const base = `http://localhost:${state.port}`;

  try {
    const health = await api(base).get("/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.restoring, true);
    assert.equal(health.body.restore.phase, "snapshot");

    const config = await api(base).get("/api/config");
    assert.equal(config.status, 200);
    assert.equal(config.body.restore.status, "restoring");

    const blocked = await api(base).get("/api/app/events/object");
    assert.equal(blocked.status, 503);
  } finally {
    await new Promise((resolve) => state.server.close(resolve));
  }
});

async function login(base, username = "admin", password = "123", database = "_global", collection = "users") {
  const result = await api(base, null).post(`/api/${database}/${collection}/auth`, { username, password });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

function api(base, token = null, extraHeaders = {}) {
  const authHeaders = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders };
  const result = async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) });
  return {
    post: async (path, body) => {
      const r = await fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
      });
      return result(r);
    },
    get: async (path) => {
      const r = await fetch(base + path, { headers: authHeaders });
      return result(r);
    },
    patch: async (path, body) => {
      const r = await fetch(base + path, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
      });
      return result(r);
    },
    put: async (path, body) => {
      const r = await fetch(base + path, {
        method: "PUT",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
      });
      return result(r);
    },
    del: async (path, body) => {
      const r = await fetch(base + path, {
        method: "DELETE",
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...authHeaders },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return result(r);
    },
  };
}

async function multipartObjectRequest(base, token, method, path, object, content, mimeType = "text/plain") {
  const form = new FormData();
  form.set("object", new Blob([JSON.stringify(object)], { type: "application/json" }));
  form.set("file", new Blob([content], { type: mimeType }), object.name || "blob");
  const response = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json().catch(() => null),
  };
}

async function ndjsonRequest(base, token, method, path, lines, headers = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-ndjson",
      prefer: "return=minimal",
      ...headers,
    },
    body: lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n") + "\n",
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json().catch(() => null),
  };
}

function clusterHeaders() {
  return { "x-spread-db-cluster-secret": TEST_CLUSTER_SECRET };
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] || headers[name.toLowerCase()];
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(10);
  }
  assert.ok(check(), "condition did not become true before timeout");
}

async function startRoutedTwoShardCluster(options = {}) {
  const portA = await freePort();
  const portB = await freePort();
  const urlA = `http://localhost:${portA}`;
  const urlB = `http://localhost:${portB}`;
  const shardMap = {
    shards: {
      "shard-a": { peers: [{ url: urlA }] },
      "shard-b": { peers: [{ url: urlB }] },
    },
  };
  const a = await startTestServer({
    port: portA,
    node: new CRDTNode({ id: "route-a", url: urlA }),
    shardMap,
    ...(options.a || {}),
  });
  const b = await startTestServer({
    port: portB,
    node: new CRDTNode({ id: "route-b", url: urlB }),
    shardMap,
    ...(options.b || {}),
  });
  return { a, b, urlA, urlB };
}

async function startMultiOwnedShardCluster() {
  const portA = await freePort();
  const portB = await freePort();
  const urlA = `http://localhost:${portA}`;
  const urlB = `http://localhost:${portB}`;
  const shardMap = {
    shards: {
      "shard-a": { peers: [{ url: urlA }] },
      "shard-b": { peers: [{ url: urlA }] },
      "shard-c": { peers: [{ url: urlB }] },
    },
  };
  const a = await startTestServer({
    port: portA,
    node: new CRDTNode({ id: "multi-a", url: urlA }),
    shardMap,
  });
  const b = await startTestServer({
    port: portB,
    node: new CRDTNode({ id: "multi-b", url: urlB }),
    shardMap,
  });
  return { a, b, urlA, urlB };
}

async function startReplicatedTwoShardCluster() {
  const ports = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const urls = ports.map((port) => `http://localhost:${port}`);
  const shardMap = {
    shards: {
      "shard-a": { peers: [{ url: urls[0] }, { url: urls[1] }] },
      "shard-b": { peers: [{ url: urls[2] }, { url: urls[3] }] },
    },
  };
  const servers = await Promise.all(urls.map((url, index) => startTestServer({
    port: ports[index],
    node: new CRDTNode({ id: `replica-${index}`, url }),
    shardMap,
  })));
  return { servers, urlA: urls[0] };
}

function idForShard(node, database, collection, shard, prefix) {
  for (let i = 0; i < 10_000; i++) {
    const id = `${prefix}-${i}`;
    if (node.shardForObject(database, collection, id) === shard) return id;
  }
  throw new Error(`could not find id for shard ${shard}`);
}

test("forwarded shard requests time out", async () => {
  const slow = createHttpServer(() => {});
  await new Promise((resolve) => slow.listen(0, "127.0.0.1", resolve));
  try {
    const port = slow.address().port;
    const router = new ShardRequestRouter({
      node: {
        routingPeersForShard: () => [{ url: `http://127.0.0.1:${port}` }],
      },
      forwardTimeoutMs: 25,
    });

    const response = await router.forwardToShard({ headers: {} }, "shard-a", "/never");
    assert.equal(response.status, 504);
    assert.match(response.body.error, /forward timeout after 25ms/);
  } finally {
    slow.closeAllConnections?.();
    await new Promise((resolve) => slow.close(resolve));
  }
});

test("sharded reads fan out to remote shards in parallel", async () => {
  const router = new ShardRequestRouter({
    node: {
      shardMap: { shardsForCollection: () => ["shard-a", "shard-b"] },
      ownsShard: () => false,
    },
  });
  let active = 0;
  let maxActive = 0;
  router.forwardToShard = async (_req, shard) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await wait(20);
    active -= 1;
    return { status: 200, body: [{ _id: shard }], headers: {} };
  };

  const result = await router.find({ headers: {} }, "db", "items", {}, { limit: 10 });

  assert.equal(maxActive, 2);
  assert.deepEqual(result.objects.map((object) => object._id), ["shard-a", "shard-b"]);
});

test("sharded aggregates start remote work before local shard aggregation", async () => {
  let remoteStarted = false;
  const router = new ShardRequestRouter({
    node: {
      shardMap: { shardsForCollection: () => ["local-shard", "remote-shard"] },
      ownsShard: (shard) => shard === "local-shard",
      aggregateShards: (_db, _coll, _criteria, _spec, shards) => {
        assert.deepEqual(shards, ["local-shard"]);
        assert.equal(remoteStarted, true);
        return [{ group: "local", _count: 1 }];
      },
      aggregatePathShards: () => "group-index",
    },
  });
  router.forwardToShard = async (_req, shard) => {
    remoteStarted = true;
    return {
      status: 200,
      body: [{ group: "remote", _count: 1 }],
      headers: { "x-spread-db-query-path": "aggregate-group-index" },
      shard,
    };
  };

  const result = await router.aggregate(
    { headers: {} },
    "db",
    "items",
    {},
    { groupBy: "group", fields: { _count: { $count: true } } },
  );

  assert.deepEqual(result.rows, [
    { group: "local", _count: 1 },
    { group: "remote", _count: 1 },
  ]);
});

test("all-peer fan-out runs in parallel", async () => {
  const router = new ShardRequestRouter({
    node: {
      shardMap: { allPeers: () => [{ url: "http://peer-a" }, { url: "http://peer-b" }] },
      _isSelfPeer: () => false,
    },
  });
  let active = 0;
  let maxActive = 0;
  router.forwardJson = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await wait(20);
    active -= 1;
    return { status: 200, body: { ok: true }, headers: {} };
  };

  const response = await router.forwardToAllPeers({ headers: {} }, "/api/databases", { method: "POST" });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, peers: 2 });
  assert.equal(maxActive, 2);
});

test("all-peer fan-out can tolerate unreachable peers only when requested", async () => {
  const router = new ShardRequestRouter({
    node: {
      shardMap: { allPeers: () => [{ url: "http://peer-a" }, { url: "http://peer-b" }] },
      _isSelfPeer: () => false,
    },
  });

  router.forwardJson = async (_req, peer) => {
    if (peer.url === "http://peer-a") return { status: 200, body: { ok: true }, headers: {} };
    throw new Error("fetch failed");
  };

  const strict = await router.forwardToAllPeers({ headers: {} }, "/api/databases", { method: "POST" });
  assert.equal(strict.status, 503);
  assert.match(strict.body.error, /fetch failed/);

  const tolerant = await router.forwardToAllPeers({ headers: {} }, "/api/databases", {
    method: "POST",
    allowUnavailable: true,
  });
  assert.equal(tolerant.status, 200);
  assert.deepEqual(tolerant.body, { ok: true, peers: 1, unavailablePeers: 1 });

  router.forwardJson = async (_req, peer) => {
    if (peer.url === "http://peer-a") return { status: 200, body: { ok: true }, headers: {} };
    return { status: 400, body: { error: "bad metadata" }, headers: {} };
  };

  const realError = await router.forwardToAllPeers({ headers: {} }, "/api/databases", {
    method: "POST",
    allowUnavailable: true,
  });
  assert.equal(realError.status, 400);
  assert.deepEqual(realError.body, { error: "bad metadata" });
});

test("auth issues and renews global user JWTs", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const base = `http://localhost:${s.port}`;
    const anonymous = api(base, null);
    const bootstrapped = s.node.get("_global", "users", "admin");
    assert.equal(bootstrapped.username, "admin");
    assert.match(bootstrapped.password, /^pbkdf2\$sha256\$/);

    assert.equal((await anonymous.get("/health")).status, 200);
    assert.equal((await anonymous.get("/api/databases")).status, 401);
    assert.equal((await anonymous.post("/auth", { username: "admin", password: "123" })).status, 404);

    const bad = await anonymous.post("/api/_global/users/auth", { username: "admin", password: "wrong" });
    assert.equal(bad.status, 401);

    const session = await anonymous.post("/api/_global/users/auth", { username: "admin", password: "123" });
    assert.equal(session.status, 200);
    assert.equal(typeof session.body.accessToken, "string");
    assert.equal(typeof session.body.refreshToken, "string");
    assert.equal(session.body.access_token, session.body.accessToken);
    assert.equal(session.body.refresh_token, session.body.refreshToken);
    assert.equal(session.body.token_type, "Bearer");
    assert.equal(session.body.expires_in, session.body.expiresIn);
    assert.equal(session.body.token.accessToken, session.body.accessToken);
    assert.equal(session.body.token.refreshToken, session.body.refreshToken);
    const claims = JSON.parse(Buffer.from(session.body.accessToken.split(".")[1], "base64url").toString("utf8"));
    assert.equal(claims.id, claims.sub);
    assert.equal(claims.tokenId, claims.sessionId);
    assert.equal(claims.userFamily, claims.role);
    assert.equal(session.body.user.username, "admin");
    assert.equal(session.body.user.password, undefined);

    const authed = api(base, session.body.accessToken);
    assert.deepEqual((await authed.get("/api/databases")).body.databases, ["_global"]);
    const legacyHeader = await fetch(`${base}/api/databases`, {
      headers: { authorization: `Baerer ${session.body.accessToken}` },
    });
    assert.equal(legacyHeader.status, 200);
    const queryToken = await fetch(`${base}/api/databases?token=${encodeURIComponent(session.body.accessToken)}`);
    assert.equal(queryToken.status, 200);
    s.node.createCollection("compression", "docs", {
      tiering: { mode: "compressedMemory", offload: ["payload"], minBytes: 1 },
    });
    s.node.insert("compression", "docs", { _id: "one", payload: "compress me ".repeat(100) });
    const config = await authed.get("/api/config");
    assert.equal(config.status, 200);
    assert.deepEqual(config.body.shards.map((shard) => shard.name), ["default"]);
    assert.ok(config.body.nodes[0].memory.rss > 0);
    assert.ok(config.body.nodes[0].memory.systemTotal > config.body.nodes[0].memory.rss);
    assert.ok(config.body.nodes[0].memory.systemFree >= 0);
    assert.ok(config.body.nodes[0].memory.rssSystemPercent > 0);
    assert.ok(config.body.rss.cluster.rss > 0);
    assert.ok(config.body.rss.cluster.totalMemory > config.body.rss.cluster.rss);
    assert.ok(config.body.rss.cluster.freeMemory >= 0);
    assert.ok(config.body.rss.cluster.rssPercent > 0);
    assert.equal(config.body.rss.cluster.nodeCount, 1);
    assert.equal(config.body.rss.cluster.totalMemory, config.body.rss.logical.totalMemory);
    assert.equal(config.body.rss.cluster.totalMemory, config.body.rss.physical.totalMemory);
    assert.equal(config.body.rss.nodes, undefined);
    assert.equal(config.body.compression.collectionCount, 1);
    assert.equal(config.body.compression.compressedObjects, 1);
    assert.equal(config.body.compression.nodes, undefined);
    assert.equal(config.body.compression.collections, undefined);
    assert.ok(config.body.compression.savedPercent > 0);

    const details = await authed.get("/api/config?details=1");
    assert.equal(details.body.compression.nodes[0].collections[0].database, "compression");
    assert.equal(details.body.compression.nodes[0].collections[0].collection, "docs");
    assert.deepEqual(details.body.compression.nodes[0].collections[0].policy.offload, ["payload"]);

    const renewed = await anonymous.post("/api/_global/users/renew", { refreshToken: session.body.refreshToken });
    assert.equal(renewed.status, 200);
    assert.equal(typeof renewed.body.accessToken, "string");
    assert.equal(typeof renewed.body.refreshToken, "string");
    assert.equal(renewed.body.access_token, renewed.body.accessToken);
    assert.equal(renewed.body.refresh_token, renewed.body.refreshToken);
    assert.equal(renewed.body.token_type, "Bearer");
    assert.equal(renewed.body.expires_in, renewed.body.expiresIn);
    assert.equal(renewed.body.token.accessToken, renewed.body.accessToken);
    assert.equal(renewed.body.token.refreshToken, renewed.body.refreshToken);
    assert.equal(renewed.body.user.password, undefined);
  } finally {
    s.server.close();
  }
});

test("first boot generates and prints a random global admin password", async () => {
  const messages = [];
  const s = await startServer({
    auth: { jwtSecret: "generated-admin-test" },
    environment: {},
    bootstrapLogger: (message) => messages.push(message),
  });
  try {
    assert.equal(messages.length, 1);
    const password = messages[0].match(/^password: (.+)$/m)?.[1];
    assert.equal(typeof password, "string");
    assert.equal(password.length, 24);
    const session = await api(`http://localhost:${s.port}`).post("/api/_global/users/auth", {
      username: "admin",
      password,
    });
    assert.equal(session.status, 200);
  } finally {
    await new Promise((resolve) => s.server.close(resolve));
  }
});

test("first boot accepts OBJYDB_ADMIN_PASSWORD without printing it", async () => {
  const messages = [];
  const s = await startServer({
    auth: { jwtSecret: "supplied-admin-test" },
    environment: { OBJYDB_ADMIN_PASSWORD: "supplied-test-password" },
    bootstrapLogger: (message) => messages.push(message),
  });
  try {
    assert.equal(messages.length, 1);
    assert.doesNotMatch(messages[0], /supplied-test-password/);
    const session = await api(`http://localhost:${s.port}`).post("/api/_global/users/auth", {
      username: "admin",
      password: "supplied-test-password",
    });
    assert.equal(session.status, 200);
    s.auth.ensureGlobalUsers({ adminPassword: "replacement-password" });
    assert.equal(messages.length, 1);
    assert.equal((await api(`http://localhost:${s.port}`).post("/api/_global/users/auth", {
      username: "admin",
      password: "replacement-password",
    })).status, 401);
  } finally {
    await new Promise((resolve) => s.server.close(resolve));
  }
});

test("only the primary replica bootstraps the generated global admin", async () => {
  const shardMap = {
    shards: {
      "shard-0": {
        peers: [
          { nodeId: "primary", url: "http://primary" },
          { nodeId: "replica", url: "http://replica" },
        ],
      },
    },
  };
  const primary = await startServer({
    node: new CRDTNode({ id: "primary", url: "http://primary" }),
    shardMap,
    auth: { jwtSecret: "primary-bootstrap-test" },
    environment: { OBJYDB_ADMIN_PASSWORD: "cluster-test-password" },
    bootstrapLogger: () => {},
  });
  const replica = await startServer({
    node: new CRDTNode({ id: "replica", url: "http://replica" }),
    shardMap,
    auth: { jwtSecret: "primary-bootstrap-test" },
    environment: { OBJYDB_ADMIN_PASSWORD: "cluster-test-password" },
    bootstrapLogger: () => {},
  });
  try {
    assert.ok(primary.node.get("_global", "users", "admin"));
    assert.equal(replica.node.get("_global", "users", "admin"), undefined);
  } finally {
    await Promise.all([
      new Promise((resolve) => primary.server.close(resolve)),
      new Promise((resolve) => replica.server.close(resolve)),
    ]);
  }
});

test("api config keeps normal status compact and loads diagnostics on demand", async () => {
  const { a, b, urlA } = await startRoutedTwoShardCluster();
  try {
    const anonymous = api(urlA, null);
    assert.equal((await anonymous.get("/api/config")).status, 401);

    const session = await login(urlA);
    const authed = api(urlA, session.accessToken);
    assert.equal((await authed.post("/api/databases", { name: "config_empty" })).status, 201);
    assert.equal((await authed.post("/api/config_empty/collections", { name: "plain" })).status, 201);
    const status = await authed.get("/api/config");

    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.body.ok, true);
    assert.equal(status.body.node.id, "route-a");
    assert.deepEqual(status.body.shards.map((shard) => shard.name), ["shard-a", "shard-b"]);
    assert.equal(status.body.peers, undefined);
    assert.equal(status.body.shardMap, undefined);

    const local = status.body.nodes.find((nodeStatus) => nodeStatus.node.id === "route-a");
    const remote = status.body.nodes.find((nodeStatus) => nodeStatus.node.id === "route-b");
    assert.equal(local.local, true);
    assert.equal(remote.reachable, true);
    assert.ok(local.memory.rss > 0);
    assert.ok(remote.memory.rss > 0);
    assert.ok(local.memory.systemTotal > local.memory.rss);
    assert.ok(remote.memory.systemTotal > remote.memory.rss);
    assert.equal(status.body.rss.cluster.nodeCount, 2);
    assert.equal(status.body.rss.cluster.onlineNodeCount, 2);
    assert.equal(status.body.rss.cluster.offlineNodeCount, 0);
    assert.equal(status.body.rss.nodes, undefined);
    assert.equal(
      status.body.rss.cluster.rss,
      status.body.nodes.reduce((sum, entry) => sum + entry.memory.rss, 0),
    );
    assert.equal(
      status.body.rss.cluster.totalMemory,
      status.body.nodes.reduce((sum, entry) => sum + entry.memory.systemTotal, 0),
    );
    assert.equal(status.body.rss.cluster.totalMemory, status.body.rss.logical.totalMemory);
    assert.equal(status.body.rss.physical.totalMemory, status.body.nodes.reduce((sum, entry) => sum + entry.memory.systemTotal, 0));
    assert.ok(status.body.rss.cluster.rssPercent > 0);
    assert.deepEqual(local.ownedShards, ["shard-a"]);
    assert.deepEqual(remote.ownedShards, ["shard-b"]);
    assert.equal(typeof local.replication.healthy, "boolean");
    assert.equal(Number.isInteger(local.replication.inflightPulls), true);
    assert.equal(local.indexes, undefined);
    assert.deepEqual(Object.keys(status.body.indexes).sort(), ["activeWorkers", "building", "error", "ready"]);
    assert.deepEqual(Object.keys(status.body.vectors).sort(), ["activeIndexes", "errors", "storedVectors", "warmingIndexes"]);
    assert.equal(status.body.shards.find((shard) => shard.name === "shard-b").peers[0].online, true);
    assert.equal(status.body.shards[0].peers[0].rss, undefined);

    const cached = await authed.get("/api/config");
    assert.equal(cached.body.generatedAt, status.body.generatedAt);

    const details = await authed.get("/api/config?details=1");
    const detailedLocal = details.body.nodes.find((nodeStatus) => nodeStatus.node.id === "route-a");
    assert.equal(detailedLocal.replication.scheduler.mode, "hinted-pull");
    assert.equal(detailedLocal.indexes.workers.fieldIndex.type, "same_thread_task");
    assert.equal(details.body.nodes.some((nodeStatus) => (
      (nodeStatus.indexes.collections || []).some((entry) => (
        entry.database === "config_empty" && entry.collection === "plain"
      ))
    )), false);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("api config reports logical memory without counting replicas", async () => {
  const { servers, urlA } = await startReplicatedTwoShardCluster();
  try {
    for (const [index, server] of servers.entries()) {
      server.node.createCollection("metrics", "docs", {
        tiering: { mode: "compressedMemory", offload: ["payload"], minBytes: 1 },
      });
      server.node.insert("metrics", "docs", {
        _id: `doc-${index}`,
        payload: "replicated payload ".repeat(100),
      });
    }
    const session = await login(urlA);
    const status = await api(urlA, session.accessToken).get("/api/config");

    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.body.nodes.length, 4);
    assert.equal(status.body.rss.nodes, undefined);
    assert.equal(status.body.rss.physical.nodeCount, 4);
    assert.equal(status.body.rss.logical.shardCount, 2);
    assert.equal(status.body.rss.logical.coveredShardCount, 2);
    assert.equal(status.body.rss.logical.missingShardCount, 0);
    assert.equal(status.body.rss.logical.nodeCount, 2);
    assert.equal(status.body.rss.cluster.totalMemory, status.body.rss.logical.totalMemory);
    assert.equal(
      status.body.rss.physical.totalMemory,
      status.body.nodes.reduce((sum, entry) => sum + entry.memory.systemTotal, 0),
    );
    assert.equal(status.body.rss.logical.selectedReplicas, undefined);
    assert.equal(status.body.compression.compressedObjects, 2);
    assert.equal(status.body.compression.nodes, undefined);

    const details = await api(urlA, session.accessToken).get("/api/config?details=1");
    const selectedNodeIds = new Set(details.body.rss.logical.selectedReplicas.map((replica) => replica.nodeId));
    const selectedNodes = details.body.nodes.filter((entry) => selectedNodeIds.has(entry.node.id));
    assert.deepEqual([...selectedNodeIds].sort(), ["replica-0", "replica-2"]);
    assert.equal(
      details.body.rss.logical.totalMemory,
      selectedNodes.reduce((sum, entry) => sum + entry.memory.systemTotal, 0),
    );
    assert.ok(details.body.rss.logical.totalMemory < details.body.rss.physical.totalMemory);
    assert.equal(details.body.compression.nodes.length, 4);
    assert.equal(details.body.compression.physical.compressedObjects, 4);
    assert.equal(details.body.compression.logical.compressedObjects, 2);
    assert.equal(details.body.compression.cluster.compressedObjects, 2);
    assert.ok(details.body.compression.logical.compressedBytes < details.body.compression.physical.compressedBytes);
  } finally {
    for (const server of servers) server.server.close();
  }
});

test("memory guard rejects local writes but still allows remote shard forwarding", async () => {
  const rejectingGuard = createMemoryGuard({
    enabled: true,
    limitMb: 1,
    rejectWritesPercent: 1,
    resumeWritesPercent: 0,
    checkMs: 0,
  });
  const { a, b, urlA } = await startRoutedTwoShardCluster({ a: { memoryGuard: rejectingGuard } });
  try {
    const session = await login(urlA);
    const c = api(urlA, session.accessToken);
    const db = "app";
    const coll = "guarded";
    const localId = idForShard(a.node, db, coll, "shard-a", "local");
    const remoteId = idForShard(a.node, db, coll, "shard-b", "remote");

    const remote = await c.post(`/api/${db}/${coll}/object`, { _id: remoteId, value: "remote" });
    assert.equal(remote.status, 201, JSON.stringify(remote.body));
    assert.equal(b.node.get(db, coll, remoteId).value, "remote");
    assert.equal(a.node.get(db, coll, remoteId), undefined);

    const local = await c.post(`/api/${db}/${coll}/object`, { _id: localId, value: "local" });
    assert.equal(local.status, 507, JSON.stringify(local.body));
    assert.equal(local.body.error, "peer memory limit exceeded");
    assert.equal(local.headers.get("retry-after"), "5");
    assert.equal(a.node.get(db, coll, localId), undefined);

    a.node.insert(db, coll, { _id: localId, value: "cleanup" });
    const deleted = await c.del(`/api/${db}/${coll}/object/${localId}`);
    assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
    assert.equal(a.node.get(db, coll, localId), undefined);

    const status = await c.get("/api/config");
    const localStatus = status.body.nodes.find((nodeStatus) => nodeStatus.node.id === "route-a");
    assert.equal(localStatus.memoryGuard.writeState, "rejecting");
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("auth works from any database collection and limits tokens to that database", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const base = `http://localhost:${s.port}`;
    const root = await login(base);
    const admin = api(base, root.accessToken);

    assert.equal((await admin.post("/api/app/collections", { name: "users", indexes: ["username"] })).status, 201);
    assert.equal((await admin.post("/api/other/collections", { name: "docs" })).status, 201);

    const created = await admin.post("/api/app/users/object", {
      _id: "reader",
      username: "reader",
      password: "reader-secret",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.password, undefined);
    assert.match(s.node.get("app", "users", "reader").password, /^pbkdf2\$sha256\$/);

    const session = await api(base, null).post("/api/app/users/auth", {
      username: "reader",
      password: "reader-secret",
    });
    assert.equal(session.status, 200);
    assert.equal(session.body.user.password, undefined);

    const appUser = api(base, session.body.accessToken);
    assert.deepEqual((await appUser.get("/api/databases")).body.databases, ["app"]);
    assert.equal((await appUser.get("/api/app/collections")).status, 403);
    assert.equal((await appUser.get("/api/other/collections")).status, 403);
    assert.equal((await appUser.post("/api/databases", { name: "blocked" })).status, 403);

    const renewed = await api(base, null).post("/api/app/users/renew", {
      refreshToken: session.body.refreshToken,
    });
    assert.equal(renewed.status, 200);
    assert.equal((await api(base, null).post("/api/_global/users/renew", {
      refreshToken: session.body.refreshToken,
    })).status, 403);
  } finally {
    s.server.close();
  }
});

test("context endpoints require global or database admin tokens", async () => {
  const s = await startTestServer({
    port: 0,
    auth: {
      ...TEST_AUTH,
      users: [
        ...TEST_AUTH.users,
        {
          _id: "global-reader",
          username: "global-reader",
          password: "secret",
        },
      ],
    },
  });
  try {
    const base = `http://localhost:${s.port}`;
    const root = await login(base);
    const admin = api(base, root.accessToken);
    const db = "secure_app";

    assert.equal((await admin.post("/api/databases", { name: db })).status, 201);
    assert.equal((await admin.post(`/api/${db}/collections`, { name: "users", indexes: ["username"] })).status, 201);
    assert.equal((await admin.post(`/api/${db}/collections`, { name: "docs", indexes: ["owner"] })).status, 201);

    const globalReaderSession = await login(base, "global-reader", "secret");
    const globalReader = api(base, globalReaderSession.accessToken);
    assert.deepEqual((await globalReader.get("/api/databases")).body.databases, ["_global"]);
    assert.equal((await globalReader.get("/api/config")).status, 403);
    assert.equal((await globalReader.post("/api/databases", { name: "blocked_global" })).status, 403);
    assert.equal((await globalReader.get(`/api/${db}/collections`)).status, 403);

    assert.equal((await admin.post(`/api/${db}/users/object`, {
      _id: "reader",
      username: "reader",
      password: "secret",
      permissions: [{ name: "own docs", query: { owner: "reader" }, perm: "r" }],
    })).status, 201);
    assert.equal((await admin.post(`/api/${db}/users/object`, {
      _id: "db-admin",
      username: "db-admin",
      password: "secret",
      admin: true,
    })).status, 201);
    assert.equal((await admin.post(`/api/${db}/docs/object`, { _id: "own", owner: "reader" })).status, 201);

    const readerSession = await login(base, "reader", "secret", db, "users");
    const reader = api(base, readerSession.accessToken);
    assert.deepEqual((await reader.get("/api/databases")).body.databases, [db]);
    assert.equal((await reader.get(`/api/${db}/docs/object/own`)).status, 200);
    assert.equal((await reader.get(`/api/${db}/collections`)).status, 403);
    assert.equal((await reader.post(`/api/${db}/collections`, { name: "blocked" })).status, 403);
    assert.equal((await reader.get(`/api/${db}/docs/meta`)).status, 403);
    assert.equal((await reader.put(`/api/${db}/docs/meta`, { indexes: [] })).status, 403);
    assert.equal((await reader.del(`/api/${db}/collections/docs`)).status, 403);

    const dbAdminSession = await login(base, "db-admin", "secret", db, "users");
    const dbAdmin = api(base, dbAdminSession.accessToken);
    assert.equal((await dbAdmin.post("/api/databases", { name: "blocked_db_admin" })).status, 403);
    assert.deepEqual((await dbAdmin.get(`/api/${db}/collections`)).body.collections, ["docs", "users"]);
    assert.equal((await dbAdmin.put(`/api/${db}/docs/meta`, { indexes: ["owner", "status"] })).status, 200);
    assert.equal((await dbAdmin.post(`/api/${db}/collections`, { name: "managed" })).status, 201);
    assert.equal((await dbAdmin.del(`/api/${db}/collections/managed`)).status, 204);
  } finally {
    s.server.close();
  }
});

test("auth routes database users to the owning shard", async () => {
  const { a, b, urlA } = await startRoutedTwoShardCluster();
  try {
    const root = await login(urlA);
    const admin = api(urlA, root.accessToken);
    const db = "app";
    const coll = "users";
    const remoteUserId = idForShard(a.node, db, coll, "shard-b", "reader");

    assert.equal((await admin.post(`/api/${db}/collections`, { name: coll, indexes: ["username"] })).status, 201);
    const created = await admin.post(`/api/${db}/${coll}/object`, {
      _id: remoteUserId,
      username: "reader",
      password: "reader-secret",
      role: "reader",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(a.node.get(db, coll, remoteUserId), undefined);
    assert.match(b.node.get(db, coll, remoteUserId).password, /^pbkdf2\$sha256\$/);

    const session = await api(urlA, null).post(`/api/${db}/${coll}/auth`, {
      username: "reader",
      password: "reader-secret",
    });
    assert.equal(session.status, 200, JSON.stringify(session.body));
    assert.equal(session.body.user._id, remoteUserId);
    assert.equal(session.body.user.password, undefined);

    const remoteByQueryToken = await fetch(`${urlA}/api/${db}/${coll}/object/${remoteUserId}?token=${encodeURIComponent(root.accessToken)}`);
    assert.equal(remoteByQueryToken.status, 200, await remoteByQueryToken.text());

    const renewed = await api(urlA, null).post(`/api/${db}/${coll}/renew`, {
      refreshToken: session.body.refreshToken,
    });
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    assert.equal(renewed.body.user._id, remoteUserId);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("database creation can bootstrap a routed admin user", async () => {
  const { a, b, urlA } = await startRoutedTwoShardCluster();
  try {
    const root = await login(urlA);
    const admin = api(urlA, root.accessToken);
    const db = "boot_admin";
    const coll = "users";
    const remoteAdminId = idForShard(a.node, db, coll, "shard-b", "owner");

    const created = await admin.post("/api/databases", {
      name: db,
      adminUser: {
        _id: remoteAdminId,
        username: "owner",
        password: "owner-secret",
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.name, db);
    assert.equal(created.body.created, true);
    assert.equal(created.body.adminUser.collection, coll);
    assert.equal(created.body.adminUser.user._id, remoteAdminId);
    assert.equal(created.body.adminUser.user.username, "owner");
    assert.equal(created.body.adminUser.user.admin, true);
    assert.equal(created.body.adminUser.user.password, undefined);

    assert.deepEqual(a.node.getCollectionMeta(db, coll), { indexes: ["username"], columns: [] });
    assert.deepEqual(b.node.getCollectionMeta(db, coll), { indexes: ["username"], columns: [] });
    assert.equal(a.node.get(db, coll, remoteAdminId), undefined);
    assert.equal(b.node.get(db, coll, remoteAdminId).admin, true);
    assert.match(b.node.get(db, coll, remoteAdminId).password, /^pbkdf2\$sha256\$/);

    const session = await api(urlA, null).post(`/api/${db}/${coll}/auth`, {
      username: "owner",
      password: "owner-secret",
    });
    assert.equal(session.status, 200, JSON.stringify(session.body));
    assert.equal(session.body.user.admin, true);
    assert.equal(session.body.user.password, undefined);

    const duplicate = await admin.post("/api/databases", {
      name: db,
      adminUser: {
        username: "other",
        password: "other-secret",
      },
    });
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.error, /already has an admin user/);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("user objects are password-hashed and can log in", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const base = `http://localhost:${s.port}`;
    const root = await login(base);
    const authed = api(base, root.accessToken);
    const db = "app";
    const coll = "users";
    const path = `/api/${db}/${coll}/object`;

    assert.equal((await authed.post(`/api/${db}/collections`, { name: coll, indexes: ["username"] })).status, 201);

    const created = await authed.post(path, {
      _id: "ada",
      username: "ada",
      password: "s3cret",
      role: "user",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.password, undefined);

    const stored = s.node.get(db, coll, "ada");
    assert.match(stored.password, /^pbkdf2\$sha256\$/);

    const duplicate = await authed.post(path, {
      _id: "ada-2",
      username: "ada",
      password: "other",
    });
    assert.equal(duplicate.status, 409);

    const duplicateBatch = await authed.post(path, [
      { username: "grace", password: "first" },
      { username: "grace", password: "second" },
    ]);
    assert.equal(duplicateBatch.status, 409);

    const session = await api(base, null).post(`/api/${db}/${coll}/auth`, { username: "ada", password: "s3cret" });
    assert.equal(session.status, 200);
    assert.equal(session.body.user.password, undefined);

    const fetched = await authed.get(`${path}/ada`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.password, undefined);
    const previousHash = s.node.get(db, coll, "ada").password;
    const replacedRedacted = await authed.put(`${path}/ada`, {
      ...fetched.body,
      displayName: "Ada Lovelace",
    });
    assert.equal(replacedRedacted.status, 200);
    assert.equal(replacedRedacted.body.password, undefined);
    assert.equal(s.node.get(db, coll, "ada").password, previousHash);
    assert.equal((await api(base, null).post(`/api/${db}/${coll}/auth`, { username: "ada", password: "s3cret" })).status, 200);

    const bulkResponse = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${root.accessToken}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify([
        { _id: "bulk-user", username: "bulk-user", password: "bulk-secret" },
        { _id: "bulk-note", kind: "not-auth" },
      ]),
    });
    const bulkBody = await bulkResponse.json();
    assert.equal(bulkResponse.status, 201);
    assert.deepEqual(bulkBody, { inserted: 2 });
    assert.match(s.node.get(db, coll, "bulk-user").password, /^pbkdf2\$sha256\$/);
    assert.equal((await api(base, null).post(`/api/${db}/${coll}/auth`, { username: "bulk-user", password: "bulk-secret" })).status, 200);

    const patched = await authed.patch(`${path}/ada`, { $set: { password: "new-secret" } });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.password, undefined);
    assert.match(s.node.get(db, coll, "ada").password, /^pbkdf2\$sha256\$/);

    assert.equal((await api(base, null).post(`/api/${db}/${coll}/auth`, { username: "ada", password: "s3cret" })).status, 401);
    assert.equal((await api(base, null).post(`/api/${db}/${coll}/auth`, { username: "ada", password: "new-secret" })).status, 200);
  } finally {
    s.server.close();
  }
});

test("_global object writes are blocked through the public API", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const base = `http://localhost:${s.port}`;
    const root = await login(base);
    const admin = api(base, root.accessToken);

    assert.equal((await admin.get("/api/_global/users/object/admin")).status, 200);
    assert.equal((await admin.post("/api/_global/users/object", {
      _id: "blocked-single",
      username: "blocked-single",
      password: "secret",
    })).status, 403);
    assert.equal((await admin.post("/api/_global/users/object", [
      { _id: "blocked-bulk", username: "blocked-bulk", password: "secret" },
    ])).status, 403);
    assert.equal((await admin.put("/api/_global/users/object/admin", {
      username: "admin",
      password: "changed",
    })).status, 403);
    assert.equal((await admin.put("/api/_global/users/object", [
      { _id: "admin", username: "admin", password: "changed" },
    ])).status, 403);
    assert.equal((await admin.patch("/api/_global/users/object/admin", {
      $set: { displayName: "Changed" },
    })).status, 403);
    assert.equal((await admin.patch("/api/_global/users/object", [
      { _id: "admin", $set: { displayName: "Changed" } },
    ])).status, 403);
    assert.equal((await admin.del("/api/_global/users/object/admin")).status, 403);
    assert.equal((await admin.del("/api/_global/users/object", { ids: ["admin"] })).status, 403);

    const stored = s.node.get("_global", "users", "admin");
    assert.equal(stored.displayName, undefined);
    assert.equal((await api(base, null).post("/api/_global/users/auth", {
      username: "admin",
      password: "123",
    })).status, 200);
  } finally {
    s.server.close();
  }
});

test("_global schema writes are blocked even for global admins", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const base = `http://localhost:${s.port}`;
    const session = await login(base);
    const c = api(base, session.accessToken);

    assert.equal((await c.post("/api/databases", {
      name: "_global",
      meta: { changed: true },
    })).status, 403);
    assert.equal((await c.post("/api/_global/collections", {
      name: "audit",
    })).status, 403);
    assert.equal((await c.put("/api/_global/users/meta", {
      indexes: ["username", "role"],
    })).status, 403);
    assert.equal((await c.del("/api/_global/collections/users")).status, 403);

    assert.equal(s.node.getDatabaseMeta("_global").changed, undefined);
    assert.equal(s.node.getCollectionMeta("_global", "audit"), null);
    const usersMeta = s.node.getCollectionMeta("_global", "users");
    assert.deepEqual(usersMeta.indexes, ["username"]);
    assert.equal((await c.get("/api/_global/users/object/admin")).status, 200);
  } finally {
    s.server.close();
  }
});

test("database user permissions filter reads and guard writes", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const adminSession = await login(`http://localhost:${s.port}`);
    const admin = api(`http://localhost:${s.port}`, adminSession.accessToken);
    const db = "perm_app";

    const user = await admin.post(`/api/${db}/users/object`, {
      _id: "reader",
      username: "reader",
      password: "secret",
      permissions: [
        { name: "own docs", query: { owner: "reader" }, perm: "crud" },
      ],
    });
    assert.equal(user.status, 201, JSON.stringify(user.body));
    assert.equal(user.body.password, undefined);
    assert.deepEqual(user.body.permissions, [
      { name: "own docs", query: { owner: "reader" }, perm: "crud" },
    ]);

    const docsBase = `/api/${db}/docs/object`;
    assert.equal((await admin.post(docsBase, [
      { _id: "own", owner: "reader", status: "open", score: 2 },
      { _id: "other", owner: "other", status: "open", score: 5 },
      { _id: "bulk-a", owner: "reader", status: "bulk", score: 1 },
      { _id: "bulk-b", owner: "reader", status: "bulk", score: 1 },
    ])).status, 201);

    const readerSession = await login(`http://localhost:${s.port}`, "reader", "secret", db, "users");
    const reader = api(`http://localhost:${s.port}`, readerSession.accessToken);

    const list = await reader.get(`${docsBase}?sortBy=_id`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((row) => row._id), ["bulk-a", "bulk-b", "own"]);

    const aggregateQuery = encodeURIComponent(JSON.stringify({
      $aggregate: { fields: { total: { $sum: "score" }, n: { $count: true } } },
    }));
    const aggregate = await reader.get(`${docsBase}?q=${aggregateQuery}`);
    assert.equal(aggregate.status, 200, JSON.stringify(aggregate.body));
    assert.deepEqual(aggregate.body, [{ total: 4, n: 3 }]);

    assert.equal((await reader.get(`${docsBase}/own`)).status, 200);
    assert.equal((await reader.get(`${docsBase}/other`)).status, 403);

    const created = await reader.post(docsBase, { _id: "new-own", owner: "reader", status: "new" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await reader.post(docsBase, { _id: "new-other", owner: "other" })).status, 403);

    const patched = await reader.patch(`${docsBase}/own`, { $set: { status: "closed" } });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.status, "closed");

    const deniedPatch = await reader.patch(`${docsBase}/own`, { $set: { owner: "other" } });
    assert.equal(deniedPatch.status, 403);
    assert.equal(s.node.get(db, "docs", "own").owner, "reader");

    const deniedBulk = await reader.patch(docsBase, [
      { _id: "bulk-a", $set: { status: "changed" } },
      { _id: "bulk-b", $set: { owner: "other" } },
    ]);
    assert.equal(deniedBulk.status, 403);
    assert.equal(s.node.get(db, "docs", "bulk-a").status, "bulk");
    assert.equal(s.node.get(db, "docs", "bulk-b").owner, "reader");

    assert.equal((await reader.del(`${docsBase}/own`)).status, 204);
    assert.equal((await reader.del(`${docsBase}/other`)).status, 403);
  } finally {
    s.server.close();
  }
});

test("user collection permission lists grant object read and write by name", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const baseUrl = `http://localhost:${s.port}`;
    const admin = api(baseUrl, (await login(baseUrl)).accessToken);
    const db = "collection_grants";
    const userPath = `/api/${db}/users/object`;
    const created = await admin.post(userPath, {
      _id: "editor",
      username: "editor",
      password: "secret",
      collectionPermissions: { read: ["articles", "media", "articles"], write: ["articles", "drafts"] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.collectionPermissions, { read: ["articles", "media"], write: ["articles", "drafts"] });
    assert.equal((await admin.post(userPath, {
      _id: "bad", username: "bad", password: "secret", collectionPermissions: { write: "articles" },
    })).status, 400);

    const articles = `/api/${db}/articles/object`;
    const media = `/api/${db}/media/object`;
    const drafts = `/api/${db}/drafts/object`;
    const privateObjects = `/api/${db}/private/object`;
    assert.equal((await admin.post(articles, { _id: "a", owner: "other" })).status, 201);
    assert.equal((await admin.post(media, { _id: "m", owner: "other" })).status, 201);
    assert.equal((await admin.post(privateObjects, { _id: "p" })).status, 201);

    const editorSession = await login(baseUrl, "editor", "secret", db, "users");
    const editor = api(baseUrl, editorSession.accessToken);
    assert.deepEqual((await editor.get(articles)).body.map((row) => row._id), ["a"]);
    assert.equal((await editor.get(`${media}/m`)).status, 200);
    assert.equal((await editor.get(`${privateObjects}/p`)).status, 403);
    assert.deepEqual((await editor.get(privateObjects)).body, []);
    assert.equal((await editor.post(articles, { _id: "new", owner: "other" })).status, 201);
    assert.equal((await editor.patch(`${articles}/a`, { $set: { owner: "changed" } })).status, 200);
    assert.equal((await editor.del(`${articles}/new`)).status, 204);
    assert.equal((await editor.post(drafts, { _id: "draft" })).status, 201);
    assert.equal((await editor.get(`${drafts}/draft`)).status, 403);
    assert.equal((await editor.patch(`${drafts}/draft`, { $set: { status: "done" } })).status, 200);
    assert.equal((await editor.del(`${drafts}/draft`)).status, 204);
    assert.equal((await editor.post(media, { _id: "new" })).status, 403);
    assert.equal((await editor.patch(`${media}/m`, { $set: { owner: "changed" } })).status, 403);
    assert.equal((await editor.del(`${media}/m`)).status, 403);
    assert.equal((await editor.get(`/api/${db}/collections`)).status, 403);
    assert.equal((await editor.get(`/api/other_db/articles/object`)).status, 403);

    const changed = await admin.patch(`${userPath}/editor`, {
      $set: { collectionPermissions: { read: ["articles", "media", "private"], write: ["articles", "drafts"] } },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal((await editor.get(`${privateObjects}/p`)).status, 403);
    const renewed = await api(baseUrl).post(`/api/${db}/users/renew`, { refreshToken: editorSession.refreshToken });
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    assert.equal((await api(baseUrl, renewed.body.accessToken).get(`${privateObjects}/p`)).status, 200);
  } finally {
    s.server.close();
  }
});

test("permissions are enforced by remote shard owners", async () => {
  const { a, b, urlA, urlB } = await startRoutedTwoShardCluster();
  try {
    const adminSession = await login(urlA);
    const admin = api(urlA, adminSession.accessToken);
    const db = "perm_shards";
    const userId = idForShard(a.node, db, "users", "shard-a", "reader");
    const allowedId = idForShard(a.node, db, "docs", "shard-b", "allowed");
    const deniedId = idForShard(a.node, db, "docs", "shard-b", "denied");
    const docsBase = `/api/${db}/docs/object`;

    assert.equal((await admin.post(`/api/${db}/users/object`, {
      _id: userId,
      username: "reader",
      password: "secret",
      permissions: [
        { name: "own remote docs", query: { owner: "reader" }, perm: "crud" },
      ],
    })).status, 201);
    assert.equal((await admin.post(docsBase, [
      { _id: allowedId, owner: "reader", side: "b", value: 1 },
      { _id: deniedId, owner: "other", side: "b", value: 2 },
    ])).status, 201);
    assert.equal(b.node.get(db, "docs", allowedId).owner, "reader");
    assert.equal(a.node.get(db, "docs", allowedId), undefined);

    const readerSession = await login(urlA, "reader", "secret", db, "users");
    const reader = api(urlA, readerSession.accessToken);

    const allowed = await reader.get(`${docsBase}/${allowedId}`);
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(allowed.body._id, allowedId);
    assert.equal((await reader.get(`${docsBase}/${deniedId}`)).status, 403);

    const patched = await reader.patch(`${docsBase}/${allowedId}`, { $set: { value: 3 } });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(b.node.get(db, "docs", allowedId).value, 3);

    const deniedPatch = await reader.patch(`${docsBase}/${allowedId}`, { $set: { owner: "other" } });
    assert.equal(deniedPatch.status, 403);
    assert.equal(b.node.get(db, "docs", allowedId).owner, "reader");

    const remoteStatus = await api(urlB, readerSession.accessToken).get(`${docsBase}/${allowedId}`);
    assert.equal(remoteStatus.status, 200);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("REST CRUD lifecycle", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const session = await login(`http://localhost:${s.port}`);
    const c = api(`http://localhost:${s.port}`, session.accessToken);
    const base = "/api/app/users/object";

    const ins = await c.post(base, { name: "ada", age: 36, profile: { city: "Berlin", legacy: true } });
    assert.equal(ins.status, 201);
    const id = ins.body._id;

    const duplicate = await c.post(base, { _id: id, name: "other" });
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.error, /object already exists/);

    const got = await c.get(`${base}/${id}`);
    assert.deepEqual(got.body, { _id: id, name: "ada", age: 36, profile: { city: "Berlin", legacy: true } });

    const patched = await c.patch(`${base}/${id}`, {
      $set: { age: 37, "profile.city": "Hamburg" },
      $unset: ["name", "profile.legacy"],
    });
    assert.equal(patched.body.age, 37);
    assert.equal(patched.body.name, undefined);
    assert.deepEqual(patched.body.profile, { city: "Hamburg" });

    const illegalIdPatch = await c.patch(`${base}/${id}`, { $set: { _id: "other" } });
    assert.equal(illegalIdPatch.status, 400);
    assert.match(illegalIdPatch.body.error, /_id cannot be changed/);

    const plainPatch = await c.patch(`${base}/${id}`, { age: 38 });
    assert.equal(plainPatch.status, 400);
    assert.match(plainPatch.body.error, /unsupported patch key/);

    const replaced = await c.put(`${base}/${id}`, { name: "ada", active: true });
    assert.deepEqual(replaced.body, { _id: id, name: "ada", active: true });

    const list = await c.get(base);
    assert.deepEqual(list.body.map((item) => item._id), [id]);

    const del = await c.del(`${base}/${id}`);
    assert.equal(del.status, 204);

    const missing = await c.get(`${base}/${id}`);
    assert.equal(missing.status, 404);

    const nope = await c.get(`${base}/nope`);
    assert.equal(nope.status, 404);

    const missingPatch = await c.patch(`${base}/nope`, { $set: { age: 99 } });
    assert.equal(missingPatch.status, 404);
  } finally {
    s.server.close();
  }
});

test("single object file CRUD stores blobs outside the object", async () => {
  const files = createFileService({ mode: "memory", prefix: "files" });
  const s = await startTestServer({ port: 0, files });
  try {
    const baseUrl = `http://localhost:${s.port}`;
    const session = await login(baseUrl);
    const c = api(baseUrl, session.accessToken);
    const base = "/api/app/docs/object";

    const created = await multipartObjectRequest(baseUrl, session.accessToken, "POST", base, {
      _id: "doc-1",
      name: "note.txt",
      status: "draft",
    }, "hello file", "text/plain");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body._file.storage, "memory");
    assert.match(created.body._file.key, /^files\/db\/app\/collection\/docs\/object\/doc-1\/blob\/[A-Za-z0-9_-]+$/);
    assert.equal(created.body._file.mimeType, "text/plain");
    assert.deepEqual(s.node.get("app", "docs", "doc-1"), {
      _id: "doc-1",
      name: "note.txt",
      status: "draft",
      _file: created.body._file,
    });

    const blob = await fetch(`${baseUrl}${base}/doc-1/blob`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    assert.equal(blob.status, 200);
    assert.equal(blob.headers.get("content-type"), "text/plain");
    assert.equal(await blob.text(), "hello file");

    const readerUser = await c.post("/api/app/users/object", {
      _id: "reader",
      username: "reader",
      password: "secret",
      permissions: [
        { name: "own docs", query: { owner: "reader" }, perm: "r" },
      ],
    });
    assert.equal(readerUser.status, 201, JSON.stringify(readerUser.body));
    const readerSession = await login(baseUrl, "reader", "secret", "app", "users");
    const deniedBlob = await fetch(`${baseUrl}${base}/doc-1/blob`, {
      headers: { authorization: `Bearer ${readerSession.accessToken}` },
    });
    assert.equal(deniedBlob.status, 403);

    const replaced = await multipartObjectRequest(baseUrl, session.accessToken, "PUT", `${base}/doc-1`, {
      name: "note-v2.txt",
      status: "final",
    }, "updated file", "text/plain");
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.notEqual(replaced.body._file.key, created.body._file.key);
    assert.equal(await files.storage.getBlob(created.body._file.key), null);
    assert.equal(replaced.body.name, "note-v2.txt");
    const updatedBlob = await fetch(`${baseUrl}${base}/doc-1/blob`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    assert.equal(await updatedBlob.text(), "updated file");

    const invalidFile = await c.post(base, {
      _id: "bad-file",
      _file: { storage: "memory", key: "evil", mimeType: "text/plain" },
    });
    assert.equal(invalidFile.status, 400);
    assert.match(invalidFile.body.error, /server-derived file key/);

    const deleted = await c.del(`${base}/doc-1`);
    assert.equal(deleted.status, 204);
    assert.equal(await files.storage.getBlob(replaced.body._file.key), null);
  } finally {
    s.server.close();
  }
});

test("multipart file writes respect memory guard before buffering", async () => {
  const files = createFileService({ mode: "memory", prefix: "files" });
  const memoryGuard = createMemoryGuard({
    enabled: true,
    rejectWritesPercent: 50,
    resumeWritesPercent: 40,
  }, {
    limitBytes: 100,
    getUsage: () => ({ rss: 99 }),
  });
  const s = await startTestServer({ port: 0, files, memoryGuard });
  try {
    const baseUrl = `http://localhost:${s.port}`;
    const session = await login(baseUrl);
    const created = await multipartObjectRequest(baseUrl, session.accessToken, "POST", "/api/app/docs/object", {
      _id: "blocked-file",
      name: "blocked.txt",
    }, "blocked", "text/plain");
    assert.equal(created.status, 507, JSON.stringify(created.body));
    assert.equal(s.node.get("app", "docs", "blocked-file"), undefined);
    assert.deepEqual(await files.storage.list("files/db/app/collection/docs/object/blocked-file/blob/"), []);
  } finally {
    s.server.close();
  }
});

test("multipart object file writes route to the owning shard", async () => {
  const storage = new MemoryObjectStorage();
  const { a, b, urlA, urlB } = await startRoutedTwoShardCluster({
    a: { files: new FileService({ storage, prefix: "files", storageName: "memory" }) },
    b: { files: new FileService({ storage, prefix: "files", storageName: "memory" }) },
  });
  try {
    const session = await login(urlA);
    const db = "app";
    const coll = "files";
    const id = idForShard(a.node, db, coll, "shard-b", "remote-file");
    const base = `/api/${db}/${coll}/object`;

    const created = await multipartObjectRequest(urlA, session.accessToken, "POST", base, {
      _id: id,
      name: "remote.txt",
    }, "remote bytes", "text/plain");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(a.node.get(db, coll, id), undefined);
    assert.equal(b.node.get(db, coll, id).name, "remote.txt");

    const blobFromA = await fetch(`${urlA}${base}/${id}/blob`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    assert.equal(blobFromA.status, 200);
    assert.equal(await blobFromA.text(), "remote bytes");

    const blobFromB = await fetch(`${urlB}${base}/${id}/blob`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    assert.equal(blobFromB.status, 200);
    assert.equal(await blobFromB.text(), "remote bytes");
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("public object interface supports bulk CRUD", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const session = await login(`http://localhost:${s.port}`);
    const c = api(`http://localhost:${s.port}`, session.accessToken);
    const base = "/api/app/events/object";

    const created = await c.post(base, [
      { _id: "e1", type: "signup", count: 1, flags: { old: true } },
      { _id: "e2", type: "purchase", count: 2, flags: { old: true } },
    ]);
    assert.equal(created.status, 201);
    assert.equal(created.body.inserted, 2);

    const q = encodeURIComponent(JSON.stringify({ _id: { $in: ["e1", "e2"] } }));
    const listed = await c.get(`${base}?q=${q}&sortBy=_id`);
    assert.deepEqual(listed.body.map((item) => item._id), ["e1", "e2"]);

    const patched = await c.patch(base, [
      { _id: "e1", $set: { count: 10 }, $unset: ["type", "flags.old"] },
      { _id: "e2", $set: { extra: true }, $unset: { type: true } },
      { _id: "missing", $set: { count: 99 } },
    ]);
    assert.equal(patched.status, 200);
    assert.equal(patched.body.updated, 2);
    assert.deepEqual(patched.body.skipped, ["missing"]);
    assert.equal((await c.get(`${base}/e1`)).body.count, 10);
    assert.equal((await c.get(`${base}/e1`)).body.type, undefined);
    assert.deepEqual((await c.get(`${base}/e1`)).body.flags, {});
    assert.equal((await c.get(`${base}/e2`)).body.extra, true);
    assert.equal((await c.get(`${base}/e2`)).body.type, undefined);

    const replaced = await c.put(base, [
      { _id: "e1", done: true },
      { _id: "e2", done: false },
    ]);
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.replaced, 2);
    assert.deepEqual((await c.get(`${base}/e1`)).body, { _id: "e1", done: true });

    const removed = await c.del(base, { ids: ["e1", "e2", "missing"] });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, 2);
    assert.deepEqual(removed.body.skipped, ["missing"]);
    assert.deepEqual((await c.get(base)).body, []);
  } finally {
    s.server.close();
  }
});

test("public object interface supports streamed NDJSON bulk CRUD", async () => {
  const s = await startTestServer({
    port: 0,
    imports: {
      maxBulkObjects: 2,
      maxBulkBytes: 1024 * 1024,
      maxObjectBytes: 1024 * 1024,
    },
  });
  try {
    const baseUrl = `http://localhost:${s.port}`;
    const session = await login(baseUrl);
    const base = "/api/app/streamed/object";

    const missingPreference = await fetch(`${baseUrl}${base}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        "content-type": "application/x-ndjson",
      },
      body: JSON.stringify({ _id: "blocked" }) + "\n",
    });
    assert.equal(missingPreference.status, 400);
    assert.match((await missingPreference.json()).error, /Prefer: return=minimal/);
    assert.equal(s.node.get("app", "streamed", "blocked"), undefined);

    const created = await ndjsonRequest(baseUrl, session.accessToken, "POST", base, [
      { _id: "e1", type: "signup", count: 1, flags: { old: true } },
      { _id: "e2", type: "purchase", count: 2, flags: { old: true } },
      { type: "generated", count: 3 },
    ]);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body, { inserted: 3 });
    assert.equal(s.node.count("app", "streamed"), 3);

    const replaced = await ndjsonRequest(baseUrl, session.accessToken, "PUT", base, [
      { _id: "e1", done: true },
      { _id: "e2", done: false },
    ]);
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.deepEqual(replaced.body, { replaced: 2 });
    assert.deepEqual(s.node.get("app", "streamed", "e1"), { _id: "e1", done: true });

    const patched = await ndjsonRequest(baseUrl, session.accessToken, "PATCH", base, [
      { _id: "e1", $set: { count: 10 } },
      { _id: "e2", $set: { extra: true } },
      { _id: "missing", $set: { count: 99 } },
    ]);
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.deepEqual(patched.body, { updated: 2, skipped: 1 });
    assert.equal(s.node.get("app", "streamed", "e1").count, 10);
    assert.equal(s.node.get("app", "streamed", "e2").extra, true);

    const removed = await ndjsonRequest(baseUrl, session.accessToken, "DELETE", base, [
      { _id: "e1" },
      { _id: "e2" },
      { _id: "missing" },
    ]);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(removed.body, { deleted: 2, skipped: 1 });
    assert.equal(s.node.get("app", "streamed", "e1"), undefined);
    assert.equal(s.node.get("app", "streamed", "e2"), undefined);

    const invalid = await ndjsonRequest(baseUrl, session.accessToken, "POST", base, [
      { _id: "partial", value: 1 },
      "{bad json",
    ]);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.line, 2);
    assert.equal(invalid.body.inserted, 0);
    assert.equal(s.node.get("app", "streamed", "partial"), undefined);
  } finally {
    s.server.close();
  }
});

test("public minimal bulk insert skips object readback", async () => {
  const node = new CRDTNode({ id: "minimal-bulk" });
  const s = await startTestServer({ port: 0, node });
  const baseUrl = `http://localhost:${s.port}`;
  const originalGet = node.get.bind(node);
  let getCalls = 0;

  try {
    const session = await login(baseUrl);
    node.get = (...args) => {
      getCalls++;
      return originalGet(...args);
    };

    const response = await fetch(`${baseUrl}/api/app/events/object`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify([
        { _id: "e1", type: "signup", count: 1 },
        { _id: "e2", type: "purchase", count: 2 },
      ]),
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.deepEqual(body, { inserted: 2 });
    assert.equal(getCalls, 0);
    node.get = originalGet;
    assert.deepEqual(node.get("app", "events", "e1"), { _id: "e1", type: "signup", count: 1 });
  } finally {
    node.get = originalGet;
    s.server.close();
  }
});

test("public JSON body limit returns 413 without accepting the write", async () => {
  const s = await startTestServer({ port: 0, maxJsonBytes: 128 });
  try {
    const session = await login(`http://localhost:${s.port}`);
    const response = await fetch(`http://localhost:${s.port}/api/app/items/object`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({ _id: "large", payload: "x".repeat(256) }),
    });
    const body = await response.json();

    assert.equal(response.status, 413);
    assert.equal(body.error, "payload too large");
    assert.equal(s.node.get("app", "items", "large"), undefined);
  } finally {
    s.server.close();
  }
});

test("public bulk imports reject excessive batch and persistence backlog pressure", async () => {
  const s = await startTestServer({
    port: 0,
    imports: {
      maxBulkObjects: 1,
      maxBulkBytes: 1024 * 1024,
      maxObjectBytes: 1024 * 1024,
      maxPendingPersistenceBytes: 1,
      retryAfterMs: 1000,
    },
    durability: {
      afterWrite: async () => ({ records: 0, ops: 0 }),
      getStats: () => ({ pendingBytes: 2, localWal: { pendingBytes: 0 } }),
    },
  });
  try {
    const session = await login(`http://localhost:${s.port}`);
    const c = api(`http://localhost:${s.port}`, session.accessToken);

    const tooMany = await c.post("/api/app/items/object", [{ _id: "a" }, { _id: "b" }]);
    assert.equal(tooMany.status, 413);
    assert.equal(tooMany.body.error, "bulk write contains too many objects");

    const backedUp = await c.post("/api/app/items/object", { _id: "c" });
    assert.equal(backedUp.status, 503);
    assert.equal(backedUp.headers.get("x-spread-db-pressure"), "persistence");
    assert.equal(backedUp.body.error, "persistence backlog is full");
  } finally {
    s.server.close();
  }
});

test("public bulk object routes reject duplicate _ids", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const session = await login(`http://localhost:${s.port}`);
    const c = api(`http://localhost:${s.port}`, session.accessToken);
    const base = "/api/app/events/object";

    const duplicatePost = await c.post(base, [
      { _id: "e1", value: 1 },
      { _id: "e1", value: 2 },
    ]);
    assert.equal(duplicatePost.status, 400);
    assert.match(duplicatePost.body.error, /duplicate _id in bulk request: e1/);

    assert.equal((await c.post(base, { _id: "e1", value: 1 })).status, 201);

    const existingPost = await c.post(base, { _id: "e1", value: 2 });
    assert.equal(existingPost.status, 409);
    assert.match(existingPost.body.error, /object already exists: e1/);
    assert.equal((await c.get(`${base}/e1`)).body.value, 1);

    const existingBulkPost = await c.post(base, [
      { _id: "e1", value: 2 },
      { _id: "e2", value: 3 },
    ]);
    assert.equal(existingBulkPost.status, 409);
    assert.match(existingBulkPost.body.error, /object already exists: e1/);
    assert.equal((await c.get(`${base}/e2`)).status, 404);

    const duplicatePatch = await c.patch(base, [
      { _id: "e1", $set: { value: 2 } },
      { _id: "e1", $set: { other: true } },
    ]);
    assert.equal(duplicatePatch.status, 400);
    assert.match(duplicatePatch.body.error, /duplicate _id in bulk request: e1/);

    const duplicatePut = await c.put(base, [
      { _id: "e1", value: 3 },
      { _id: "e1", value: 4 },
    ]);
    assert.equal(duplicatePut.status, 400);
    assert.match(duplicatePut.body.error, /duplicate _id in bulk request: e1/);

    const duplicateDelete = await c.del(base, { ids: ["e1", "e1"] });
    assert.equal(duplicateDelete.status, 400);
    assert.match(duplicateDelete.body.error, /duplicate _id in bulk request: e1/);
  } finally {
    s.server.close();
  }
});

test("public object writes ack after local WAL flush", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spread-db-http-wal-"));
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "http-wal" });
  const persistence = new PersistenceManager({
    node,
    storage,
    flushMs: 0,
    snapshotMs: 0,
    ack: "localWal",
    localWal: { mode: "on", dir, fsync: true },
  });
  persistence.start();
  const s = await startTestServer({ port: 0, node, persistence });

  try {
    const session = await login(`http://localhost:${s.port}`);
    const c = api(`http://localhost:${s.port}`, session.accessToken);
    const created = await c.post("/api/app/events/object", [
      { _id: "e1", value: 1 },
      { _id: "e2", value: 2 },
    ]);
    assert.equal(created.status, 201);
    assert.equal(persistence.getStats().localWal.pendingRecords, 0);

    const fresh = new CRDTNode({ id: "http-wal" });
    const restored = await new PersistenceManager({
      node: fresh,
      storage,
      flushMs: 0,
      snapshotMs: 0,
      ack: "localWal",
      localWal: { mode: "on", dir, fsync: true },
    }).restore();

    assert.ok(restored.localWalOps >= 2);
    assert.deepEqual(fresh.get("app", "events", "e1"), { _id: "e1", value: 1 });
    assert.deepEqual(fresh.get("app", "events", "e2"), { _id: "e2", value: 2 });
  } finally {
    await persistence.stop().catch(() => {});
    s.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("public CRUD routes object writes to the owning shard peer", async () => {
  const { a, b, urlA } = await startRoutedTwoShardCluster();
  try {
    const session = await login(urlA);
    const c = api(urlA, session.accessToken);
    const db = "app";
    const coll = "routed";
    const base = `/api/${db}/${coll}/object`;
    const localId = idForShard(a.node, db, coll, "shard-a", "local");
    const remoteId = idForShard(a.node, db, coll, "shard-b", "remote");

    const created = await c.post(base, [
      { _id: localId, side: "a", value: 1 },
      { _id: remoteId, side: "b", value: 2 },
    ]);
    assert.equal(created.status, 201);
    assert.equal(created.body.inserted, 2);
    assert.deepEqual(a.node.get(db, coll, localId), { _id: localId, side: "a", value: 1 });
    assert.equal(a.node.get(db, coll, remoteId), undefined);
    assert.deepEqual(b.node.get(db, coll, remoteId), { _id: remoteId, side: "b", value: 2 });

    const remoteRead = await c.get(`${base}/${remoteId}`);
    assert.equal(remoteRead.status, 200);
    assert.deepEqual(remoteRead.body, { _id: remoteId, side: "b", value: 2 });

    const patched = await c.patch(`${base}/${remoteId}`, { $set: { value: 3 } });
    assert.equal(patched.status, 200);
    assert.equal(b.node.get(db, coll, remoteId).value, 3);
    assert.equal(a.node.get(db, coll, remoteId), undefined);

    const replaced = await c.put(`${base}/${remoteId}`, { side: "b2", value: 4 });
    assert.equal(replaced.status, 200);
    assert.deepEqual(b.node.get(db, coll, remoteId), { _id: remoteId, side: "b2", value: 4 });

    const removed = await c.del(`${base}/${remoteId}`);
    assert.equal(removed.status, 204);
    assert.equal(b.node.get(db, coll, remoteId), undefined);
    assert.deepEqual(a.node.get(db, coll, localId), { _id: localId, side: "a", value: 1 });
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("public queries resolve live references across shard owners", async () => {
  const { a, b, urlA } = await startRoutedTwoShardCluster();
  try {
    const session = await login(urlA);
    const c = api(urlA, session.accessToken);
    const db = "app";
    const authorColl = "authors";
    const postColl = "posts";
    const authorBase = `/api/${db}/${authorColl}/object`;
    const postBase = `/api/${db}/${postColl}/object`;
    const authorId = idForShard(a.node, db, authorColl, "shard-b", "author");
    const postId = idForShard(a.node, db, postColl, "shard-a", "post");

    const author = await c.post(authorBase, { _id: authorId, name: "Alice", score: 10 });
    assert.equal(author.status, 201);
    assert.equal(a.node.get(db, authorColl, authorId), undefined);
    assert.equal(b.node.get(db, authorColl, authorId).name, "Alice");

    const created = await c.post(postBase, {
      _id: postId,
      title: "Reference post",
      author: {
        type: "reference",
        database: db,
        collection: authorColl,
        value: authorId,
        object: { _id: authorId, name: "stale payload should not be stored" },
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.author.object.name, "Alice");
    assert.equal(a.node.get(db, postColl, postId).author.object, undefined);

    const raw = await c.get(`${postBase}/${postId}?$refDepth=0`);
    assert.equal(raw.status, 200);
    assert.equal(raw.body.author.object, undefined);

    const got = await c.get(`${postBase}/${postId}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.author.object.name, "Alice");

    const qAlice = encodeURIComponent(JSON.stringify({ "author.object.name": "Alice" }));
    const alice = await c.get(`${postBase}?q=${qAlice}`);
    assert.equal(alice.status, 200, JSON.stringify(alice.body));
    assert.deepEqual(alice.body.map((post) => post._id), [postId]);

    const patched = await c.patch(`${authorBase}/${authorId}`, { $set: { name: "Ada" } });
    assert.equal(patched.status, 200);
    const qAda = encodeURIComponent(JSON.stringify({ "author.object.name": "Ada" }));
    const ada = await c.get(`${postBase}?q=${qAda}`);
    assert.deepEqual(ada.body.map((post) => post._id), [postId]);

    const missingBeforeDelete = await c.get(`${postBase}?q=${encodeURIComponent(JSON.stringify({ "author.object": null }))}`);
    assert.deepEqual(missingBeforeDelete.body, []);

    assert.equal((await c.del(`${authorBase}/${authorId}`)).status, 204);
    const missing = await c.get(`${postBase}?q=${encodeURIComponent(JSON.stringify({ "author.object": null }))}`);
    assert.deepEqual(missing.body.map((post) => post._id), [postId]);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("bulk CRUD splits batches by shard and read routes fan out", async () => {
  const { a, b, urlA } = await startRoutedTwoShardCluster();
  try {
    const session = await login(urlA);
    const c = api(urlA, session.accessToken);
    const db = "app";
    const coll = "bulk_routed";
    const base = `/api/${db}/${coll}/object`;
    const idA = idForShard(a.node, db, coll, "shard-a", "a");
    const idB = idForShard(a.node, db, coll, "shard-b", "b");

    const generated = await c.post(base, { side: "generated", value: 7 });
    assert.equal(generated.status, 201);
    const generatedShard = a.node.shardForObject(db, coll, generated.body._id);
    const generatedOwner = generatedShard === "shard-a" ? a.node : b.node;
    assert.deepEqual(generatedOwner.get(db, coll, generated.body._id), generated.body);

    const created = await c.post(base, [
      { _id: idA, side: "a", value: 10 },
      { _id: idB, side: "b", value: 20 },
    ]);
    assert.equal(created.status, 201);
    assert.equal(created.body.inserted, 2);
    assert.equal(a.node.get(db, coll, idA).value, 10);
    assert.equal(b.node.get(db, coll, idB).value, 20);
    assert.equal(a.node.get(db, coll, idB), undefined);
    assert.equal(b.node.get(db, coll, idA), undefined);

    const patched = await c.patch(base, [
      { _id: idA, $set: { value: 11 } },
      { _id: idB, $set: { value: 21 } },
    ]);
    assert.equal(patched.status, 200);
    assert.equal(patched.body.updated, 2);
    assert.equal(a.node.get(db, coll, idA).value, 11);
    assert.equal(b.node.get(db, coll, idB).value, 21);

    const list = await c.get(`${base}?sortBy=value&sort=desc`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((item) => item.value), [21, 11, 7]);

    const page = await c.get(`${base}?sortBy=value&sort=desc&limit=1`);
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.map((item) => item.value), [21]);

    const q = encodeURIComponent(JSON.stringify({
      $aggregate: {
        groupBy: "side",
        fields: {
          total: { $sum: "value" },
          n: { $count: true },
        },
        $sort: { total: -1 },
      },
    }));
    const aggregate = await c.get(`${base}?q=${q}`);
    assert.equal(aggregate.status, 200);
    assert.deepEqual(aggregate.body.map((row) => row.side), ["b", "a", "generated"]);

    const replaced = await c.put(base, [
      { _id: idA, side: "a2", value: 100 },
      { _id: idB, side: "b2", value: 200 },
    ]);
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.replaced, 2);
    assert.deepEqual(a.node.get(db, coll, idA), { _id: idA, side: "a2", value: 100 });
    assert.deepEqual(b.node.get(db, coll, idB), { _id: idB, side: "b2", value: 200 });

    const deleted = await c.del(base, { ids: [idA, idB, "missing"] });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, 2);
    assert.deepEqual(deleted.body.skipped, ["missing"]);
    assert.equal(a.node.get(db, coll, idA), undefined);
    assert.equal(b.node.get(db, coll, idB), undefined);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("streamed NDJSON bulk CRUD splits chunks by shard", async () => {
  const { a, b, urlA } = await startRoutedTwoShardCluster({
    a: {
      imports: {
        maxBulkObjects: 2,
        maxBulkBytes: 1024 * 1024,
        maxObjectBytes: 1024 * 1024,
      },
    },
    b: {
      imports: {
        maxBulkObjects: 2,
        maxBulkBytes: 1024 * 1024,
        maxObjectBytes: 1024 * 1024,
      },
    },
  });
  const originalFetch = global.fetch;
  const forwarded = [];
  try {
    const session = await login(urlA);
    global.fetch = async (url, init = {}) => {
      if (String(url).startsWith(`http://localhost:${b.port}/api/`)) {
        forwarded.push({
          method: init.method || "GET",
          contentType: headerValue(init.headers, "content-type"),
          prefer: headerValue(init.headers, "prefer"),
        });
      }
      return originalFetch(url, init);
    };
    const db = "app";
    const coll = "streamed_routed";
    const base = `/api/${db}/${coll}/object`;
    const idA = idForShard(a.node, db, coll, "shard-a", "local");
    const idB = idForShard(a.node, db, coll, "shard-b", "remote");

    const created = await ndjsonRequest(urlA, session.accessToken, "POST", base, [
      { _id: idA, side: "a", value: 1 },
      { _id: idB, side: "b", value: 2 },
    ]);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body, { inserted: 2 });
    assert.equal(a.node.get(db, coll, idA).value, 1);
    assert.equal(b.node.get(db, coll, idB).value, 2);

    const patched = await ndjsonRequest(urlA, session.accessToken, "PATCH", base, [
      { _id: idA, $set: { value: 3 } },
      { _id: idB, $set: { value: 4 } },
    ]);
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.deepEqual(patched.body, { updated: 2, skipped: 0 });
    assert.equal(a.node.get(db, coll, idA).value, 3);
    assert.equal(b.node.get(db, coll, idB).value, 4);

    const replaced = await ndjsonRequest(urlA, session.accessToken, "PUT", base, [
      { _id: idA, side: "a", value: 5 },
      { _id: idB, side: "b", value: 6 },
    ]);
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.deepEqual(replaced.body, { replaced: 2 });
    assert.equal(a.node.get(db, coll, idA).value, 5);
    assert.equal(b.node.get(db, coll, idB).value, 6);

    const removed = await ndjsonRequest(urlA, session.accessToken, "DELETE", base, [
      { _id: idA },
      { _id: idB },
    ]);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(removed.body, { deleted: 2, skipped: 0 });
    assert.equal(a.node.get(db, coll, idA), undefined);
    assert.equal(b.node.get(db, coll, idB), undefined);
    assert.deepEqual(forwarded.map((entry) => entry.method), ["POST", "PATCH", "PUT", "DELETE"]);
    assert.ok(forwarded.every((entry) => entry.contentType === "application/x-ndjson"));
    assert.ok(forwarded.every((entry) => /\breturn=minimal\b/i.test(entry.prefer)));
  } finally {
    global.fetch = originalFetch;
    a.server.close();
    b.server.close();
  }
});

test("public sharded list does not count shards for array responses", async () => {
  const { a, b, urlA } = await startRoutedTwoShardCluster();
  try {
    const session = await login(urlA);
    const c = api(urlA, session.accessToken);
    const db = "app";
    const coll = "fast_list";
    const base = `/api/${db}/${coll}/object`;
    const idA = idForShard(a.node, db, coll, "shard-a", "a");
    const idB = idForShard(a.node, db, coll, "shard-b", "b");

    assert.equal((await c.post(base, [
      { _id: idA, value: 1 },
      { _id: idB, value: 2 },
    ])).status, 201);

    a.node.count = a.node.countShards = () => {
      throw new Error("count should not run for public list responses");
    };
    b.node.count = b.node.countShards = () => {
      throw new Error("count should not run for public list responses");
    };

    const list = await c.get(`${base}?limit=1`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(Array.isArray(list.body), true);
    assert.equal(list.body.length, 1);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("query router pages and aggregates correctly when one node owns multiple shards", async () => {
  const { a, b, urlA } = await startMultiOwnedShardCluster();
  try {
    const session = await login(urlA);
    const c = api(urlA, session.accessToken);
    const db = "app";
    const coll = "multi_owned_query";
    const base = `/api/${db}/${coll}/object`;
    const idA1 = idForShard(a.node, db, coll, "shard-a", "a1");
    const idA2 = idForShard(a.node, db, coll, "shard-a", "a2");
    const idB = idForShard(a.node, db, coll, "shard-b", "b");
    const idC = idForShard(a.node, db, coll, "shard-c", "c");

    const created = await c.post(base, [
      { _id: idA1, bucket: "local-a", value: 1 },
      { _id: idB, bucket: "local-b", value: 2 },
      { _id: idC, bucket: "remote-c", value: 3 },
      { _id: idA2, bucket: "local-a", value: 4 },
    ]);
    assert.equal(created.status, 201);
    assert.equal(a.node.count(db, coll), 3);
    assert.equal(b.node.count(db, coll), 1);

    const page = await c.get(`${base}?sortBy=value&sort=asc&limit=2&offset=1`);
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.map((item) => item.value), [2, 3]);

    const q = encodeURIComponent(JSON.stringify({
      $aggregate: {
        fields: {
          total: { $sum: "value" },
          n: { $count: true },
        },
      },
    }));
    const aggregate = await c.get(`${base}?q=${q}`);
    assert.equal(aggregate.status, 200);
    assert.deepEqual(aggregate.body, [{ total: 10, n: 4 }]);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("collection metadata fan-out builds indexes on shard peers", async () => {
  const { a, b, urlA } = await startRoutedTwoShardCluster();
  try {
    const session = await login(urlA);
    const c = api(urlA, session.accessToken);
    const db = "app";
    const coll = "fanout_meta";
    const base = `/api/${db}/${coll}/object`;
    const idB = idForShard(a.node, db, coll, "shard-b", "remote");

    const created = await c.post(`/api/${db}/collections`, { name: coll, indexes: ["value"] });
    assert.equal(created.status, 201);
    assert.deepEqual(b.node.getCollectionMeta(db, coll), { indexes: ["value"], columns: [] });

    await c.post(base, { _id: idB, value: 3 });
    assert.equal(b.node.queryPath(db, coll, { value: 3 }), "index-exact");

    const updated = await c.put(`/api/${db}/${coll}/meta`, { indexes: ["value", "id"] });
    assert.equal(updated.status, 200);
    assert.deepEqual(b.node.getCollectionMeta(db, coll), { indexes: ["value", "id"], columns: [] });

    const removed = await c.del(`/api/${db}/collections/${coll}`);
    assert.equal(removed.status, 204);
    assert.equal(b.node.getCollectionMeta(db, coll), null);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("schema writes tolerate unavailable peers except for destructive collection drops", async () => {
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const offlineUrl = `http://127.0.0.1:${await freePort()}`;
  const shardMap = {
    shards: {
      "shard-a": { peers: [{ url }, { url: offlineUrl }] },
    },
  };
  const s = await startTestServer({
    port,
    node: new CRDTNode({ id: "schema-fanout", url }),
    shardMap,
  });
  try {
    const session = await login(url);
    const c = api(url, session.accessToken);

    const createdDb = await c.post("/api/databases", { name: "offline_schema" });
    assert.equal(createdDb.status, 201, JSON.stringify(createdDb.body));
    assert.deepEqual(s.node.getDatabaseMeta("offline_schema"), {});

    const createdCollection = await c.post("/api/offline_schema/collections", {
      name: "docs",
      indexes: ["status"],
    });
    assert.equal(createdCollection.status, 201, JSON.stringify(createdCollection.body));
    assert.deepEqual(s.node.getCollectionMeta("offline_schema", "docs"), {
      indexes: ["status"],
      columns: [],
    });

    const updatedMeta = await c.put("/api/offline_schema/docs/meta", {
      indexes: ["status", "owner"],
    });
    assert.equal(updatedMeta.status, 200, JSON.stringify(updatedMeta.body));
    assert.deepEqual(s.node.getCollectionMeta("offline_schema", "docs"), {
      indexes: ["status", "owner"],
      columns: [],
    });

    const deletedCollection = await c.del("/api/offline_schema/collections/docs");
    assert.equal(deletedCollection.status, 503, JSON.stringify(deletedCollection.body));
    assert.equal(s.node.getCollectionMeta("offline_schema", "docs"), null);

    const deletedDb = await c.del("/api/databases/offline_schema");
    assert.equal(deletedDb.status, 503, JSON.stringify(deletedDb.body));
    assert.equal(s.node.getDatabaseMeta("offline_schema"), null);
  } finally {
    s.server.close();
  }
});

test("collection and database deletes keep committed state when file cleanup fails", async () => {
  const files = {
    deleteCollectionFiles: async () => {
      throw new Error("fetch failed");
    },
    deleteDatabaseFiles: async () => {
      throw new Error("fetch failed");
    },
  };
  const s = await startTestServer({ port: 0, files });
  try {
    const base = `http://localhost:${s.port}`;
    const session = await login(base);
    const c = api(base, session.accessToken);

    assert.equal((await c.post("/api/file_cleanup/collections", { name: "docs" })).status, 201);
    const deletedCollection = await c.del("/api/file_cleanup/collections/docs");
    assert.equal(deletedCollection.status, 204, JSON.stringify(deletedCollection.body));
    assert.equal(s.node.getCollectionMeta("file_cleanup", "docs"), null);

    assert.equal((await c.post("/api/databases", { name: "file_cleanup_db" })).status, 201);
    const deletedDb = await c.del("/api/databases/file_cleanup_db");
    assert.equal(deletedDb.status, 204, JSON.stringify(deletedDb.body));
    assert.equal(s.node.getDatabaseMeta("file_cleanup_db"), null);
  } finally {
    s.server.close();
  }
});

test("public object interface returns old aggregate rows from the object route", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const session = await login(`http://localhost:${s.port}`);
    const c = api(`http://localhost:${s.port}`, session.accessToken);
    const base = "/api/app/events/object";

    await c.post(base, [
      { _id: "e1", type: "signup", count: 1 },
      { _id: "e2", type: "signup", count: 2 },
      { _id: "e3", type: "purchase", count: 5 },
    ]);

    const q = encodeURIComponent(JSON.stringify({
      type: { $in: ["signup", "purchase"] },
      $aggregate: {
        groupBy: "type",
        fields: {
          total: { $sum: "count" },
          n: { $count: true },
        },
        $sort: { total: -1 },
      },
    }));
    const listed = await c.get(`${base}?q=${q}`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, [
      { type: "purchase", total: 5, n: 1 },
      { type: "signup", total: 3, n: 2 },
    ]);
  } finally {
    s.server.close();
  }
});

test("POST search honors body pagination controls", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const session = await login(`http://localhost:${s.port}`);
    const c = api(`http://localhost:${s.port}`, session.accessToken);
    const db = "app";
    const coll = "search_body_paging";
    const base = `/api/${db}/${coll}`;

    const created = await c.post(`${base}/object`, [
      { _id: "a", status: "active", score: 1 },
      { _id: "b", status: "active", score: 2 },
      { _id: "c", status: "active", score: 3 },
    ]);
    assert.equal(created.status, 201);

    const page = await c.post(`${base}/search`, {
      status: "active",
      $sort: { score: 1 },
      $page: 2,
      $pageSize: 1,
      $refDepth: 0,
    });
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.deepEqual(page.body.map((row) => row._id), ["b"]);

    const skipped = await c.post(`${base}/search`, {
      status: "active",
      $sort: { score: 1 },
      $skip: 2,
      $limit: 1,
      $refDepth: 0,
    });
    assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
    assert.deepEqual(skipped.body.map((row) => row._id), ["c"]);
  } finally {
    s.server.close();
  }
});

test("public object queries default and cap page size", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const session = await login(`http://localhost:${s.port}`);
    const c = api(`http://localhost:${s.port}`, session.accessToken, { prefer: "return=minimal" });
    const db = "app";
    const coll = "query_page_cap";
    const base = `/api/${db}/${coll}`;
    const rows = Array.from({ length: 260 }, (_, index) => ({
      _id: `row-${String(index).padStart(3, "0")}`,
      status: "active",
      index,
    }));

    const created = await c.post(`${base}/object`, rows);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const defaultPage = await c.get(`${base}/object?$refDepth=0`);
    assert.equal(defaultPage.status, 200, JSON.stringify(defaultPage.body));
    assert.equal(defaultPage.body.length, 250);

    const cappedBodyPage = await c.post(`${base}/search`, {
      status: "active",
      $pageSize: 500,
      $refDepth: 0,
    });
    assert.equal(cappedBodyPage.status, 200, JSON.stringify(cappedBodyPage.body));
    assert.equal(cappedBodyPage.body.length, 250);

    const secondPage = await c.post(`${base}/search`, {
      status: "active",
      $page: 2,
      $pageSize: 250,
      $refDepth: 0,
    });
    assert.equal(secondPage.status, 200, JSON.stringify(secondPage.body));
    assert.equal(secondPage.body.length, 10);
  } finally {
    s.server.close();
  }
});

test("public query responses expose planner path headers", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const session = await login(`http://localhost:${s.port}`);
    const c = api(`http://localhost:${s.port}`, session.accessToken);
    const db = "app";
    const coll = "path_headers";
    const base = `/api/${db}/${coll}/object`;

    const createdCollection = await c.post(`/api/${db}/collections`, {
      name: coll,
      indexes: ["status"],
      columns: ["score"],
    });
    assert.equal(createdCollection.status, 201);
    assert.equal((await c.post(base, [
      { _id: "a", status: "active", score: 1 },
      { _id: "b", status: "active", score: 2 },
      { _id: "c", status: "archived", score: 3 },
    ])).status, 201);

    const listed = await c.get(`${base}?limit=2`);
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get("x-spread-db-query-path"), "scan");

    const indexedQuery = encodeURIComponent(JSON.stringify({ status: "active" }));
    const indexed = await c.get(`${base}?q=${indexedQuery}`);
    assert.equal(indexed.status, 200);
    assert.equal(indexed.headers.get("x-spread-db-query-path"), "index-full");

    const partialQuery = encodeURIComponent(JSON.stringify({ status: "active", score: { $gt: 1 } }));
    const partial = await c.get(`${base}?q=${partialQuery}`);
    assert.equal(partial.status, 200);
    assert.equal(partial.headers.get("x-spread-db-query-path"), "index-partial");

    const aggregateQuery = encodeURIComponent(JSON.stringify({
      $aggregate: {
        fields: {
          total: { $sum: "score" },
        },
      },
    }));
    const aggregate = await c.get(`${base}?q=${aggregateQuery}`);
    assert.equal(aggregate.status, 200);
    assert.deepEqual(aggregate.body, [{ total: 6 }]);
    assert.equal(aggregate.headers.get("x-spread-db-query-path"), "aggregate-column-summary");

    const groupedCountQuery = encodeURIComponent(JSON.stringify({
      status: "active",
      $aggregate: {
        groupBy: "status",
        fields: { n: { $count: true } },
      },
    }));
    const groupedCount = await c.get(`${base}?q=${groupedCountQuery}`);
    assert.equal(groupedCount.status, 200);
    assert.deepEqual(groupedCount.body, [{ status: "active", n: 2 }]);
    assert.equal(groupedCount.headers.get("x-spread-db-query-path"), "aggregate-group-index");

    const groupedMetricQuery = encodeURIComponent(JSON.stringify({
      status: "active",
      $aggregate: {
        groupBy: "status",
        fields: {
          total: { $sum: "score" },
          n: { $count: true },
        },
      },
    }));
    const groupedMetric = await c.get(`${base}?q=${groupedMetricQuery}`);
    assert.equal(groupedMetric.status, 200);
    assert.deepEqual(groupedMetric.body, [{ status: "active", total: 3, n: 2 }]);
    assert.equal(groupedMetric.headers.get("x-spread-db-query-path"), "aggregate-group-forward-index");
  } finally {
    s.server.close();
  }
});

test("sharded object-db aggregate merges shard partials without fetching raw objects", async () => {
  const { a, b, urlA, urlB } = await startRoutedTwoShardCluster();
  const originalFetch = globalThis.fetch;
  try {
    const session = await login(urlA);
    const c = api(urlA, session.accessToken);
    const db = "app";
    const coll = "aggregate_routed";
    const base = `/api/${db}/${coll}/object`;
    const createdCollection = await c.post(`/api/${db}/collections`, {
      name: coll,
      indexes: ["status"],
      columns: ["status", "score"],
    });
    assert.equal(createdCollection.status, 201);

    const idA1 = idForShard(a.node, db, coll, "shard-a", "a1");
    const idA2 = idForShard(a.node, db, coll, "shard-a", "a2");
    const idB1 = idForShard(a.node, db, coll, "shard-b", "b1");
    const idB2 = idForShard(a.node, db, coll, "shard-b", "b2");

    assert.equal((await c.post(base, [
      { _id: idA1, status: "new", score: 1 },
      { _id: idA2, status: "done", score: 10 },
      { _id: idB1, status: "new", score: 2 },
      { _id: idB2, status: "done", score: 20 },
    ])).status, 201);
    assert.equal(a.node.indexStats(db, coll).find((entry) => entry.type === "column" && entry.path === "score").entries, 2);
    assert.equal(b.node.indexStats(db, coll).find((entry) => entry.type === "column" && entry.path === "score").entries, 2);

    const forwarded = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.startsWith(urlB)) forwarded.push({ url, method: init.method || "GET" });
      return originalFetch(input, init);
    };

    const q = encodeURIComponent(JSON.stringify({
      $aggregate: {
        groupBy: "status",
        fields: {
          score: { $sum: "score" },
          average: { $avg: "score" },
          n: { $count: true },
        },
        $sort: { score: -1 },
      },
    }));
    const result = await c.get(`${base}?q=${q}`);

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body, [
      { status: "done", score: 30, average: 15, n: 2 },
      { status: "new", score: 3, average: 1.5, n: 2 },
    ]);
    assert.equal(result.headers.get("x-spread-db-query-path"), "aggregate-group-forward-index");
    assert.equal(
      forwarded.some((entry) => entry.method === "GET" && entry.url.includes("%22%24aggregate%22")),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    a.server.close();
    b.server.close();
  }
});

test("public vector search supports GET query syntax and POST body payloads", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const session = await login(`http://localhost:${s.port}`);
    const c = api(`http://localhost:${s.port}`, session.accessToken);
    const base = "/api/app/docs/object";

    const created = await c.post(base, [
      { _id: "near", title: "near", status: "active", rank: 2, _vec: [1, 0, 0] },
      { _id: "mid", title: "mid", status: "active", rank: 1, _vec: [0.8, 0.2, 0] },
      { _id: "far", title: "far", status: "archived", rank: 3, _vec: [0, 1, 0] },
    ]);
    assert.equal(created.status, 201);
    assert.equal(created.body.items[0]._vec, undefined);
    assert.deepEqual(s.node.getVector("app", "docs", "near"), [1, 0, 0]);

    const listed = await c.get(base);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.some((row) => row._vec !== undefined), false);

    const q = encodeURIComponent(JSON.stringify({
      status: "active",
      $vector: { vector: [1, 0, 0], limit: 2 },
    }));
    const vectorOnlyQ = encodeURIComponent(JSON.stringify({
      $vector: { vector: [1, 0, 0], limit: 2 },
    }));
    await s.node.awaitVectorIndexes();
    s.node.vectorWarmupEnabled = false;
    s.node.db.clearVectorIndexes();
    const warming = await c.get(`${base}?q=${vectorOnlyQ}`);
    assert.equal(warming.status, 503, JSON.stringify(warming.body));
    assert.match(warming.body.error, /vector index warming/);
    await s.node.awaitVectorIndexes();

    const getSearch = await c.get(`${base}?q=${q}`);
    assert.equal(getSearch.status, 200, JSON.stringify(getSearch.body));
    assert.deepEqual(getSearch.body.map((row) => row._id), ["near", "mid"]);
    assert.equal(getSearch.body.every((row) => typeof row._score === "number" && row._vec === undefined), true);

    const bodySearch = await c.post("/api/app/docs/search", {
      $vector: { vector: [1, 0, 0], limit: 3 },
      $sort: { rank: -1 },
    });
    assert.equal(bodySearch.status, 200, JSON.stringify(bodySearch.body));
    assert.deepEqual(bodySearch.body.map((row) => row._id), ["far", "near", "mid"]);

    const badAggregate = await c.post("/api/app/docs/search", {
      $vector: { vector: [1, 0, 0] },
      $aggregate: { fields: { n: { $count: true } } },
    });
    assert.equal(badAggregate.status, 400);
    assert.match(badAggregate.body.error, /\$aggregate and \$vector/);

    const badVector = await c.post("/api/app/docs/search", {
      $vector: { vector: [1, Number.NaN] },
    });
    assert.equal(badVector.status, 400);

    const redacted = await c.get(`${base}/near`);
    assert.equal(redacted.body._vec, undefined);
    const replaced = await c.put(`${base}/near`, redacted.body);
    assert.equal(replaced.status, 200);
    assert.deepEqual(s.node.getVector("app", "docs", "near"), [1, 0, 0]);

    const vectorPatched = await c.patch(`${base}/near`, { $set: { _vec: [0, 0, 1] } });
    assert.equal(vectorPatched.status, 200);
    assert.equal(vectorPatched.body._vec, undefined);
    assert.deepEqual(s.node.getVector("app", "docs", "near"), [0, 0, 1]);

    const vectorRemoved = await c.patch(`${base}/near`, { $unset: ["_vec"] });
    assert.equal(vectorRemoved.status, 200);
    assert.equal(vectorRemoved.body._vec, undefined);
    assert.equal(s.node.getVector("app", "docs", "near"), null);
  } finally {
    s.server.close();
  }
});

test("sharded vector search fans out with POST bodies and merges scores", async () => {
  const { a, b, urlA, urlB } = await startRoutedTwoShardCluster();
  const originalFetch = globalThis.fetch;
  try {
    const session = await login(urlA);
    const c = api(urlA, session.accessToken);
    const db = "app";
    const coll = "vector_routed";
    const base = `/api/${db}/${coll}/object`;
    const idA = idForShard(a.node, db, coll, "shard-a", "local");
    const idB = idForShard(a.node, db, coll, "shard-b", "remote");

    const created = await c.post(base, [
      { _id: idA, side: "a", _vec: [1, 0] },
      { _id: idB, side: "b", _vec: [0, 1] },
    ]);
    assert.equal(created.status, 201);
    assert.equal(a.node.get(db, coll, idA).side, "a");
    assert.equal(b.node.get(db, coll, idB).side, "b");
    await Promise.all([a.node.awaitVectorIndexes(), b.node.awaitVectorIndexes()]);

    const forwarded = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.startsWith(urlB)) {
        forwarded.push({
          url,
          method: init.method || "GET",
          body: init.body,
        });
      }
      return originalFetch(input, init);
    };

    const searched = await c.post(`/api/${db}/${coll}/search`, {
      $vector: { vector: [0, 1], limit: 2 },
    });
    assert.equal(searched.status, 200, JSON.stringify(searched.body));
    assert.deepEqual(searched.body.map((row) => row._id), [idB, idA]);
    assert.equal(searched.body.some((row) => row._vec !== undefined), false);

    const searchForward = forwarded.find((entry) => entry.method === "POST" && entry.url.endsWith(`/api/${db}/${coll}/search`));
    assert.ok(searchForward);
    assert.match(String(searchForward.body), /"\$vector"/);
    assert.equal(forwarded.some((entry) => entry.url.includes("%22%24vector%22")), false);
  } finally {
    globalThis.fetch = originalFetch;
    a.server.close();
    b.server.close();
  }
});

test("public interface lists databases, collections, and collection meta", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const session = await login(`http://localhost:${s.port}`);
    const c = api(`http://localhost:${s.port}`, session.accessToken);

    assert.deepEqual((await c.get("/api/databases")).body.databases, ["_global"]);

    const createdDb = await c.post("/api/databases", { name: "app" });
    assert.equal(createdDb.status, 201);
    assert.deepEqual(createdDb.body, { name: "app", created: true, meta: {} });

    const createdCollection = await c.post("/api/app/collections", {
      name: "orders",
      indexes: ["status"],
      owner: "events-team",
    });
    assert.equal(createdCollection.status, 201);
    assert.deepEqual(createdCollection.body, {
      name: "orders",
      created: true,
      meta: { indexes: ["status"], columns: [], owner: "events-team" },
    });

    await c.post("/api/app/users/object", { _id: "u1", name: "Ada" });

    assert.deepEqual((await c.get("/api/databases")).body.databases, ["_global", "app"]);
    assert.deepEqual((await c.get("/api/app/collections")).body.collections, ["orders", "users"]);
    assert.deepEqual((await c.get("/api/app/orders/meta")).body, {
      indexes: ["status"],
      columns: [],
      owner: "events-team",
    });
    assert.deepEqual((await c.get("/api/app/users/meta")).body, { indexes: [], columns: [] });

    await c.post("/api/app/orders/object", { _id: "o1", status: "paid" });
    assert.equal(s.node.queryPath("app", "orders", { status: "paid" }), "index-exact");

    const removed = await c.del("/api/app/collections/orders");
    assert.equal(removed.status, 204);
    assert.deepEqual((await c.get("/api/app/collections")).body.collections, ["users"]);
    assert.equal((await c.get("/api/app/orders/meta")).status, 404);

    assert.equal((await c.del("/api/databases/_global")).status, 403);
    const removedDb = await c.del("/api/databases/app");
    assert.equal(removedDb.status, 204);
    assert.deepEqual((await c.get("/api/databases")).body.databases, ["_global"]);
  } finally {
    s.server.close();
  }
});

test("collection meta endpoint rejects invalid index metadata", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const session = await login(`http://localhost:${s.port}`);
    const c = api(`http://localhost:${s.port}`, session.accessToken);
    const res = await c.put("/api/app/users/meta", { indexes: "name" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /indexes must be an array/);

    const create = await c.post("/api/app/collections", { name: "bad", meta: [] });
    assert.equal(create.status, 400);
    assert.match(create.body.error, /body.meta must be a plain object/);

    const createDatabase = await c.post("/api/databases", { name: "bad", meta: [] });
    assert.equal(createDatabase.status, 400);
    assert.match(createDatabase.body.error, /body.meta must be a plain object/);
  } finally {
    s.server.close();
  }
});

test("retention uses durable catch-up instead of HTTP snapshots", async () => {
  const { CRDTNode } = await import("../src/crdt.js");
  const storage = new MemoryObjectStorage();
  const nodeA = new CRDTNode({ retainOps: 0 });
  const persistenceA = new PersistenceManager({ node: nodeA, storage, segmentBytes: 1024 });
  const a = await startTestServer({ port: 0, node: nodeA, persistence: persistenceA });
  const b = await startTestServer({ port: 0 });
  a.node.addPeer(httpPeer(`http://localhost:${b.port}`, a.node.id, { secret: TEST_CLUSTER_SECRET }));
  b.node.addPeer(httpPeer(`http://localhost:${a.port}`, b.node.id, { secret: TEST_CLUSTER_SECRET }));
  try {
    const session = await login(`http://localhost:${a.port}`);
    const ca = api(`http://localhost:${a.port}`, session.accessToken);
    for (let i = 0; i < 20; i++) {
      await ca.post("/api/app/items/object", { _id: `i${i}`, v: i });
    }
    await b.node.syncAll();
    assert.equal(b.node.count("app", "items"), 20);
    assert.equal(a.node.trimmed, a.node.seq, "acked log pruned to zero");
    await persistenceA.checkpoint();

    const deniedPull = await fetch(`http://localhost:${a.port}/replicate?after=0`);
    assert.equal(deniedPull.status, 401);
    const pull = await fetch(`http://localhost:${a.port}/replicate?after=0`, { headers: clusterHeaders() });
    assert.equal(pull.status, 410);
    const snapshot = await fetch(`http://localhost:${a.port}/replicate/snapshot`, { headers: clusterHeaders() });
    assert.equal(snapshot.status, 404);

    const nodeFresh = new CRDTNode();
    const persistenceFresh = new PersistenceManager({ node: nodeFresh, storage });
    const fresh = await startTestServer({ port: 0, node: nodeFresh, persistence: persistenceFresh });
    try {
      fresh.node.addPeer(httpPeer(`http://localhost:${a.port}`, fresh.node.id, { secret: TEST_CLUSTER_SECRET }));
      await fresh.node.syncAll();
      const freshSession = await login(`http://localhost:${fresh.port}`);
      const items = (await api(`http://localhost:${fresh.port}`, freshSession.accessToken).get("/api/app/items/object")).body;
      assert.equal(items.length, 20);
      assert.equal(items[0].v, 0);
    } finally {
      fresh.server.close();
    }
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("serves the console UI at /", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const r = await fetch(`http://localhost:${s.port}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/html/);
    const html = await r.text();
    assert.match(html, /OBJY DB/);
    assert.match(html, /objy-db-logo\.png/);
    assert.match(html, /id="object-file"/);
    assert.match(html, /id="download-file-btn"/);

    const logo = await fetch(`http://localhost:${s.port}/objy-db-logo.png`);
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get("content-type"), /image\/png/);
    assert.ok((await logo.arrayBuffer()).byteLength > 0);

    const docs = await fetch(`http://localhost:${s.port}/API.md`);
    assert.equal(docs.status, 200);
    assert.match(docs.headers.get("content-type"), /text\/markdown/);
    const docsText = await docs.text();
    assert.match(docsText, /# OBJY DB API/);
    assert.match(docsText, /## File Handling/);
  } finally {
    s.server.close();
  }
});

test("shape store remains available behind the public interface", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const session = await login(`http://localhost:${s.port}`);
    const c = api(`http://localhost:${s.port}`, session.accessToken);
    await c.post("/api/d/c/object", { x: 1, y: "a" });
    await c.post("/api/d/c/object", { x: 2, y: "b" });
    await c.post("/api/d/c/object", { x: 3, y: 1 });
    const shapes = s.node.stats("d", "c");
    assert.equal(shapes.length, 1);
    const shared = shapes.find((s2) => s2.rows === 3);
    assert.ok(shared);
    assert.ok(shared.bytes > 0);
  } finally {
    s.server.close();
  }
});

test("replication across two HTTP nodes", async () => {
  const a = await startTestServer({ port: 0 });
  const b = await startTestServer({ port: 0 });
  try {
    a.node.addPeer(httpPeer(`http://localhost:${b.port}`, a.node.id, { secret: TEST_CLUSTER_SECRET }));
    b.node.addPeer(httpPeer(`http://localhost:${a.port}`, b.node.id, { secret: TEST_CLUSTER_SECRET }));
    const sessionA = await login(`http://localhost:${a.port}`);
    const sessionB = await login(`http://localhost:${b.port}`);
    const ca = api(`http://localhost:${a.port}`, sessionA.accessToken);
    const cb = api(`http://localhost:${b.port}`, sessionB.accessToken);

    const ins = await ca.post("/api/app/items/object", { _id: "i1", qty: 5 });
    assert.equal(ins.status, 201);

    await b.node.syncAll();
    const onB = await cb.get("/api/app/items/object/i1");
    assert.equal(onB.status, 200);
    assert.deepEqual(onB.body, { _id: "i1", qty: 5 });

    await cb.patch("/api/app/items/object/i1", { $set: { qty: 6 } });
    await a.node.syncAll();
    const onA = await ca.get("/api/app/items/object/i1");
    assert.equal(onA.body.qty, 6);

    const pull = await fetch(`http://localhost:${a.port}/replicate?after=0`, { headers: clusterHeaders() });
    const payload = await pull.json();
    assert.equal(payload.node, a.node.id);
    assert.ok(Array.isArray(payload.ops));

    const streamPull = await fetch(`http://localhost:${a.port}/replicate?after=0`, {
      headers: { ...clusterHeaders(), accept: "application/x-ndjson" },
    });
    assert.equal(streamPull.status, 200);
    assert.match(streamPull.headers.get("content-type"), /application\/x-ndjson/);
    assert.equal(streamPull.headers.get("x-spread-db-node"), a.node.id);
    const streamedOps = (await streamPull.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(streamedOps.length >= 1);
    assert.ok(streamedOps.some((op) => op.kind === "putObj" && op.id === "i1"));

    const pushedOp = {
      kind: "putObj",
      db: "app",
      coll: "items",
      id: "i2",
      value: { _id: "i2", qty: 7 },
      ts: { c: 1000, n: "manual" },
      seq: 1000,
      from: "manual",
    };
    const pushed = await fetch(`http://localhost:${b.port}/replicate?node=manual`, {
      method: "POST",
      headers: {
        ...clusterHeaders(),
        "content-type": "application/x-ndjson",
        "x-spread-db-node": "manual",
      },
      body: `${JSON.stringify(pushedOp)}\n`,
    });
    assert.equal(pushed.status, 200);
    assert.equal((await pushed.json()).applied, 1);
    assert.equal(b.node.get("app", "items", "i2").qty, 7);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("replication hints wake shard replicas through the existing pull path", async () => {
  const portA = await freePort();
  const portB = await freePort();
  const urlA = `http://localhost:${portA}`;
  const urlB = `http://localhost:${portB}`;
  const shardMap = {
    shards: {
      default: { peers: [{ url: urlA }, { url: urlB }] },
    },
  };
  const a = await startTestServer({
    port: portA,
    node: new CRDTNode({ id: "hint-a", url: urlA }),
    shardMap,
    replicationHints: { debounceMs: 0 },
  });
  const b = await startTestServer({
    port: portB,
    node: new CRDTNode({ id: "hint-b", url: urlB }),
    shardMap,
    replicationHints: { debounceMs: 0 },
  });

  try {
    const session = await login(urlA);
    const client = api(urlA, session.accessToken);
    const created = await client.post("/api/app/events/object", { _id: "e1", value: 1 });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    await waitFor(() => (
      b.node.get("app", "events", "e1")?.value === 1
      && b.replication.status().pullSyncs === 1
    ));
    assert.equal(a.replication.status().hintsSent, 1);
    assert.equal(b.replication.status().hintsReceived, 1);
    assert.equal(b.replication.status().pullSyncs, 1);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("replication hint route requires cluster secret and known shard peer", async () => {
  const portA = await freePort();
  const portB = await freePort();
  const urlA = `http://localhost:${portA}`;
  const urlB = `http://localhost:${portB}`;
  const shardMap = {
    shards: {
      default: { peers: [{ url: urlA }, { url: urlB }] },
    },
  };
  const a = await startTestServer({
    port: portA,
    node: new CRDTNode({ id: "hint-auth-a", url: urlA }),
    shardMap,
  });
  const b = await startTestServer({
    port: portB,
    node: new CRDTNode({ id: "hint-auth-b", url: urlB }),
    shardMap,
  });

  try {
    const anonymous = await fetch(`${urlB}/replicate/hint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node: "hint-auth-a", url: urlA, scopes: [{ shard: "default" }] }),
    });
    assert.equal(anonymous.status, 401);

    const unknown = await fetch(`${urlB}/replicate/hint`, {
      method: "POST",
      headers: { "content-type": "application/json", ...clusterHeaders() },
      body: JSON.stringify({ node: "unknown", url: "http://localhost:1", scopes: [{ shard: "default" }] }),
    });
    assert.equal(unknown.status, 403);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("HTTP peers learn node ids and sync incrementally", async () => {
  const { CRDTNode } = await import("../src/crdt.js");
  const a = await startTestServer({ port: 0, node: new CRDTNode({ id: "a", syncBatchSize: 3 }) });
  const b = await startTestServer({ port: 0, node: new CRDTNode({ id: "b", syncBatchSize: 3 }) });
  try {
    const peerToA = httpPeer(`http://localhost:${a.port}`, b.node.id, { secret: TEST_CLUSTER_SECRET });
    b.node.addPeer(peerToA);

    const session = await login(`http://localhost:${a.port}`);
    const ca = api(`http://localhost:${a.port}`, session.accessToken);
    for (let i = 0; i < 5; i++) await ca.post("/api/app/items/object", { _id: `i${i}`, v: i });

    await b.node.syncAll();
    assert.equal(peerToA.nodeId, "a");
    assert.equal(b.node.lastSeen.get("a"), a.node.seq);
    assert.equal(b.node.count("app", "items"), 5);

    await ca.post("/api/app/items/object", { _id: "i5", v: 5 });
    await b.node.syncAll();
    assert.equal(b.node.lastSeen.get("a"), a.node.seq);
    assert.equal(b.node.count("app", "items"), 6);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("custom interface plugins can mount routes", async () => {
  const s = await startTestServer({
    port: 0,
    interfaces: [
      {
        name: "custom-test",
        register(router, { node }) {
          router.get("/custom/node", (req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ node: node.id }));
          });
        },
      },
    ],
  });

  try {
    const res = await fetch(`http://localhost:${s.port}/custom/node`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).node, s.node.id);
  } finally {
    s.server.close();
  }
});

test("cluster peer updates persist shard map when a shard map store is configured", async () => {
  const { CRDTNode } = await import("../src/crdt.js");
  const storage = new MemoryObjectStorage();
  const shardMapStore = new ShardMapStore({ storage });
  const s = await startTestServer({
    port: 0,
    node: new CRDTNode({ id: "node-a" }),
    shardMapStore,
  });

  try {
    const c = api(`http://localhost:${s.port}`, null, clusterHeaders());
    const res = await c.post("/cluster/peers", {
      database: "app",
      collection: "events",
      shard: "shard-0",
      url: "http://localhost:9999",
    });
    assert.equal(res.status, 201);

    const stored = await shardMapStore.load();
    assert.equal(stored.shards["shard-0"].peers[0].url, "http://localhost:9999");
  } finally {
    s.server.close();
  }
});
