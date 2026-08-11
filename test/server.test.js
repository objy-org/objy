import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, httpPeer } from "../src/server.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { ShardMapStore } from "../src/shard-map-store.js";

const TEST_AUTH = { jwtSecret: "test-jwt-secret" };

function startTestServer(options = {}) {
  return startServer({ auth: TEST_AUTH, ...options });
}

async function login(base, username = "admin", password = "123", database = "_global", collection = "users") {
  const result = await api(base, null).post(`/api/${database}/${collection}/auth`, { username, password });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

function api(base, token = null) {
  const authHeaders = token ? { authorization: `Bearer ${token}` } : {};
  return {
    post: async (path, body) => {
      const r = await fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    get: async (path) => {
      const r = await fetch(base + path, { headers: authHeaders });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    patch: async (path, body) => {
      const r = await fetch(base + path, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    put: async (path, body) => {
      const r = await fetch(base + path, {
        method: "PUT",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    del: async (path, body) => {
      const r = await fetch(base + path, {
        method: "DELETE",
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...authHeaders },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
  };
}

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
    assert.equal(session.body.user.username, "admin");
    assert.equal(session.body.user.password, undefined);

    const authed = api(base, session.body.accessToken);
    assert.deepEqual((await authed.get("/api/databases")).body.databases, ["_global"]);

    const renewed = await anonymous.post("/api/_global/users/renew", { refreshToken: session.body.refreshToken });
    assert.equal(renewed.status, 200);
    assert.equal(typeof renewed.body.accessToken, "string");
    assert.equal(typeof renewed.body.refreshToken, "string");
    assert.equal(renewed.body.user.password, undefined);
  } finally {
    s.server.close();
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
      id: "reader",
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
    assert.equal((await appUser.get("/api/app/collections")).status, 200);
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

test("global users are password-hashed and can log in", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const base = `http://localhost:${s.port}`;
    const root = await login(base);
    const authed = api(base, root.accessToken);

    const created = await authed.post("/api/_global/users/object", {
      id: "ada",
      username: "ada",
      password: "s3cret",
      role: "user",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.password, undefined);

    const stored = s.node.get("_global", "users", "ada");
    assert.match(stored.password, /^pbkdf2\$sha256\$/);

    const duplicate = await authed.post("/api/_global/users/object", {
      id: "ada-2",
      username: "ada",
      password: "other",
    });
    assert.equal(duplicate.status, 409);

    const duplicateBatch = await authed.post("/api/_global/users/object", [
      { username: "grace", password: "first" },
      { username: "grace", password: "second" },
    ]);
    assert.equal(duplicateBatch.status, 409);

    const session = await api(base, null).post("/api/_global/users/auth", { username: "ada", password: "s3cret" });
    assert.equal(session.status, 200);
    assert.equal(session.body.user.password, undefined);

    const patched = await authed.patch("/api/_global/users/object/ada", { password: "new-secret" });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.password, undefined);
    assert.match(s.node.get("_global", "users", "ada").password, /^pbkdf2\$sha256\$/);

    assert.equal((await api(base, null).post("/api/_global/users/auth", { username: "ada", password: "s3cret" })).status, 401);
    assert.equal((await api(base, null).post("/api/_global/users/auth", { username: "ada", password: "new-secret" })).status, 200);
  } finally {
    s.server.close();
  }
});

test("REST CRUD lifecycle", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const session = await login(`http://localhost:${s.port}`);
    const c = api(`http://localhost:${s.port}`, session.accessToken);
    const base = "/api/app/users/object";

    const ins = await c.post(base, { name: "ada", age: 36 });
    assert.equal(ins.status, 201);
    const id = ins.body.id;

    const got = await c.get(`${base}/${id}`);
    assert.deepEqual(got.body, { id, name: "ada", age: 36 });

    const patched = await c.patch(`${base}/${id}`, { age: 37 });
    assert.equal(patched.body.age, 37);

    const replaced = await c.put(`${base}/${id}`, { name: "ada", active: true });
    assert.deepEqual(replaced.body, { id, name: "ada", active: true });

    const list = await c.get(base);
    assert.equal(list.body.count, 1);

    const del = await c.del(`${base}/${id}`);
    assert.equal(del.status, 204);

    const missing = await c.get(`${base}/${id}`);
    assert.equal(missing.status, 404);

    const nope = await c.get(`${base}/nope`);
    assert.equal(nope.status, 404);
  } finally {
    s.server.close();
  }
});

test("public object interface supports bulk CRUD", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const session = await login(`http://localhost:${s.port}`);
    const c = api(`http://localhost:${s.port}`, session.accessToken);
    const base = "/api/app/events/object";

    const created = await c.post(base, [
      { id: "e1", type: "signup", count: 1 },
      { id: "e2", type: "purchase", count: 2 },
    ]);
    assert.equal(created.status, 201);
    assert.equal(created.body.inserted, 2);

    const q = encodeURIComponent(JSON.stringify({ id: { $in: ["e1", "e2"] } }));
    const listed = await c.get(`${base}?q=${q}&sortBy=id`);
    assert.equal(listed.body.count, 2);
    assert.deepEqual(listed.body.objects.map((item) => item.id), ["e1", "e2"]);

    const patched = await c.patch(base, [
      { id: "e1", count: 10 },
      { id: "e2", extra: true },
    ]);
    assert.equal(patched.status, 200);
    assert.equal(patched.body.updated, 2);
    assert.equal((await c.get(`${base}/e1`)).body.count, 10);
    assert.equal((await c.get(`${base}/e2`)).body.extra, true);

    const replaced = await c.put(base, [
      { id: "e1", done: true },
      { id: "e2", done: false },
    ]);
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.replaced, 2);
    assert.deepEqual((await c.get(`${base}/e1`)).body, { id: "e1", done: true });

    const removed = await c.del(base, { ids: ["e1", "e2", "missing"] });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, 2);
    assert.deepEqual(removed.body.skipped, ["missing"]);
    assert.equal((await c.get(base)).body.count, 0);
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
      { id: "e1", type: "signup", count: 1 },
      { id: "e2", type: "signup", count: 2 },
      { id: "e3", type: "purchase", count: 5 },
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
      meta: { indexes: ["status"], owner: "events-team" },
    });

    await c.post("/api/app/users/object", { id: "u1", name: "Ada" });

    assert.deepEqual((await c.get("/api/databases")).body.databases, ["_global", "app"]);
    assert.deepEqual((await c.get("/api/app/collections")).body.collections, ["orders", "users"]);
    assert.deepEqual((await c.get("/api/app/orders/meta")).body, {
      indexes: ["status"],
      owner: "events-team",
    });
    assert.deepEqual((await c.get("/api/app/users/meta")).body, { indexes: [] });

    await c.post("/api/app/orders/object", { id: "o1", status: "paid" });
    const indexStats = s.node.indexStats("app", "orders");
    assert.equal(indexStats.length, 1);
    assert.equal(indexStats[0].path, "status");
    assert.equal(indexStats[0].entries, 1);

    const removed = await c.del("/api/app/collections/orders");
    assert.equal(removed.status, 204);
    assert.deepEqual((await c.get("/api/app/collections")).body.collections, ["users"]);
    assert.equal((await c.get("/api/app/orders/meta")).status, 404);
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

test("retention + snapshot recovery over HTTP", async () => {
  const { CRDTNode } = await import("../src/crdt.js");
  const a = await startTestServer({ port: 0, node: new CRDTNode({ retainOps: 0 }) });
  const b = await startTestServer({ port: 0 });
  a.node.addPeer(httpPeer(`http://localhost:${b.port}`, a.node.id));
  b.node.addPeer(httpPeer(`http://localhost:${a.port}`, b.node.id));
  try {
    const session = await login(`http://localhost:${a.port}`);
    const ca = api(`http://localhost:${a.port}`, session.accessToken);
    for (let i = 0; i < 20; i++) {
      await ca.post("/api/app/items/object", { id: `i${i}`, v: i });
    }
    await b.node.syncAll();
    assert.equal(b.node.count("app", "items"), 20);
    assert.equal(a.node.trimmed, a.node.seq, "acked log pruned to zero");

    const pull = await fetch(`http://localhost:${a.port}/replicate?after=0`);
    assert.equal(pull.status, 410);

    const fresh = await startTestServer({ port: 0 });
    try {
      fresh.node.addPeer(httpPeer(`http://localhost:${a.port}`, fresh.node.id));
      await fresh.node.syncAll();
      const freshSession = await login(`http://localhost:${fresh.port}`);
      const items = (await api(`http://localhost:${fresh.port}`, freshSession.accessToken).get("/api/app/items/object")).body;
      assert.equal(items.count, 20);
      assert.equal(items.objects[0].v, 0);
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
    assert.match(html, /spread-db console/);
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
    a.node.addPeer(httpPeer(`http://localhost:${b.port}`, a.node.id));
    b.node.addPeer(httpPeer(`http://localhost:${a.port}`, b.node.id));
    const sessionA = await login(`http://localhost:${a.port}`);
    const sessionB = await login(`http://localhost:${b.port}`);
    const ca = api(`http://localhost:${a.port}`, sessionA.accessToken);
    const cb = api(`http://localhost:${b.port}`, sessionB.accessToken);

    const ins = await ca.post("/api/app/items/object", { id: "i1", qty: 5 });
    assert.equal(ins.status, 201);

    await b.node.syncAll();
    const onB = await cb.get("/api/app/items/object/i1");
    assert.equal(onB.status, 200);
    assert.deepEqual(onB.body, { id: "i1", qty: 5 });

    await cb.patch("/api/app/items/object/i1", { qty: 6 });
    await a.node.syncAll();
    const onA = await ca.get("/api/app/items/object/i1");
    assert.equal(onA.body.qty, 6);

    const pull = await fetch(`http://localhost:${a.port}/replicate?after=0`);
    const payload = await pull.json();
    assert.equal(payload.node, a.node.id);
    assert.ok(Array.isArray(payload.ops));
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
    const peerToA = httpPeer(`http://localhost:${a.port}`, b.node.id);
    b.node.addPeer(peerToA);

    const session = await login(`http://localhost:${a.port}`);
    const ca = api(`http://localhost:${a.port}`, session.accessToken);
    for (let i = 0; i < 5; i++) await ca.post("/api/app/items/object", { id: `i${i}`, v: i });

    await b.node.syncAll();
    assert.equal(peerToA.nodeId, "a");
    assert.equal(b.node.lastSeen.get("a"), a.node.seq);
    assert.equal(b.node.count("app", "items"), 5);

    await ca.post("/api/app/items/object", { id: "i5", v: 5 });
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
    const c = api(`http://localhost:${s.port}`);
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
