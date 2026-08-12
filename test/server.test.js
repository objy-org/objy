import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, httpPeer } from "../src/server.js";
import { CRDTNode } from "../src/crdt.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";
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

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startRoutedTwoShardCluster() {
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
  });
  const b = await startTestServer({
    port: portB,
    node: new CRDTNode({ id: "route-b", url: urlB }),
    shardMap,
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

function idForShard(node, database, collection, shard, prefix) {
  for (let i = 0; i < 10_000; i++) {
    const id = `${prefix}-${i}`;
    if (node.shardForObject(database, collection, id) === shard) return id;
  }
  throw new Error(`could not find id for shard ${shard}`);
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
    const config = await authed.get("/api/config");
    assert.equal(config.status, 200);
    assert.deepEqual(config.body.shards.map((shard) => shard.name), ["default"]);
    assert.ok(config.body.nodes[0].memory.rss > 0);

    const renewed = await anonymous.post("/api/_global/users/renew", { refreshToken: session.body.refreshToken });
    assert.equal(renewed.status, 200);
    assert.equal(typeof renewed.body.accessToken, "string");
    assert.equal(typeof renewed.body.refreshToken, "string");
    assert.equal(renewed.body.user.password, undefined);
  } finally {
    s.server.close();
  }
});

test("api config reports cluster shards peers and node RSS", async () => {
  const { a, b, urlA } = await startRoutedTwoShardCluster();
  try {
    const anonymous = api(urlA, null);
    assert.equal((await anonymous.get("/api/config")).status, 401);

    const session = await login(urlA);
    const authed = api(urlA, session.accessToken);
    const status = await authed.get("/api/config");

    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.body.ok, true);
    assert.equal(status.body.node.id, "route-a");
    assert.deepEqual(status.body.shards.map((shard) => shard.name), ["shard-a", "shard-b"]);
    assert.equal(status.body.peers.length, 2);

    const local = status.body.nodes.find((nodeStatus) => nodeStatus.node.id === "route-a");
    const remote = status.body.nodes.find((nodeStatus) => nodeStatus.node.id === "route-b");
    assert.equal(local.local, true);
    assert.equal(remote.reachable, true);
    assert.ok(local.memory.rss > 0);
    assert.ok(remote.memory.rss > 0);
    assert.deepEqual(local.ownedShards, ["shard-a"]);
    assert.deepEqual(remote.ownedShards, ["shard-b"]);
    assert.equal(local.indexes.status, "ready");
    assert.equal(local.indexes.workers.columnIndex.type, "worker_thread");
    assert.equal(local.indexes.workers.vectorIndex.type, "same_thread_task");
    assert.equal(Number.isInteger(local.indexes.workers.columnIndex.active), true);
    assert.equal(Number.isInteger(local.indexes.workers.vectorIndex.active), true);
    assert.ok(local.indexes.collections.some((entry) => (
      entry.database === "_global" &&
      entry.collection === "users" &&
      entry.fieldIndexes.some((index) => index.path === "username" && index.status === "ready")
    )));
    assert.equal(status.body.shards.find((shard) => shard.name === "shard-b").peers[0].online, true);
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
      id: remoteUserId,
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
    assert.equal(session.body.user.id, remoteUserId);
    assert.equal(session.body.user.password, undefined);

    const renewed = await api(urlA, null).post(`/api/${db}/${coll}/renew`, {
      refreshToken: session.body.refreshToken,
    });
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    assert.equal(renewed.body.user.id, remoteUserId);
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
        id: remoteAdminId,
        username: "owner",
        password: "owner-secret",
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.name, db);
    assert.equal(created.body.created, true);
    assert.equal(created.body.adminUser.collection, coll);
    assert.equal(created.body.adminUser.user.id, remoteAdminId);
    assert.equal(created.body.adminUser.user.username, "owner");
    assert.equal(created.body.adminUser.user.admin, true);
    assert.equal(created.body.adminUser.user.password, undefined);

    assert.deepEqual(a.node.getCollectionMeta(db, coll), { indexes: ["username"], columnIndexes: [] });
    assert.deepEqual(b.node.getCollectionMeta(db, coll), { indexes: ["username"], columnIndexes: [] });
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
    assert.deepEqual(list.body.map((item) => item.id), [id]);

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
    assert.deepEqual(listed.body.map((item) => item.id), ["e1", "e2"]);

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
    assert.deepEqual((await c.get(base)).body, []);
  } finally {
    s.server.close();
  }
});

