import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { CRDTNode } from "../src/crdt.js";
import { createObjectHookRegistry, createObjectHookRunner, normalizeObjectHooksMeta } from "../src/object-hooks.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";
import { startServer } from "../src/server.js";

const AUTH = {
  jwtSecret: "hook-test-secret",
  users: [{ _id: "admin", username: "admin", password: "123", role: "admin", admin: true }],
};

test("hook registry resolves common and operation hooks in order and honors collection switches", async () => {
  const calls = [];
  const registry = createObjectHookRegistry()
    .register("common", async (context, next) => {
      assert.ok(Object.isFrozen(context.principal));
      assert.ok(Object.isFrozen(context.principal.permissions));
      assert.ok(Object.isFrozen(context.principal.permissions[0]));
      calls.push(`common:${context.operation}:before`);
      await next();
      calls.push(`common:${context.operation}:after`);
    })
    .register("create-only", {
      operations: ["create"],
      handler: async (context, next) => {
        calls.push("create:before");
        await next();
        calls.push("create:after");
      },
    });
  const node = new CRDTNode({ id: "hooks" });
  node.createCollection("app", "items", {
    hooks: { enabled: true, use: ["common"], create: ["create-only"] },
  });
  const runner = createObjectHookRunner(node, registry);

  const result = await runner.run({
    operation: "create",
    variant: "bulk",
    database: "app",
    collection: "items",
    input: { objects: [{ _id: "a" }, { _id: "b" }] },
    principal: { id: "user-1", permissions: [{ action: "read" }] },
  }, async (input, context) => {
    assert.equal(context.count, 2);
    return { inserted: input.objects.length };
  });

  assert.deepEqual(result, { inserted: 2 });
  assert.deepEqual(calls, ["common:create:before", "create:before", "create:after", "common:create:after"]);

  node.setCollectionMeta("app", "items", {
    hooks: { enabled: false, use: ["common"], create: ["create-only"] },
  });
  calls.length = 0;
  await runner.run({
    operation: "create",
    variant: "single",
    database: "app",
    collection: "items",
    input: { objects: [{ _id: "c" }] },
  }, async () => ({ inserted: 1 }));
  assert.deepEqual(calls, []);
  runner.dispose();
});

test("hook metadata and middleware contract fail closed", async () => {
  assert.deepEqual(normalizeObjectHooksMeta({ use: ["audit"] }), { enabled: true, use: ["audit"] });
  assert.throws(() => normalizeObjectHooksMeta({ enabled: "yes" }), /must be a boolean/);
  assert.throws(() => normalizeObjectHooksMeta({ all: ["audit"] }), /is not supported/);

  const registry = createObjectHookRegistry().register("broken", async () => {});
  const node = new CRDTNode({ id: "broken" });
  node.createCollection("app", "items", { hooks: { use: ["broken"] } });
  const runner = createObjectHookRunner(node, registry);
  await assert.rejects(runner.run({
    operation: "read",
    variant: "query",
    database: "app",
    collection: "items",
    input: { query: {} },
  }, async () => []), (err) => err.status === 500 && /must call next/.test(err.message));
  assert.deepEqual(runner.validateMeta({ hooks: { enabled: false, use: ["missing"] } }), {
    enabled: false,
    use: ["missing"],
  });
  assert.throws(() => runner.validateMeta({ hooks: { use: ["missing"] } }), /not registered/);
  runner.dispose();
});

