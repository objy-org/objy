import { test } from "node:test";
import assert from "node:assert/strict";
import { CRDTNode } from "../src/crdt.js";
import { nodeCompression } from "../src/node-runtime.js";
import { compareSortValues } from "../src/query.js";
import { mergeOrdered, objectOrder, selectOrdered } from "../src/order.js";
import { IdOrder } from "../src/id-order.js";
import { DerivedStateScheduler } from "../src/derived-state-scheduler.js";

const values = [-10, 0, 10, "10", "A", "a", "z", "\u00e4", false, true, [], [1], [1, 2], {}, { a: 1 }, null, undefined];
const ids = (rows) => rows.map((row) => row._id);
const compareIds = (a, b) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
const rank = (value) => values.findIndex((expected) => JSON.stringify(expected) === JSON.stringify(value));
const oracle = (rows, sort = "asc") => [...rows].sort((a, b) => (rank(a.value) - rank(b.value)) * (sort === "desc" ? -1 : 1) || compareIds(a, b));

function fixture(count = 257) {
  return Array.from({ length: count }, (_, i) => ({
    _id: `id-${String((i * 73) % count).padStart(5, "0")}`,
    value: values[i % values.length],
    active: i % 3 !== 0,
    payload: { index: i, text: "x".repeat(1024) },
  }));
}

test("sort comparison is antisymmetric, transitive, and independent of locale", () => {
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < values.length; j++) {
      assert.equal(Math.sign(compareSortValues(values[i], values[j])) || 0, Math.sign(i - j) || 0);
      assert.equal(Math.sign(compareSortValues(values[i], values[j])) || 0, -Math.sign(compareSortValues(values[j], values[i])) || 0);
      for (let k = j; k < values.length; k++) {
        if (i <= j) assert.ok(compareSortValues(values[i], values[k]) <= 0);
      }
    }
  }
  assert.equal(compareSortValues({ b: 2, a: 1 }, { a: 1, b: 2 }), 0);
  assert.equal(compareSortValues(-0, 0), 0);
  assert.equal(compareSortValues(NaN, NaN), 0);
  assert.equal(compareSortValues(null, undefined), -1);
  assert.equal(compareSortValues(undefined, null), 1);
});

test("bounded selection and shard merge match an independent full-sort oracle", () => {
  const rows = fixture();
  for (const sort of ["asc", "desc"]) {
    const compare = objectOrder({ sortBy: "value", sort });
    const expected = oracle(rows, sort);
    const streams = [0, 1, 2, 3].map((shard) => rows.filter((_, i) => i % 4 === shard).sort(compare));
    assert.deepEqual(ids([...mergeOrdered(streams, compare)]), ids(expected));
    for (const offset of [0, 1, 49, 200, 300]) {
      for (const limit of [0, 1, 17, Infinity]) {
        assert.deepEqual(ids(selectOrdered(rows, compare, { offset, limit })), ids(expected.slice(offset, offset + limit)));
      }
    }
  }
});

for (const engine of ["object", "shape"]) {
  test(`${engine} scan and index paging agree across insertion orders and value types`, async () => {
    const nodes = [new CRDTNode({ id: "a", storage: { engine } }), new CRDTNode({ id: "b", storage: { engine } })];
    const rows = fixture();
    try {
      nodes[0].insertMany("db", "items", rows);
      nodes[1].insertMany("db", "items", [...rows].reverse());
      for (const indexed of [false, true]) {
        if (indexed) {
          for (const node of nodes) node.db.collection("db", "items").createIndex("value");
          for (const node of nodes) await node.db.awaitIndexes("db", "items");
        }
        for (const sort of ["asc", "desc"]) {
          for (const filtered of [false, true]) {
            const expected = oracle(rows.filter((row) => !filtered || row.active), sort);
            for (const offset of [0, 13, 100, 250]) {
              for (const node of nodes) {
                const actual = node.find("db", "items", filtered ? { active: true } : {}, { sortBy: "value", sort, offset, limit: 19 });
                assert.deepEqual(ids(actual), ids(expected.slice(offset, offset + 19)));
              }
            }
          }
        }
      }
    } finally {
      for (const node of nodes) node.db.dispose();
    }
  });
}

