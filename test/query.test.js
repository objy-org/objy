import { test } from "node:test";
import assert from "node:assert/strict";
import { CRDTNode } from "../src/crdt.js";
import { AGGREGATE_PATH, READ_PATH } from "../src/query-planner.js";

function seedUsers(n) {
  n.insert("db", "users", {
    _id: "ada",
    email: "ada@example.com",
    name: "Ada Lovelace",
    age: 36,
    status: "active",
    score: 10,
    tags: ["math", "admin"],
    profile: { city: "London" },
  });
  n.insert("db", "users", {
    _id: "grace",
    email: "grace@example.com",
    name: "Grace Hopper",
    age: 85,
    status: "active",
    score: 20,
    tags: ["compiler"],
    profile: { city: "Arlington" },
  });
  n.insert("db", "users", {
    _id: "linus",
    email: "linus@example.com",
    name: "Linus Torvalds",
    age: "unknown",
    status: "inactive",
    score: 5,
    tags: ["kernel"],
    profile: { city: "Helsinki" },
  });
}

const storageEngines = [
  { name: "shape", storage: { engine: "shape" } },
  {
    name: "object",
    storage: {
      engine: "object",
      object: { valueDirectory: { enabled: false } },
    },
  },
];

test("find supports object-db query operators and nested paths", () => {
  const n = new CRDTNode({ id: "a" });
  seedUsers(n);

  assert.deepEqual(
    n.find("db", "users", { "profile.city": "London" }).map((o) => o._id),
    ["ada"],
  );
  assert.deepEqual(
    n.find("db", "users", { age: { $gte: 40 } }).map((o) => o._id),
    ["grace"],
  );
  assert.deepEqual(
    n.find("db", "users", { tags: { $contains: "admin" } }).map((o) => o._id),
    ["ada"],
  );
  assert.deepEqual(
    n.find("db", "users", { name: { $regex: { pattern: "hopper", flags: "i" } } }).map((o) => o._id),
    ["grace"],
  );
  assert.deepEqual(
    n.find("db", "users", { status: { $in: ["inactive"] } }).map((o) => o._id),
    ["linus"],
  );
  assert.equal(n.count("db", "users", { missing: { $exists: false } }), 3);
});

test("find supports old logical and scalar query operators", () => {
  const n = new CRDTNode({ id: "a" });
  seedUsers(n);

  assert.deepEqual(
    n.find("db", "users", { $or: [{ status: "inactive" }, { "profile.city": "London" }] }).map((o) => o._id),
    ["ada", "linus"],
  );
  assert.deepEqual(
    n.find("db", "users", { $and: [{ status: "active" }, { age: { $lt: 40 } }] }).map((o) => o._id),
    ["ada"],
  );
  assert.deepEqual(
    n.find("db", "users", { $not: { status: "active" } }).map((o) => o._id),
    ["linus"],
  );
  assert.deepEqual(
    n.find("db", "users", { $nor: [{ status: "active" }, { name: { $like: "Linus" } }] }),
    [],
  );
  assert.deepEqual(
    n.find("db", "users", { status: ["active", "inactive"] }).map((o) => o._id),
    ["ada", "grace", "linus"],
  );
  assert.deepEqual(
    n.find("db", "users", { status: { $nin: ["active"] } }).map((o) => o._id),
    ["linus"],
  );
  assert.deepEqual(
    n.find("db", "users", { name: { $likeI: "hopper" } }).map((o) => o._id),
    ["grace"],
  );
  assert.deepEqual(
    n.find("db", "users", { name: { $startsWith: "Ada" } }).map((o) => o._id),
    ["ada"],
  );
  assert.deepEqual(
    n.find("db", "users", { name: { $endsWith: "Torvalds" } }).map((o) => o._id),
    ["linus"],
  );
  assert.deepEqual(
    n.find("db", "users", { age: { $type: "number", $between: [30, 40] } }).map((o) => o._id),
    ["ada"],
  );
  assert.deepEqual(
    n.find("db", "users", { score: { $mod: [10, 0] } }).map((o) => o._id),
    ["ada", "grace"],
  );
});