test("public hooks cover CRUD, bulk, bounded streams and live metadata changes", async (t) => {
  const calls = [];
  const registry = createObjectHookRegistry()
    .register("decorate", {
      operations: ["create", "update"],
      handler: async (context, next) => {
        calls.push({ operation: context.operation, variant: context.variant, count: context.count, batch: context.batch?.index });
        for (const object of context.input.objects || []) object.hooked = true;
        await next();
      },
    })
    .register("observe", async (context, next) => {
      calls.push({ operation: context.operation, variant: context.variant, count: context.count, batch: context.batch?.index });
      if (context.operation === "read" && context.variant === "query") {
        context.input.query = { ...context.input.query, hooked: true };
      }
      await next();
      assert.notEqual(context.result, undefined);
    });
  const state = await startServer({
    auth: AUTH,
    objectHooks: registry,
    imports: { maxBulkObjects: 2, maxBulkBytes: 1024 * 1024, maxObjectBytes: 1024 * 1024 },
  });
  t.after(() => closeServer(state));
  const base = `http://localhost:${state.port}`;
  const token = await login(base);
  const client = api(base, token);

  assert.equal((await client.post("/api/databases", { name: "app" })).status, 201);
  assert.equal((await client.post("/api/app/collections", {
    name: "items",
    meta: { hooks: { enabled: true, use: ["observe", "decorate"] } },
  })).status, 201);

  const created = await client.post("/api/app/items/object", [{ _id: "a" }, { _id: "b" }]);
  assert.equal(created.status, 201);
  assert.ok(created.body.items.every((object) => object.hooked === true));
  assert.deepEqual(calls.map(({ operation, count }) => [operation, count]), [["create", 2], ["create", 2]]);

  calls.length = 0;
  const replaced = await client.put("/api/app/items/object", [{ _id: "a", value: 1 }]);
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.items[0].hooked, true);
  assert.deepEqual(calls.map(({ operation, variant }) => [operation, variant]), [
    ["update", "bulk-replace"], ["update", "bulk-replace"],
  ]);

  calls.length = 0;
  assert.equal((await client.patch("/api/app/items/object", [{ _id: "a", $set: { patched: true } }])).status, 200);
  assert.equal((await client.del("/api/app/items/object", ["b"])).status, 200);
  assert.deepEqual(calls.map(({ operation, variant }) => [operation, variant]), [
    ["update", "bulk-patch"], ["update", "bulk-patch"],
    ["delete", "bulk"],
  ]);

  calls.length = 0;
  const streamed = await ndjson(base, token, "POST", "/api/app/items/object", [
    { _id: "s1" }, { _id: "s2" }, { _id: "s3" }, { _id: "s4" }, { _id: "s5" },
  ]);
  assert.equal(streamed.status, 201);
  assert.deepEqual(calls.filter((call) => call.operation === "create" && call.variant === "stream")
    .map(({ count, batch }) => [count, batch]), [[2, 0], [2, 0], [2, 1], [2, 1], [1, 2], [1, 2]]);

  calls.length = 0;
  assert.equal((await ndjson(base, token, "PUT", "/api/app/items/object", [
    { _id: "s1", value: 1 }, { _id: "s2", value: 2 },
  ])).status, 200);
  assert.equal((await ndjson(base, token, "PATCH", "/api/app/items/object", [
    { _id: "s1", $set: { patched: true } }, { _id: "s2", $set: { patched: true } },
  ])).status, 200);
  assert.equal((await ndjson(base, token, "DELETE", "/api/app/items/object", ["s1", "s2"])).status, 200);
  assert.deepEqual(calls.map(({ operation, variant }) => [operation, variant]), [
    ["update", "stream-replace"], ["update", "stream-replace"],
    ["update", "stream-patch"], ["update", "stream-patch"],
    ["delete", "stream"],
  ]);

  calls.length = 0;
  const read = await client.get("/api/app/items/object?q=%7B%7D");
  assert.equal(read.status, 200);
  assert.ok(read.body.length > 0);
  assert.ok(read.body.every((object) => object.hooked === true));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, "read");

  calls.length = 0;
  assert.equal((await client.post("/api/app/items/object", { _id: "single" })).status, 201);
  assert.equal((await client.put("/api/app/items/object/single", { value: 3 })).status, 200);
  assert.equal((await client.get("/api/app/items/object/single")).status, 200);
  assert.equal((await client.del("/api/app/items/object/single")).status, 204);
  assert.deepEqual(calls.map(({ operation, variant }) => [operation, variant]), [
    ["create", "single"], ["create", "single"],
    ["update", "single-replace"], ["update", "single-replace"],
    ["read", "single"],
    ["delete", "single"],
  ]);

  const disabledMeta = {
    hooks: { enabled: false, use: ["observe", "decorate"] },
  };
  assert.equal((await client.put("/api/app/items/meta", disabledMeta)).status, 200);
  calls.length = 0;
  const disabled = await client.post("/api/app/items/object", { _id: "disabled" });
  assert.equal(disabled.status, 201);
  assert.equal(disabled.body.hooked, undefined);
  assert.deepEqual(calls, []);

  const unknown = await client.put("/api/app/items/meta", { hooks: { use: ["missing"] } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /not registered/);
});

test("hook-mutated writes are revalidated before storage", async (t) => {
  const registry = createObjectHookRegistry().register("invalidate", {
    operations: ["create"],
    handler: async (context, next) => {
      context.input.objects = [null];
      await next();
    },
  });
  const state = await startServer({ auth: AUTH, objectHooks: registry });
  t.after(() => closeServer(state));
  const base = `http://localhost:${state.port}`;
  const token = await login(base);
  const client = api(base, token);
  await client.post("/api/databases", { name: "app" });
  await client.post("/api/app/collections", { name: "items", meta: { hooks: { use: ["invalidate"] } } });

  const response = await client.post("/api/app/items/object", { _id: "unsafe" });
  assert.equal(response.status, 400);
  assert.equal(state.node.get("app", "items", "unsafe"), undefined);
});

