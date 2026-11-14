import test from "node:test";
import assert from "node:assert/strict";
import { ObjyStore, createServerAdapter } from "../src/data/objy-store.js";
import { Connections } from "../src/data/connections.js";
import { testServer } from "./helpers/server.mjs";

test("server: paging, CRUD, queries and lifecycle through the official client", async (t) => {
  const server = await testServer();
  t.after(() => server.close());
  const base = createServerAdapter({ url: server.url });
  let objectReads = 0;
  const adapter = {
    ...base,
    search(...args) {
      objectReads++;
      return base.search(...args);
    },
  };
  const store = await new ObjyStore(adapter, { pageSize: 2 }).open();
  t.after(() => store.close());
  await store.createDatabase("inventory");
  await store.createCollections("inventory", ["bikes", "orders"]);
  await store.insertObjects("inventory", "bikes", [
    {
      _id: "a",
      id: "business",
      name: "City",
      profile: { gears: 7, other: true },
    },
    { _id: "b", name: "Trail" },
    { _id: "c", name: "Cargo" },
  ]);
  await store.refresh();
  assert.equal(objectReads, 0, "catalog refresh eagerly read objects");
  assert.equal(store.databases[0].collections[0].loaded, false);
  assert.equal(
    store.databases[0].collections[0].count,
    null,
    "unloaded is not empty",
  );
  const first = await store.loadCollection("inventory", "bikes");
  assert.deepEqual(
    first.objects.map((o) => o._id),
    ["a", "b"],
  );
  assert.equal(first.count, 3);
  assert.equal(first.hasMore, true);
  const next = await store.loadCollection("inventory", "bikes", { more: true });
  assert.deepEqual(
    next.objects.map((o) => o._id),
    ["a", "b", "c"],
  );
  assert.equal(next.hasMore, false);
  await store.patchObject("inventory", "bikes", "a", {
    $set: { "profile.gears": 8 },
    $unset: ["name"],
  });
  assert.deepEqual((await store.query("inventory", "bikes", { _id: "a" }))[0], {
    _id: "a",
    id: "business",
    profile: { gears: 8, other: true },
  });
  await assert.rejects(
    store.patchObject("inventory", "bikes", "missing", { $set: { x: 1 } }),
    /not found/,
  );
  await assert.rejects(
    store.replaceObject("inventory", "bikes", "missing", { x: 1 }),
    /not found/,
  );
  await store.replaceObject("inventory", "bikes", "b", {
    name: "Replaced",
    value: 10,
  });
  assert.deepEqual(
    await store.query("inventory", "bikes", { value: { $gte: 10 } }),
    [{ _id: "b", name: "Replaced", value: 10 }],
  );
  assert.deepEqual(
    await store.query("inventory", "bikes", {
      $aggregate: { fields: { total: { $count: true } } },
    }),
    [{ total: 3 }],
  );
  await store.insertObjects("inventory", "orders", [
    {
      _id: "order",
      bike: { type: "reference", collection: "bikes", value: "b" },
    },
  ]);
  assert.equal(
    (await store.query("inventory", "orders", {}, { refDepth: 1 }))[0].bike
      .object.name,
    "Replaced",
  );
  await store.setMeta("inventory", "bikes", { label: "Bikes" });
  assert.equal((await store.getMeta("inventory", "bikes")).label, "Bikes");
  assert.equal(
    (await store.removeObjects("inventory", "bikes", ["a", "missing"])).deleted,
    1,
  );
  await store.dropCollection("inventory", "bikes");
  assert.equal(store.databases[0].collections[0].name, "orders");
  await store.dropDatabase("inventory");
  assert.deepEqual(store.databases, []);
});

test("startup is disconnected and a store requires an explicit adapter", () => {
  const connections = new Connections();
  assert.equal(connections.activeId, null);
  assert.equal(connections.active, undefined);
  assert.equal(connections.entries.size, 0);
  assert.throws(() => new ObjyStore(), /Connect to an OBJY server/);
});

