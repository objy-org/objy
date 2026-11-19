import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { WorkBudget } from "../src/derived-state-scheduler.js";
import { CRDTNode } from "../src/crdt.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";
import { nodeCompression } from "../src/node-runtime.js";
import { readPublished } from "./helpers/primary-state.js";

const scope = { database: "app", collection: "items", shard: "default" };
const base = "objydb/db/app/collection/items/shard/default";

function fixture(t, engine = "object") {
  const node = new CRDTNode({ id: "writer", storage: { engine, compression: nodeCompression } });
  const storage = new MemoryObjectStorage();
  const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0 });
  t.after(() => { persistence.unsubscribe?.(); node.db.dispose(); });
  return { node, storage, persistence };
}

function duringPreparation(node, action) {
  const iterate = node.snapshotScopeObjects.bind(node);
  let visited = 0;
  node.snapshotScopeObjects = function* (context) {
    for (const row of iterate(context)) {
      if (++visited === 1) setImmediate(() => action(visited));
      yield row;
    }
  };
}

test("checkpoint selection preserves role, dirty-only, and manual checkpoint policies", async (t) => {
  for (const snapshotRole of ["primary", "none"]) {
    for (const replica of [false, true]) {
      const { node, persistence } = fixture(t);
      node.url = replica ? "http://replica" : "http://primary";
      node.replaceShardMap({ shards: { default: { peers: [{ url: "http://primary" }, { url: "http://replica" }] } } });
      node.createCollection("app", "items");
      persistence.snapshotRole = snapshotRole;
      const manual = replica ? 0 : 1;
      const scheduled = !replica && snapshotRole === "primary" ? 1 : 0;
      assert.equal(persistence._snapshotScopes().length, manual);
      assert.equal(persistence._snapshotScopes({ primaryOnly: true }).length, scheduled);
      assert.equal(persistence._snapshotScopes({ automatic: true }).length, 0, "clean collections need no automatic checkpoint");
      persistence.start();
      node.insertManyCount("app", "items", [{ _id: "one", score: 1 }]);
      assert.equal(persistence._snapshotScopes({ automatic: true }).length, scheduled);
      persistence.dirtyScopes.clear();
      persistence.snapshotDirtyOnly = false;
      assert.equal(persistence._snapshotScopes({ automatic: true }).length, scheduled);
    }
  }
});

test("the shared work budget yields for both count and elapsed-time limits", async () => {
  const budget = new WorkBudget({ batchSize: 4, maxSliceMs: 60000 });
  assert.equal(budget.checkpoint(1), undefined);
  let serviced = false;
  setImmediate(() => { serviced = true; });
  await budget.checkpoint(4);
  assert.equal(serviced, true);
  serviced = false;
  budget.lastYieldAt -= 60000;
  setImmediate(() => { serviced = true; });
  await budget.checkpoint(1);
  assert.equal(serviced, true);
});

for (const engine of ["object", "shape"]) {
  test(`${engine}: yielding preserves snapshot bytes, segment boundaries, and full hydrated objects`, async (t) => {
    const { node, storage, persistence } = fixture(t, engine);
    node.createCollection("app", "items", {
      indexes: ["kind"], columns: ["score"],
      tiering: { mode: "compressedMemory", offload: ["details"], minBytes: 1 },
    });
    node.insertManyCount("app", "items", Array.from({ length: 5001 }, (_, i) => ({
      _id: String(i), kind: i % 7, score: i,
      details: { text: `M\u00fcnchen \ud83d\ude00 ${i}`, payload: "cold data ".repeat(16) },
    })));
    node.removeMany("app", "items", ["17"]);
    await node.awaitIndexes("app", "items");
    for (const segmentBytes of [16 * 1024 * 1024, 1024]) {
      persistence.segmentBytes = segmentBytes;
      const expected = [];
      let lines = [], bytes = 0;
      for (const row of node.snapshotScopeObjects(scope)) {
        const line = `${JSON.stringify(row)}\n`;
        if (lines.length && bytes + Buffer.byteLength(line) > segmentBytes) {
          expected.push(lines.join("")); lines = []; bytes = 0;
        }
        lines.push(line); bytes += Buffer.byteLength(line);
      }
      if (lines.length) expected.push(lines.join(""));
      const written = await persistence.checkpoint();
      assert.equal(written.objects, 5001);
      assert.equal(written.segments, expected.length);
      const manifest = JSON.parse(await readPublished(storage, `${base}/latest.json`));
      for (let i = 0; i < manifest.segments.length; i++) {
        const segment = manifest.segments[i];
        assert.equal(await storage.get(segment.key), expected[i]);
        assert.equal(segment.bytes, Buffer.byteLength(expected[i]));
        assert.equal(segment.count, expected[i].trim().split("\n").length);
      }
    }
    const fresh = new CRDTNode({ id: "restored", storage: { engine, compression: nodeCompression } });
    t.after(() => fresh.db.dispose());
    await new PersistenceManager({ node: fresh, storage }).restore();
    await fresh.awaitIndexes("app", "items");
    assert.equal(fresh.count("app", "items"), 5000);
    assert.equal(fresh.get("app", "items", "17"), undefined);
    for (let i = 0; i < 5001; i++) assert.deepEqual(fresh.get("app", "items", String(i)), node.get("app", "items", String(i)));
  });
}

