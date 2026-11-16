import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { DerivedStateScheduler } from "../src/derived-state-scheduler.js";
import { CRDTNode } from "../src/crdt.js";
import { nodeCompression } from "../src/node-runtime.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";

test("batch execution is lazy, cancellable, and keeps one admitted build", async () => {
  const scheduler = new DerivedStateScheduler({ batchSize: 16 });
  const owner = {};
  let visited = 0, produced = 0, closed = false, second = false;
  function* source() {
    try { for (let i = 0; i < 10000; i++) { produced++; yield i; } }
    finally { closed = true; }
  }
  const first = scheduler.schedule("first", (job) => job.forEach(source(), () => {
    assert.equal(produced, visited + 1);
    visited++;
    assert.equal(second, false);
  }), { owner });
  const next = scheduler.schedule("next", () => { second = true; });
  await turn();
  assert.equal(visited, 16);
  scheduler.cancel(owner);
  assert.equal(await first, false);
  await next;
  assert.equal(visited, 16);
  assert.equal(closed, true);
  assert.equal(second, true);
  scheduler.close();
});

test("batch execution honors budgets that are not multiples of its checkpoint interval", async () => {
  for (const batchSize of [100, 4097]) {
    const scheduler = new DerivedStateScheduler({ batchSize, maxSliceMs: 60000 });
    const owner = {};
    let visited = 0;
    const running = scheduler.schedule("batch", (job) => job.forEach(Array(10000).keys(), () => { visited++; }), { owner });
    await turn();
    assert.equal(visited, batchSize);
    scheduler.cancel(owner);
    assert.equal(await running, false);
    scheduler.close();
  }
});

const rows = (count) => Array.from({ length: count }, (_, i) => ({
  _id: String(i), score: i, group: i % 4, details: { rank: i, label: "keep" }, payload: "cold data ".repeat(64),
}));
const tiering = { mode: "compressedMemory", offload: ["payload", "details"], minBytes: 1 };
function intercept(node, match, action) {
  const scheduler = node.db.derivedStateScheduler, schedule = scheduler.schedule.bind(scheduler);
  scheduler.schedule = (name, run, options) => schedule(name, (job) => {
    const checkpoint = job.checkpoint.bind(job);
    job.checkpoint = async (count) => {
      await checkpoint(count);
      if (match(name)) action(name);
    };
    return run(job);
  }, options);
}
function check(node, data) {
  assert.equal(node.count("d", "c"), data.size);
  for (const object of data.values()) assert.deepEqual(node.get("d", "c", object._id), object);
  const expected = [...data.values()].reduce((n, object) => n + (object.score || 0), 0);
  assert.deepEqual(node.aggregate("d", "c", {}, { fields: { sum: { $sum: "score" }, n: { $count: true } } }), [{ sum: expected, n: data.size }]);
}

