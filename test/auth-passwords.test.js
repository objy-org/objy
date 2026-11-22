import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { CRDTNode } from "../src/crdt.js";
import { startServer, createObjectHookRegistry, shardMapFromHttp } from "../src/server.js";
import { PersistenceManager } from "../src/persistence.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { FileService } from "../src/files.js";

const { hashPassword, verifyPassword, parsePasswordHash } = createRequire(import.meta.url)("../src/lib/crypto.cjs");
const LEGACY_PASSWORD = "correct horse battery staple";
const LEGACY_HASH = "pbkdf2$sha256$10000$00112233445566778899aabbccddeeff$12692e36cf3996532fc79e05b0a662c0a2e7e257ef8d8eeeb30c31bb30a29747";

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function fixture(t, options = {}) {
  const state = await startServer({
    auth: { jwtSecret: "password-tests", users: [{ _id: "admin", username: "admin", password: "root", admin: true }] },
    environment: {}, bootstrapLogger: null, ...options,
  });
  const base = `http://127.0.0.1:${state.port}`;
  const token = state.auth.issueTokenPair("_global", "users", state.node.get("_global", "users", "admin")).accessToken;
  t.after(async () => {
    await state.replication.stop();
    state.server.closeAllConnections();
    await new Promise((resolve) => state.server.close(resolve));
    state.node.db.dispose();
  });
  const call = async (method, path, body, { stream = false, authenticated = true } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
        "content-type": stream ? "application/x-ndjson" : "application/json", prefer: "return=minimal" },
      ...(body !== undefined ? { body: stream ? body.map((row) => JSON.stringify(row)).join("\n") + "\n" : JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json(), headers: response.headers };
  };
  const login = (username, password) => call("POST", "/api/app/users/auth", { username, password }, { authenticated: false });
  return { ...state, base, token, call, login };
}

test("single, bulk and streamed password writes share the same hashing policy", async (t) => {
  const { node, call, login } = await fixture(t);
  const path = "/api/app/users/object";
  for (const stream of [false, true]) {
    const id = stream ? "stream" : "bulk";
    assert.equal((await call("POST", path, [{ _id: id, username: id, password: "first" }], { stream })).status, 201);
    assert.equal(parsePasswordHash(node.getField("app", "users", id, "password")).iterations, 600000);
    assert.equal((await login(id, "first")).status, 200);
    assert.equal((await call("PUT", path, [{ _id: id, username: id, password: "second" }], { stream })).status, 200);
    assert.equal((await login(id, "first")).status, 401);
    assert.equal((await login(id, "second")).status, 200);
    assert.equal((await call("PATCH", path, [{ _id: id, $set: { password: "third" } }], { stream })).status, 200);
    assert.equal((await login(id, "third")).status, 200);
  }
  assert.equal((await call("POST", path, { _id: "one", username: "one", password: "first" })).status, 201);
  assert.equal((await call("PUT", `${path}/one`, { username: "one", password: "second" })).status, 200);
  assert.equal((await call("PATCH", `${path}/one`, { $set: { password: "third" } })).status, 200);
  const hash = node.getField("app", "users", "one", "password");
  assert.equal((await call("PUT", `${path}/one`, { username: "one", label: "redacted replacement" })).status, 200);
  assert.equal(node.getField("app", "users", "one", "password"), hash);
  const session = await login("one", "third");
  assert.equal(session.status, 200);
  assert.equal(session.body.user.password, undefined);
  assert.equal((await call("PATCH", `${path}/one`, { $unset: ["password"] })).status, 200);
  assert.equal((await login("one", "third")).status, 401);
});