test("sorted pages hydrate only selected compressed objects for ID, hot, column, and indexed sorting", async () => {
  let inflations = 0;
  const compression = { ...nodeCompression, decompress: (value) => { inflations++; return nodeCompression.decompress(value); } };
  const node = new CRDTNode({ id: "compressed", storage: { compression } });
  try {
    node.createCollection("db", "items", {
      indexes: ["active"], columns: ["score"],
      tiering: { mode: "compressedMemory", offload: ["payload"], minBytes: 1 },
    });
    const rows = fixture(509).map((row, i) => ({ ...row, score: i, hot: i, payload: { ...row.payload, text: "x".repeat(8192) } }));
    node.insertMany("db", "items", rows);
    await node.db.awaitIndexes("db", "items");
    for (const sortBy of ["_id", "score", "hot", "active"]) {
      inflations = 0;
      const result = node.find("db", "items", {}, { sortBy, offset: 100, limit: 7 });
      assert.equal(result.length, 7);
      assert.equal(inflations, 7, `${sortBy} inflates only returned rows`);
      result[0].payload.text = "changed";
      assert.notEqual(node.get("db", "items", result[0]._id).payload.text, "changed");
    }
    const cold = node.find("db", "items", { "payload.index": { $gte: 400 } }, { sortBy: "payload.index", limit: 7 });
    assert.deepEqual(cold.map((row) => row.payload.index), [400, 401, 402, 403, 404, 405, 406]);
    const missing = node.find("db", "items", { missing: { $exists: false } }, { sortBy: "_id", limit: 7 });
    assert.equal(missing.length, 7);
    const whole = node.find("db", "items", { $where() { return this.score >= 500 && this.payload.index >= 500; } }, { sortBy: "_id" });
    assert.equal(whole.length, 9);
  } finally {
    node.db.dispose();
  }
});

test("sorted pages use current dirty column values before and after catch-up", async () => {
  const node = new CRDTNode({ id: "dirty", storage: { compression: nodeCompression } });
  try {
    node.createCollection("db", "items", { indexes: ["group"], columns: ["score"] });
    const rows = Array.from({ length: 6000 }, (_, i) => ({ _id: `id-${String(i).padStart(5, "0")}`, score: i, group: i % 3 }));
    node.insertMany("db", "items", rows);
    await node.db.awaitIndexes("db", "items");
    const updated = rows.map((row, i) => ({ ...row, score: -i, group: (i + 1) % 3 }));
    node.replaceMany("db", "items", updated);
    assert.ok(node.db.collection("db", "items").indexDirtyRids.size > 0);
    const expected = updated.filter((row) => row.group === 1).sort((a, b) => a.score - b.score || compareIds(a, b)).slice(250, 281);
    for (const ready of [false, true]) {
      if (ready) await node.db.awaitIndexes("db", "items");
      const actual = node.find("db", "items", { group: 1 }, { sortBy: "score", offset: 250, limit: 31 });
      assert.deepEqual(actual, expected);
    }
  } finally {
    node.db.dispose();
  }
});

test("compact ID ordering includes new IDs and deletions during bounded merges", async () => {
  const scheduler = new DerivedStateScheduler({ batchSize: 4096, maxSliceMs: 1 });
  const source = Array.from({ length: 20_000 }, (_, i) => `id-${String(Math.imul(i + 1, 0x9e3779b1) >>> 0).padStart(10, "0")}`);
  const dead = new Set();
  const accepts = (rid) => !dead.has(rid);
  const order = new IdOrder(source, scheduler, {}, "test");
  const verify = () => {
    const expected = source.map((id, rid) => ({ id, rid })).filter(({ rid }) => accepts(rid)).sort((a, b) => a.id < b.id ? -1 : 1);
    for (const sort of ["asc", "desc"]) {
      const sorted = sort === "desc" ? [...expected].reverse() : expected;
      for (const offset of [0, 1, 257, 19_990, 40_000]) {
        assert.deepEqual(order.page(accepts, { sort, offset, limit: 31 }), sorted.slice(offset, offset + 31).map(({ rid }) => rid));
      }
    }
  };
  try {
    verify();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(order.indexed > 0 && !order.complete);
    dead.add(1);
    dead.add(12_000);
    source.push("000-new-first", "zzz-new-last");
    verify();
    await order.ready();
    verify();
    assert.equal(order.bytes, source.length * Uint32Array.BYTES_PER_ELEMENT);
    for (let i = 0; i < 9; i++) {
      source.push(`000-tiny-${i}`);
      await order.ready();
    }
    dead.delete(1);
    verify();
    assert.equal(order.bytes, source.length * Uint32Array.BYTES_PER_ELEMENT);
  } finally {
    order.dispose();
    scheduler.close();
  }
});

