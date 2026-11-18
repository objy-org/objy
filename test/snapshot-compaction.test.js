import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { CRDTNode } from "../src/crdt.js";
import { nodeCompression } from "../src/node-runtime.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";
import { publishShardMap } from "../src/shard-map.js";
import { captureCompaction, compactSnapshot } from "../experiments/snapshot-compaction/compact.js";

const scope = { database: "app", collection: "items", shard: "default" };
const head = "objydb/db/app/collection/items/shard/default/latest.json";

async function fixture(t, { snapshot = true } = {}) {
  const node = new CRDTNode({ id: "writer", storage: { engine: "object", compression: nodeCompression } });
  const storage = new MemoryObjectStorage();
  const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0, opBatchSize: 100000 });
  persistence.start();
  t.after(async () => { await persistence.stop(); node.db.dispose(); });
  node.createCollection("app", "items", {
    indexes: ["kind"], columns: ["score"],
    tiering: { mode: "compressedMemory", offload: ["payload"], minBytes: 64 },
    structure: [{ condition: {}, apply: { virtual: "not physically stored" } }],
  });
  node.insertManyCount("app", "items", Array.from({ length: 64 }, (_, i) => ({
    _id: `id-${i}`, kind: `g${i % 4}`, score: i,
    payload: { text: `hello ${i} \u00e4\u4e16\u754c`.repeat(40), nested: [i, null, false, { x: true }] },
    _vec: [i + 1, 1, 0],
    reference: { type: "reference", family: "items", value: "id-1" },
  })));
  if (snapshot) await persistence.checkpoint();
  return { node, storage, persistence };
}

function objects(node) {
  return [...node.db.collectionSnapshotObjects("app", "items")]
    .map((row) => row.deleted ? { id: row.id, deleted: row.deleted } : row)
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function build(storage, plan, options = {}) {
  const workDir = await mkdtemp(join(tmpdir(), "objy-compaction-test-"));
  try {
    return await compactSnapshot(storage, plan, { workDir, runBytes: 4096, segmentBytes: 8192, mergeWidth: 2, ...options });
  } finally { await assert.rejects(access(workDir)); }
}

async function restore(t, storage, plan, { tail = false } = {}) {
  const copy = new MemoryObjectStorage();
  copy.objects = new Map(storage.objects);
  const key = `${plan.output}/manifest.json`;
  assert.ok(await copy.get(key));
  // Publication happens only inside this disposable restore fixture.
  await copy.put(head, await copy.get(key));
  const node = new CRDTNode({ id: "fresh", storage: { engine: "object", compression: nodeCompression } });
  t.after(() => node.db.dispose());
  await new PersistenceManager({ node, storage: copy, restoreSnapshotId: tail ? undefined : plan.manifest.id }).restore();
  await node.awaitIndexes("app", "items");
  return node;
}

test("candidate compacts full objects, vectors, columns and compressed bodies with the normal restore reader", async (t) => {
  const f = await fixture(t);
  f.node.replaceManyCount("app", "items", [{ _id: "id-0", kind: "changed", score: 999, payload: { text: "updated" }, _vec: [1, 2, 3] }]);
  f.node.removeMany("app", "items", ["id-1", "id-2"]);
  f.node.insertManyCount("app", "items", [{ _id: "new", score: 3, dynamic: { nested: [1, "two"] } }]);
  const plan = await captureCompaction(f.persistence, scope), expected = objects(f.node);
  const before = new Map(f.storage.objects), result = await build(f.storage, plan);
  assert.ok(result.initialRuns > 2);
  assert.ok(result.mergePasses > 0);
  assert.equal(result.manifest.objectCount, 65);
  for (const [key, value] of before) assert.deepEqual(f.storage.objects.get(key), value, key);
  const fresh = await restore(t, f.storage, plan);
  assert.deepEqual(objects(fresh), expected);
  assert.equal(fresh.count("app", "items"), 63);
  assert.equal(fresh.get("app", "items", "id-0").virtual, undefined);
  assert.deepEqual(fresh.aggregate("app", "items", {}, { fields: { sum: { $sum: "score" }, count: { $count: true } } }),
    f.node.aggregate("app", "items", {}, { fields: { sum: { $sum: "score" }, count: { $count: true } } }));
});

test("journal-only first snapshot and an empty collection need no live object export", async (t) => {
  const f = await fixture(t, { snapshot: false });
  const plan = await captureCompaction(f.persistence, scope);
  f.node.snapshotScopeObjects = () => { throw new Error("must not read live objects"); };
  await build(f.storage, plan);
  assert.deepEqual(objects(await restore(t, f.storage, plan)), objects(f.node));
  const empty = { ...plan, snapshot: null, journals: [], output: plan.output.replace(plan.manifest.id, "candidate-empty"), manifest: { ...plan.manifest, id: "candidate-empty" } };
  const result = await build(f.storage, empty);
  assert.equal(result.manifest.objectCount, 0);
  assert.deepEqual(result.manifest.segments, []);
});

test("concurrent durable writes beyond the captured cut remain in journals and replay normally", async (t) => {
  const f = await fixture(t);
  f.node.replaceManyCount("app", "items", [{ _id: "id-3", score: 100 }]);
  const plan = await captureCompaction(f.persistence, scope), atCut = objects(f.node);
  f.node.replaceManyCount("app", "items", [{ _id: "id-3", score: 200 }]);
  f.node.removeMany("app", "items", ["id-4"]);
  f.node.insertManyCount("app", "items", [{ _id: "after-cut", score: 300 }]);
  await f.persistence.flush();
  // Include a file containing later operations: record-level cut filtering is required.
  plan.journals = await f.storage.list("objydb/db/app/collection/items/shard/default/journal/");
  await build(f.storage, plan);
  assert.deepEqual(objects(await restore(t, f.storage, plan)), atCut);
  assert.deepEqual(objects(await restore(t, f.storage, plan, { tail: true })), objects(f.node));
});

test("multi-writer conflicts, duplicate operations, stale writes and delete/recreate use existing version rules", async (t) => {
  const f = await fixture(t);
  const changes = [
    { kind: "putObj", id: "id-0", value: { score: 2 }, ts: { c: 100, n: "b" } },
    { kind: "putObj", id: "id-0", value: { score: 1 }, ts: { c: 100, n: "a" } },
    { kind: "delObj", id: "id-1", ts: { c: 101, n: "b" } },
    { kind: "putObj", id: "id-1", value: { score: -1 }, ts: { c: 99, n: "b" } },
    { kind: "putObj", id: "id-2", value: { score: 5 }, ts: { c: 103, n: "b" } },
    { kind: "delObj", id: "id-2", ts: { c: 102, n: "b" } },
    { kind: "touch", id: "empty", ts: { c: 104, n: "b" } },
  ].map((op, i) => ({ ...op, db: "app", coll: "items", shard: "default", from: "b", seq: i + 1 }));
  f.node.applyRemote("b", changes, f.node._cursorKey("b", scope));
  const plan = await captureCompaction(f.persistence, scope);
  const key = "objydb/db/app/collection/items/shard/default/journal/b/duplicates.jsonl";
  await f.storage.put(key, changes.map((op) => JSON.stringify(op)).join("\n") + "\n");
  plan.journals.push(key);
  await build(f.storage, plan);
  assert.deepEqual(objects(await restore(t, f.storage, plan)), objects(f.node));
});

test("one hot ID's history may exceed the run budget without retaining its entire history", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 3000; i++) f.node.replaceManyCount("app", "items", [{ _id: "hot", value: i, data: "x".repeat(128) }]);
  const plan = await captureCompaction(f.persistence, scope);
  const result = await build(f.storage, plan);
  assert.ok(result.initialRuns > 100);
  assert.deepEqual(objects(await restore(t, f.storage, plan)), objects(f.node));
});

