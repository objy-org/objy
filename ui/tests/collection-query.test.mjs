import test from "node:test";
import assert from "node:assert/strict";
import { testStore } from "./helpers/store.mjs";

async function fixture(t) {
  const store = await testStore();
  t.after(() => store.close());
  await store.createDatabase("query");
  await store.createCollections("query", ["bikes", "other"]);
  await store.insertObjects("query", "bikes", [
    { _id: "a", active: true, score: 10, details: { gears: 7 } },
    { _id: "b", active: false, score: 30, details: { gears: 3 } },
    { _id: "c", active: true, score: 20, details: { gears: 12 } },
  ]);
  return store;
}

test("collection queries run native filters and sort on the server, with separate total and match counts", async (t) => {
  const s = await fixture(t);
  s.pageSize = 1;
  const query = {
    active: true,
    "details.gears": { $gte: 7 },
    $sort: { score: -1 },
  };
  const page = await s.loadCollection("query", "bikes", { query });
  assert.deepEqual(
    page.objects.map((o) => o._id),
    ["c"],
  );
  assert.equal(page.count, 3);
  assert.equal(page.resultCount, 2);
  assert.equal(page.hasMore, true);
  query.active = false;
  const more = await s.loadCollection("query", "bikes", { more: true });
  assert.deepEqual(
    more.objects.map((o) => o._id),
    ["c", "a"],
  );
  assert.equal(more.hasMore, false);
  assert.equal(more.query.active, true);
  assert.equal(more.readOnly, false);
});

test("explicit JSON pagination controls pass through without URL options overriding them", async (t) => {
  const s = await fixture(t);
  const page = await s.loadCollection("query", "bikes", {
    query: { $sort: { score: -1 }, $limit: 1, $skip: 1 },
  });
  assert.deepEqual(
    page.objects.map((o) => o._id),
    ["c"],
  );
  assert.equal(page.hasMore, false);
  assert.equal(page.directQuery, true);
  const numbered = await s.loadCollection("query", "bikes", {
    query: { $sort: { score: -1 }, $page: 3, $pageSize: 1 },
  });
  assert.deepEqual(
    numbered.objects.map((o) => o._id),
    ["a"],
  );
});

test("native aggregation returns derived rows marked read only, and clearing restores database objects", async (t) => {
  const s = await fixture(t);
  const page = await s.loadCollection("query", "bikes", {
    query: {
      active: true,
      $aggregate: {
        fields: { total: { $sum: "score" }, count: { $count: true } },
      },
    },
  });
  assert.deepEqual(page.objects, [{ total: 30, count: 2 }]);
  assert.equal(page.readOnly, true);
  assert.equal(page.resultCount, 1);
  assert.equal(page.count, 3);
  const all = await s.loadCollection("query", "bikes", { query: {} });
  assert.equal(all.objects.length, 3);
  assert.equal(all.query, null);
  assert.equal(all.readOnly, false);
});

test("native reference expansion is preserved and expanded results cannot become editable replacements", async (t) => {
  const s = await fixture(t);
  await s.insertObjects("query", "other", [
    {
      _id: "order",
      bike: { type: "reference", collection: "bikes", value: "a" },
    },
  ]);
  const page = await s.loadCollection("query", "other", {
    query: { $refDepth: 1 },
  });
  assert.equal(page.objects[0].bike.object.score, 10);
  assert.equal(page.readOnly, true);
});

test("queries remain scoped per collection through refresh, edits and empty results", async (t) => {
  const s = await fixture(t);
  await s.loadCollection("query", "bikes", { query: { active: true } });
  await s.loadCollection("query", "other");
  await s.replaceObject("query", "bikes", "a", {
    _id: "a",
    active: false,
    score: 10,
  });
  let c = s.assertCollection("query", "bikes");
  assert.deepEqual(
    c.objects.map((o) => o._id),
    ["c"],
  );
  assert.deepEqual(c.query, { active: true });
  assert.equal(s.assertCollection("query", "other").query, null);
  await s.loadCollection("query", "bikes", { query: { active: "missing" } });
  await s.refresh();
  c = s.assertCollection("query", "bikes");
  assert.deepEqual(c.objects, []);
  assert.equal(c.resultCount, 0);
  assert.equal(c.hasMore, false);
});

test("invalid queries or failed requests retain the previous successful query and results", async (t) => {
  const s = await fixture(t);
  await s.loadCollection("query", "bikes", { query: { active: true } });
  const before = s.assertCollection("query", "bikes");
  assert.throws(
    () => s.loadCollection("query", "bikes", { query: [] }),
    /JSON object/,
  );
  const search = s.adapter.search;
  s.adapter.search = async () => {
    throw new Error("Server rejected query");
  };
  await assert.rejects(
    s.loadCollection("query", "bikes", { query: { active: false } }),
    /rejected/,
  );
  assert.equal(s.assertCollection("query", "bikes"), before);
  s.adapter.search = search;
  assert.equal(
    (await s.loadCollection("query", "bikes", { query: { active: false } }))
      .objects[0]._id,
    "b",
  );
});

test("Load more and refresh cross the server 250-row cap without losing or repeating rows", async (t) => {
  const s = await fixture(t);
  await s.insertObjects(
    "query",
    "other",
    Array.from({ length: 310 }, (_, i) => ({
      _id: String(i).padStart(3, "0"),
      active: true,
    })),
  );
  s.pageSize = 150;
  await s.loadCollection("query", "other", { query: { active: true } });
  let page = await s.loadCollection("query", "other", { more: true });
  assert.equal(page.objects.length, 300);
  assert.equal(page.hasMore, true);
  page = await s.loadCollection("query", "other", { more: true });
  assert.equal(page.objects.length, 310);
  assert.equal(new Set(page.objects.map((o) => o._id)).size, 310);
  assert.equal(page.hasMore, false);
  await s.refresh();
  assert.equal(s.assertCollection("query", "other").objects.length, 310);
});
