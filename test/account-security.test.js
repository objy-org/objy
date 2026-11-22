import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, createObjectHookRegistry, shardMapFromHttp } from "../src/server.js";
import { accountAuthority, assertAccountWriteAllowed } from "../src/permissions.js";
import { CRDTNode } from "../src/crdt.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { FileService } from "../src/files.js";
import { PersistenceManager } from "../src/persistence.js";
import { nodeCompression } from "../src/node-runtime.js";

const HASH = "pbkdf2$sha256$10000$00112233445566778899aabbccddeeff$12692e36cf3996532fc79e05b0a662c0a2e7e257ef8d8eeeb30c31bb30a29747";
const GRANTS = [
  { admin: true }, { role: "admin" }, { role: "editor" },
  { permissions: [{ query: {}, perm: "crud" }] },
  { collectionPermissions: { write: ["docs"] } }, { tokenVersion: 1 },
];

async function fixture(t, options = {}) {
  const state = await startServer({
    port: { host: "127.0.0.1", port: 0 },
    auth: { jwtSecret: "account-security", users: [{ _id: "admin", username: "admin", password: "root", admin: true }] },
    environment: {}, bootstrapLogger: null, ...options,
  });
  const base = `http://127.0.0.1:${state.port}`;
  state.node.url = base;
  for (const collection of ["accounts", "docs", "elsewhere"]) state.node.createCollection("app", collection, { indexes: ["username"] });
  const writer = { _id: "writer", username: "writer", password: HASH, permissions: [{ query: {}, perm: "crud" }] };
  state.node.insertManyCount("app", "accounts", [writer,
    { _id: "other", username: "other", password: HASH },
    { _id: "boss", username: "boss", password: HASH, admin: true },
  ]);
  const token = (database, collection, user) => state.auth.issueTokenPair(database, collection, user).accessToken;
  const writerToken = token("app", "accounts", writer);
  const rootToken = token("_global", "users", state.node.get("_global", "users", "admin"));
  t.after(async () => {
    await state.replication.stop();
    state.server.closeAllConnections();
    await new Promise((resolve) => state.server.close(resolve));
    await options.persistence?.stop();
    state.node.db.dispose();
  });
  const call = async (method, path, body, { stream = false, root = false, accessToken } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${accessToken || (root ? rootToken : writerToken)}`,
        "content-type": stream ? "application/x-ndjson" : "application/json", prefer: "return=minimal" },
      ...(body !== undefined ? { body: stream ? body.map((row) => JSON.stringify(row)).join("\n") + "\n" : JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  return { ...state, base, call, token, writer, writerToken, rootToken };
}

test("account authority has one shared definition and preserves ordinary business fields", () => {
  const actor = { sub: "me", database: "db", collection: "users", admin: false };
  const account = { username: "me", password: HASH };
  assert.deepEqual(accountAuthority((field) => account[field]), accountAuthority(account));
  for (const grant of GRANTS) {
    assert.throws(() => assertAccountWriteAllowed(actor, "db", "users", "me", null, { ...account, ...grant }), (error) => error.status === 403);
    assert.doesNotThrow(() => assertAccountWriteAllowed(actor, "db", "assets", "asset", null, { ...grant }));
    assert.doesNotThrow(() => assertAccountWriteAllowed({ ...actor, admin: true }, "db", "users", "me", null, { ...account, ...grant }));
    assert.throws(() => assertAccountWriteAllowed({ ...actor, admin: true, database: "other" }, "db", "users", "me", null, { ...account, ...grant }), (error) => error.status === 403);
  }
  assert.doesNotThrow(() => assertAccountWriteAllowed(null, "db", "users", "me", null, { ...account, admin: true }));
  for (const foreign of [{ ...actor, database: "other" }, { ...actor, collection: "other" }]) {
    assert.throws(() => assertAccountWriteAllowed(foreign, "db", "users", "me", (field) => account[field],
      { ...account, password: "changed" }), (error) => error.status === 403);
  }
});

test("collection writers cannot create privileged users in any public write format", async (t) => {
  const { node, call } = await fixture(t);
  for (const variant of ["single", "bulk", "stream"]) {
    for (let i = 0; i < GRANTS.length; i++) {
      const user = { _id: `${variant}-${i}`, username: `${variant}-${i}`, password: "secret", ...GRANTS[i] };
      const result = await call("POST", "/api/app/docs/object", variant === "single" ? user : [user], { stream: variant === "stream" });
      assert.equal(result.status, 403, JSON.stringify(result));
      assert.equal(node.has("app", "docs", user._id), false);
    }
  }
  assert.equal((await call("POST", "/api/app/docs/object", { _id: "plain", username: "plain", password: "secret" })).status, 201);
  const session = await call("POST", "/api/app/docs/auth", { username: "plain", password: "secret" });
  assert.equal(session.status, 200);
  assert.equal((await call("PUT", "/api/app/docs/meta", {}, { accessToken: session.body.accessToken })).status, 403);
});

test("full replacements and patches cannot alter account authority, including removals", async (t) => {
  const { node, call } = await fixture(t);
  const path = "/api/app/accounts/object";
  for (const grant of GRANTS) {
    const changed = grant.permissions ? { permissions: [{ query: {}, perm: "r" }] } : grant;
    for (const [method, body] of [["PUT", { _id: "writer", username: "writer", ...changed }],
      ["PATCH", { _id: "writer", $set: changed }]]) {
      assert.equal((await call(method, path, [body])).status, 403);
      assert.equal((await call(method, path, [body], { stream: true })).status, 403);
    }
  }
  assert.equal((await call("PATCH", `${path}/writer`, { $unset: ["permissions"] })).status, 403);
  assert.equal((await call("PUT", `${path}/writer`, { username: "writer" })).status, 403);
  assert.equal((await call("PATCH", `${path}/writer`, { $set: { label: "profile edit" } })).status, 200);
  const current = node.get("app", "accounts", "writer");
  const { password, ...redacted } = current;
  assert.equal((await call("PUT", `${path}/writer`, { ...redacted, label: "replacement" })).status, 200);
  assert.equal(node.getField("app", "accounts", "writer", "password"), password);
});

test("dormant privilege fields cannot be activated later or hidden by deactivation", async (t) => {
  const { node, call } = await fixture(t);
  const path = "/api/app/docs/object";
  assert.equal((await call("POST", path, { _id: "dormant", role: "admin", admin: true })).status, 201);
  assert.equal((await call("PATCH", `${path}/dormant`, { $set: { username: "dormant", password: "secret" } })).status, 403);
  assert.equal(node.getField("app", "docs", "dormant", "password"), undefined);
  node.insertManyCount("app", "docs", [{ _id: "password-only", password: HASH, admin: true }]);
  assert.equal((await call("PATCH", `${path}/password-only`, { $set: { username: "activate" } })).status, 403);
  assert.equal((await call("PATCH", "/api/app/accounts/object/writer", {
    $unset: ["username", "password"], $set: { admin: true },
  })).status, 403);
  const sameId = { _id: "writer", username: "elsewhere", password: HASH };
  node.insertManyCount("app", "elsewhere", [sameId]);
  assert.equal((await call("PATCH", "/api/app/elsewhere/object/writer", { $set: { password: "takeover" } })).status, 403);
});

test("credentials and deletion require account ownership as well as CRUD permission", async (t) => {
  const { node, call, token, writer } = await fixture(t);
  const path = "/api/app/accounts/object";
  for (const variant of ["single", "bulk", "stream"]) {
    const stream = variant === "stream";
    const destination = variant === "single" ? `${path}/other` : path;
    const patch = { _id: "other", $set: { password: "takeover" } };
    const replacement = { _id: "other", username: "other", password: "takeover" };
    assert.equal((await call("PATCH", destination, variant === "single" ? { $set: patch.$set } : [patch], { stream })).status, 403);
    assert.equal((await call("PUT", destination, variant === "single" ? replacement : [replacement], { stream })).status, 403);
    assert.equal((await call("DELETE", destination, variant === "single" ? undefined : ["other"], { stream })).status, 403);
  }
  assert.equal(node.getField("app", "accounts", "other", "password"), HASH);
  assert.equal((await call("PATCH", `${path}/other`, { $set: { username: "renamed" } })).status, 403);
  assert.equal((await call("PATCH", `${path}/other`, { $unset: ["password"] })).status, 403);
  const readOnly = token("app", "accounts", { ...writer, permissions: [{ query: {}, perm: "r" }] });
  assert.equal((await call("PATCH", `${path}/writer`, { $set: { password: "own" } }, { accessToken: readOnly })).status, 403);
  assert.equal((await call("DELETE", `${path}/writer`, undefined, { accessToken: readOnly })).status, 403);
  assert.equal((await call("PATCH", `${path}/writer`, { $set: { username: "renamed-self", password: "own" } })).status, 200);
  assert.equal((await call("DELETE", `${path}/writer`)).status, 204);
});

test("local batches reject unauthorized members before mutation and streams retain partial counts", async (t) => {
  const { node, call } = await fixture(t, { imports: { maxBulkObjects: 2 } });
  const path = "/api/app/accounts/object";
  node.insertManyCount("app", "accounts", [{ _id: "doc", label: "before" }]);
  assert.equal((await call("PATCH", path, [
    { _id: "doc", $set: { label: "after" } }, { _id: "writer", $set: { admin: true } },
  ])).status, 403);
  assert.equal(node.getField("app", "accounts", "doc", "label"), "before");
  assert.equal((await call("DELETE", path, ["doc", "other"])).status, 403);
  assert.equal(node.has("app", "accounts", "doc"), true);
  const streamed = await call("POST", path, [{ _id: "one" }, { _id: "two" },
    { _id: "blocked", username: "blocked", password: "secret", admin: true }], { stream: true });
  assert.equal(streamed.status, 403);
  assert.equal(streamed.body.inserted, 2);
  assert.equal(node.has("app", "accounts", "blocked"), false);
});

test("hooks and file-backed writes cannot bypass account authorization", async (t) => {
  const hooks = createObjectHookRegistry().register("escalate", async (context, next) => {
    for (const object of context.input.objects) Object.assign(object, { username: "hooked", password: "secret", admin: true });
    await next();
  });
  const storage = new MemoryObjectStorage();
  const { node, base, writerToken, call } = await fixture(t, { objectHooks: hooks, files: new FileService({ storage }) });
  node.setCollectionMeta("app", "docs", { hooks: { create: ["escalate"] } });
  assert.equal((await call("POST", "/api/app/docs/object", { _id: "hooked" })).status, 403);
  for (const method of ["POST", "PUT"]) {
    const form = new FormData();
    const id = method === "POST" ? "file-admin" : "other";
    form.append("object", JSON.stringify({ _id: id, username: id, password: "takeover", ...(method === "POST" ? { admin: true } : {}) }));
    form.append("file", new Blob(["test"], { type: "text/plain" }), "test.txt");
    const response = await fetch(`${base}/api/app/accounts/object${method === "PUT" ? "/other" : ""}`, {
      method, headers: { authorization: `Bearer ${writerToken}` }, body: form,
    });
    assert.equal(response.status, 403, await response.text());
  }
  assert.equal(storage.objects.size, 0);
});

test("writes waiting for capacity recheck account state on commit", async (t) => {
  const { node, auth, call } = await fixture(t);
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    node.replaceManyCount("app", "docs", [{ _id: "queued", label: "ordinary" }]);
    let entered, release;
    const waiting = new Promise((resolve) => { entered = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    const original = auth.durability.withCapacity;
    auth.durability.withCapacity = async (apply) => { entered(); await blocked; return apply(true); };
    const body = method === "PUT" ? { _id: "queued", label: "replace" }
      : method === "PATCH" ? { $set: { admin: true } } : undefined;
    const pending = call(method, "/api/app/docs/object/queued", body);
    try {
      await waiting;
      node.replaceManyCount("app", "docs", [{ _id: "queued", username: "protected", password: HASH }]);
    } finally { release(); }
    assert.equal((await pending).status, 403);
    assert.equal(node.getField("app", "docs", "queued", "username"), "protected");
    auth.durability.withCapacity = original;
  }
});

test("authorized account grants survive replication and persistence without public checks", async (t) => {
  const node = new CRDTNode({ id: "account-source" });
  const storage = new MemoryObjectStorage();
  const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0 });
  persistence.start();
  const { call, token } = await fixture(t, { node, persistence });
  const result = await call("POST", "/api/app/docs/object", { _id: "new-admin", username: "new-admin", password: "secret", role: "admin" }, { root: true });
  assert.equal(result.status, 201);
  const admin = node.get("app", "docs", "new-admin");
  const accessToken = token("app", "docs", admin);
  assert.equal((await call("PATCH", "/api/app/accounts/object/other", { $set: { permissions: [{ query: {}, perm: "r" }] } }, { accessToken })).status, 200);
  assert.equal((await call("POST", "/api/databases", { name: "blocked" }, { accessToken })).status, 403);
  assert.equal((await call("PATCH", "/api/_global/users/object/admin", { $set: { admin: false } }, { root: true })).status, 403);
  const replica = new CRDTNode({ id: "replica" }), restored = new CRDTNode({ id: "restored" });
  try {
    replica.applyRemote(node.id, node.log);
    await persistence.flush();
    await new PersistenceManager({ node: restored, storage, flushMs: 0, snapshotMs: 0 }).restore();
    for (const copy of [replica, restored]) assert.deepEqual(copy.get("app", "docs", "new-admin"), admin);
  } finally { replica.db.dispose(); restored.db.dispose(); }
});

test("handling shard enforces account policy for forwarded JSON and NDJSON writes", async (t) => {
  const states = [];
  for (const id of ["a", "b"]) states.push(await fixture(t, { node: new CRDTNode({ id }), clusterSecret: "account-cluster" }));
  const map = { shards: Object.fromEntries(states.map((state) => [state.node.id, { peers: [{ nodeId: state.node.id, url: state.base }] }])) };
  for (const state of states) state.node.replaceShardMap(shardMapFromHttp(map, state.node.id, { secret: "account-cluster" }));
  let n = 0;
  while (states[0].node.shardForObject("app", "docs", `remote-${n}`) !== "b") n++;
  const _id = `remote-${n}`;
  for (const stream of [false, true]) {
    const result = await states[0].call("POST", "/api/app/docs/object", [{ _id, username: "remote", password: "secret", admin: true }], { stream });
    assert.equal(result.status, 403, JSON.stringify(result));
    assert.equal(states[1].node.has("app", "docs", _id), false);
  }
  states[1].node.insertManyCount("app", "docs", [{ _id, username: "remote", password: HASH }]);
  for (const stream of [false, true]) {
    assert.equal((await states[0].call("PATCH", "/api/app/docs/object", [{ _id, $set: { admin: true } }], { stream })).status, 403);
    assert.equal((await states[0].call("DELETE", "/api/app/docs/object", [_id], { stream })).status, 403);
  }
});

test("account field checks preserve compressed account behavior", async (t) => {
  const node = new CRDTNode({ storage: { compression: nodeCompression } });
  const { call, writer, token } = await fixture(t, { node });
  node.setCollectionMeta("app", "accounts", { tiering: { mode: "compressedMemory", keep: ["label"], minBytes: 1 } });
  node.replaceManyCount("app", "accounts", [{ ...writer, payload: "cold data ".repeat(1000) }]);
  const accessToken = token("app", "accounts", writer);
  assert.equal((await call("PATCH", "/api/app/accounts/object/writer", { $set: { admin: true } }, { accessToken })).status, 403);
  assert.equal((await call("PATCH", "/api/app/accounts/object/writer", { $set: { label: "allowed" } }, { accessToken })).status, 200);
});

test(`account authorization reads indexed and column-backed fields`, async (t) => {
  const node = new CRDTNode({ storage: { compression: nodeCompression } });
  const { call, writer } = await fixture(t, { node });
  node.setCollectionMeta("app", "accounts", { indexes: ["username", "role"],
    columns: ["admin", "permissions", "password", "tokenVersion"] });
  await node.awaitIndexes("app", "accounts");
  assert.equal((await call("PATCH", "/api/app/accounts/object/boss", { $set: { admin: false } })).status, 403);
  assert.equal((await call("PATCH", "/api/app/accounts/object/writer", { $set: { permissions: [] } })).status, 403);
  const { password: _password, ...redacted } = writer;
  assert.equal((await call("PUT", "/api/app/accounts/object/writer", { ...redacted, label: "profile" })).status, 200);
  assert.equal(node.getField("app", "accounts", "writer", "password"), HASH);
});
