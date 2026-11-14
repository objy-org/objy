import test, { after } from "node:test";
import assert from "node:assert/strict";
import { testStore } from "./helpers/store.mjs";
const stores = [];
after(() => Promise.all(stores.map((s) => s.close())));
async function fixture() {
  const s = await testStore();
  stores.push(s);
  await s.createDatabase("test");
  await s.createCollections("test", ["customers", "orders"]);
  return s;
}
test("native databases and collections are independent and schema-less", async () => {
  const s = await fixture();
  assert.deepEqual(await s.adapter.listDatabases(), ["test"]);
  assert.deepEqual(await s.adapter.listCollections("test"), [
    "customers",
    "orders",
  ]);
  assert.deepEqual(await s.getMeta("test", "customers"), {
    indexes: [],
    columns: [],
  });
  await assert.rejects(s.createDatabase("test"), /already exists/);
  await assert.rejects(
    s.insertObjects("typo", "customers", [{}]),
    /does not exist/,
  );
  assert.deepEqual(await s.adapter.listDatabases(), ["test"]);
});
test("mixed JSON shapes, business id and supplied or generated _id round-trip in real OBJY", async () => {
  const s = await fixture();
  const rows = [
    {
      _id: "a",
      id: "business-a",
      active: true,
      tags: ["sample"],
      profile: { city: "Berlin" },
      nil: null,
    },
    { quantity: 3 },
    { name: "different", quantity: "three" },
    {},
  ];
  const result = await s.insertObjects("test", "customers", rows);
  assert.equal(result.inserted, 4);
  assert.ok(result.items[3]._id);
  const saved = await s.query("test", "customers");
  for (const [index, row] of rows.entries()) {
    const id = result.items[index]._id;
    assert.deepEqual(saved.find((object) => object._id === id), { ...row, _id: id });
  }
});
test("native filters, aggregation, references and partial vs full updates", async () => {
  const s = await fixture();
  await s.insertObjects("test", "customers", [
    {
      _id: "a",
      id: "business",
      active: true,
      profile: { city: "Berlin", zip: "123" },
      tags: ["sample"],
      score: 12,
      nil: null,
    },
    { score: 8 },
  ]);
  await s.patchObject("test", "customers", "a", {
    $set: { "profile.city": "Hamburg" },
    $unset: ["nil"],
  });
  const rows = await s.query("test", "customers", {
    active: true,
    tags: { $contains: "sample" },
  });
  assert.deepEqual(rows[0].profile, { city: "Hamburg", zip: "123" });
  assert.equal(rows[0].id, "business");
  assert.equal(Object.hasOwn(rows[0], "nil"), false);
  assert.deepEqual(
    await s.query("test", "customers", {
      $aggregate: {
        fields: { total: { $sum: "score" }, count: { $count: true } },
      },
    }),
    [{ total: 20, count: 2 }],
  );
  await s.insertObjects("test", "orders", [
    {
      _id: "o",
      customer: { type: "reference", collection: "customers", value: "a" },
    },
  ]);
  assert.equal((await s.query("test", "orders"))[0].customer.value, "a");
  assert.equal(
    (await s.query("test", "orders", {}, { refDepth: 1 }))[0].customer.object
      .id,
    "business",
  );
  await assert.rejects(
    async () => s.patchObject("test", "customers", "a", { $set: { _id: "b" } }),
    /cannot be patched/,
  );
  await assert.rejects(
    async () => s.replaceObject("test", "customers", "a", { _id: "b" }),
    /cannot be changed/,
  );
  await assert.rejects(
    async () =>
      s.patchObject("test", "customers", "a", {
        $set: { "__proto__.polluted": true },
      }),
    /Unsafe/,
  );
  await s.replaceObject("test", "customers", "a", { name: "Replaced" });
  assert.deepEqual((await s.query("test", "customers", { _id: "a" }))[0], {
    _id: "a",
    name: "Replaced",
  });
  const removed = await s.removeObjects("test", "customers", ["a", "missing"]);
  assert.equal(removed.deleted, 1);
});
test("metadata and catalog follow the database lifecycle", async () => {
  const s = await fixture();
  await s.setMeta("test", "customers", { label: "Customers" });
  assert.deepEqual(await s.getMeta("test", "customers"), {
    label: "Customers",
    indexes: [],
    columns: [],
  });
  await s.insertObjects("test", "customers", [
    { id: "custom", other: [false, null] },
  ]);
  assert.equal((await s.query("test", "customers")).length, 1);
  await s.dropCollection("test", "orders");
  assert.throws(() => s.assertCollection("test", "orders"), /does not exist/);
  assert.equal((await s.query("test", "customers")).length, 1);
  await s.dropCollection("test", "customers");
  assert.equal(s.assertDatabase("test").collections.length, 0);
  await s.dropDatabase("test");
  assert.equal(s.databases.length, 0);
  assert.throws(() => s.assertDatabase("test"), /does not exist/);
});
test("native duplicate-ID batch rejects without partial inserts; queue recovers", async () => {
  const s = await fixture();
  await s.insertObjects("test", "customers", [{ _id: "existing" }]);
  await assert.rejects(
    s.insertObjects("test", "customers", [{ _id: "new" }, { _id: "existing" }]),
  );
  assert.equal((await s.query("test", "customers")).length, 1);
  await s.insertObjects("test", "customers", [{ _id: "after" }]);
  assert.equal((await s.query("test", "customers")).length, 2);
});
test("independent servers do not share database objects or UI state", async () => {
  const s = await fixture();
  await s.insertObjects("test", "customers", [{ name: "temporary" }]);
  const second = await testStore();
  stores.push(second);
  assert.deepEqual(second.databases, []);
});