for (const engine of ["object", "shape"]) {
  const make = () => new CRDTNode({ id: "maintenance", storage: { engine, compression: nodeCompression, derivedState: { batchSize: 64 } } });

  test(`${engine}: metadata indexes are query-correct before and after background builds`, async () => {
    const node = make();
    try {
      node.createCollection("d", "c", { tiering });
      const data = rows(1025); node.insertManyCount("d", "c", data);
      node.setCollectionMeta("d", "c", { tiering, indexes: ["group", "details.rank"] });
      assert.ok(node.db.collection("d", "c").fieldBuilds.size);
      assert.equal(node.count("d", "c", { "details.rank": 42 }), 1);
      node.replaceManyCount("d", "c", [{ ...data[42], details: { rank: 9999 } }]);
      assert.equal(node.count("d", "c", { "details.rank": 42 }), 0);
      await node.awaitIndexes("d", "c");
      assert.equal(node.count("d", "c", { "details.rank": 9999 }), 1);
    } finally { node.db.dispose(); }
  });

  test(`${engine}: storage migration tolerates writes, deletes, superseding meta and snapshots`, async () => {
    const node = make();
    try {
      node.createCollection("d", "c", { columns: ["score", "details"], tiering });
      const expected = new Map(rows(1025).map(object => [object._id, object]));
      node.insertManyCount("d", "c", [...expected.values()]); await node.awaitIndexes("d", "c");
      let changed = false;
      intercept(node, name => name.startsWith("storage:"), () => {
        if (changed) return;
        changed = true;
        const updated = { ...expected.get("0"), score: 99999, details: { rank: 8, label: "changed" } };
        node.replaceManyCount("d", "c", [updated]); expected.set("0", updated);
        node.removeMany("d", "c", ["1"]); expected.delete("1");
        node.replaceManyCount("d", "c", [{ _id: "1", score: -1, payload: "recreated" }]);
        expected.set("1", { _id: "1", score: -1, payload: "recreated" });
        node.setCollectionMeta("d", "c", { columns: ["score"], tiering });
        node.setCollectionMeta("d", "c", { columns: ["details.rank"] });
        check(node, expected);
        for (const row of node.db.collection("d", "c").snapshotObjects()) {
          if (!row.deleted) assert.deepEqual({ ...row.value, _id: row.id }, expected.get(row.id));
        }
      });
      node.setCollectionMeta("d", "c", { columns: ["details.rank"], tiering: { ...tiering, offload: ["payload"] } });
      check(node, expected);
      await node.awaitIndexes("d", "c");
      assert.equal(changed, true);
      assert.deepEqual([...node.db.collection("d", "c").columns.keys()], ["details.rank"]);
      check(node, expected);
    } finally { node.db.dispose(); }
  });

  test(`${engine}: yielded field and column delta replay includes repeated updates`, async () => {
    const node = make();
    try {
      const data = rows(1025), expected = new Map(data.map(object => [object._id, object]));
      node.createCollection("d", "c", { indexes: ["group"], columns: ["score"] });
      node.insertManyCount("d", "c", data); await node.awaitIndexes("d", "c");
      const c = node.db.collection("d", "c");
      let initial = false, repeated = false;
      intercept(node, name => name.startsWith("field-index:") || name.startsWith("column:"), () => {
        if (!initial) {
          initial = true;
          const changed = data.map(object => ({ ...object, group: 9, score: object.score + 10000 }));
          node.replaceManyCount("d", "c", changed); for (const object of changed) expected.set(object._id, object);
        } else if (!repeated && !c.fieldBuilds.get("group")?.pending.has(0)) {
          repeated = true;
          const changed = { ...expected.get("0"), group: 11, score: -999 };
          node.replaceManyCount("d", "c", [changed]); expected.set("0", changed);
          node.removeMany("d", "c", ["1"]); expected.delete("1");
        }
        check(node, expected);
      });
      c.scheduleIndexBuildsFromMeta(); await node.awaitIndexes("d", "c");
      assert.equal(initial && repeated, true);
      check(node, expected);
      assert.equal(node.count("d", "c", { group: 11 }), 1);
    } finally { node.db.dispose(); }
  });

  test(`${engine}: dirty batches remain visible across checkpoints`, async () => {
    const node = make();
    try {
      node.createCollection("d", "c", { indexes: ["group"], columns: ["score"] });
      const data = rows(5001); node.insertManyCount("d", "c", data); await node.awaitIndexes("d", "c");
      const changed = data.map(object => ({ ...object, group: 9, score: 3 }));
      let checked = 0;
      intercept(node, name => name.startsWith("dirty-index:"), () => {
        checked++;
        assert.equal(node.count("d", "c", { group: 9 }), 5001);
        assert.deepEqual(node.aggregate("d", "c", {}, { fields: { sum: { $sum: "score" } } }), [{ sum: 15003 }]);
      });
      node.replaceManyCount("d", "c", changed); await node.awaitIndexes("d", "c");
      assert.ok(checked > 1);
    } finally { node.db.dispose(); }
  });

  test(`${engine}: column publication keeps replayed and newly arriving writes visible`, async () => {
    const node = make();
    try {
      const data = rows(513), expected = new Map(data.map(object => [object._id, object]));
      node.createCollection("d", "c", { columns: ["score"] });
      node.insertManyCount("d", "c", data); await node.awaitIndexes("d", "c");
      const c = node.db.collection("d", "c");
      let stage = 0;
      intercept(node, name => name.startsWith("column:"), () => {
        const column = c.columns.get("score");
        if (stage === 0) {
          stage++;
          const changed = data.map(object => ({ ...object, score: object.score + 10000 }));
          node.replaceManyCount("d", "c", changed); for (const object of changed) expected.set(object._id, object);
        } else if (stage === 1 && column.pending?.size && !column.pending.has(0)) {
          stage++;
          const updated = { ...expected.get("0"), score: 99999 };
          node.replaceManyCount("d", "c", [updated]); expected.set("0", updated);
        } else if (stage === 2 && column.status === "building" && column.pending?.size === 0) {
          stage++;
          const updated = { ...expected.get("0"), score: -111 };
          node.replaceManyCount("d", "c", [updated]); expected.set("0", updated);
          node.removeMany("d", "c", ["2"]); expected.delete("2");
        }
        check(node, expected);
      });
      c._rebuildColumns(); await node.awaitIndexes("d", "c");
      assert.equal(stage, 3); check(node, expected);
    } finally { node.db.dispose(); }
  });

  test(`${engine}: failed conversion retains data and can be retried`, async () => {
    let fail = false;
    const node = new CRDTNode({ id: "failure", storage: { engine, compression: {
      ...nodeCompression,
      compress(value) { if (fail) { fail = false; throw new Error("injected compression failure"); } return nodeCompression.compress(value); },
    } } });
    try {
      node.createCollection("d", "c", { tiering });
      const data = new Map(rows(129).map(object => [object._id, object]));
      node.insertManyCount("d", "c", [...data.values()]);
      fail = true;
      const next = { tiering: { ...tiering, offload: ["payload"] } };
      node.setCollectionMeta("d", "c", next);
      await assert.rejects(node.awaitIndexes("d", "c"), /injected compression failure/);
      check(node, data);
      node.setCollectionMeta("d", "c", next); await node.awaitIndexes("d", "c"); check(node, data);
    } finally { node.db.dispose(); }
  });
}