test("public hash-looking passwords cannot supply stored hash parameters", async (t) => {
  const { node, call, login } = await fixture(t);
  const path = "/api/app/users/object";
  assert.equal((await call("POST", path, { _id: "literal", username: "literal", password: LEGACY_HASH })).status, 201);
  const stored = node.getField("app", "users", "literal", "password");
  assert.notEqual(stored, LEGACY_HASH);
  assert.equal(parsePasswordHash(stored).iterations, 600000);
  assert.equal((await login("literal", LEGACY_PASSWORD)).status, 401);
  assert.equal((await login("literal", LEGACY_HASH)).status, 200);
  for (const stream of [false, true]) {
    assert.equal((await call("POST", path, [{ _id: `large-${stream}`, username: "large", password: "x".repeat(1025) }], { stream })).status, 400);
    assert.equal(node.has("app", "users", `large-${stream}`), false);
  }
  assert.equal((await login("literal", "x".repeat(1025))).status, 400);
});

test("legacy upgrade uses durable WAL and S3 writes, preserving user data", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "objy-password-wal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const node = new CRDTNode({ id: "password-node" });
  const storage = new MemoryObjectStorage();
  const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0,
    ack: "localWal", localWal: { mode: "on", dir, fsync: true } });
  persistence.start();
  const { login, auth } = await fixture(t, { node, persistence });
  t.after(() => persistence.stop());
  node.insertManyCount("app", "users", [{ _id: "legacy", username: "legacy", password: LEGACY_HASH, label: "preserved" }]);
  await persistence.afterWrite();
  const before = persistence.localWalDurable;
  assert.equal((await login("legacy", LEGACY_PASSWORD)).status, 200);
  assert.ok(persistence.localWalDurable > before);
  assert.equal(persistence.localWalPending.length, 0);
  const upgraded = node.getField("app", "users", "legacy", "password");
  assert.equal(parsePasswordHash(upgraded).iterations, 600000);
  assert.equal(node.getField("app", "users", "legacy", "label"), "preserved");
  assert.equal((await login("legacy", LEGACY_PASSWORD)).status, 200);
  assert.equal(node.getField("app", "users", "legacy", "password"), upgraded);
  const replica = new CRDTNode({ id: "password-replica" });
  const walRestored = new CRDTNode({ id: node.id });
  const restored = new CRDTNode({ id: "password-restored" });
  try {
    await new PersistenceManager({ node: walRestored, storage: new MemoryObjectStorage(), flushMs: 0, snapshotMs: 0,
      localWal: { mode: "on", dir, fsync: true } }).restore();
    assert.equal(walRestored.getField("app", "users", "legacy", "password"), upgraded);
    replica.applyRemote(node.id, node.log);
    assert.equal(replica.getField("app", "users", "legacy", "password"), upgraded);
    await persistence.flush();
    await new PersistenceManager({ node: restored, storage, flushMs: 0, snapshotMs: 0 }).restore();
    assert.equal(restored.getField("app", "users", "legacy", "password"), upgraded);
    assert.equal(await verifyPassword(LEGACY_PASSWORD, upgraded), true);
    const claims = auth.authenticateRequest({ headers: { authorization: `Bearer ${(await login("legacy", LEGACY_PASSWORD)).body.accessToken}` } });
    assert.equal(claims.ok, true);
  } finally { replica.db.dispose(); walRestored.db.dispose(); restored.db.dispose(); }
});

test("overlapping legacy logins upgrade once without rejecting valid credentials", async (t) => {
  const { node, auth } = await fixture(t);
  node.insertManyCount("app", "users", [{ _id: "legacy", username: "legacy", password: LEGACY_HASH }]);
  const seq = node.seq;
  const results = await Promise.all(Array.from({ length: 4 }, () => auth.login("app", "users", "legacy", LEGACY_PASSWORD)));
  assert.ok(results.every((result) => result?.accessToken));
  assert.equal(node.seq, seq + 1);
});

