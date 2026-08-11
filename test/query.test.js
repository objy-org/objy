import { test } from "node:test";
import assert from "node:assert/strict";
import { CRDTNode } from "../src/crdt.js";
import { AGGREGATE_PATH, READ_PATH } from "../src/query-planner.js";

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

test("field indexes also drive sorted paging and stay fresh", () => {
  const n = new CRDTNode({ id: "a" });
  seedUsers(n);
  n.createIndex("db", "users", "score");

  assert.deepEqual(
    n.find("db", "users", {}, { sortBy: "score", sort: "desc", limit: 2 }).map((o) => o.id),
    ["grace", "ada"],
  );
  assert.equal(n.indexStats("db", "users")[0].orderedEntries, 3);

  n.update("db", "users", "linus", { score: 30 });
  assert.deepEqual(
    n.find("db", "users", {}, { sortBy: "score", sort: "desc", limit: 2 }).map((o) => o.id),
    ["linus", "grace"],
  );

  n.remove("db", "users", "linus");
  assert.deepEqual(
    n.find("db", "users", {}, { sortBy: "score", sort: "asc", limit: 3 }).map((o) => o.id),
    ["ada", "grace"],
  );
});

test("ordered index verifies filters it cannot prove", () => {
  const n = new CRDTNode({ id: "a" });
  n.insertMany("db", "items", [
    { id: "a", bucket: "b1", score: 1 },
    { id: "b", score: 2 },
    { id: "c", bucket: "b2", score: 3 },
  ]);
  n.createIndex("db", "items", "id");

  assert.deepEqual(
    n.find("db", "items", { bucket: { $exists: false } }, { sortBy: "id", sort: "asc" }).map((o) => o.id),
    ["b"],
  );
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

test("queries can follow live reference objects", () => {
  const n = new CRDTNode({ id: "a" });
  n.insertMany("db", "authors", [
    { id: "alice", name: "Alice", score: 10 },
    { id: "bob", name: "Bob", score: 20 },
  ]);
  n.insertMany("db", "posts", [
    { id: "p1", title: "One", author: { type: "reference", collection: "authors", value: "alice" } },
    { id: "p2", title: "Two", author: { type: "reference", collection: "authors", value: "bob" } },
    { id: "p3", title: "Missing", author: { type: "reference", collection: "authors", value: "missing" } },
  ]);

  assert.equal(n.get("db", "posts", "p1").author.object, undefined);
  assert.equal(n.get("db", "posts", "p1", { refDepth: 1 }).author.object.name, "Alice");
  assert.deepEqual(
    n.find("db", "posts", { "author.object.name": "Alice" }).map((post) => post.id),
    ["p1"],
  );

  n.update("db", "authors", "alice", { name: "Ada" });
  assert.deepEqual(
    n.find("db", "posts", { "author.object.name": "Ada" }).map((post) => post.id),
    ["p1"],
  );
  assert.deepEqual(
    n.find("db", "posts", { "author.object": null }).map((post) => post.id),
    ["p3"],
  );

  const sorted = n.find("db", "posts", {}, { sortBy: "author.object.score", sort: "asc" });
  assert.deepEqual(sorted.map((post) => post.id), ["p1", "p2", "p3"]);

  assert.deepEqual(
    n.aggregate("db", "posts", { "author.object": { $ne: null } }, {
      groupBy: "author.object.name",
      sum: "author.object.score",
    }),
    [
      { count: 1, key: "Ada", sum: { "author.object.score": 10 } },
      { count: 1, key: "Bob", sum: { "author.object.score": 20 } },
    ],
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

test("column indexes drive object-db aggregates and stay fresh", async () => {
  const n = new CRDTNode({ id: "a" });
  n.createCollection("db", "users", {
    indexes: ["status"],
    columnIndexes: ["status", "score"],
  });
  seedUsers(n);
  await n.awaitColumnIndexes("db", "users");

  assert.deepEqual(
    n.indexStats("db", "users")
      .filter((entry) => entry.type === "column")
      .map(({ path, status, entries }) => ({ path, status, entries })),
    [
      { path: "status", status: "ready", entries: 3 },
      { path: "score", status: "ready", entries: 3 },
    ],
  );

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

  const collection = n.db.collection("db", "users");
  const originalRead = collection.read.bind(collection);
  let reads = 0;
  collection.read = (id) => {
    reads++;
    return originalRead(id);
  };
  assert.deepEqual(n.aggregate("db", "users", {}, {
    fields: {
      totalScore: { $sum: "score" },
    },
  }), [
    { totalScore: 35 },
  ]);
  assert.equal(reads, 0);
  collection.read = originalRead;

  n.update("db", "users", "ada", { status: "inactive", score: 15 });
  n.remove("db", "users", "linus");

  assert.deepEqual(n.aggregate("db", "users", {}, {
    groupBy: "status",
    fields: {
      total: { $sum: "score" },
      n: { $count: true },
    },
    $sort: { total: -1 },
  }), [
    { status: "active", total: 20, n: 1 },
    { status: "inactive", total: 15, n: 1 },
  ]);
});

test("query planner chooses old index-style read and aggregate paths", async () => {
  const n = new CRDTNode({ id: "a" });
  n.createCollection("db", "users", {
    indexes: ["status"],
    columnIndexes: ["score", "profile.city"],
  });
  seedUsers(n);
  await n.awaitColumnIndexes("db", "users");

  const collection = n.db.collection("db", "users");
  assert.equal(collection._planRead({ status: "active" }, {}).path, READ_PATH.INDEX_EXACT);
  assert.equal(collection._planRead({ status: "active", age: { $gt: 30 } }, {}).path, READ_PATH.INDEX_PARTIAL);
  assert.equal(collection._planRead({ age: { $gt: 30 } }, {}).path, READ_PATH.SCAN);
  assert.equal(collection._planRead({}, { sortBy: "status" }).path, READ_PATH.ORDERED_INDEX);
  assert.equal(collection._planRead({}, { sortBy: "score" }).path, READ_PATH.SCAN);

  assert.equal(collection._planAggregate({}, {
    fields: {
      total: { $sum: "score" },
    },
  }).path, AGGREGATE_PATH.COLUMN_SUMMARY);
  assert.equal(collection._planAggregate({ status: "active" }, {
    fields: {
      total: { $sum: "score" },
    },
  }).path, AGGREGATE_PATH.COLUMN_SCAN);
  assert.equal(collection._planAggregate({}, {
    groupBy: "status",
    fields: {
      total: { $sum: "score" },
    },
  }).path, AGGREGATE_PATH.GROUP_INDEX);
  assert.equal(collection._planAggregate({}, {
    groupBy: "profile.city",
    fields: {
      total: { $sum: "score" },
    },
  }).path, AGGREGATE_PATH.GROUP_COLUMN_SCAN);
  assert.equal(collection._planAggregate({}, {
    fields: {
      total: { $sum: "missingColumn" },
    },
  }).path, AGGREGATE_PATH.SCAN);
});

test("column indexes build in the background and absorb live deltas", async () => {
  const n = new CRDTNode({ id: "a" });
  const objects = [];
  for (let i = 0; i < 512; i++) {
    objects.push({
      id: `e${i}`,
      status: i % 2 === 0 ? "hot" : "cold",
      score: i,
      payload: { bucket: i % 8 },
    });
  }
  n.insertMany("db", "events", objects);
  n.createIndex("db", "events", "status");
  n.setCollectionMeta("db", "events", {
    indexes: ["status"],
    columnIndexes: ["score", "payload"],
  });

  n.update("db", "events", "e10", { score: 100, payload: { bucket: "changed" } });
  n.remove("db", "events", "e11");

  assert.deepEqual(n.aggregate("db", "events", { status: "hot" }, {
    fields: {
      total: { $sum: "score" },
      payloads: { $count: "payload" },
      n: { $count: true },
    },
  }), [
    { total: 65370, payloads: 256, n: 256 },
  ]);

  await n.awaitColumnIndexes("db", "events");
  const columns = n.indexStats("db", "events").filter((entry) => entry.type === "column");
  assert.equal(columns.every((entry) => entry.status === "ready"), true);
  assert.equal(columns.find((entry) => entry.path === "payload").nonScalarEntries, 511);

  assert.deepEqual(n.aggregate("db", "events", { status: "hot" }, {
    fields: {
      total: { $sum: "score" },
      payloads: { $count: "payload" },
      n: { $count: true },
    },
  }), [
    { total: 65370, payloads: 256, n: 256 },
  ]);
});