for (const kind of ["missing", "malformed", "oversized", "row-count", "manifest-context", "total-count", "upload", "head-change", "meta-change", "drop", "recreate"]) {
  test(`failed candidate (${kind}) leaves the old snapshot and journals untouched`, async (t) => {
    const f = await fixture(t);
    f.node.replaceManyCount("app", "items", [{ _id: "id-0", score: 1000 }]);
    const plan = await captureCompaction(f.persistence, scope), before = new Map(f.storage.objects);
    if (kind === "missing") plan.journals.push("missing.jsonl");
    if (kind === "malformed") { await f.storage.put("bad.jsonl", "{broken\n"); plan.journals.push("bad.jsonl"); }
    if (kind === "row-count") plan.snapshot.segments[0].count++;
    if (kind === "manifest-context") plan.snapshot.database = "other";
    if (kind === "total-count") plan.snapshot.objectCount++;
    if (kind === "head-change") await f.storage.put(head, JSON.stringify({ different: true }));
    if (kind === "meta-change") await f.storage.put(plan.guards[2][0], JSON.stringify({ indexes: ["new"] }));
    if (kind === "drop") await f.storage.put(plan.guards[4][0], JSON.stringify({ deletedAt: "now" }));
    if (kind === "recreate") await f.storage.put(plan.guards[0][0], null);
    if (kind === "upload") {
      const put = f.storage.put.bind(f.storage);
      f.storage.put = (key, ...args) => key.startsWith(plan.output) ? Promise.reject(new Error("upload failed")) : put(key, ...args);
    }
    await assert.rejects(build(f.storage, plan, kind === "oversized" ? { maxRecordBytes: 64 } : {}));
    assert.equal(await f.storage.get(`${plan.output}/manifest.json`), null);
    for (const [key, value] of before) {
      if (["head-change", "meta-change", "drop", "recreate"].includes(kind) && plan.guards.some(([guard]) => guard === key)) continue;
      assert.deepEqual(f.storage.objects.get(key), value, key);
    }
  });
}