test("public bulk object routes reject duplicate ids", async () => {
  const s = await startTestServer({ port: 0 });
  try {
    const session = await login(`http://localhost:${s.port}`);
    const c = api(`http://localhost:${s.port}`, session.accessToken);
    const base = "/api/app/events/object";

    const duplicatePost = await c.post(base, [
      { id: "e1", value: 1 },
      { id: "e1", value: 2 },
    ]);
    assert.equal(duplicatePost.status, 400);
    assert.match(duplicatePost.body.error, /duplicate id in bulk request: e1/);

    assert.equal((await c.post(base, { id: "e1", value: 1 })).status, 201);

    const duplicatePatch = await c.patch(base, [
      { id: "e1", value: 2 },
      { id: "e1", other: true },
    ]);
    assert.equal(duplicatePatch.status, 400);
    assert.match(duplicatePatch.body.error, /duplicate id in bulk request: e1/);

    const duplicatePut = await c.put(base, [
      { id: "e1", value: 3 },
      { id: "e1", value: 4 },
    ]);
    assert.equal(duplicatePut.status, 400);
    assert.match(duplicatePut.body.error, /duplicate id in bulk request: e1/);

    const duplicateDelete = await c.del(base, { ids: ["e1", "e1"] });
    assert.equal(duplicateDelete.status, 400);
    assert.match(duplicateDelete.body.error, /duplicate id in bulk request: e1/);
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
      { id: "e1", value: 1 },
      { id: "e2", value: 2 },
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
    assert.deepEqual(fresh.get("app", "events", "e1"), { id: "e1", value: 1 });
    assert.deepEqual(fresh.get("app", "events", "e2"), { id: "e2", value: 2 });
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
      { id: localId, side: "a", value: 1 },
      { id: remoteId, side: "b", value: 2 },
    ]);
    assert.equal(created.status, 201);
    assert.equal(created.body.inserted, 2);
    assert.deepEqual(a.node.get(db, coll, localId), { id: localId, side: "a", value: 1 });
    assert.equal(a.node.get(db, coll, remoteId), undefined);
    assert.deepEqual(b.node.get(db, coll, remoteId), { id: remoteId, side: "b", value: 2 });

    const remoteRead = await c.get(`${base}/${remoteId}`);
    assert.equal(remoteRead.status, 200);
    assert.deepEqual(remoteRead.body, { id: remoteId, side: "b", value: 2 });

    const patched = await c.patch(`${base}/${remoteId}`, { value: 3 });
    assert.equal(patched.status, 200);
    assert.equal(b.node.get(db, coll, remoteId).value, 3);
    assert.equal(a.node.get(db, coll, remoteId), undefined);

    const replaced = await c.put(`${base}/${remoteId}`, { side: "b2", value: 4 });
    assert.equal(replaced.status, 200);
    assert.deepEqual(b.node.get(db, coll, remoteId), { id: remoteId, side: "b2", value: 4 });

    const removed = await c.del(`${base}/${remoteId}`);
    assert.equal(removed.status, 204);
    assert.equal(b.node.get(db, coll, remoteId), undefined);
    assert.deepEqual(a.node.get(db, coll, localId), { id: localId, side: "a", value: 1 });
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

    const author = await c.post(authorBase, { id: authorId, name: "Alice", score: 10 });
    assert.equal(author.status, 201);
    assert.equal(a.node.get(db, authorColl, authorId), undefined);
    assert.equal(b.node.get(db, authorColl, authorId).name, "Alice");

    const created = await c.post(postBase, {
      id: postId,
      title: "Reference post",
      author: {
        type: "reference",
        database: db,
        collection: authorColl,
        value: authorId,
        object: { id: authorId, name: "stale payload should not be stored" },
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
    assert.deepEqual(alice.body.map((post) => post.id), [postId]);

    const patched = await c.patch(`${authorBase}/${authorId}`, { name: "Ada" });
    assert.equal(patched.status, 200);
    const qAda = encodeURIComponent(JSON.stringify({ "author.object.name": "Ada" }));
    const ada = await c.get(`${postBase}?q=${qAda}`);
    assert.deepEqual(ada.body.map((post) => post.id), [postId]);

    const missingBeforeDelete = await c.get(`${postBase}?q=${encodeURIComponent(JSON.stringify({ "author.object": null }))}`);
    assert.deepEqual(missingBeforeDelete.body, []);

    assert.equal((await c.del(`${authorBase}/${authorId}`)).status, 204);
    const missing = await c.get(`${postBase}?q=${encodeURIComponent(JSON.stringify({ "author.object": null }))}`);
    assert.deepEqual(missing.body.map((post) => post.id), [postId]);
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
    const generatedShard = a.node.shardForObject(db, coll, generated.body.id);
    const generatedOwner = generatedShard === "shard-a" ? a.node : b.node;
    assert.deepEqual(generatedOwner.get(db, coll, generated.body.id), generated.body);

    const created = await c.post(base, [
      { id: idA, side: "a", value: 10 },
      { id: idB, side: "b", value: 20 },
    ]);
    assert.equal(created.status, 201);
    assert.equal(created.body.inserted, 2);
    assert.equal(a.node.get(db, coll, idA).value, 10);
    assert.equal(b.node.get(db, coll, idB).value, 20);
    assert.equal(a.node.get(db, coll, idB), undefined);
    assert.equal(b.node.get(db, coll, idA), undefined);

    const patched = await c.patch(base, [
      { id: idA, value: 11 },
      { id: idB, value: 21 },
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
      { id: idA, side: "a2", value: 100 },
      { id: idB, side: "b2", value: 200 },
    ]);
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.replaced, 2);
    assert.deepEqual(a.node.get(db, coll, idA), { id: idA, side: "a2", value: 100 });
    assert.deepEqual(b.node.get(db, coll, idB), { id: idB, side: "b2", value: 200 });

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
      { id: idA, value: 1 },
      { id: idB, value: 2 },
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
      { id: idA1, bucket: "local-a", value: 1 },
      { id: idB, bucket: "local-b", value: 2 },
      { id: idC, bucket: "remote-c", value: 3 },
      { id: idA2, bucket: "local-a", value: 4 },
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
    assert.deepEqual(b.node.getCollectionMeta(db, coll), { indexes: ["value"], columnIndexes: [] });

    await c.post(base, { id: idB, value: 3 });
    assert.equal(b.node.indexStats(db, coll)[0].orderedEntries, 1);

    const updated = await c.put(`/api/${db}/${coll}/meta`, { indexes: ["value", "id"] });
    assert.equal(updated.status, 200);
    assert.deepEqual(b.node.getCollectionMeta(db, coll), { indexes: ["value", "id"], columnIndexes: [] });

    const removed = await c.del(`/api/${db}/collections/${coll}`);
    assert.equal(removed.status, 204);
    assert.equal(b.node.getCollectionMeta(db, coll), null);
  } finally {
    a.server.close();
    b.server.close();
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
      columnIndexes: ["score"],
    });
    assert.equal(createdCollection.status, 201);
    assert.equal((await c.post(base, [
      { id: "a", status: "active", score: 1 },
      { id: "b", status: "active", score: 2 },
      { id: "c", status: "archived", score: 3 },
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
      columnIndexes: ["status", "score"],
    });
    assert.equal(createdCollection.status, 201);

    const idA1 = idForShard(a.node, db, coll, "shard-a", "a1");
    const idA2 = idForShard(a.node, db, coll, "shard-a", "a2");
    const idB1 = idForShard(a.node, db, coll, "shard-b", "b1");
    const idB2 = idForShard(a.node, db, coll, "shard-b", "b2");

    assert.equal((await c.post(base, [
      { id: idA1, status: "new", score: 1 },
      { id: idA2, status: "done", score: 10 },
      { id: idB1, status: "new", score: 2 },
      { id: idB2, status: "done", score: 20 },
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
    assert.equal(result.headers.get("x-spread-db-query-path"), "aggregate-group-index");
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
      { id: "near", title: "near", status: "active", rank: 2, _vec: [1, 0, 0] },
      { id: "mid", title: "mid", status: "active", rank: 1, _vec: [0.8, 0.2, 0] },
      { id: "far", title: "far", status: "archived", rank: 3, _vec: [0, 1, 0] },
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
    await s.node.awaitVectorIndexes();
    s.node.vectorWarmupEnabled = false;
    s.node.db.clearVectorIndexes();
    const warming = await c.get(`${base}?q=${q}`);
    assert.equal(warming.status, 503, JSON.stringify(warming.body));
    assert.match(warming.body.error, /vector index warming/);
    await s.node.awaitVectorIndexes();

    const getSearch = await c.get(`${base}?q=${q}`);
    assert.equal(getSearch.status, 200, JSON.stringify(getSearch.body));
    assert.deepEqual(getSearch.body.map((row) => row.id), ["near", "mid"]);
    assert.equal(getSearch.body.every((row) => typeof row._score === "number" && row._vec === undefined), true);

    const bodySearch = await c.post("/api/app/docs/search", {
      $vector: { vector: [1, 0, 0], limit: 3 },
      $sort: { rank: -1 },
    });
    assert.equal(bodySearch.status, 200, JSON.stringify(bodySearch.body));
    assert.deepEqual(bodySearch.body.map((row) => row.id), ["far", "near", "mid"]);

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
      { id: idA, side: "a", _vec: [1, 0] },
      { id: idB, side: "b", _vec: [0, 1] },
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
    assert.deepEqual(searched.body.map((row) => row.id), [idB, idA]);
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
      meta: { indexes: ["status"], columnIndexes: [], owner: "events-team" },
    });

    await c.post("/api/app/users/object", { id: "u1", name: "Ada" });

    assert.deepEqual((await c.get("/api/databases")).body.databases, ["_global", "app"]);
    assert.deepEqual((await c.get("/api/app/collections")).body.collections, ["orders", "users"]);
    assert.deepEqual((await c.get("/api/app/orders/meta")).body, {
      indexes: ["status"],
      columnIndexes: [],
      owner: "events-team",
    });
    assert.deepEqual((await c.get("/api/app/users/meta")).body, { indexes: [], columnIndexes: [] });

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
    assert.match(html, /spread-db console/);

    const docs = await fetch(`http://localhost:${s.port}/API.md`);
    assert.equal(docs.status, 200);
    assert.match(docs.headers.get("content-type"), /text\/markdown/);
    assert.match(await docs.text(), /# spread-db API/);
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
