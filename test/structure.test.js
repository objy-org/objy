import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { CRDTNode } from "../src/crdt.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";
import { startServer } from "../src/server.js";

const AUTH = {
  jwtSecret: "structure-test-secret",
  users: [{ _id: "admin", username: "admin", password: "123", role: "admin", admin: true }],
};

const STRUCTURE = [
  {
    condition: {},
    apply: {
      status: "draft",
      lifecycle: { managed: false, active: false },
      labels: ["default"],
    },
  },
  {
    condition: { type: "asset" },
    apply: {
      status: "managed",
      lifecycle: { managed: true },
    },
  },
  {
    condition: { status: "managed" },
    apply: { matchedVirtualCondition: true },
  },
];

test("conditional structure materializes read copies without changing physical data", () => {
  const node = new CRDTNode({ id: "structure-unit" });
  node.createCollection("app", "items", { structure: STRUCTURE });
  node.insertMany("app", "items", [
    { _id: "asset", type: "asset", lifecycle: { active: true } },
    { _id: "override", type: "asset", status: null, labels: [] },
    { _id: "physical-condition", status: "managed" },
  ]);

  const asset = node.materializeRead("app", "items", node.get("app", "items", "asset"));
  assert.deepEqual(asset, {
    _id: "asset",
    type: "asset",
    status: "managed",
    lifecycle: { active: true, managed: true },
    labels: ["default"],
  });
  assert.equal(asset.matchedVirtualCondition, undefined, "conditions do not see values applied by earlier entries");

  const override = node.materializeRead("app", "items", node.get("app", "items", "override"));
  assert.equal(override.status, null, "explicit null wins over a virtual value");
  assert.deepEqual(override.labels, [], "an explicit empty array wins over a virtual value");

  const physicalCondition = node.materializeRead("app", "items", node.get("app", "items", "physical-condition"));
  assert.equal(physicalCondition.matchedVirtualCondition, true);
  assert.deepEqual(node.get("app", "items", "asset"), {
    _id: "asset",
    type: "asset",
    lifecycle: { active: true },
  });

  assert.deepEqual(node.find("app", "items", { status: "managed" }).map(({ _id }) => _id), ["physical-condition"]);
  const snapshot = node.db.getCollection("app", "items").snapshot();
  assert.equal(snapshot.find(({ id }) => id === "asset").value.status, undefined);
});

test("collection structure metadata is strict and protects internal fields", () => {
  const node = new CRDTNode({ id: "structure-validation" });
  assert.throws(
    () => node.createCollection("app", "items", { structure: { condition: {}, apply: {} } }),
    /structure must be an array/,
  );
  assert.throws(
    () => node.createCollection("app", "items", { structure: [{ condition: {}, apply: { _id: "virtual" } }] }),
    /apply\._id is reserved/,
  );
  assert.throws(
    () => node.createCollection("app", "items", { structure: [{ condition: {}, apply: { admin: true } }] }),
    /apply\.admin is reserved/,
  );
  assert.throws(
    () => node.createCollection("app", "items", { structure: [{ condition: { $page: 1 }, apply: {} }] }),
    /condition\.\$page is not supported/,
  );
});

test("persistence restores structure metadata without storing virtual values", async () => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "structure-persist" });
  const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0 });
  persistence.start();
  node.createCollection("app", "items", { structure: STRUCTURE });
  node.insert("app", "items", { _id: "asset", type: "asset" });
  await persistence.checkpoint();
  await persistence.stop();

  const fresh = new CRDTNode({ id: "structure-restored" });
  await new PersistenceManager({ node: fresh, storage }).restore();
  assert.equal(fresh.get("app", "items", "asset").status, undefined);
  assert.equal(fresh.materializeRead("app", "items", fresh.get("app", "items", "asset")).status, "managed");
  assert.deepEqual(fresh.find("app", "items", { status: "managed" }), []);
});