test("ID ordering is lazy, survives snapshot application, and is released on collection deletion", async () => {
  const node = new CRDTNode({ id: "id-lifecycle" });
  try {
    node.insertMany("db", "items", [{ _id: "z", value: 1 }, { _id: "a", value: 2 }]);
    const collection = node.db.collection("db", "items");
    assert.equal(collection.idOrder, null, "writes and restore do not build unused orderings");
    assert.deepEqual(ids(node.find("db", "items", {}, { sortBy: "_id" })), ["a", "z"]);
    await collection.idOrder.ready();
    const ordering = collection.idOrder;
    assert.equal(collection.readPath({}, { sortBy: "_id" }), "ordered-index");
    collection.applySnapshotObjects([{ id: "m", value: { value: 3 }, ts: { c: 10, n: "restore" } }], { deferDerivedIndexes: true });
    node.remove("db", "items", "a");
    assert.deepEqual(ids(node.find("db", "items", {}, { sortBy: "_id" })), ["m", "z"]);
    assert.deepEqual(ids(node.find("db", "items", {}, { sortBy: "_id", sort: "desc" })), ["z", "m"]);
    node.db.deleteCollection("db", "items");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ordering.bytes, 0);
    assert.equal(ordering.disposed, true);
  } finally {
    node.db.dispose();
  }
});

test("ready ID ordering narrows broad indexed filters while sparse ID candidates stay direct", async () => {
  const node = new CRDTNode({ id: "filtered-order" });
  try {
    node.createCollection("db", "items", { indexes: ["active"] });
    const rows = fixture(20_003);
    node.insertMany("db", "items", rows);
    await node.awaitIndexes("db", "items");
    const collection = node.db.collection("db", "items");
    node.find("db", "items", {}, { sortBy: "_id", limit: 1 });
    await collection.idOrder.ready();
    const original = collection._idForRid.bind(collection);
    let visited = 0;
    collection._idForRid = (rid) => { visited++; return original(rid); };
    const options = { sortBy: "_id", limit: 17 };
    const actual = node.find("db", "items", { active: true }, options);
    assert.deepEqual(ids(actual), ids(rows.filter((row) => row.active).sort(compareIds).slice(0, 17)));
    assert.equal(collection.readPath({ active: true }, options), "ordered-index");
    assert.ok(visited < 200, `broad filter visited ${visited} RIDs`);
    visited = 0;
    const wanted = [rows[16_000]._id, rows[19_000]._id];
    const sparse = node.find("db", "items", { _id: { $in: wanted } }, { sortBy: "_id", limit: 1 });
    assert.deepEqual(ids(sparse), [...wanted].sort().slice(0, 1));
    assert.ok(visited < 20, `sparse filter visited ${visited} RIDs`);
  } finally {
    node.db.dispose();
  }
});

test("string extrema agree between aggregate scans, field indexes, and columns", async () => {
  const node = new CRDTNode({ id: "extrema" });
  try {
    node.insertMany("db", "items", ["a", "\u00e4", "Z", "A"].map((label, i) => ({ _id: String(i), label })));
    const spec = { fields: { low: { $min: "label" }, high: { $max: "label" } } };
    for (const meta of [{}, { indexes: ["label"] }, { columns: ["label"] }]) {
      node.setCollectionMeta("db", "items", meta);
      await node.awaitIndexes("db", "items");
      assert.deepEqual(node.aggregate("db", "items", {}, spec), [{ low: "A", high: "\u00e4" }]);
    }
  } finally {
    node.db.dispose();
  }
});