test("sharded fan-out runs hooks once on ingress and rejects spoofed forward markers", async (t) => {
  const ports = await Promise.all([freePort(), freePort()]);
  const urls = ports.map((port) => `http://localhost:${port}`);
  const shardMap = {
    shards: {
      "shard-a": { peers: [{ url: urls[0] }] },
      "shard-b": { peers: [{ url: urls[1] }] },
    },
  };
  const calls = [0, 0];
  const registries = calls.map((_, index) => createObjectHookRegistry().register("count", async (_context, next) => {
    calls[index]++;
    await next();
  }));
  const nodes = urls.map((url, index) => new CRDTNode({ id: `hook-node-${index}`, url }));
  const states = await Promise.all(nodes.map((node, index) => startServer({
    port: ports[index],
    node,
    shardMap,
    auth: AUTH,
    objectHooks: registries[index],
  })));
  t.after(() => Promise.all(states.map(closeServer)));
  const token = await login(urls[0]);
  const client = api(urls[0], token);
  await client.post("/api/databases", { name: "app" });
  await client.post("/api/app/collections", { name: "items", meta: { hooks: { use: ["count"] } } });
  const ids = [
    idForShard(nodes[0], "app", "items", "shard-a", "a"),
    idForShard(nodes[0], "app", "items", "shard-b", "b"),
  ];

  const inserted = await client.post("/api/app/items/object", ids.map((_id) => ({ _id })));
  assert.equal(inserted.status, 201);
  assert.deepEqual(calls, [1, 0]);

  const spoofed = await api(urls[0], token, { "x-objydb-forwarded": "1" })
    .post("/api/app/items/object", { _id: idForShard(nodes[0], "app", "items", "shard-a", "spoof") });
  assert.equal(spoofed.status, 201);
  assert.deepEqual(calls, [2, 0]);
});

test("replication and persistence restore never execute object hooks", async (t) => {
  let calls = 0;
  const registry = createObjectHookRegistry().register("count", async (_context, next) => {
    calls++;
    await next();
  });
  const node = new CRDTNode({ id: "replica" });
  node.createCollection("app", "items", { hooks: { use: ["count"] } });
  const state = await startServer({ node, auth: AUTH, objectHooks: registry, clusterSecret: AUTH.jwtSecret });
  t.after(() => closeServer(state));

  const source = new CRDTNode({ id: "source" });
  source.insert("app", "items", { _id: "replicated", value: 1 });
  const replicated = await fetch(`http://localhost:${state.port}/replicate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-objydb-cluster-secret": AUTH.jwtSecret },
    body: JSON.stringify({ node: source.id, ops: source.log }),
  });
  assert.equal(replicated.status, 200);
  assert.equal(node.get("app", "items", "replicated").value, 1);
  assert.equal(calls, 0);

  const storage = new MemoryObjectStorage();
  const writer = new CRDTNode({ id: "writer" });
  writer.createCollection("app", "items", { hooks: { use: ["count"] } });
  writer.insert("app", "items", { _id: "restored", value: 2 });
  await new PersistenceManager({ node: writer, storage }).checkpoint();

  const fresh = new CRDTNode({ id: "fresh" });
  const runner = createObjectHookRunner(fresh, registry);
  await new PersistenceManager({ node: fresh, storage }).restore();
  assert.equal(fresh.get("app", "items", "restored").value, 2);
  assert.equal(calls, 0);
  runner.dispose();
});

async function login(base) {
  const response = await api(base).post("/api/_global/users/auth", { username: "admin", password: "123" });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.accessToken;
}

function api(base, token = null, extraHeaders = {}) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders };
  return {
    get: (path) => request(base, path, "GET", undefined, headers),
    post: (path, body) => request(base, path, "POST", body, headers),
    put: (path, body) => request(base, path, "PUT", body, headers),
    patch: (path, body) => request(base, path, "PATCH", body, headers),
    del: (path, body) => request(base, path, "DELETE", body, headers),
  };
}

async function request(base, path, method, body, headers) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function ndjson(base, token, method, path, objects) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-ndjson",
      prefer: "return=minimal",
    },
    body: `${objects.map((object) => JSON.stringify(object)).join("\n")}\n`,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function idForShard(node, database, collection, shard, prefix) {
  for (let i = 0; i < 10_000; i++) {
    const id = `${prefix}-${i}`;
    if (node.shardForObject(database, collection, id) === shard) return id;
  }
  throw new Error(`could not find id for ${shard}`);
}

async function closeServer(state) {
  state.objectHooks?.dispose();
  state.server.closeAllConnections?.();
  await new Promise((resolve) => state.server.close(resolve));
}