test("scope mixups and missing source coverage fail closed", async (t) => {
  const f = await fixture(t);
  const plan = await captureCompaction(f.persistence, scope);
  const key = "objydb/db/app/collection/items/shard/default/journal/unknown/test.jsonl";
  const op = { kind: "putObj", db: "wrong", coll: "items", shard: "default", id: "bad", ts: { c: 100, n: "unknown" }, from: "unknown", seq: 1, value: {} };
  await f.storage.put(key, JSON.stringify(op) + "\n");
  plan.journals.push(key);
  await assert.rejects(build(f.storage, plan), /context/);
  op.db = "app";
  await f.storage.put(key, JSON.stringify(op) + "\n");
  await assert.rejects(build(f.storage, plan), /no durable cut/);
});

test("database, collection and shard scopes remain separate across candidate restores", async (t) => {
  const map = { shards: { a: { peers: [] }, b: { peers: [] } } };
  const node = new CRDTNode({ id: "writer", shardMap: map }), storage = new MemoryObjectStorage();
  const persistence = new PersistenceManager({ node, storage, snapshotMs: 0, flushMs: 0 });
  persistence.start();
  t.after(async () => { await persistence.stop(); node.db.dispose(); });
  const contexts = [["one", "items"], ["two", "items"], ["one", "other"]];
  for (const [db, collection] of contexts) {
    node.insertManyCount(db, collection, Array.from({ length: 100 }, (_, i) => ({ _id: `id-${i}`, value: `${db}/${collection}/${i}` })));
  }
  await persistence.checkpoint();
  for (const [db, collection] of contexts) {
    node.replaceManyCount(db, collection, [{ _id: "id-0", changed: `${db}/${collection}` }]);
    node.removeMany(db, collection, ["id-1"]);
  }
  for (const [database, collection] of contexts) {
    for (const shard of ["a", "b"]) {
      const plan = await captureCompaction(persistence, { database, collection, shard });
      await build(storage, plan);
      // Disposable fixture only; all production heads remain untouched by build().
      await storage.put(plan.guards[0][0], await storage.get(`${plan.output}/manifest.json`));
    }
  }
  const fresh = new CRDTNode({ id: "fresh", shardMap: map });
  t.after(() => fresh.db.dispose());
  await new PersistenceManager({ node: fresh, storage }).restore();
  for (const [db, collection] of contexts) {
    for (let i = 0; i < 100; i++) assert.deepEqual(fresh.get(db, collection, `id-${i}`), node.get(db, collection, `id-${i}`));
  }
});

test("the isolated candidate refuses active resharding rather than creating empty target snapshots", async (t) => {
  const f = await fixture(t);
  const current = { shards: { old: { peers: [] } } };
  f.node.replaceShardMap(publishShardMap(current, { shards: { a: { peers: [] }, b: { peers: [] } } }));
  await assert.rejects(captureCompaction(f.persistence, scope), /active reshard/);
});

for (const bytes of [0, 1024 * 1024, 4 * 1024 * 1024]) {
  test(`completion delivery is drained before child exit (${bytes} bytes), without sending the manifest`, async () => {
    const module = new URL("../experiments/snapshot-compaction/process.js", import.meta.url).href;
    const code = `import { sendCompactionResult } from ${JSON.stringify(module)};
      await sendCompactionResult({ manifest: { large: "x".repeat(4000000) }, manifestKey: "candidate/manifest.json", payload: "x".repeat(${bytes}) });
      process.disconnect();`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    let message;
    child.on("message", (value) => { message = value; });
    const [status] = await once(child, "close");
    assert.equal(status, 0);
    assert.equal(message?.result.manifestKey, "candidate/manifest.json");
    assert.equal(message.result.payload.length, bytes);
    assert.equal(message.result.manifest, undefined);
  });
}

test("scratch write failures abort and clean up without modifying persisted inputs", { timeout: 10000 }, async (t) => {
  const f = await fixture(t), plan = await captureCompaction(f.persistence, scope);
  const before = new Map(f.storage.objects);
  const workDir = await mkdtemp(join(tmpdir(), "objy-compaction-disk-test-"));
  await mkdir(join(workDir, "run-0.txt"));
  await assert.rejects(compactSnapshot(f.storage, plan, { workDir, runBytes: 4096 }), /EEXIST/);
  await assert.rejects(access(workDir));
  assert.deepEqual(f.storage.objects, before);
});