test("find supports old null and array-object operators", () => {
  const n = new CRDTNode({ id: "a" });
  seedUsers(n);
  n.insert("db", "users", {
    _id: "nulls",
    name: "",
    status: null,
    aliases: [{ kind: "primary", value: "n/a" }],
    emptyTags: ["", null],
  });

  assert.deepEqual(
    n.find("db", "users", { tags: "admin" }).map((o) => o._id),
    ["ada"],
  );
  assert.deepEqual(
    n.find("db", "users", { status: null }).map((o) => o._id),
    ["nulls"],
  );
  assert.deepEqual(
    n.find("db", "users", { emptyTags: { $exists: true, $null: true } }).map((o) => o._id),
    ["nulls"],
  );
  assert.deepEqual(
    n.find("db", "users", { aliases: { $elemMatch: { kind: "primary" } } }).map((o) => o._id),
    ["nulls"],
  );
  assert.deepEqual(
    n.find("db", "users", { tags: { $size: 2 } }).map((o) => o._id),
    ["ada"],
  );
});

test("find supports sorting, limits, and offsets", () => {
  const n = new CRDTNode({ id: "a" });
  seedUsers(n);

  assert.deepEqual(
    n.find("db", "users", {}, { sortBy: "score", sort: "desc", limit: 2 }).map((o) => o._id),
    ["grace", "ada"],
  );
  assert.deepEqual(
    n.find("db", "users", {}, { sortBy: "name", offset: 1, limit: 1 }).map((o) => o._id),
    ["grace"],
  );
});

test("equality indexes are maintained across updates and deletes", () => {
  const n = new CRDTNode({ id: "a" });
  seedUsers(n);
  n.createIndex("db", "users", "email");

  assert.deepEqual(
    n.find("db", "users", { email: "ada@example.com" }).map((o) => o._id),
    ["ada"],
  );

  n.update("db", "users", "ada", { email: "ada@history.example" });
  assert.deepEqual(n.find("db", "users", { email: "ada@example.com" }), []);
  assert.deepEqual(
    n.find("db", "users", { email: "ada@history.example" }).map((o) => o._id),
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
    n.find("db", "users", {}, { sortBy: "score", sort: "desc", limit: 2 }).map((o) => o._id),
    ["grace", "ada"],
  );
  assert.equal(n.indexStats("db", "users")[0].orderedEntries, 3);

  n.update("db", "users", "linus", { score: 30 });
  assert.deepEqual(
    n.find("db", "users", {}, { sortBy: "score", sort: "desc", limit: 2 }).map((o) => o._id),
    ["linus", "grace"],
  );

  n.remove("db", "users", "linus");
  assert.deepEqual(
    n.find("db", "users", {}, { sortBy: "score", sort: "asc", limit: 3 }).map((o) => o._id),
    ["ada", "grace"],
  );
});

test("ordered index verifies filters it cannot prove", () => {
  const n = new CRDTNode({ id: "a" });
  n.insertMany("db", "items", [
    { _id: "a", bucket: "b1", score: 1 },
    { _id: "b", score: 2 },
    { _id: "c", bucket: "b2", score: 3 },
  ]);
  n.createIndex("db", "items", "_id");

  assert.deepEqual(
    n.find("db", "items", { bucket: { $exists: false } }, { sortBy: "_id", sort: "asc" }).map((o) => o._id),
    ["b"],
  );
});

test("reverse indexes narrow old equality, in, logical, array, and _id queries", () => {
  const n = new CRDTNode({ id: "a" });
  seedUsers(n);
  n.createIndex("db", "users", "status");
  n.createIndex("db", "users", "tags");

  assert.equal(n.count("db", "users", { status: "active" }), 2);
  assert.deepEqual(
    n.find("db", "users", { status: { $in: ["inactive"] } }).map((o) => o._id),
    ["linus"],
  );
  assert.deepEqual(
    n.find("db", "users", { tags: "admin" }).map((o) => o._id),
    ["ada"],
  );
  assert.deepEqual(
    n.find("db", "users", { $or: [{ status: "inactive" }, { tags: "compiler" }] }).map((o) => o._id),
    ["linus", "grace"],
  );
  assert.deepEqual(
    n.find("db", "users", { _id: { $in: ["ada", "missing"] } }).map((o) => o._id),
    ["ada"],
  );

  n.update("db", "users", "ada", { tags: ["history"] });
  assert.deepEqual(n.find("db", "users", { tags: "admin" }), []);
  assert.deepEqual(
    n.find("db", "users", { tags: "history" }).map((o) => o._id),
    ["ada"],
  );
});