test("editor saves full JSON by immutable ID and guards against a changed server object", async () => {
  const s = await fixture();
  await s.insertObjects("test", "customers", [
    { _id: "edit-me", name: "Before", nested: { a: 1, b: 2 }, removeMe: true },
  ]);
  const original = (await s.query("test", "customers"))[0];
  const reordered = {
    removeMe: true,
    nested: { b: 2, a: 1 },
    name: "Before",
    _id: "edit-me",
  };
  const saved = await s.replaceObject(
    "test",
    "customers",
    "edit-me",
    { _id: "edit-me", name: "After", nested: { a: 3, b: 2 } },
    { expected: reordered },
  );
  assert.equal(saved._id, "edit-me");
  assert.equal(saved.name, "After");
  assert.equal(Object.hasOwn(saved, "removeMe"), false);
  await assert.rejects(
    s.replaceObject(
      "test",
      "customers",
      "edit-me",
      { _id: "edit-me", name: "Stale" },
      { expected: original },
    ),
    /changed on the server/,
  );
  assert.equal((await s.query("test", "customers"))[0].name, "After");
});

test("editor deletion checks the loaded version and removes only the selected ID", async () => {
  const s = await fixture();
  await s.insertObjects("test", "customers", [
    { _id: "a", value: 1 },
    { _id: "b", value: 1 },
  ]);
  const original = (await s.query("test", "customers", { _id: "a" }))[0];
  await s.patchObject("test", "customers", "a", { $set: { value: 2 } });
  await assert.rejects(
    s.removeObjects("test", "customers", ["a"], { expected: original }),
    /changed or was deleted/,
  );
  const latest = (await s.query("test", "customers", { _id: "a" }))[0];
  assert.equal(
    (await s.removeObjects("test", "customers", ["a"], { expected: latest }))
      .deleted,
    1,
  );
  assert.deepEqual(
    (await s.query("test", "customers")).map((o) => o._id),
    ["b"],
  );
});

test("metadata editor round-trips native metadata and rejects a stale edit", async () => {
  const s = await fixture(),
    original = await s.getMeta("test", "customers");
  await s.setMeta(
    "test",
    "customers",
    { ...original, label: "Customers", description: "Editable metadata" },
    { expected: original },
  );
  const saved = await s.getMeta("test", "customers");
  assert.equal(saved.label, "Customers");
  assert.deepEqual(saved.indexes, original.indexes);
  await assert.rejects(
    s.setMeta(
      "test",
      "customers",
      { ...original, label: "Stale" },
      { expected: original },
    ),
    /metadata changed/,
  );
  assert.equal((await s.getMeta("test", "customers")).label, "Customers");
});