test("login never grants stale privileges or accepts a concurrently changed password", async (t) => {
  const { node, auth } = await fixture(t);
  const hash = await hashPassword("secret");
  node.insertManyCount("app", "users", [{ _id: "account", username: "account", password: hash, admin: true }]);
  const pending = auth.login("app", "users", "account", "secret");
  await nextTurn();
  node.updateMany("app", "users", [{ _id: "account", admin: false, permissions: [] }]);
  const session = await pending;
  const checked = auth.authenticateRequest({ headers: { authorization: `Bearer ${session.accessToken}` } });
  assert.equal(checked.claims.admin, false);
  const replacement = await hashPassword("different");
  const candidate = { ...node.get("app", "users", "account") };
  const changing = auth.loginFromUsers("app", "users", "account", "secret", [candidate]);
  await nextTurn();
  candidate.password = replacement;
  node.updateMany("app", "users", [{ _id: "account", password: replacement }]);
  assert.equal(await changing, null);
  node.updateMany("app", "users", [{ _id: "account", password: hash }]);
  const revoked = auth.login("app", "users", "account", "secret");
  await nextTurn();
  node.removeMany("app", "users", ["account"]);
  assert.equal(await revoked, null);
  node.insertManyCount("app", "users", [{ _id: "legacy", username: "legacy", password: LEGACY_HASH }]);
  const original = auth.upgradePassword.bind(auth);
  auth.upgradePassword = async (...args) => {
    node.updateMany("app", "users", [{ _id: "legacy", password: hash }]);
    return original(...args);
  };
  assert.equal(await auth.login("app", "users", "legacy", LEGACY_PASSWORD), null);
  assert.equal(node.getField("app", "users", "legacy", "password"), hash);
});

test("password preparation cannot overwrite intervening PATCH changes or create duplicate usernames", async (t) => {
  const { node, auth, call } = await fixture(t);
  const path = "/api/app/users/object";
  await call("POST", path, { _id: "account", username: "account", password: "first" });
  const entered = deferred(), release = deferred();
  const original = auth.hashWritePasswords.bind(auth);
  auth.hashWritePasswords = async (...args) => {
    const result = await original(...args);
    if (args[1]?.patch) { entered.resolve(); await release.promise; }
    return result;
  };
  const pending = call("PATCH", `${path}/account`, { $set: { password: "second" } });
  try {
    await entered.promise;
    node.updateMany("app", "users", [{ _id: "account", label: "concurrent" }]);
  } finally { release.resolve(); }
  assert.equal((await pending).status, 200);
  assert.equal(node.getField("app", "users", "account", "label"), "concurrent");
  auth.hashWritePasswords = original;
  const responses = await Promise.all(["a", "b"].map((_id) => call("POST", path, { _id, username: "same", password: "secret" })));
  assert.deepEqual(responses.map((result) => result.status).sort(), [201, 409]);
  assert.equal(node.count("app", "users", { username: "same" }), 1);
});

test("hook-injected credentials and multipart objects use ordinary password preparation", async (t) => {
  const objectHooks = createObjectHookRegistry().register("credentials", async (context, next) => {
    for (const object of context.input.objects || []) Object.assign(object, { username: "hooked", password: "secret" });
    await next();
  });
  const files = new FileService({ storage: new MemoryObjectStorage(), storageName: "test" });
  const { node, call, base, token } = await fixture(t, { files, objectHooks });
  node.createCollection("app", "hooked", { hooks: { create: ["credentials"] } });
  assert.equal((await call("POST", "/api/app/hooked/object", { _id: "one" })).status, 201);
  assert.equal(await verifyPassword("secret", node.getField("app", "hooked", "one", "password")), true);
  for (const method of ["POST", "PUT"]) {
    const form = new FormData();
    form.append("object", JSON.stringify({ _id: "file", username: "file-user", password: method }));
    form.append("file", new Blob(["test"], { type: "text/plain" }), "test.txt");
    const response = await fetch(`${base}/api/app/files/object${method === "PUT" ? "/file" : ""}`, {
      method, headers: { authorization: `Bearer ${token}` }, body: form,
    });
    assert.equal(response.status, method === "POST" ? 201 : 200, await response.text());
    assert.equal(await verifyPassword(method, node.getField("app", "files", "file", "password")), true);
  }
});