test("queries can follow live reference objects", () => {
  const n = new CRDTNode({ id: "a" });
  n.insertMany("db", "authors", [
    { _id: "alice", name: "Alice", score: 10 },
    { _id: "bob", name: "Bob", score: 20 },
  ]);
  n.insertMany("db", "posts", [
    { _id: "p1", title: "One", author: { type: "reference", collection: "authors", value: "alice" } },
    { _id: "p2", title: "Two", author: { type: "reference", collection: "authors", value: "bob" } },
    { _id: "p3", title: "Missing", author: { type: "reference", collection: "authors", value: "missing" } },
  ]);

  assert.equal(n.get("db", "posts", "p1").author.object, undefined);
  assert.equal(n.get("db", "posts", "p1", { refDepth: 1 }).author.object.name, "Alice");
  const expanded = n.get("db", "posts", "p1", { refDepth: 1 });
  expanded.author.object.name = "Changed";
  assert.equal(n.get("db", "authors", "alice").name, "Alice");
  assert.equal(n.get("db", "posts", "p1").author.object, undefined);
  assert.deepEqual(
    n.find("db", "posts", { "author.object.name": "Alice" }).map((post) => post._id),
    ["p1"],
  );

  n.update("db", "authors", "alice", { name: "Ada" });
  assert.deepEqual(
    n.find("db", "posts", { "author.object.name": "Ada" }).map((post) => post._id),
    ["p1"],
  );
  assert.deepEqual(
    n.find("db", "posts", { "author.object": null }).map((post) => post._id),
    ["p3"],
  );

  const sorted = n.find("db", "posts", {}, { sortBy: "author.object.score", sort: "asc" });
  assert.deepEqual(sorted.map((post) => post._id), ["p1", "p2", "p3"]);

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

for (const { name, storage } of storageEngines) {
  test(`query scans use fast reads and return isolated objects with ${name} storage`, () => {
    const n = new CRDTNode({ id: `query-${name}`, storage });
    n.insertMany("db", "items", [
      { _id: "a", status: "hot", score: 10, tags: ["x"], nested: { flag: true } },
      { _id: "b", status: "cold", score: 20, tags: ["y"], nested: { flag: false } },
    ]);

    const collection = n.db.collection("db", "items");
    const originalRead = collection.read.bind(collection);
    const originalReadForQuery = collection.readForQuery.bind(collection);
    let safeReads = 0;
    let queryReads = 0;
    collection.read = (id) => {
      safeReads++;
      return originalRead(id);
    };
    collection.readForQuery = (id) => {
      queryReads++;
      return originalReadForQuery(id);
    };

    const rows = n.find("db", "items", { "nested.flag": true }, { limit: 1 });

    collection.read = originalRead;
    collection.readForQuery = originalReadForQuery;
    assert.deepEqual(rows.map((row) => row._id), ["a"]);
    assert.equal(safeReads, 1);
    assert.equal(queryReads, 1);

    rows[0].nested.flag = false;
    rows[0].tags.push("mutated");
    assert.equal(n.get("db", "items", "a").nested.flag, true);
    assert.deepEqual(n.get("db", "items", "a").tags, ["x"]);
  });

  test(`fallback aggregates use fast reads and return isolated values with ${name} storage`, () => {
    const n = new CRDTNode({ id: `aggregate-${name}`, storage });
    n.insertMany("db", "items", [
      { _id: "a", bucket: { name: "one" }, payload: { rank: 1 }, score: 10 },
      { _id: "b", bucket: { name: "two" }, payload: { rank: 2 }, score: 20 },
    ]);

    const collection = n.db.collection("db", "items");
    const originalRead = collection.read.bind(collection);
    const originalReadForQuery = collection.readForQuery.bind(collection);
    let safeReads = 0;
    let queryReads = 0;
    collection.read = (id) => {
      safeReads++;
      return originalRead(id);
    };
    collection.readForQuery = (id) => {
      queryReads++;
      return originalReadForQuery(id);
    };

    const grouped = n.aggregate("db", "items", {}, {
      groupBy: "bucket",
      fields: { n: { $count: true } },
    });
    const legacy = n.aggregate("db", "items", {}, { min: "payload" });

    collection.read = originalRead;
    collection.readForQuery = originalReadForQuery;
    assert.equal(safeReads, 0);
    assert.ok(queryReads >= 4);

    const one = grouped.find((row) => row.bucket.name === "one");
    assert.ok(one);
    one.bucket.name = "changed";
    legacy.min.payload.rank = 999;

    assert.equal(n.get("db", "items", "a").bucket.name, "one");
    assert.equal(n.get("db", "items", "a").payload.rank, 1);
  });
}

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
    columns: ["status", "score"],
  });
  seedUsers(n);
  await n.awaitColumns("db", "users");

  assert.deepEqual(
    n.indexStats("db", "users")
      .filter((entry) => entry.type === "column")
      .map(({ path, status, entries }) => ({ path, status, entries })),
    [
      { path: "status", status: "ready", entries: 3 },
      { path: "score", status: "ready", entries: 3 },
    ],
  );
  const scoreColumn = n.db.collection("db", "users").columns.get("score");
  assert.equal(scoreColumn.hasScalar(n.db.collection("db", "users")._ridForId("ada")), true);
  assert.equal(scoreColumn.valueFor(n.db.collection("db", "users")._ridForId("grace")), 20);

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

