import { test } from "node:test";
import assert from "node:assert/strict";
import { CRDTNode } from "../src/crdt.js";

function seedUsers(n) {
  n.insert("db", "users", {
    id: "ada",
    email: "ada@example.com",
    name: "Ada Lovelace",
    age: 36,
    status: "active",
    score: 10,
    tags: ["math", "admin"],
    profile: { city: "London" },
  });
  n.insert("db", "users", {
    id: "grace",
    email: "grace@example.com",
    name: "Grace Hopper",
    age: 85,
    status: "active",
    score: 20,
    tags: ["compiler"],
    profile: { city: "Arlington" },
  });
  n.insert("db", "users", {
    id: "linus",
    email: "linus@example.com",
    name: "Linus Torvalds",
    age: "unknown",
    status: "inactive",
    score: 5,
    tags: ["kernel"],
    profile: { city: "Helsinki" },
  });
}

test("find supports object-db query operators and nested paths", () => {
  const n = new CRDTNode({ id: "a" });
  seedUsers(n);

  assert.deepEqual(
    n.find("db", "users", { "profile.city": "London" }).map((o) => o.id),
    ["ada"],
  );
  assert.deepEqual(
    n.find("db", "users", { age: { $gte: 40 } }).map((o) => o.id),
    ["grace"],
  );
  assert.deepEqual(
    n.find("db", "users", { tags: { $contains: "admin" } }).map((o) => o.id),
    ["ada"],
  );
  assert.deepEqual(
    n.find("db", "users", { name: { $regex: { pattern: "hopper", flags: "i" } } }).map((o) => o.id),
    ["grace"],
  );
  assert.deepEqual(
    n.find("db", "users", { status: { $in: ["inactive"] } }).map((o) => o.id),
    ["linus"],
  );
  assert.equal(n.count("db", "users", { missing: { $exists: false } }), 3);
});

test("find supports old logical and scalar query operators", () => {
  const n = new CRDTNode({ id: "a" });
  seedUsers(n);

  assert.deepEqual(
    n.find("db", "users", { $or: [{ status: "inactive" }, { "profile.city": "London" }] }).map((o) => o.id),
    ["ada", "linus"],
  );
  assert.deepEqual(
    n.find("db", "users", { $and: [{ status: "active" }, { age: { $lt: 40 } }] }).map((o) => o.id),
    ["ada"],
  );
  assert.deepEqual(
    n.find("db", "users", { $not: { status: "active" } }).map((o) => o.id),
    ["linus"],
  );
  assert.deepEqual(
    n.find("db", "users", { $nor: [{ status: "active" }, { name: { $like: "Linus" } }] }),
    [],
  );
  assert.deepEqual(
    n.find("db", "users", { status: ["active", "inactive"] }).map((o) => o.id),
    ["ada", "grace", "linus"],
  );
  assert.deepEqual(
    n.find("db", "users", { status: { $nin: ["active"] } }).map((o) => o.id),
    ["linus"],
  );
  assert.deepEqual(
    n.find("db", "users", { name: { $likeI: "hopper" } }).map((o) => o.id),
    ["grace"],
  );
  assert.deepEqual(
    n.find("db", "users", { name: { $startsWith: "Ada" } }).map((o) => o.id),
    ["ada"],
  );
  assert.deepEqual(
    n.find("db", "users", { name: { $endsWith: "Torvalds" } }).map((o) => o.id),
    ["linus"],
  );
  assert.deepEqual(
    n.find("db", "users", { age: { $type: "number", $between: [30, 40] } }).map((o) => o.id),
    ["ada"],
  );
  assert.deepEqual(
    n.find("db", "users", { score: { $mod: [10, 0] } }).map((o) => o.id),
    ["ada", "grace"],
  );
});

test("find supports old null and array-object operators", () => {
  const n = new CRDTNode({ id: "a" });
  seedUsers(n);
  n.insert("db", "users", {
    id: "nulls",
    name: "",
    status: null,
    aliases: [{ kind: "primary", value: "n/a" }],
    emptyTags: ["", null],
  });

  assert.deepEqual(
    n.find("db", "users", { tags: "admin" }).map((o) => o.id),
    ["ada"],
  );
  assert.deepEqual(
    n.find("db", "users", { status: null }).map((o) => o.id),
    ["nulls"],
  );
  assert.deepEqual(
    n.find("db", "users", { emptyTags: { $exists: true, $null: true } }).map((o) => o.id),
    ["nulls"],
  );
  assert.deepEqual(
    n.find("db", "users", { aliases: { $elemMatch: { kind: "primary" } } }).map((o) => o.id),
    ["nulls"],
  );
  assert.deepEqual(
    n.find("db", "users", { tags: { $size: 2 } }).map((o) => o.id),
    ["ada"],
  );
});