test("failed login keeps the current server; objects and explorer drafts stay isolated", async (t) => {
  const firstServer = await testServer();
  t.after(() => firstServer.close());
  const secondServer = await testServer({
    auth: { enabled: true },
    environment: { OBJYDB_ADMIN_PASSWORD: "adapter-test-only" },
  });
  t.after(() => secondServer.close());
  const connections = new Connections();
  t.after(() => connections.close());
  await assert.rejects(
    connections.connect({
      url: secondServer.url,
      username: "admin",
      password: "incorrect",
    }),
    /Authentication/,
  );
  assert.equal(connections.activeId, null);
  assert.equal(connections.entries.size, 0);
  const first = await connections.connect({ url: firstServer.url });
  await first.store.createDatabase("same");
  await first.store.createCollections("same", ["items"]);
  first.viewState = {
    collection: "items",
    drafts: [["object", { text: "First draft" }]],
  };
  await assert.rejects(
    connections.connect({
      url: secondServer.url,
      username: "admin",
      password: "incorrect",
    }),
    /Authentication/,
  );
  assert.equal(connections.active, first);
  assert.equal(connections.entries.size, 1);
  const second = await connections.connect({
    url: secondServer.url,
    username: "admin",
    password: "adapter-test-only",
  });
  assert.deepEqual(second.viewState, {});
  assert.equal(second.store.connection.package, "@objy/client");
  await second.store.createDatabase("same");
  await second.store.createCollections("same", ["items"]);
  await first.store.insertObjects("same", "items", [{ name: "First only" }]);
  assert.deepEqual(await second.store.query("same", "items"), []);
  assert.equal(
    (await first.store.query("same", "items"))[0].name,
    "First only",
  );
  await connections.use(first.id);
  assert.equal(connections.active.viewState.drafts[0][1].text, "First draft");
  await connections.use(second.id);
  const originalRefresh = first.store.refresh;
  first.store.refresh = async () => {
    throw new Error("Offline");
  };
  await assert.rejects(connections.use(first.id), /Offline/);
  assert.equal(connections.active, second);
  first.store.refresh = originalRefresh;
  await connections.disconnect(first.id);
  assert.equal(connections.active, second);
  await connections.disconnect(second.id);
  assert.equal(connections.activeId, null);
  assert.equal(connections.active, undefined);
  assert.equal(connections.entries.size, 0);
  const reconnected = await connections.connect({ url: firstServer.url });
  assert.deepEqual(reconnected.viewState, {});
  assert.equal(
    (await reconnected.store.query("same", "items"))[0].name,
    "First only",
    "disconnect must not erase server data",
  );
  await connections.close();
  assert.equal(connections.activeId, null);
  assert.equal(connections.entries.size, 0);
});

test("disconnecting the active server never falls back to another server", async (t) => {
  const server = await testServer();
  t.after(() => server.close());
  const connections = new Connections();
  t.after(() => connections.close());
  const first = await connections.connect({ url: server.url });
  const second = await connections.connect({ url: server.url });
  await connections.disconnect(second.id);
  assert.equal(connections.activeId, null);
  assert.equal(connections.entries.size, 1);
  await connections.use(first.id);
  assert.equal(connections.active, first);
});

test("confirmed writes survive a subsequent refresh failure without retry", async (t) => {
  const server = await testServer();
  t.after(() => server.close());
  const base = createServerAdapter({ url: server.url });
  let fail = false;
  const store = await new ObjyStore({
    ...base,
    search(...args) {
      if (fail) throw new Error("Offline");
      return base.search(...args);
    },
  }).open();
  t.after(() => store.close());
  await store.createDatabase("test");
  await store.createCollections("test", ["data"]);
  await store.loadCollection("test", "data");
  fail = true;
  assert.equal(
    (await store.insertObjects("test", "data", [{ name: "Saved" }])).inserted,
    1,
  );
  assert.match(store.refreshError.message, /Offline/);
  assert.equal((await base.search("test", "data", {})).length, 1);
  fail = false;
  await store.refresh();
  assert.equal(store.refreshError, null);
});

test("lost HTTP write response marks uncertainty without replaying the insert", async (t) => {
  const server = await testServer();
  t.after(() => server.close());
  let loseResponse = false,
    writes = 0;
  const adapter = createServerAdapter({
    url: server.url,
    fetch: async (url, init) => {
      const result = await fetch(url, init);
      if (
        loseResponse &&
        init.method === "POST" &&
        new URL(url).pathname === "/api/test/data/object"
      ) {
        writes++;
        throw new TypeError("Network response lost");
      }
      return result;
    },
  });
  const store = await new ObjyStore(adapter).open();
  t.after(() => store.close());
  await store.createDatabase("test");
  await store.createCollections("test", ["data"]);
  loseResponse = true;
  await assert.rejects(
    store.insertObjects("test", "data", [{ name: "Only once" }]),
    (error) => error.writeMayHaveSucceeded === true,
  );
  assert.equal(writes, 1);
  assert.equal((await store.query("test", "data")).length, 1);
});

test("database creation retains its confirmed result if the catalog refresh fails", async (t) => {
  const server = await testServer();
  t.after(() => server.close());
  const base = createServerAdapter({ url: server.url });
  let fail = false;
  const store = await new ObjyStore({
    ...base,
    listDatabases() {
      if (fail) throw new Error("Offline");
      return base.listDatabases();
    },
    async createDatabase(...args) {
      const result = await base.createDatabase(...args);
      fail = true;
      return result;
    },
  }).open();
  t.after(() => store.close());
  await store.createDatabase("created");
  assert.match(store.refreshError.message, /Offline/);
  assert.deepEqual(await base.listDatabases(), ["created"]);
});

test("partially created collection batches report saved parts rather than inviting replay", async (t) => {
  const server = await testServer();
  t.after(() => server.close());
  const base = createServerAdapter({ url: server.url });
  const store = await new ObjyStore({
    ...base,
    createCollection(db, name) {
      if (name === "denied") throw new Error("Permission denied");
      return base.createCollection(db, name);
    },
  }).open();
  t.after(() => store.close());
  await store.createDatabase("test");
  await assert.rejects(
    store.createCollections("test", ["saved", "denied"]),
    (error) =>
      error.writeMayHaveSucceeded &&
      /Created collections: saved/.test(error.message),
  );
  assert.deepEqual(await base.listCollections("test"), ["saved"]);
});