test("HTTP reads expose structure after physical filtering and paging", async (t) => {
  const state = await startServer({ auth: AUTH });
  t.after(() => new Promise((resolve) => state.server.close(resolve)));
  const base = `http://localhost:${state.port}`;
  const token = await login(base);
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };

  state.node.createDatabase("app");
  state.node.createCollection("app", "items", { structure: STRUCTURE });
  state.node.insertMany("app", "items", [
    { _id: "virtual", type: "asset", name: "Virtual" },
    { _id: "physical", type: "asset", name: "Physical", status: "managed" },
  ]);

  const virtualQuery = await request(base, headers, "GET", `/api/app/items/object?q=${encodeURIComponent(JSON.stringify({ status: "managed" }))}`);
  assert.deepEqual(virtualQuery.body.map(({ _id }) => _id), ["physical"]);
  assert.equal(virtualQuery.body[0].status, "managed");

  const physicalQuery = await request(base, headers, "GET", `/api/app/items/object?q=${encodeURIComponent(JSON.stringify({ type: "asset" }))}&limit=1`);
  assert.equal(physicalQuery.body.length, 1);
  assert.equal(physicalQuery.body[0].status, "managed");

  await request(base, headers, "POST", "/api/app/users/object", {
    _id: "reader",
    username: "reader",
    password: "123",
    permissions: [{ query: { status: "managed" }, perm: "r" }],
  });
  const reader = await request(base, { "content-type": "application/json" }, "POST", "/api/app/users/auth", {
    username: "reader",
    password: "123",
  });
  assert.equal(reader.status, 200, JSON.stringify(reader.body));
  const readerHeaders = { authorization: `Bearer ${reader.body.accessToken}` };
  const permitted = await request(base, readerHeaders, "GET", "/api/app/items/object");
  assert.deepEqual(permitted.body.map(({ _id }) => _id), ["physical"]);
  const deniedVirtual = await request(base, readerHeaders, "GET", "/api/app/items/object/virtual?$refDepth=0");
  assert.equal(deniedVirtual.status, 403);

  const beforeUnset = await request(base, headers, "GET", "/api/app/items/object/physical?$refDepth=0");
  assert.equal(beforeUnset.body.status, "managed");
  await request(base, headers, "PATCH", "/api/app/items/object/physical", { $unset: ["status"] });
  const afterUnset = await request(base, headers, "GET", "/api/app/items/object/physical?$refDepth=0");
  assert.equal(afterUnset.body.status, "managed");
  assert.equal(state.node.get("app", "items", "physical").status, undefined);
});

test("sharded fan-out keeps virtual values out of remote filtering", async (t) => {
  const ports = await Promise.all([freePort(), freePort()]);
  const urls = ports.map((port) => `http://localhost:${port}`);
  const shardMap = {
    shards: {
      "shard-a": { peers: [{ url: urls[0] }] },
      "shard-b": { peers: [{ url: urls[1] }] },
    },
  };
  const states = await Promise.all(urls.map((url, index) => startServer({
    port: ports[index],
    node: new CRDTNode({ id: `structure-shard-${index}`, url }),
    shardMap,
    auth: AUTH,
  })));
  t.after(() => Promise.all(states.map((state) => new Promise((resolve) => state.server.close(resolve)))));

  const token = await login(urls[0]);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await request(urls[0], headers, "POST", "/api/databases", { name: "app" });
  await request(urls[0], headers, "POST", "/api/app/collections", { name: "items", meta: { structure: STRUCTURE } });

  const ids = [
    idForShard(states[0].node, "app", "items", "shard-a", "a"),
    idForShard(states[0].node, "app", "items", "shard-b", "b"),
  ];
  const inserted = await request(urls[0], headers, "POST", "/api/app/items/object", ids.map((_id) => ({ _id, type: "asset" })));
  assert.equal(inserted.status, 201, JSON.stringify(inserted.body));

  const virtualQuery = await request(urls[0], headers, "GET", `/api/app/items/object?q=${encodeURIComponent(JSON.stringify({ status: "managed" }))}`);
  assert.deepEqual(virtualQuery.body, []);

  const physicalQuery = await request(urls[0], headers, "GET", `/api/app/items/object?q=${encodeURIComponent(JSON.stringify({ type: "asset" }))}`);
  assert.deepEqual(physicalQuery.body.map(({ _id }) => _id).sort(), [...ids].sort());
  assert.ok(physicalQuery.body.every(({ status }) => status === "managed"));
});

async function login(base) {
  const response = await request(base, { "content-type": "application/json" }, "POST", "/api/_global/users/auth", {
    username: "admin",
    password: "123",
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.accessToken;
}

async function request(base, headers, method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function idForShard(node, database, collection, shard, prefix) {
  for (let index = 0; index < 10_000; index++) {
    const id = `${prefix}-${index}`;
    if (node.shardForObject(database, collection, id) === shard) return id;
  }
  throw new Error(`could not find id for shard ${shard}`);
}
