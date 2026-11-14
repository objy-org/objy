import test from "node:test";
import assert from "node:assert/strict";
import { buildQuery, readQuery } from "../src/ui/query-builder.js";
import { testStore } from "./helpers/store.mjs";

test("builder filters keep types, repeated fields and native all/any semantics", async (t) => {
  const store = await testStore();
  t.after(() => store.close());
  await store.createDatabase("builder");
  await store.createCollections("builder", ["items"]);
  await store.insertObjects("builder", "items", [
    { _id: "a", active: true, amount: 10, code: "001", details: { value: 1 } },
    { _id: "b", active: true, amount: 20, code: "002", details: { value: 2 } },
    { _id: "c", active: false, amount: 30, code: "003", details: { value: 3 } },
  ]);
  const state = readQuery("");
  state.filters = [
    { field: "active", op: "$eq", value: "true" },
    { field: "amount", op: "$gte", value: "10" },
    { field: "amount", op: "$lt", value: "30" },
  ];
  state.sortField = "amount";
  state.direction = -1;
  let page = await store.loadCollection("builder", "items", { query: buildQuery(state) });
  assert.deepEqual(page.objects.map((o) => o._id), ["b", "a"]);
  state.mode = "$or";
  state.filters = [
    { field: "code", op: "$eq", value: '"001"' },
    { field: "details.value", op: "$gte", value: "3" },
  ];
  page = await store.loadCollection("builder", "items", { query: buildQuery(state) });
  assert.deepEqual(page.objects.map((o) => o._id), ["c", "a"]);
});

test("each builder aggregation groups and sorts through the official client", async (t) => {
  const store = await testStore();
  t.after(() => store.close());
  await store.createDatabase("builder");
  await store.createCollections("builder", ["items"]);
  await store.insertObjects("builder", "items", [
    { group: "a", amount: 10 }, { group: "a", amount: 20 }, { group: "b", amount: 40 },
  ]);
  for (const [aggregate, expected] of [["$count", 2], ["$sum", 30], ["$avg", 15], ["$min", 10], ["$max", 20]]) {
    const state = { ...readQuery(""), aggregate, field: "amount", group: "group", sortField: "group", direction: -1 };
    const query = buildQuery(state);
    const page = await store.loadCollection("builder", "items", { query });
    assert.equal(page.readOnly, true);
    assert.deepEqual(page.objects.map((o) => o.group), ["b", "a"]);
    assert.equal(page.objects[1][aggregate.slice(1)], expected);
    assert.deepEqual(buildQuery(readQuery(JSON.stringify(query))), query);
  }
});

test("existing ranges, aliases and typed values survive builder round trips", () => {
  const input = { amount: { $gte: 10, $lt: 30 }, active: true, $aggregate: {
    groupBy: "status", fields: { total: { $sum: "amount" } }, $sort: { total: -1 },
  } };
  const state = readQuery(JSON.stringify(input));
  assert.equal(state.filters.length, 3);
  assert.deepEqual(buildQuery(state).$aggregate, input.$aggregate);
  for (const value of [true, false, null, 42, "42", "", [1, 2], { nested: true }]) {
    const query = { value: { $eq: value } };
    assert.deepEqual(buildQuery(readQuery(JSON.stringify(query))), query);
  }
  assert.deepEqual(buildQuery(readQuery("{}")), {});
});

test("unsupported JSON stays in the editor instead of being partially rebuilt", () => {
  for (const query of [
    { $limit: 3 }, { $or: [] }, { $or: [{ a: 1 }, { b: 2 }], c: 3 },
    { $sort: { a: 1, b: -1 } }, { a: { $regex: "foo" } }, { " a ": 1 },
    { $aggregate: { groupBy: ["a", "b"], fields: { n: { $count: true } } } },
    { $aggregate: { fields: { n: { $count: true }, total: { $sum: "amount" } } } },
    { $sort: { a: 1 }, $aggregate: { fields: { n: { $count: true } } } },
  ]) assert.throws(() => readQuery(JSON.stringify(query)), /simple builder cannot edit/);
  assert.throws(() => readQuery("{"), /valid JSON/);
  assert.throws(() => readQuery("[]"), /JSON object/);
});

test("invalid builder values fail clearly; field keys remain data", () => {
  const state = readQuery("");
  for (const [op, value, message] of [["$in", "active", /array/], ["$exists", "yes", /true or false/], ["$eq", "[broken", /valid JSON/]]) {
    state.filters = [{ field: "status", op, value }];
    assert.throws(() => buildQuery(state), message);
  }
  state.filters = [{ field: "__proto__", op: "$eq", value: "safe" }];
  const query = buildQuery(state);
  assert.equal(Object.getPrototypeOf(query), Object.prototype);
  assert.equal(Object.hasOwn(query, "__proto__"), true);
  assert.equal(query.__proto__.$eq, "safe");
});