test("find supports sorting, limits, and offsets", () => {
  const n = new CRDTNode({ id: "a" });
  seedUsers(n);

  assert.deepEqual(
    n.find("db", "users", {}, { sortBy: "score", sort: "desc", limit: 2 }).map((o) => o.id),
    ["grace", "ada"],
  );
  assert.deepEqual(
    n.find("db", "users", {}, { sortBy: "name", offset: 1, limit: 1 }).map((o) => o.id),
    ["grace"],
  );
});

test("equality indexes are maintained across updates and deletes", () => {
  const n = new CRDTNode({ id: "a" });
  seedUsers(n);
  n.createIndex("db", "users", "email");

  assert.deepEqual(
    n.find("db", "users", { email: "ada@example.com" }).map((o) => o.id),
    ["ada"],
  );

  n.update("db", "users", "ada", { email: "ada@history.example" });
  assert.deepEqual(n.find("db", "users", { email: "ada@example.com" }), []);
  assert.deepEqual(
    n.find("db", "users", { email: "ada@history.example" }).map((o) => o.id),
    ["ada"],
  );

  assert.equal(n.dropIndex("db", "users", "email"), true);
  n.createIndex("db", "users", "profile.city");
  n.remove("db", "users", "grace");
  assert.deepEqual(n.find("db", "users", { "profile.city": "Arlington" }), []);
});

test("reverse indexes narrow old equality, in, logical, array, and id queries", () => {
  const n = new CRDTNode({ id: "a" });
  seedUsers(n);
  n.createIndex("db", "users", "status");
  n.createIndex("db", "users", "tags");

  assert.equal(n.count("db", "users", { status: "active" }), 2);
  assert.deepEqual(
    n.find("db", "users", { status: { $in: ["inactive"] } }).map((o) => o.id),
    ["linus"],
  );
  assert.deepEqual(
    n.find("db", "users", { tags: "admin" }).map((o) => o.id),
    ["ada"],
  );
  assert.deepEqual(
    n.find("db", "users", { $or: [{ status: "inactive" }, { tags: "compiler" }] }).map((o) => o.id),
    ["linus", "grace"],
  );
  assert.deepEqual(
    n.find("db", "users", { _id: { $in: ["ada", "missing"] } }).map((o) => o.id),
    ["ada"],
  );

  n.update("db", "users", "ada", { tags: ["history"] });
  assert.deepEqual(n.find("db", "users", { tags: "admin" }), []);
  assert.deepEqual(
    n.find("db", "users", { tags: "history" }).map((o) => o.id),
    ["ada"],
  );
});

test("aggregate uses the same query matcher", () => {
  const n = new CRDTNode({ id: "a" });
  seedUsers(n);

  assert.deepEqual(n.aggregate("db", "users", { status: "active" }, { sum: "score", avg: "score" }), {
    count: 2,
    sum: { score: 30 },
    avg: { score: 15 },
  });

  assert.deepEqual(n.aggregate("db", "users", {}, { groupBy: "status", sum: "score" }), [
    { count: 2, key: "active", sum: { score: 30 } },
    { count: 1, key: "inactive", sum: { score: 5 } },
  ]);
});

test("aggregate supports old object-db aggregate specs", () => {
  const n = new CRDTNode({ id: "a" });
  seedUsers(n);

  assert.deepEqual(n.aggregate("db", "users", {}, {
    groupBy: "status",
    fields: {
      total: { $sum: "score" },
      average: { $avg: "score" },
      n: { $count: true },
    },
    $sort: { total: -1 },
  }), [
    { status: "active", total: 30, average: 15, n: 2 },
    { status: "inactive", total: 5, average: 5, n: 1 },
  ]);

  assert.deepEqual(n.aggregate("db", "users", { status: "active" }, {
    fields: {
      minScore: { $min: "score" },
      maxScore: { $max: "score" },
      scored: { $count: "score" },
    },
  }), [
    { minScore: 10, maxScore: 20, scored: 2 },
  ]);
});
