import { test } from "node:test";
import assert from "node:assert/strict";
import { CRDTNode } from "../src/crdt.js";

function makeNode(id) {
  return new CRDTNode({ id });
}

test("insert generates an id and get returns the object", () => {
  const n = makeNode("a");
  const id = n.insert("db", "users", { name: "ada", age: 36 });
  assert.ok(id);
  assert.match(id, /^[A-Za-z0-9_-]{16}$/);
  assert.deepEqual(n.get("db", "users", id), { _id: id, name: "ada", age: 36 });
});

test("auto-generated ids are compact and unique", () => {
  const n = makeNode("a");
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    const id = n.insert("db", "events", { n: i });
    assert.match(id, /^[A-Za-z0-9_-]{16}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 1000);
});

test("insert honours a caller-provided id", () => {
  const n = makeNode("a");
  n.insert("db", "users", { _id: "u1", name: "bob" });
  assert.deepEqual(n.get("db", "users", "u1"), { _id: "u1", name: "bob" });
  assert.throws(
    () => n.insert("db", "users", { _id: "u1", name: "alice" }),
    /object already exists: u1/,
  );
  assert.deepEqual(n.get("db", "users", "u1"), { _id: "u1", name: "bob" });
});

test("insert rejects empty caller-provided _ids", () => {
  const n = makeNode("a");
  assert.throws(
    () => n.insert("db", "users", { _id: "", name: "empty" }),
    /non-empty _id/,
  );
});

test("dynamic objects of any shape are stored", () => {
  const n = makeNode("a");
  n.insert("db", "c", { a: 1 });
  n.insert("db", "c", { b: "two", nested: { x: [1, 2] } });
  n.insert("db", "c", {});
  assert.equal(n.count("db", "c"), 3);
});

test("update merges fields; replace removes missing ones", () => {
  const n = makeNode("a");
  const id = n.insert("db", "c", { a: 1, b: 2, c: 3 });
  n.update("db", "c", id, { b: 20 });
  assert.deepEqual(n.get("db", "c", id), { _id: id, a: 1, b: 20, c: 3 });
  n.replace("db", "c", id, { a: 100 });
  assert.deepEqual(n.get("db", "c", id), { _id: id, a: 100 });
});

test("delete hides the object; re-insert resurrects it", () => {
  const n = makeNode("a");
  const id = n.insert("db", "c", { a: 1 });
  assert.equal(n.remove("db", "c", id), true);
  assert.equal(n.get("db", "c", id), undefined);
  n.update("db", "c", id, { a: 2 });
  assert.deepEqual(n.get("db", "c", id), { _id: id, a: 2 });
});

test("databases and collections are namespaced", () => {
  const n = makeNode("a");
  n.insert("db1", "c1", { _id: "same", v: 1 });
  n.insert("db1", "c2", { _id: "same", v: 2 });
  n.insert("db2", "c1", { _id: "same", v: 3 });
  assert.deepEqual(n.get("db1", "c1", "same"), { _id: "same", v: 1 });
  assert.deepEqual(n.get("db1", "c2", "same"), { _id: "same", v: 2 });
  assert.deepEqual(n.get("db2", "c1", "same"), { _id: "same", v: 3 });
  n.remove("db1", "c1", "same");
  assert.equal(n.get("db1", "c1", "same"), undefined);
  assert.deepEqual(n.get("db1", "c2", "same"), { _id: "same", v: 2 });
});

test("list returns live objects only", () => {
  const n = makeNode("a");
  n.insert("db", "c", { _id: "a", v: 1 });
  n.insert("db", "c", { _id: "b", v: 2 });
  n.insert("db", "c", { _id: "c", v: 3 });
  n.remove("db", "c", "b");
  assert.deepEqual(
    n.list("db", "c").map((o) => o._id).sort(),
    ["a", "c"],
  );
});

test("same shapes deduplicate within a collection", () => {
  const n = makeNode("a");
  for (let i = 0; i < 10; i++) n.insert("db", "c", { x: i, y: `s${i}`, z: true });
  const shapes = n.stats("db", "c");
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].rows, 10);
});

test("bulk operations are the internal write default", () => {
  const n = makeNode("a");
  const changes = [];
  n.onChange((change) => changes.push(change));

  const inserted = n.insertMany("db", "c", [
    { _id: "a", x: 1 },
    { _id: "b", x: 2 },
  ]);
  assert.equal(inserted.length, 2);
  assert.equal(changes[0].kind, "ops");
  assert.equal(changes[0].ops.length, 2);

  const updated = n.updateMany("db", "c", [
    { _id: "a", y: 10 },
    { _id: "b", y: 20 },
  ]);
  assert.equal(updated.updated, 2);
  assert.deepEqual(n.get("db", "c", "a"), { _id: "a", x: 1, y: 10 });

  const replaced = n.replaceMany("db", "c", [
    { _id: "a", z: true },
    { _id: "b", z: false },
  ]);
  assert.equal(replaced.replaced, 2);
  assert.deepEqual(n.get("db", "c", "a"), { _id: "a", z: true });

  const removed = n.removeMany("db", "c", ["a", "b", "missing"]);
  assert.equal(removed.deleted, 2);
  assert.deepEqual(removed.skipped, ["missing"]);
  assert.equal(n.count("db", "c"), 0);

  changes.length = 0;
  n.insert("db", "c", { _id: "single", v: 1 });
  assert.equal(changes[0].kind, "ops");
  assert.equal(changes[0].ops.length, 1);
});

test("bulk insert count path skips object hydration", () => {
  const n = makeNode("a");
  const originalGet = n.get.bind(n);
  let getCalls = 0;
  n.get = (...args) => {
    getCalls++;
    return originalGet(...args);
  };

  const inserted = n.insertManyCount("db", "c", [
    { _id: "a", x: 1 },
    { _id: "b", x: 2 },
  ]);

  assert.equal(inserted, 2);
  assert.equal(getCalls, 0);
  assert.deepEqual(originalGet("db", "c", "a"), { _id: "a", x: 1 });
});

test("bulk operations reject duplicate _ids", () => {
  const n = makeNode("a");
  n.insert("db", "c", { _id: "a", x: 1 });

  assert.throws(
    () => n.insertMany("db", "c", [{ _id: "a", x: 2 }, { _id: "b", x: 3 }]),
    /object already exists: a/,
  );
  assert.equal(n.get("db", "c", "b"), undefined);
  assert.deepEqual(n.get("db", "c", "a"), { _id: "a", x: 1 });

  assert.throws(
    () => n.insertMany("db", "c", [{ _id: "dup", x: 1 }, { _id: "dup", x: 2 }]),
    /duplicate _id in bulk request: dup/,
  );
  assert.throws(
    () => n.updateMany("db", "c", [{ _id: "a", y: 1 }, { _id: "a", z: 2 }]),
    /duplicate _id in bulk request: a/,
  );
  assert.throws(
    () => n.replaceMany("db", "c", [{ _id: "a", y: 1 }, { _id: "a", z: 2 }]),
    /duplicate _id in bulk request: a/,
  );
  assert.throws(
    () => n.removeMany("db", "c", ["a", "a"]),
    /duplicate _id in bulk request: a/,
  );
});