test("columns store selected paths outside base rows and hydrate snapshots", async () => {
  const n = new CRDTNode({ id: "a" });
  n.createCollection("db", "events", {
    indexes: ["status"],
    columns: ["score", "nested.value"],
  });
  n.insert("db", "events", {
    _id: "e1",
    status: "hot",
    score: 7,
    nested: { value: 11, keep: true },
  });
  await n.awaitColumns("db", "events");

  const collection = n.db.collection("db", "events");
  assert.deepEqual(collection.store.readForQuery("e1"), {
    status: "hot",
    nested: { keep: true },
  });
  assert.deepEqual(n.get("db", "events", "e1"), {
    _id: "e1",
    status: "hot",
    score: 7,
    nested: { keep: true, value: 11 },
  });
  assert.deepEqual(n.aggregate("db", "events", {}, {
    fields: {
      total: { $sum: "score" },
      nestedTotal: { $sum: "nested.value" },
    },
  }), [{ total: 7, nestedTotal: 11 }]);

  const [snapshot] = [...collection.snapshotObjects()];
  assert.deepEqual(snapshot.value, {
    status: "hot",
    nested: { keep: true, value: 11 },
    score: 7,
  });

  const fresh = new CRDTNode({ id: "fresh" });
  fresh.createCollection("db", "events", { indexes: ["status"], columns: ["score", "nested.value"] });
  fresh.applySnapshot("a", { collections: [{ db: "db", coll: "events", objects: [snapshot] }] });
  assert.deepEqual(fresh.get("db", "events", "e1"), n.get("db", "events", "e1"));
});

