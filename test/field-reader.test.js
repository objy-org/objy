import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { CRDTNode } from "../src/crdt.js";
import { nodeCompression } from "../src/node-runtime.js";

function countedNode(engine, meta) {
  const calls = { compress: 0, decompress: 0 };
  const compression = { ...nodeCompression };
  for (const operation of Object.keys(calls)) {
    compression[operation] = (value) => {
      calls[operation]++;
      return nodeCompression[operation](value);
    };
  }
  const node = new CRDTNode({ id: "fields", storage: { engine, compression } });
  node.createCollection("db", "items", meta);
  const collection = node.db.collection("db", "items");
  return { node, collection, calls, reset: () => { calls.compress = calls.decompress = 0; } };
}

const tiering = { mode: "compressedMemory", keep: ["group", "score", "details.rank", "tags"], minBytes: 1 };
const fixture = (count) => Array.from({ length: count }, (_, i) => ({
  _id: `id-${i}`, group: i % 7, score: i,
  details: { rank: i % 13, text: `record ${i} ` + "large cold data ".repeat(512) },
  tags: ["a", `tag-${i % 3}`], payload: { text: "history ".repeat(1024), index: i },
}));

for (const engine of ["object", "shape"]) {
  test(`${engine} builds hot indexes and columns without touching compressed content`, async () => {
    const { node, collection, calls, reset } = countedNode(engine, { tiering });
    try {
      const rows = fixture(257);
      node.insertMany("db", "items", rows);
      const buffers = [...collection.compressedCold];
      const totals = { ...collection.compressionTotals };
      reset();
      node.setCollectionMeta("db", "items", { indexes: ["group", "tags"], columns: ["score", "details.rank"], tiering });
      await node.awaitIndexes("db", "items");
      assert.deepEqual(calls, { compress: 0, decompress: 0 });
      assert.deepEqual(collection.compressionTotals, totals);
      for (let rid = 0; rid < buffers.length; rid++) assert.equal(collection.compressedCold[rid], buffers[rid]);
      assert.equal(collection.store.readForQuery("id-10").score, undefined);
      assert.equal(collection.store.readForQuery("id-10").details, undefined);
      assert.deepEqual(node.get("db", "items", "id-10"), rows[10]);

      reset();
      collection.scheduleIndexBuildsFromMeta();
      await node.awaitIndexes("db", "items");
      assert.deepEqual(calls, { compress: 0, decompress: 0 });
      assert.deepEqual(node.aggregate("db", "items", { tags: { $contains: "tag-1" } }, {
        fields: { total: { $sum: "score" }, count: { $count: true } },
      }), [{ total: rows.filter((row) => row.tags.includes("tag-1")).reduce((sum, row) => sum + row.score, 0), count: 86 }]);
      assert.deepEqual(node.get("db", "items", "id-10"), rows[10]);
    } finally { node.db.dispose(); }
  });

  test(`${engine} reads cold and overlapping paths once per RID without mutating storage`, async () => {
    const { node, collection, calls, reset } = countedNode(engine, { tiering, columns: ["details.rank"] });
    try {
      const row = fixture(1)[0];
      node.insertMany("db", "items", [row]);
      const read = collection._fieldValueReader({ indexes: false });
      const rid = collection._ridForId(row._id);
      reset();
      assert.equal(read(rid, "details.rank"), row.details.rank);
      assert.equal(calls.decompress, 0);
      assert.equal(read(rid, "details.text"), row.details.text);
      assert.deepEqual(read(rid, "details"), row.details);
      assert.deepEqual(read(rid, "payload"), row.payload);
      assert.equal(read(rid, "missing"), undefined);
      assert.equal(calls.decompress, 1);
      assert.deepEqual(node.get("db", "items", row._id), row);

      node.createIndex("db", "items", "group");
      collection.indexes.get("group").forward.set(rid, 999);
      assert.equal(collection._fieldValueReader({ indexes: false })(rid, "group"), row.group);
      node.createIndex("db", "items", "group");
      assert.equal(collection.indexes.get("group").valueForRid(rid), row.group);
      const result = node.get("db", "items", row._id);
      result.details.rank = 999;
      result.tags.push("changed");
      assert.deepEqual(node.get("db", "items", row._id), row);
    } finally { node.db.dispose(); }
  });

  test(`${engine} moves formerly cold fields to columns and preserves full snapshots`, async () => {
    const meta = { tiering: { mode: "compressedMemory", keep: ["group"], minBytes: 1 } };
    const { node, collection, calls, reset } = countedNode(engine, meta);
    try {
      const rows = fixture(37);
      node.insertMany("db", "items", rows);
      reset();
      node.setCollectionMeta("db", "items", { ...meta, columns: ["score", "details", "tags"] });
      await node.awaitIndexes("db", "items");
      assert.equal(calls.compress, rows.length);
      assert.equal(calls.decompress, rows.length * 2);
      for (const row of rows) {
        const rid = collection._ridForId(row._id);
        const cold = collection._hydrateCompressedCold({}, rid);
        assert.equal(cold.score, undefined);
        assert.equal(cold.details, undefined);
        assert.equal(cold.tags, undefined);
        assert.deepEqual(cold.payload, row.payload);
        assert.deepEqual(node.get("db", "items", row._id), row);
      }
      const snapshot = [...collection.snapshotObjects()];
      const restored = new CRDTNode({ id: "restored", storage: { engine, compression: nodeCompression } });
      try {
        restored.createCollection("db", "items", collection.getMeta());
        restored.db.beginBulkLoad();
        restored.db.applySnapshotObjects("db", "items", snapshot);
        restored.db.endBulkLoad();
        restored.startIndexWarmup();
        await restored.awaitIndexes("db", "items");
        for (const row of rows) assert.deepEqual(restored.get("db", "items", row._id), row);
      } finally { restored.db.dispose(); }
    } finally { node.db.dispose(); }
  });

  test(`${engine} column rebuilds read pending replacements, unsets, and deletions`, async () => {
    const { node, collection } = countedNode(engine, { tiering, columns: ["score", "details.rank"] });
    try {
      const rows = fixture(41);
      node.insertMany("db", "items", rows);
      collection.scheduleIndexBuildsFromMeta();
      const updated = { ...rows[3], score: "changed", details: { text: rows[3].details.text } };
      node.replaceMany("db", "items", [updated]);
      node.remove("db", "items", rows[4]._id);
      assert.deepEqual(node.get("db", "items", updated._id), updated);
      const read = collection._fieldValueReader({ indexes: false });
      assert.equal(read(collection._ridForId(updated._id), "score"), "changed");
      assert.equal(read(collection._ridForId(updated._id), "details.rank"), undefined);
      assert.deepEqual(read(collection._ridForId(updated._id), "details"), updated.details);
      await node.awaitIndexes("db", "items");
      assert.deepEqual(node.get("db", "items", updated._id), updated);
      assert.equal(node.get("db", "items", rows[4]._id), undefined);
      for (const row of rows.filter((_, i) => i !== 3 && i !== 4)) assert.deepEqual(node.get("db", "items", row._id), row);
    } finally { node.db.dispose(); }
  });
}

