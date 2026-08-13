import { test } from "node:test";
import assert from "node:assert/strict";
import { CRDTNode, localPeer } from "../src/crdt.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";

test("vectors are stored outside returned objects and searched through warmed HNSW", async () => {
  const node = new CRDTNode({ id: "vector-node" });

  node.insertMany("app", "docs", [
    { _id: "a", title: "alpha", status: "active", _vec: [1, 0, 0] },
    { _id: "b", title: "beta", status: "active", _vec: [0.9, 0.1, 0] },
    { _id: "c", title: "gamma", status: "archived", _vec: [0, 1, 0] },
  ]);

  assert.deepEqual(node.get("app", "docs", "a"), {
    _id: "a",
    title: "alpha",
    status: "active",
  });
  assert.deepEqual(node.getVector("app", "docs", "a"), [1, 0, 0]);
  assert.throws(
    () => node.vectorSearch("app", "docs", [1, 0, 0], 2),
    (err) => err.status === 503 && /vector index warming/.test(err.message),
  );
  await node.awaitVectorIndexes();

  const hits = node.vectorSearch("app", "docs", [1, 0, 0], 2);
  assert.deepEqual(hits.map((hit) => hit._id), ["a", "b"]);
  assert.ok(hits[0]._score > hits[1]._score);

  const filtered = node.rankVectorRows(
    "app",
    "docs",
    node.find("app", "docs", { status: "active" }),
    [0, 1, 0],
    2,
  );
  assert.deepEqual(filtered.map((row) => row._id), ["b", "a"]);
  assert.equal(filtered[0]._score > filtered[1]._score, true);
});

test("vector writes validate, preserve on ordinary replace, and remove explicitly", () => {
  const node = new CRDTNode({ id: "vector-node" });

  assert.throws(
    () => node.insert("app", "docs", { _id: "bad", _vec: [1, "not-a-number"] }),
    /_vec must be an array of finite numbers/,
  );
  assert.equal(node.get("app", "docs", "bad"), undefined);

  node.insert("app", "docs", { _id: "doc", title: "first", _vec: [1, 0] });
  node.replace("app", "docs", "doc", { title: "second" });
  assert.deepEqual(node.get("app", "docs", "doc"), { _id: "doc", title: "second" });
  assert.deepEqual(node.getVector("app", "docs", "doc"), [1, 0]);

  node.update("app", "docs", "doc", { _vec: [0, 1] });
  assert.deepEqual(node.getVector("app", "docs", "doc"), [0, 1]);

  node.update("app", "docs", "doc", { _vec: null });
  assert.equal(node.getVector("app", "docs", "doc"), null);
  assert.deepEqual(node.vectorSearch("app", "docs", [0, 1], 1), []);
});

test("replication carries vectors in object ops and rebuilds local vector indexes", async () => {
  const source = new CRDTNode({ id: "source" });
  const replica = new CRDTNode({ id: "replica" });
  replica.addPeer(localPeer(source));

  source.insert("app", "docs", { _id: "doc", title: "replicated", _vec: [0, 1, 0] });
  await replica.syncAll();

  assert.deepEqual(replica.get("app", "docs", "doc"), { _id: "doc", title: "replicated" });
  assert.deepEqual(replica.getVector("app", "docs", "doc"), [0, 1, 0]);
  await replica.awaitVectorIndexes();
  assert.deepEqual(replica.vectorSearch("app", "docs", [0, 1, 0], 1).map((hit) => hit._id), ["doc"]);
});

test("snapshots persist vectors but not vector indexes", async () => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "snapshot-writer" });
  const persistence = new PersistenceManager({ node, storage, segmentBytes: 1024 });

  node.insertMany("app", "docs", [
    { _id: "near", title: "near", _vec: [1, 0] },
    { _id: "far", title: "far", _vec: [0, 1] },
  ]);
  const snapshotRows = [...node.db.collection("app", "docs").snapshotObjects()];
  const nearSnapshot = snapshotRows.find((row) => row.id === "near");
  nearSnapshot.value.title = "changed";
  nearSnapshot.value._vec[0] = 99;
  assert.deepEqual(node.get("app", "docs", "near"), { _id: "near", title: "near" });
  assert.deepEqual(node.getVector("app", "docs", "near"), [1, 0]);

  await node.awaitVectorIndexes();
  node.vectorSearch("app", "docs", [1, 0], 1);
  await persistence.checkpoint();

  const keys = await storage.list("spread-db/");
  assert.equal(keys.some((key) => /hnsw|vector-index/i.test(key)), false);

  const segmentKey = keys.find((key) => key.includes("/snapshots/") && key.endsWith(".json") && key.includes("segment-"));
  assert.ok(segmentKey);
  const rows = JSON.parse(await storage.get(segmentKey));
  assert.deepEqual(rows.find((row) => row.id === "near").value._vec, [1, 0]);

  const fresh = new CRDTNode({ id: "fresh" });
  const restored = await new PersistenceManager({ node: fresh, storage }).restore();
  assert.equal(restored.snapshotObjects, 2);
  assert.deepEqual(fresh.get("app", "docs", "near"), { _id: "near", title: "near" });
  assert.throws(
    () => fresh.vectorSearch("app", "docs", [1, 0], 1),
    (err) => err.status === 503 && /vector index warming/.test(err.message),
  );
  await fresh.awaitVectorIndexes();
  assert.deepEqual(fresh.vectorSearch("app", "docs", [1, 0], 1).map((hit) => hit._id), ["near"]);
});
