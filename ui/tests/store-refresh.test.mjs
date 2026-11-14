import test from "node:test";
import assert from "node:assert/strict";
import { testStore } from "./helpers/store.mjs";

async function fixture(t, size = 110) {
  const store = await testStore();
  t.after(() => store.close());
  for (const db of ["one", "two", "three"]) {
    await store.createDatabase(db);
    await store.createCollections(db, ["items", "other"]);
  }
  await store.insertObjects(
    "one",
    "items",
    Array.from({ length: size }, (_, i) => ({
      _id: `row_${String(i).padStart(4, "0")}`,
      value: i,
    })),
  );
  await store.insertObjects("two", "other", [{ _id: "second", value: 1 }]);
  return store;
}

function measure(store) {
  const calls = [],
    rows = [];
  for (const name of ["listDatabases", "listCollections", "count", "search"]) {
    const original = store.adapter[name];
    store.adapter[name] = async (...args) => {
      calls.push([name, ...args]);
      const result = await original(...args);
      if (name === "search") rows.push(...result);
      return result;
    };
  }
  return { calls, rows };
}

test("browsing 2000 objects transfers 2000 rows with 40 searches and one count", async (t) => {
  const store = await fixture(t, 2000),
    work = measure(store);
  await store.loadCollection("one", "items");
  for (let page = 1; page < 40; page++)
    await store.loadCollection("one", "items", { more: true });
  assert.equal(store.assertCollection("one", "items").objects.length, 2000);
  assert.equal(work.rows.length, 2000);
  assert.equal(work.calls.filter(([method]) => method === "search").length, 40);
  assert.equal(work.calls.filter(([method]) => method === "count").length, 1);
  const before = work.calls.length;
  await store.loadCollection("one", "items", { more: true });
  assert.equal(
    work.calls.length,
    before,
    "exhausted collections must not be queried again",
  );
});

test("editing one collection does not reload catalogs or previously visited collections", async (t) => {
  const store = await fixture(t);
  await store.loadCollection("one", "items");
  await store.loadCollection("two", "other");
  const untouched = store.assertCollection("one", "items"),
    work = measure(store);
  await store.patchObject("two", "other", "second", { $set: { value: 2 } });
  assert.equal(store.assertCollection("one", "items"), untouched);
  assert.equal(store.assertCollection("two", "other").objects[0].value, 2);
  assert.deepEqual(
    work.calls.map((call) => call.slice(0, 3)),
    [
      ["count", "two", "other"],
      ["search", "two", "other"],
    ],
  );
  assert.equal(work.rows.length, 1);
  work.calls.length = 0;
  await store.setMeta("two", "other", { label: "Other" });
  assert.equal(
    work.calls.length,
    0,
    "metadata changes must not re-query object pages",
  );
});

test("catalog changes preserve loaded pages and discover only the changed scope", async (t) => {
  const store = await fixture(t);
  await store.loadCollection("one", "items");
  const page = store.assertCollection("one", "items"),
    work = measure(store);
  await store.createCollections("two", ["new"]);
  assert.ok(store.assertCollection("two", "new"));
  assert.ok(
    work.calls.every(
      ([method, db]) => method === "listCollections" && db === "two",
    ),
  );
  work.calls.length = 0;
  await store.createDatabase("four");
  assert.equal(store.assertCollection("one", "items"), page);
  assert.ok(
    work.calls.every(
      ([method, db]) =>
        method === "listDatabases" ||
        (method === "listCollections" && db === "four"),
    ),
  );
});

test("failed next pages preserve the current window; retry resumes at the same offset", async (t) => {
  const store = await fixture(t);
  await store.loadCollection("one", "items");
  const first = store.assertCollection("one", "items"),
    original = store.adapter.search;
  store.adapter.search = async () => {
    throw new Error("Unavailable");
  };
  await assert.rejects(
    store.loadCollection("one", "items", { more: true }),
    /Unavailable/,
  );
  assert.equal(store.assertCollection("one", "items"), first);
  const offsets = [];
  store.adapter.search = (...args) => {
    offsets.push(args[3].offset);
    return original(...args);
  };
  const next = await store.loadCollection("one", "items", { more: true });
  assert.deepEqual(offsets, [50]);
  assert.equal(next.objects.length, 100);
  const reset = await store.loadCollection("one", "items", {
    more: true,
    query: { value: { $gte: 100 } },
  });
  assert.equal(reset.objects.length, 10);
  assert.equal(reset.objects[0].value, 100);
});

test("default browsing follows ID order and refresh includes new objects before the loaded window", async (t) => {
  const store = await fixture(t);
  store.pageSize = 2;
  await store.loadCollection("one", "items");
  await store.adapter.insertMany("one", "items", [
    { _id: "before", value: -1 },
  ]);
  const next = await store.loadCollection("one", "items", { more: true });
  // Live offset pages can overlap after an insertion before the current window.
  assert.deepEqual(next.objects.map((row) => row._id), ["row_0000", "row_0001", "row_0002"]);
  assert.equal(
    new Set(next.objects.map((row) => row._id)).size,
    next.objects.length,
  );
  assert.equal(next.nextOffset, 4);
  await store.refresh();
  assert.equal(store.assertCollection("one", "items").objects[0]._id, "before");
});

test("refresh failures remain scoped and retain confirmed writes until recovery", async (t) => {
  const store = await fixture(t);
  await store.loadCollection("one", "items");
  await store.loadCollection("two", "other");
  const original = store.adapter.search;
  store.adapter.search = (db, ...args) => {
    if (db === "one") throw new Error("First collection unavailable");
    return original(db, ...args);
  };
  assert.equal(
    (
      await store.patchObject("one", "items", "row_0000", {
        $set: { value: 999 },
      })
    ).value,
    999,
  );
  assert.match(
    store.collectionRefreshError("one", "items").message,
    /unavailable/,
  );
  await store.patchObject("two", "other", "second", { $set: { value: 2 } });
  assert.equal(store.collectionRefreshError("two", "other"), undefined);
  assert.match(store.refreshError.message, /unavailable/);
  store.adapter.search = original;
  await store.loadCollection("one", "items");
  assert.equal(store.refreshError, null);
  assert.equal(store.assertCollection("one", "items").objects[0].value, 999);
});