test("dirty catch-up reads authoritative fields and leaves cold buffers unchanged", async () => {
  const { node, collection, calls, reset } = countedNode("object", { indexes: ["group", "tags"], columns: ["score", "details.rank"], tiering });
  try {
    const rows = fixture(6000);
    node.insertManyCount("db", "items", rows);
    await node.awaitIndexes("db", "items");
    const updated = rows.map((row, i) => ({ ...row, score: -i, group: (i + 2) % 7, details: { ...row.details, rank: i % 17 } }));
    node.replaceManyCount("db", "items", updated);
    node.removeMany("db", "items", updated.slice(0, 7).map((row) => row._id));
    const buffers = [...collection.compressedCold];
    reset();
    assert.ok(collection.indexDirtyRids.size > 0);
    assert.equal(node.count("db", "items", { group: 3 }), updated.slice(7).filter((row) => row.group === 3).length);
    assert.deepEqual(calls, { compress: 0, decompress: 0 });
    await node.awaitIndexes("db", "items");
    assert.deepEqual(calls, { compress: 0, decompress: 0 });
    for (let rid = 7; rid < buffers.length; rid++) assert.equal(collection.compressedCold[rid], buffers[rid]);
    for (const row of updated.slice(7)) assert.deepEqual(node.get("db", "items", row._id), row);
    const expected = updated.slice(7).reduce((sum, row) => sum + row.score, 0);
    assert.deepEqual(node.aggregate("db", "items", {}, { fields: { total: { $sum: "score" }, count: { $count: true } } }), [{ total: expected, count: 5993 }]);
  } finally { node.db.dispose(); }
});

test("column stripping skips new dirty writes between build batches", async () => {
  const { node, collection } = countedNode("object", { tiering });
  try {
    const rows = fixture(9000);
    node.insertManyCount("db", "items", rows);
    const strip = collection._stripBaseValuesForColumns.bind(collection);
    let wrote = false;
    collection._stripBaseValuesForColumns = async (paths, job) => {
      const updated = rows.slice(3000).map((row, i) => ({ ...row, score: 20_000 + i }));
      node.replaceManyCount("db", "items", updated);
      assert.ok(collection.indexDirtyRids.size > 0);
      wrote = true;
      await strip(paths, job);
    };
    node.setCollectionMeta("db", "items", { tiering, columns: ["score"] });
    await node.awaitIndexes("db", "items");
    assert.equal(wrote, true);
    for (let i = 0; i < rows.length; i++) assert.equal(node.get("db", "items", rows[i]._id).score, i < 3000 ? i : 20_000 + i - 3000);
  } finally { node.db.dispose(); }
});