test("writes, deletes, and replicated tails during preparation survive restore", async (t) => {
  const { node, storage, persistence } = fixture(t);
  persistence.start();
  node.createCollection("app", "items", { indexes: ["kind"], columns: ["score"] });
  node.insertManyCount("app", "items", Array.from({ length: 8193 }, (_, i) => ({ _id: String(i), kind: i % 7, score: i })));
  await node.awaitIndexes("app", "items");
  let changed = false, uploaded = false;
  const put = storage.put.bind(storage);
  storage.put = async (key, ...args) => {
    if (key.includes("/segment-")) uploaded = true;
    return put(key, ...args);
  };
  duringPreparation(node, (visited) => {
    assert.equal(uploaded, false);
    assert.ok(visited < 8193, "must yield before the first whole segment is ready");
    changed = true;
    node.replaceManyCount("app", "items", [{ _id: "0", kind: 9, score: -100 }, { _id: "8192", kind: 9, score: -200 }]);
    node.removeMany("app", "items", ["1", "8191"]);
    node.insertManyCount("app", "items", [{ _id: "new", kind: 9, score: 300 }]);
    node.applyRemote("remote", [{ kind: "putObj", db: "app", coll: "items", id: "remote", value: { kind: 9, score: 400 },
      from: "remote", seq: 1, ts: { c: 20000, n: "remote" }, shard: "default" }], node._cursorKey("remote", scope));
  });
  await persistence.checkpoint();
  assert.equal(changed, true);
  await persistence.flush();
  await node.awaitIndexes("app", "items");
  const manifest = JSON.parse(await readPublished(storage, `${base}/latest.json`));
  assert.equal(manifest.cursors.writer, 8193);
  assert.equal(manifest.cursors.remote, undefined);
  assert.ok((await storage.list(`${base}/journal/`)).length > 0, "post-cut operations must not be compacted");
  const fresh = new CRDTNode({ id: "restored" });
  t.after(() => fresh.db.dispose());
  await new PersistenceManager({ node: fresh, storage }).restore();
  await fresh.awaitIndexes("app", "items");
  assert.equal(fresh.count("app", "items"), node.count("app", "items"));
  for (let i = 0; i < 8193; i++) assert.deepEqual(fresh.get("app", "items", String(i)), node.get("app", "items", String(i)));
  for (const id of ["new", "remote"]) assert.deepEqual(fresh.get("app", "items", id), node.get("app", "items", id));
  const spec = { groupBy: "kind", fields: { total: { $sum: "score" }, count: { $count: true } } };
  const ordered = (groups) => groups.sort((a, b) => a.kind - b.kind);
  assert.deepEqual(ordered(fresh.aggregate("app", "items", {}, spec)), ordered(node.aggregate("app", "items", {}, spec)));
});

for (const context of ["database", "collection"]) {
  test(`${context} deletion during preparation fences the checkpoint`, async (t) => {
    const { node, storage, persistence } = fixture(t);
    persistence.start();
    node.insertManyCount("app", "items", Array.from({ length: 8193 }, (_, i) => ({ _id: String(i), score: i })));
    let deletion;
    duringPreparation(node, () => {
      deletion = node.lifecycle.drop({ database: "app", ...(context === "collection" ? { collection: "items" } : {}) });
    });
    await assert.rejects(persistence.checkpoint(), { code: "SNAPSHOT_CONFLICT" });
    assert.ok(deletion);
    await deletion;
    if (context === "database") await node.lifecycle.create({ database: "app" }, null, () => node.createDatabase("app"));
    await node.lifecycle.create(scope, null, () => node.createCollection("app", "items"));
    node.insertManyCount("app", "items", [{ _id: "new", score: 42 }]);
    await persistence.flush();
    const fresh = new CRDTNode({ id: "restored" });
    t.after(() => fresh.db.dispose());
    await new PersistenceManager({ node: fresh, storage }).restore();
    assert.equal(fresh.count("app", "items"), 1);
    assert.deepEqual(fresh.get("app", "items", "new"), { _id: "new", score: 42 });
  });
}

test("snapshot upload waits do not occupy the derived-state scheduler", async (t) => {
  const { node, storage, persistence } = fixture(t);
  node.insertManyCount("app", "items", Array.from({ length: 5001 }, (_, i) => ({ _id: String(i), kind: i % 7 })));
  let release, reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const atUpload = new Promise((resolve) => { reached = resolve; });
  const put = storage.put.bind(storage);
  storage.put = async (key, ...args) => {
    if (key.includes("/segment-")) { reached(); await gate; }
    return put(key, ...args);
  };
  const checkpoint = persistence.checkpoint();
  try {
    await atUpload;
    node.setCollectionMeta("app", "items", { indexes: ["kind"] });
    await node.awaitIndexes("app", "items");
    assert.equal(node.count("app", "items", { kind: 0 }), 715);
  } finally { release(); await checkpoint; }
});

test("preparation failure leaves the published head and journals intact", async (t) => {
  const { node, storage, persistence } = fixture(t);
  persistence.start();
  node.insertManyCount("app", "items", Array.from({ length: 8193 }, (_, i) => ({ _id: String(i), score: i })));
  await persistence.checkpoint();
  const head = await readPublished(storage, `${base}/latest.json`);
  node.replaceManyCount("app", "items", [{ _id: "0", score: 42 }]);
  await persistence.flush();
  const journals = await storage.list(`${base}/journal/`);
  const iterate = node.snapshotScopeObjects.bind(node);
  node.snapshotScopeObjects = function* (context) {
    let count = 0;
    for (const row of iterate(context)) {
      if (++count === 5000) throw new Error("injected preparation failure");
      yield row;
    }
  };
  await assert.rejects(persistence.checkpoint(), /injected preparation failure/);
  assert.equal(await readPublished(storage, `${base}/latest.json`), head);
  assert.deepEqual(await storage.list(`${base}/journal/`), journals);
  node.snapshotScopeObjects = iterate;
  await turn();
  await persistence.checkpoint();
  assert.notEqual(await readPublished(storage, `${base}/latest.json`), head);
});
