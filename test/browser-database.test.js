import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase } from "../src/browser.js";
import { CRDTNode } from "../src/crdt.js";

test("local database mode does not retain replication operations", () => {
  const node = new CRDTNode({ operationLog: false });
  node.insertMany("app", "items", [{ _id: "one", value: 1 }, { _id: "two", value: 2 }]);
  assert.equal(node.log.length, 0);
  assert.equal(node.count("app", "items"), 2);
});

test("browser database reuses bulk CRUD, indexes, columns, tiering and references", async () => {
  const database = createDatabase({ storage: { engine: "object" } });
  await database.createDatabase("app");
  const app = database.database("app");
  await app.createCollection("teams");
  await app.createCollection("assets", {
    indexes: ["status", "team.object.name"],
    columns: ["cost"],
    tiering: { mode: "compressedMemory", keep: ["name", "status", "team", "cost"], minBytes: 1 },
  });

  const teams = app.collection("teams");
  const assets = app.collection("assets");
  await teams.insert({ _id: "platform", name: "Platform" });
  const inserted = await assets.insertMany([
    {
      _id: "a",
      name: "Laptop",
      status: "active",
      cost: 100,
      details: { notes: "cold ".repeat(100) },
      team: { type: "reference", collection: "teams", value: "platform" },
    },
    { _id: "b", name: "Phone", status: "archived", cost: 40, details: { notes: "old ".repeat(100) } },
  ]);
  assert.equal(inserted.inserted, 2);
  await assets.ready();

  assert.deepEqual((await assets.find({ status: "active", $refDepth: 1 })).map((row) => row._id), ["a"]);
  assert.equal((await assets.get("a")).team.object.name, "Platform");
  assert.deepEqual(await assets.search({
    $aggregate: { fields: { total: { $sum: "cost" }, count: { $count: true } } },
  }), [{ total: 140, count: 2 }]);

  const patched = await assets.patch("a", { $set: { "details.owner": "Ada" }, $unset: ["details.notes"] });
  assert.deepEqual(patched.details, { owner: "Ada" });
  assert.equal(assets.stats().compression.compressedObjects, 2);

  await assets.removeMany(["a", "missing"]);
  assert.equal(await assets.count(), 1);
  database.close();
});

test("browser database builds and queries its vector index", async () => {
  const database = createDatabase();
  await database.createDatabase("app");
  await database.database("app").createCollection("documents");
  const documents = database.database("app").collection("documents");
  await documents.insertMany([
    { _id: "near", category: "guide", _vec: [1, 0] },
    { _id: "far", category: "guide", _vec: [0, 1] },
  ]);
  await documents.ready();

  const rows = await documents.search({
    category: "guide",
    $vector: { vector: [1, 0], limit: 1 },
  });
  assert.equal(rows[0]._id, "near");
  assert.equal(rows[0]._score, 1);
  database.close();
});