test("query planner chooses old index-style read and aggregate paths", async () => {
  const n = new CRDTNode({ id: "a" });
  n.createCollection("db", "users", {
    indexes: ["status"],
    columns: ["score", "profile.city"],
  });
  seedUsers(n);
  await n.awaitColumns("db", "users");

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
  assert.equal(collection._planAggregate({ status: "active" }, {
    groupBy: "status",
    fields: {
      total: { $sum: "score" },
    },
  }).path, AGGREGATE_PATH.GROUP_FORWARD_INDEX);
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

test("indexed grouped count aggregates use bucket counts", async () => {
  const n = new CRDTNode({ id: "a" });
  n.createCollection("db", "assets", {
    indexes: ["applications", "properties.department.value"],
    columns: ["score"],
  });

  const departments = ["ops", "rd", "sales"];
  const expected = new Map(departments.map((department) => [department, { count: 0, score: 0 }]));
  const rows = [];
  for (let i = 0; i < 1000; i++) {
    const department = departments[i % departments.length];
    const score = i % 11;
    const applications = i % 2 === 0 ? ["assetmanagement", "core"] : ["crm"];
    rows.push({
      _id: `asset-${i}`,
      applications,
      properties: {
        department: { value: department },
      },
      score,
    });
    if (applications.includes("assetmanagement")) {
      expected.get(department).count++;
      expected.get(department).score += score;
    }
  }
  n.insertMany("db", "assets", rows);
  await n.awaitColumns("db", "assets");

  const spec = {
    groupBy: "properties.department.value",
    fields: {
      _count: { $count: true },
    },
    $sort: { "properties.department.value": 1 },
  };
  const collection = n.db.collection("db", "assets");
  assert.equal(collection._planAggregate({ applications: "assetmanagement" }, spec).path, AGGREGATE_PATH.GROUP_INDEX);
  assert.equal(collection._planAggregate({ applications: { $contains: "assetmanagement" } }, spec).path, AGGREGATE_PATH.GROUP_INDEX);

  const groupIndex = collection.indexes.get("properties.department.value");
  const originalIterateGroups = groupIndex.iterateGroups;
  const originalReadForQuery = collection.readForQuery;
  groupIndex.iterateGroups = function* () {
    throw new Error("grouped count aggregate walked IDs");
  };
  collection.readForQuery = () => {
    throw new Error("grouped count aggregate read objects");
  };
  try {
    assert.deepEqual(
      n.aggregate("db", "assets", { applications: "assetmanagement" }, spec),
      [...expected.entries()].map(([department, values]) => ({
        "properties.department.value": department,
        _count: values.count,
      })),
    );
    assert.deepEqual(
      n.aggregate("db", "assets", { applications: { $contains: "assetmanagement" } }, spec),
      [...expected.entries()].map(([department, values]) => ({
        "properties.department.value": department,
        _count: values.count,
      })),
    );
  } finally {
    groupIndex.iterateGroups = originalIterateGroups;
    collection.readForQuery = originalReadForQuery;
  }

  n.update("db", "assets", "asset-0", {
    _id: "asset-0",
    applications: ["crm"],
    properties: { department: { value: "ops" } },
    score: 0,
  });
  expected.get("ops").count--;
  assert.deepEqual(
    n.aggregate("db", "assets", { applications: { $contains: "assetmanagement" } }, spec),
    [...expected.entries()].map(([department, values]) => ({
      "properties.department.value": department,
      _count: values.count,
    })),
  );

  n.remove("db", "assets", "asset-6");
  expected.get("ops").count--;
  expected.get("ops").score -= 6;
  assert.deepEqual(
    n.aggregate("db", "assets", { applications: { $contains: "assetmanagement" } }, spec),
    [...expected.entries()].map(([department, values]) => ({
      "properties.department.value": department,
      _count: values.count,
    })),
  );

  assert.deepEqual(
    n.aggregate("db", "assets", { applications: "assetmanagement" }, {
      groupBy: "properties.department.value",
      fields: {
        _count: { $count: true },
        totalScore: { $sum: "score" },
      },
      $sort: { "properties.department.value": 1 },
    }),
    [...expected.entries()].map(([department, values]) => ({
      "properties.department.value": department,
      _count: values.count,
      totalScore: values.score,
    })),
  );

  const strings = new CRDTNode({ id: "strings" });
  strings.createCollection("db", "docs", { indexes: ["title"] });
  strings.insertMany("db", "docs", [
    { _id: "a", title: "assetmanagement" },
    { _id: "b", title: "asset" },
  ]);
  assert.equal(strings.db.collection("db", "docs")._planRead({ title: { $contains: "asset" } }, {}).path, READ_PATH.SCAN);
  assert.equal(strings.db.collection("db", "docs")._planAggregate({ title: { $contains: "asset" } }, {
    groupBy: "title",
    fields: { _count: { $count: true } },
  }).path, AGGREGATE_PATH.SCAN);
  assert.equal(collection._planAggregate({ applications: { $in: ["assetmanagement", "core"] } }, spec).path, AGGREGATE_PATH.GROUP_INDEX);
});

test("indexed grouped metric aggregates use forward index values and column maps", async () => {
  const n = new CRDTNode({ id: "a" });
  n.createCollection("db", "assets", {
    indexes: ["applications", "properties.department.value"],
    columns: ["score", "cost", "label"],
  });
  n.insertMany("db", "assets", [
    {
      _id: "a1",
      applications: ["assetmanagement", "core"],
      properties: { department: { value: "ops" } },
      score: 10,
      cost: 100,
      label: "charlie",
    },
    {
      _id: "a2",
      applications: ["assetmanagement"],
      properties: { department: { value: "ops" } },
      score: 20,
      cost: 50,
      label: "alpha",
    },
    {
      _id: "a3",
      applications: ["assetmanagement"],
      properties: { department: { value: "rd" } },
      score: 5,
      cost: 30,
      label: "bravo",
    },
    {
      _id: "a4",
      applications: ["crm"],
      properties: { department: { value: "ops" } },
      score: 100,
      cost: 1000,
      label: "ignored",
    },
  ]);
  await n.awaitColumns("db", "assets");

  const spec = {
    groupBy: "properties.department.value",
    fields: {
      totalScore: { $sum: "score" },
      averageCost: { $avg: "cost" },
      minLabel: { $min: "label" },
      maxScore: { $max: "score" },
      n: { $count: true },
    },
    $sort: { "properties.department.value": 1 },
  };
  const collection = n.db.collection("db", "assets");
  assert.equal(
    collection._planAggregate({ applications: { $contains: "assetmanagement" } }, spec).path,
    AGGREGATE_PATH.GROUP_FORWARD_INDEX,
  );

  const groupIndex = collection.indexes.get("properties.department.value");
  const originalIterateGroups = groupIndex.iterateGroups;
  const originalReadForQuery = collection.readForQuery;
  groupIndex.iterateGroups = function* () {
    throw new Error("forward aggregate walked group buckets");
  };
  collection.readForQuery = () => {
    throw new Error("forward aggregate read objects");
  };
  try {
    assert.deepEqual(
      n.aggregate("db", "assets", { applications: { $contains: "assetmanagement" } }, spec),
      [
        {
          "properties.department.value": "ops",
          totalScore: 30,
          averageCost: 75,
          minLabel: "alpha",
          maxScore: 20,
          n: 2,
        },
        {
          "properties.department.value": "rd",
          totalScore: 5,
          averageCost: 30,
          minLabel: "bravo",
          maxScore: 5,
          n: 1,
        },
      ],
    );
  } finally {
    groupIndex.iterateGroups = originalIterateGroups;
    collection.readForQuery = originalReadForQuery;
  }

  n.update("db", "assets", "a2", {
    applications: ["assetmanagement"],
    properties: { department: { value: "rd" } },
    score: 25,
    cost: 70,
    label: "delta",
  });
  n.remove("db", "assets", "a1");

  assert.deepEqual(
    n.aggregate("db", "assets", { applications: { $contains: "assetmanagement" } }, spec),
    [
      {
        "properties.department.value": "rd",
        totalScore: 30,
        averageCost: 50,
        minLabel: "bravo",
        maxScore: 25,
        n: 2,
      },
    ],
  );
});

test("shard scoped grouped count aggregates use shard id sets", () => {
  const n = new CRDTNode({
    id: "a",
    shardMap: {
      shards: {
        "shard-0": { peers: [] },
        "shard-1": { peers: [] },
      },
    },
  });
  n.createCollection("db", "assets", {
    indexes: ["applications", "properties.department.value"],
  });

  const expected = new Map();
  const rows = [];
  for (let i = 0; i < 1000; i++) {
    const department = i % 3 === 0 ? "ops" : "rd";
    const applications = i % 2 === 0 ? ["assetmanagement"] : ["crm"];
    const row = {
      _id: `asset-${i}`,
      applications,
      properties: { department: { value: department } },
    };
    rows.push(row);
    if (n.shardForObject("db", "assets", row._id) === "shard-0" && applications.includes("assetmanagement")) {
      expected.set(department, (expected.get(department) || 0) + 1);
    }
  }
  n.insertMany("db", "assets", rows);

  const options = n._shardQueryOptions("db", "assets", ["shard-0"]);
  assert.equal(options.includeIds instanceof Set, true);
  assert.equal(typeof options.includeId, "undefined");
  assert.equal([...options.includeIds].every((rid) => Number.isInteger(rid)), true);
  assert.equal([...n.db.collection("db", "assets").indexes.get("applications").idsForValues(["assetmanagement"])]
    .every((rid) => Number.isInteger(rid)), true);

  n.shardForObject = () => {
    throw new Error("shard scoped aggregate hashed object ids");
  };

  assert.deepEqual(
    n.aggregateShards("db", "assets", { applications: { $contains: "assetmanagement" } }, {
      groupBy: "properties.department.value",
      fields: { _count: { $count: true } },
      $sort: { "properties.department.value": 1 },
    }, ["shard-0"]),
    [...expected.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([department, count]) => ({
      "properties.department.value": department,
      _count: count,
    })),
  );
});

test("unfiltered limited reads and column builds stream live ids", async () => {
  const n = new CRDTNode({ id: "a" });
  const rows = [];
  for (let i = 0; i < 64; i++) {
    rows.push({ _id: `e${i}`, score: i });
  }
  n.insertMany("db", "events", rows);

  const collection = n.db.collection("db", "events");
  collection._ridSetForAll = () => {
    throw new Error("live rids were materialized");
  };

  assert.deepEqual(
    n.find("db", "events", {}, { limit: 5 }).map((row) => row._id),
    ["e0", "e1", "e2", "e3", "e4"],
  );

  n.createIndex("db", "events", "score");
  n.setCollectionMeta("db", "events", {
    indexes: ["score"],
    columns: ["score"],
  });
  await n.awaitColumns("db", "events");

  const scoreColumn = n.indexStats("db", "events").find((entry) => entry.type === "column" && entry.path === "score");
  assert.equal(scoreColumn.status, "ready");
  assert.equal(scoreColumn.entries, 64);
});

test("column indexes build in the background and absorb live deltas", async () => {
  const n = new CRDTNode({ id: "a" });
  const objects = [];
  for (let i = 0; i < 512; i++) {
    objects.push({
      _id: `e${i}`,
      status: i % 2 === 0 ? "hot" : "cold",
      score: i,
      payload: { bucket: i % 8 },
    });
  }
  n.insertMany("db", "events", objects);
  n.createIndex("db", "events", "status");
  n.setCollectionMeta("db", "events", {
    indexes: ["status"],
    columns: ["score", "payload"],
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

  await n.awaitColumns("db", "events");
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

test("large indexed bulk writes defer index catch-up without stale query results", async () => {
  const n = new CRDTNode({ id: "a" });
  n.createCollection("db", "events", {
    indexes: ["status", "tags"],
    columns: ["score"],
  });

  const rows = [];
  for (let i = 0; i < 6000; i++) {
    rows.push({
      _id: `e${i}`,
      status: i % 2 === 0 ? "hot" : "cold",
      tags: i % 3 === 0 ? ["asset", `t${i % 5}`] : ["other"],
      score: i,
    });
  }
  assert.equal(n.insertManyCount("db", "events", rows), rows.length);

  const collection = n.db.collection("db", "events");
  assert.equal(collection.indexDirtyRids.size, rows.length);
  assert.equal(collection._planRead({ status: "hot" }, {}).path, READ_PATH.INDEX_EXACT);
  assert.equal(collection._planAggregate({}, {
    fields: {
      total: { $sum: "score" },
    },
  }).path, AGGREGATE_PATH.SCAN);

  assert.equal(n.count("db", "events", { status: "hot" }), 3000);
  assert.equal(n.count("db", "events", { tags: { $contains: "asset" } }), 2000);

  n.update("db", "events", "e0", { status: "cold", score: 100000 });
  n.remove("db", "events", "e2");

  assert.equal(n.count("db", "events", { status: "hot" }), 2998);
  assert.equal(n.count("db", "events", { status: "cold" }), 3001);
  assert.equal(n.find("db", "events", { status: "hot" }).some((row) => row._id === "e0" || row._id === "e2"), false);
  assert.equal(n.find("db", "events", { status: "cold" }).some((row) => row._id === "e0"), true);
  assert.deepEqual(n.aggregate("db", "events", {}, {
    fields: {
      total: { $sum: "score" },
      n: { $count: true },
    },
  }), [
    { total: 18096998, n: 5999 },
  ]);

  await n.awaitIndexes("db", "events");

  assert.equal(collection.indexDirtyRids.size, 0);
  assert.equal(collection._planAggregate({}, {
    fields: {
      total: { $sum: "score" },
    },
  }).path, AGGREGATE_PATH.COLUMN_SUMMARY);
  assert.deepEqual(n.aggregate("db", "events", {}, {
    fields: {
      total: { $sum: "score" },
      n: { $count: true },
    },
  }), [
    { total: 18096998, n: 5999 },
  ]);
});