test("snapshot during storage migration retains full objects and conservative journal coverage", async () => {
  const node = new CRDTNode({ id: "snapshot", storage: { compression: nodeCompression } });
  const fresh = new CRDTNode({ id: "restore", storage: { compression: nodeCompression } });
  const storage = new MemoryObjectStorage();
  const p = new PersistenceManager({ node, storage, prefix: "batches", flushMs: 0, snapshotMs: 0, segmentBytes: 16384 });
  p.start();
  try {
    node.createCollection("d", "c", { columns: ["score"], tiering });
    const data = rows(1025), expected = new Map(data.map(object => [object._id, object]));
    node.insertManyCount("d", "c", data); await node.awaitIndexes("d", "c");
    const original = storage.put.bind(storage); let changed = false;
    storage.put = async (key, body, type) => {
      if (key.includes("segment-") && !changed) {
        changed = true;
        const value = { ...data[0], score: 90000 };
        node.replaceManyCount("d", "c", [value]); expected.set("0", value);
        node.removeMany("d", "c", ["1"]); expected.delete("1");
        node.setCollectionMeta("d", "c", { indexes: ["group"], tiering });
      }
      return original(key, body, type);
    };
    await p.checkpoint(); await p.flush(); await node.awaitIndexes("d", "c");
    await new PersistenceManager({ node: fresh, storage, prefix: "batches" }).restore();
    await fresh.awaitIndexes("d", "c"); check(fresh, expected);
    assert.equal(changed, true);
  } finally { await p.stop(); node.db.dispose(); fresh.db.dispose(); }
});
