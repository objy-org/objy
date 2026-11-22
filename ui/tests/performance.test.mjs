import test from "node:test";
import assert from "node:assert/strict";
import { testServer } from "./helpers/server.mjs";
import { ObjyStore, createServerAdapter } from "../src/data/objy-store.js";

async function fixture(t, { databases = 1, collections = 3, rows = 2000 } = {}) {
  const server = await testServer();
  t.after(() => server.close());
  for (let d = 0; d < databases; d++) {
    server.runtime.node.createDatabase(`d${d}`);
    for (let c = 0; c < collections; c++) server.runtime.node.createCollection(`d${d}`, `c${c}`);
  }
  server.runtime.node.insertMany("d0", "c0", Array.from({ length: rows }, (_, i) =>
    ({ _id: String(i).padStart(5, "0"), value: i, active: i % 2 === 0 })));
  const calls = [], adapter = createServerAdapter({ url: server.url });
  for (const name of ["listDatabases", "listCollections", "count", "search"]) {
    const native = adapter[name];
    adapter[name] = async (...args) => {
      const call = { name, args };
      calls.push(call);
      const result = await native(...args);
      if (name === "search") call.rows = result.length;
      return result;
    };
  }
  const store = await new ObjyStore(adapter).open();
  t.after(() => store.close());
  return { store, calls };
}

test("100 database catalogs load with one request; expanding fetches only that database", async (t) => {
  const { store, calls } = await fixture(t, { databases: 100, collections: 20, rows: 0 });
  assert.deepEqual(calls.map((c) => c.name), ["listDatabases"]);
  assert.equal(store.databases.length, 100);
  await store.loadDatabase("d42");
  await store.loadDatabase("d42");
  assert.deepEqual(calls.slice(1).map((c) => [c.name, ...c.args]), [["listCollections", "d42"]]);
  assert.equal(store.assertDatabase("d42").collections.length, 20);
  assert.equal(store.assertDatabase("d0").collectionsLoaded, false);
});

test("rows arrive before optional counts; count failure keeps usable paging and query results", async (t) => {
  const { store, calls } = await fixture(t);
  const page = await store.loadCollection("d0", "c0", { query: { active: true } });
  assert.equal(page.objects.length, 50);
  assert.equal(calls.some((c) => c.name === "count"), false);
  let rejectCount;
  store.adapter.count = () => new Promise((_, reject) => { rejectCount = reject; });
  const count = store.loadCounts("d0", "c0");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.assertCollection("d0", "c0").objects, page.objects);
  rejectCount(new Error("Slow count failed"));
  await count;
  assert.equal(store.assertCollection("d0", "c0").objects, page.objects);
  assert.equal(store.assertCollection("d0", "c0").countError, true);
  assert.equal((await store.loadCollection("d0", "c0", { more: true })).objects.length, 100);
});

test("editing one of 2000 loaded objects transfers no page rows; deletion preserves the next offset", async (t) => {
  const { store, calls } = await fixture(t, { rows: 2050 });
  for (let i = 0; i < 40; i++) await store.loadCollection("d0", "c0", { more: i > 0 });
  calls.length = 0;
  await store.replaceObject("d0", "c0", "00000", { _id: "00000", value: -1 });
  assert.equal(store.assertCollection("d0", "c0").objects[0].value, -1);
  assert.equal(calls.length, 0);
  await store.removeObjects("d0", "c0", ["00001"]);
  assert.equal(store.assertCollection("d0", "c0").nextOffset, 1999);
  const page = await store.loadCollection("d0", "c0", { more: true });
  assert.equal(page.objects.length, 2049);
  assert.equal(page.objects.at(-1)._id, "02049");
  assert.equal(new Set(page.objects.map((o) => o._id)).size, 2049);
});

test("filtered edits refresh one bounded page using server membership and ordering", async (t) => {
  const { store, calls } = await fixture(t);
  await store.loadCollection("d0", "c0", { query: { active: true, $sort: { value: -1 } } });
  for (let i = 0; i < 5; i++) await store.loadCollection("d0", "c0", { more: true });
  calls.length = 0;
  await store.replaceObject("d0", "c0", "01998", { active: false, value: 1998 });
  const page = store.assertCollection("d0", "c0");
  assert.equal(page.objects.length, 50);
  assert.equal(page.objects[0]._id, "01996");
  assert.equal(page.hasMore, true);
  assert.equal(calls.filter((c) => c.name === "search").reduce((n, c) => n + c.rows, 0), 50);
  assert.equal(calls.some((c) => c.name === "count"), false);
});

test("inactive row caches are bounded and evicted queries load from their first page", async (t) => {
  const { store } = await fixture(t);
  await store.loadCollection("d0", "c0", { query: { value: { $gte: 0 } } });
  for (let i = 0; i < 25; i++) await store.loadCollection("d0", "c0", { more: true });
  await store.loadCollection("d0", "c1");
  assert.equal(store.assertCollection("d0", "c0").objects.length, 0);
  assert.equal(store.assertCollection("d0", "c0").loaded, false);
  const page = await store.loadCollection("d0", "c0");
  assert.equal(page.objects.length, 50);
  assert.equal(page.objects[0]._id, "00000");
  assert.deepEqual(page.query, { value: { $gte: 0 } });
  store.releasePages();
  assert.equal(store.databases.flatMap((db) => db.collections).flatMap((c) => c.objects).length, 0);
});

test("aggregate queries do not issue counts, and stale counts cannot repopulate an evicted cache", async (t) => {
  const { store, calls } = await fixture(t);
  await store.loadCollection("d0", "c0", { query: { $aggregate: { fields: { n: { $count: true } } } } });
  await store.loadCounts("d0", "c0");
  assert.equal(calls.some((c) => c.name === "count"), false);
  await store.loadCollection("d0", "c0", { query: {} });
  let finish;
  store.adapter.count = () => new Promise((resolve) => { finish = resolve; });
  const pending = store.loadCounts("d0", "c0");
  await new Promise((resolve) => setImmediate(resolve));
  store.releasePages();
  finish(2000);
  assert.equal(await pending, false);
  assert.equal(store.assertCollection("d0", "c0").loaded, false);
});