test("login overload is bounded while ordinary reads and writes keep running", async (t) => {
  const { node, auth, call, login } = await fixture(t);
  node.insertManyCount("app", "users", [{ _id: "account", username: "account", password: await hashPassword("secret") }]);
  const objects = Array.from({ length: 10000 }, (_, i) => ({ _id: String(i), payload: "ordinary data" }));
  assert.equal(await auth.hashWritePasswords(objects), objects);
  let completed = 0;
  const pending = Promise.all(Array.from({ length: 40 }, () => login("account", "secret").then((result) => { completed++; return result; })));
  const written = await call("POST", "/api/app/docs/object", objects.slice(0, 10));
  assert.equal(written.status, 201);
  assert.equal((await call("GET", "/api/app/docs/object/0")).status, 200);
  assert.ok(completed < 40, "ordinary operations should finish before the login queue drains");
  const results = await pending;
  assert.ok(results.some((result) => result.status === 200));
  assert.ok(results.some((result) => result.status === 503));
  for (const result of results) {
    assert.ok([200, 503].includes(result.status), JSON.stringify(result.body));
    if (result.status === 503) assert.equal(result.headers.get("retry-after"), "1");
  }
  assert.equal((await login("account", "secret")).status, 200);
});

test("access tokens stay stateless until expiry and renewal reloads the account", async (t) => {
  const { node, auth } = await fixture(t);
  node.insertManyCount("app", "users", [{ _id: "account", username: "account", password: await hashPassword("secret"), admin: true }]);
  const session = await auth.login("app", "users", "account", "secret");
  const request = () => ({ headers: { authorization: `Bearer ${session.accessToken}` } });
  node.updateMany("app", "users", [{ _id: "account", admin: false }]);
  assert.equal(auth.authenticateRequest(request()).claims.admin, true);
  const renewed = auth.renew("app", "users", session.refreshToken);
  assert.equal(auth.authenticateRequest({ headers: { authorization: `Bearer ${renewed.accessToken}` } }).claims.admin, false);
  node.removeMany("app", "users", ["account"]);
  assert.equal(auth.authenticateRequest(request()).ok, true);
  assert.throws(() => auth.renew("app", "users", session.refreshToken), (error) => error.status === 401);
});

test("streamed credentials are hashed once on their shard owner through any ingress", async (t) => {
  const a = await fixture(t, { node: new CRDTNode({ id: "a" }), clusterSecret: "password-cluster" });
  const b = await fixture(t, { node: new CRDTNode({ id: "b" }), clusterSecret: "password-cluster" });
  const states = [a, b];
  for (const state of states) state.node.url = state.base;
  const map = { shards: Object.fromEntries(states.map((state) => [state.node.id, {
    peers: [{ nodeId: state.node.id, url: state.base }],
  }])) };
  for (const state of states) {
    state.node.replaceShardMap(shardMapFromHttp(map, state.node.id, { secret: "password-cluster" }));
    state.node.createCollection("app", "users");
  }
  const users = states.map((state) => {
    let n = 0;
    while (a.node.shardForObject("app", "users", `${state.node.id}-${n}`) !== state.node.id) n++;
    return { _id: `${state.node.id}-${n}`, username: state.node.id, password: "first" };
  });
  const path = "/api/app/users/object";
  assert.equal((await a.call("POST", path, users, { stream: true })).status, 201);
  assert.equal((await b.call("PUT", path, users.map((user) => ({ ...user, password: "second" })), { stream: true })).status, 200);
  assert.equal((await a.call("PATCH", path, users.map((user) => ({ _id: user._id, $set: { password: "third" } })), { stream: true })).status, 200);
  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const hash = states[i].node.getField("app", "users", user._id, "password");
    assert.equal(await verifyPassword("third", hash), true);
    assert.equal(states[1 - i].node.has("app", "users", user._id), false);
    for (const state of states) assert.equal((await state.login(user.username, "third")).status, 200);
  }
});