test("field readers preserve mixed types and refresh their per-row cache after yielding", async () => {
  const { node, collection } = countedNode("object", { tiering });
  try {
    const values = [undefined, null, false, 0, "", "text", [1, null, "x"], { nested: [false, 3] }];
    const rows = values.map((value, i) => ({ _id: `mixed-${i}`, group: i, ...(value === undefined ? {} : { value }), payload: "text ".repeat(1024) }));
    node.insertMany("db", "items", rows);
    const read = collection._fieldValueReader({ indexes: false });
    for (const row of rows) assert.deepEqual(read(collection._ridForId(row._id), "value"), row.value);
    const rid = collection._ridForId(rows[1]._id);
    assert.equal(read(rid, "value"), null);
    await yieldToEventLoop();
    node.replaceMany("db", "items", [{ ...rows[1], value: 42 }]);
    read.reset();
    assert.equal(read(rid, "value"), 42);
    node.setCollectionMeta("db", "items", { tiering, columns: ["value"] });
    await node.awaitIndexes("db", "items");
    for (let i = 0; i < rows.length; i++) assert.deepEqual(node.get("db", "items", rows[i]._id), i === 1 ? { ...rows[i], value: 42 } : rows[i]);
  } finally { node.db.dispose(); }
});

test("field and column builds replay writes to already-scanned and future RIDs", async () => {
  const { node, collection } = countedNode("object", { indexes: ["group"], columns: ["score", "details.rank"], tiering });
  try {
    const rows = fixture(9000);
    const expected = new Map(rows.map((row) => [row._id, row]));
    node.insertManyCount("db", "items", rows);
    await node.awaitIndexes("db", "items");
    const scheduler = collection.derivedStateScheduler;
    const schedule = scheduler.schedule.bind(scheduler);
    const changed = new Set();
    scheduler.schedule = (name, run, options) => schedule(name, (job) => {
      const checkpoint = job.checkpoint.bind(job);
      job.checkpoint = async (scanned) => {
        const phase = name.split(":")[0];
        if ((phase === "field-index" || phase === "column") && !changed.has(phase)) {
          changed.add(phase);
          for (const i of [100, 8000]) {
            const next = { ...rows[i], group: 20, score: i * changed.size, details: { ...rows[i].details, rank: 99 } };
            node.replaceManyCount("db", "items", [next]);
            expected.set(next._id, next);
          }
          const removed = rows[changed.size]._id;
          node.remove("db", "items", removed);
          expected.delete(removed);
          const added = { ...fixture(1)[0], _id: `added-${phase}`, group: 20, score: changed.size };
          node.insertManyCount("db", "items", [added]);
          expected.set(added._id, added);
        }
        await checkpoint(scanned);
      };
      return run(job);
    }, options);
    collection.scheduleIndexBuildsFromMeta();
    await node.awaitIndexes("db", "items");
    assert.deepEqual([...changed], ["field-index", "column"]);
    assert.equal(node.count("db", "items"), expected.size);
    for (const row of expected.values()) assert.deepEqual(node.get("db", "items", row._id), row);
    const selected = [...expected.values()].filter((row) => row.group === 20);
    assert.equal(node.count("db", "items", { group: 20 }), selected.length);
    assert.deepEqual(node.aggregate("db", "items", { group: 20 }, {
      fields: { total: { $sum: "score" }, count: { $count: true } },
    }), [{ total: selected.reduce((sum, row) => sum + row.score, 0), count: selected.length }]);
    assert.equal(node.get("db", "items", rows[1]._id), undefined);
    assert.equal(node.get("db", "items", rows[2]._id), undefined);
  } finally { node.db.dispose(); }
});

test("failed column rebuilds retain pending values and can be retried", async () => {
  const meta = { tiering, columns: ["score", "details.rank"] };
  const { node, collection } = countedNode("object", meta);
  try {
    const rows = fixture(17);
    node.insertMany("db", "items", rows);
    const column = collection.columns.get("score");
    const install = column.install;
    column.install = () => { throw new Error("injected column build failure"); };
    collection.scheduleIndexBuildsFromMeta();
    const updated = { ...rows[3], details: { text: rows[3].details.text } };
    delete updated.score;
    node.replaceManyCount("db", "items", [updated, { ...rows[4], score: 1234 }]);
    await node.awaitIndexes("db", "items");
    assert.equal(column.status, "error");
    assert.deepEqual(node.get("db", "items", updated._id), updated);
    assert.deepEqual(node.get("db", "items", rows[4]._id), { ...rows[4], score: 1234 });
    column.install = install;
    node.setCollectionMeta("db", "items", meta);
    await node.awaitIndexes("db", "items");
    assert.equal(column.status, "ready");
    assert.deepEqual(node.get("db", "items", updated._id), updated);
    assert.deepEqual(node.get("db", "items", rows[4]._id), { ...rows[4], score: 1234 });
  } finally { node.db.dispose(); }
});
