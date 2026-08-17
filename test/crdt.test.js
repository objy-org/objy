import { test } from "node:test";
import assert from "node:assert/strict";
import { CRDTNode, localPeer } from "../src/crdt.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";

function pair() {
  const a = new CRDTNode({ id: "a" });
  const b = new CRDTNode({ id: "b" });
  a.addPeer(localPeer(b));
  b.addPeer(localPeer(a));
  return { a, b };
}

function shardMapFor(shards) {
  return {
    shards: Object.fromEntries(shards.map((shard) => [shard, { peers: [] }])),
  };
}

function idForShard(node, shard) {
  for (let i = 0; i < 10_000; i++) {
    const id = `id-${i}`;
    if (node.shardForObject("app", "events", id) === shard) return id;
  }
  throw new Error(`no test id found for ${shard}`);
}

function op(kind, id, extra = {}) {
  return { kind, id, db: "db", coll: "c", ...extra };
}

function logged(node, kind, id, extra = {}) {
  const o = op(kind, id, extra);
  o.from = node.id;
  o.seq = ++node.seq;
  node.log.push(o);
  node._applyOp(o);
  return o;
}

test("replication propagates writes in both directions", async () => {
  const { a, b } = pair();
  const id = a.insert("db", "c", { v: 1 });
  await b.syncAll();
  assert.deepEqual(b.get("db", "c", id), { _id: id, v: 1 });

  a.update("db", "c", id, { v: 2 });
  await b.syncAll();
  assert.equal(b.get("db", "c", id).v, 2);

  b.insert("db", "c", { _id: "from-b", v: 9 });
  await a.syncAll();
  assert.equal(a.get("db", "c", "from-b").v, 9);
});

test("three nodes converge through pairwise sync", async () => {
  const a = new CRDTNode({ id: "a" });
  const b = new CRDTNode({ id: "b" });
  const c = new CRDTNode({ id: "c" });
  for (const [x, y] of [[a, b], [b, c], [a, c]]) {
    x.addPeer(localPeer(y));
    y.addPeer(localPeer(x));
  }
  a.insert("db", "c", { _id: "x", v: 1 });
  b.insert("db", "c", { _id: "y", v: 2 });
  c.insert("db", "c", { _id: "z", v: 3 });
  for (let i = 0; i < 3; i++) {
    await a.syncAll();
    await b.syncAll();
    await c.syncAll();
  }
  for (const n of [a, b, c]) {
    assert.equal(n.count("db", "c"), 3);
    assert.deepEqual(n.list("db", "c").sort((p, q) => p._id.localeCompare(q._id)), [
      { _id: "x", v: 1 },
      { _id: "y", v: 2 },
      { _id: "z", v: 3 },
    ]);
  }
});

test("concurrent writes to the same object converge deterministically", async () => {
  const { a, b } = pair();
  a.insert("db", "c", { _id: "o", v: 1 });
  b.insert("db", "c", { _id: "o", v: 2 });
  await a.syncAll();
  await b.syncAll();
  const gotA = a.get("db", "c", "o").v;
  const gotB = b.get("db", "c", "o").v;
  assert.equal(gotA, gotB);
  assert.equal(gotA, 2, "higher node id wins the tie");
});

test("last-write-wins on whole objects, higher counter wins", async () => {
  const { a, b } = pair();
  logged(a, "putObj", "o", { value: { v: 1, from: "a" }, ts: { c: 1, n: "z" } });
  logged(b, "putObj", "o", { value: { v: 2, from: "b" }, ts: { c: 2, n: "z" } });
  await a.syncAll();
  await b.syncAll();
  assert.deepEqual(a.get("db", "c", "o"), { _id: "o", v: 2, from: "b" });
  assert.deepEqual(b.get("db", "c", "o"), { _id: "o", v: 2, from: "b" });
});

test("stale writes are ignored and never regress through sync", async () => {
  const { a, b } = pair();
  logged(a, "putObj", "o", { value: { v: 9 }, ts: { c: 5, n: "z" } });
  logged(a, "putObj", "o", { value: { v: 1 }, ts: { c: 2, n: "z" } });
  await b.syncAll();
  assert.equal(a.get("db", "c", "o").v, 9);
  assert.equal(b.get("db", "c", "o").v, 9);
});

test("delete vs concurrent update: newer timestamp wins either way", async () => {
  const { a, b } = pair();
  logged(a, "putObj", "o", { value: { v: 1 }, ts: { c: 1, n: "z" } });
  logged(b, "putObj", "o", { value: { v: 2 }, ts: { c: 4, n: "z" } });
  logged(a, "delObj", "o", { ts: { c: 3, n: "z" } });
  for (let i = 0; i < 3; i++) {
    await a.syncAll();
    await b.syncAll();
  }
  assert.deepEqual(a.get("db", "c", "o"), { _id: "o", v: 2 }, "update wins over older delete");
  assert.deepEqual(b.get("db", "c", "o"), { _id: "o", v: 2 });

  const { a: a2, b: b2 } = pair();
  logged(a2, "putObj", "o", { value: { v: 1 }, ts: { c: 1, n: "z" } });
  logged(b2, "putObj", "o", { value: { v: 2 }, ts: { c: 2, n: "z" } });
  logged(a2, "delObj", "o", { ts: { c: 3, n: "z" } });
  for (let i = 0; i < 3; i++) {
    await a2.syncAll();
    await b2.syncAll();
  }
  assert.equal(a2.get("db", "c", "o"), undefined, "delete wins over older update");
  assert.equal(b2.get("db", "c", "o"), undefined);
});

test("re-applying the same ops is idempotent", async () => {
  const { a } = pair();
  const ops = [
    op("putObj", "o", { value: { v: 7 }, ts: { c: 1, n: "z" } }),
    op("putObj", "o", { value: { w: "s" }, ts: { c: 2, n: "z" } }),
  ];
  a.applyRemote("seed", ops);
  a.applyRemote("seed", ops);
  assert.deepEqual(a.get("db", "c", "o"), { _id: "o", w: "s" });
});

test("concurrent object writes do not merge independent fields", async () => {
  const { a, b } = pair();
  logged(a, "putObj", "o", { value: { aOnly: true }, ts: { c: 1, n: "a" } });
  logged(b, "putObj", "o", { value: { bOnly: true }, ts: { c: 1, n: "b" } });
  await a.syncAll();
  await b.syncAll();
  assert.deepEqual(a.get("db", "c", "o"), { _id: "o", bOnly: true });
  assert.deepEqual(b.get("db", "c", "o"), { _id: "o", bOnly: true });
});

test("sync only transfers ops not yet seen", async () => {
  const a = new CRDTNode({ id: "a" });
  const b = new CRDTNode({ id: "b" });
  let pulled = 0;
  a.addPeer({
    nodeId: b.id,
    pull: async (after) => {
      pulled++;
      return { nodeId: b.id, lastSeq: b.log.length, ops: b.log.slice(after) };
    },
  });
  b.insert("db", "c", { _id: "o", v: 1 });
  await a.syncAll();
  assert.equal(a.count("db", "c"), 1);
  b.insert("db", "c", { _id: "p", v: 2 });
  await a.syncAll();
  assert.equal(a.count("db", "c"), 2);
  assert.equal(pulled, 2, "after cursor reused for incremental pull");
});

test("large replication catches up through bounded batches", async () => {
  const source = new CRDTNode({ id: "source" });
  const replica = new CRDTNode({ id: "replica", syncBatchSize: 250 });
  let pulls = 0;
  let maxBatch = 0;

  replica.addPeer({
    key: source.id,
    nodeId: source.id,
    pull: async (after, limit) => {
      pulls++;
      if (after < source.trimmed) {
        return { status: 410, nodeId: source.id, lastSeq: source.seq, trimmed: source.trimmed };
      }
      const start = after - source.trimmed;
      const ops = source.log.slice(start, limit ? start + limit : undefined);
      maxBatch = Math.max(maxBatch, ops.length);
      return { status: 200, nodeId: source.id, lastSeq: source.seq, ops };
    },
    ack: async (id, seq) => source.receiveAck(id, seq),
  });

  for (let i = 0; i < 2000; i++) {
    source.insert("db", "events", {
      _id: `e${i}`,
      kind: i % 2 ? "odd" : "even",
      value: i,
      payload: { bucket: i % 10 },
    });
  }

  const applied = await replica.syncAll();
  assert.equal(replica.count("db", "events"), 2000);
  assert.equal(replica.get("db", "events", "e1999").value, 1999);
  assert.equal(applied, source.seq);
  assert.ok(pulls > 1, "sync used multiple bounded pulls");
  assert.ok(maxBatch <= 250, "no pull exceeded the configured batch size");
  assert.equal(source.acks.get(replica.id), source.seq);
});

test("field type change replicates cleanly", async () => {
  const { a, b } = pair();
  const id = a.insert("db", "c", { v: 1 });
  await b.syncAll();
  a.replace("db", "c", id, { v: "now a string" });
  await b.syncAll();
  assert.deepEqual(b.get("db", "c", id), { _id: id, v: "now a string" });
});

test("replication receive updates declared field indexes", async () => {
  const { a, b } = pair();
  b.createCollection("db", "events", { indexes: ["value"] });

  a.insertMany("db", "events", [
    { _id: "e1", value: 2 },
    { _id: "e2", value: 1 },
  ]);
  await b.syncAll();

  assert.deepEqual(
    b.find("db", "events", {}, { sortBy: "value", limit: 2 }).map((event) => event._id),
    ["e2", "e1"],
  );
  assert.equal(b.indexStats("db", "events")[0].orderedEntries, 2);

  a.update("db", "events", "e1", { value: 0 });
  await b.syncAll();
  assert.deepEqual(
    b.find("db", "events", {}, { sortBy: "value", limit: 2 }).map((event) => event._id),
    ["e1", "e2"],
  );
});

test("retention prunes ops once acked", async () => {
  const a = new CRDTNode({ id: "a", retainOps: 0 });
  const b = new CRDTNode({ id: "b" });
  a.addPeer(localPeer(b));
  b.addPeer(localPeer(a));
  for (let i = 0; i < 50; i++) a.insert("db", "c", { _id: `o${i}`, v: i });
  assert.equal(a.log.length, 50);
  await b.syncAll();
  assert.equal(b.count("db", "c"), 50);
  assert.equal(a.trimmed, 50);
  assert.equal(a.log.length, 0);
  assert.equal(a.prune(), 0, "pruning is idempotent");
});

test("scoped replication snapshots only when that scope was trimmed", () => {
  const source = new CRDTNode({ id: "source", retainOps: 0 });
  source.replaceShardMap(shardMapFor(["shard-0", "shard-1"]));

  source.insert("app", "events", { _id: idForShard(source, "shard-0"), value: 1 });
  source.receiveAck("replica", source.seq, { database: "*", collection: "*", shard: "shard-0" });

  assert.equal(source.trimmed, 1);
  assert.equal(source.needsSnapshot(0, { database: "*", collection: "*", shard: "shard-0" }), true);
  assert.equal(source.needsSnapshot(0, { database: "*", collection: "*", shard: "shard-1" }), false);
});

test("retention keeps ops for a peer that acked but fell behind", async () => {
  const a = new CRDTNode({ id: "a", retainOps: 0 });
  const b = new CRDTNode({ id: "b" });
  const c = new CRDTNode({ id: "c" });
  a.addPeer(localPeer(b));
  a.addPeer(localPeer(c));
  b.addPeer(localPeer(a));
  c.addPeer(localPeer(a));
  for (let i = 0; i < 10; i++) a.insert("db", "c", { _id: `o${i}`, v: i });
  await c.syncAll();
  await b.syncAll();
  for (let i = 10; i < 20; i++) a.insert("db", "c", { _id: `o${i}`, v: i });
  await b.syncAll();
  assert.equal(a.trimmed, 10, "c's old ack protects ops 11..20");
  assert.equal(a.log.length, 10);
  await c.syncAll();
  assert.equal(c.count("db", "c"), 20);
  assert.equal(a.trimmed, 20);
});

test("retention buffer keeps ops beyond the ack watermark", async () => {
  const a = new CRDTNode({ id: "a", retainOps: 5 });
  const b = new CRDTNode({ id: "b" });
  a.addPeer(localPeer(b));
  b.addPeer(localPeer(a));
  for (let i = 0; i < 20; i++) a.insert("db", "c", { _id: `o${i}`, v: i });
  await b.syncAll();
  assert.equal(a.trimmed, 15, "kept 5 most recent acked ops");
  assert.equal(a.log.length, 5);
});

test("far-behind peer recovers via durable catch-up after 410", async () => {
  const a = new CRDTNode({ id: "a", retainOps: 0 });
  const b = new CRDTNode({ id: "b" });
  const storage = new MemoryObjectStorage();
  a.addPeer(localPeer(b));
  b.addPeer(localPeer(a));
  for (let i = 0; i < 30; i++) a.insert("db", "c", { _id: `o${i}`, v: i });
  await b.syncAll();
  a.remove("db", "c", "o5");
  await b.syncAll();
  assert.ok(a.trimmed > 0, "log has been truncated");
  await new PersistenceManager({ node: a, storage, segmentBytes: 1024 }).checkpoint();

  const fresh = new CRDTNode({ id: "fresh" });
  const freshPersistence = new PersistenceManager({ node: fresh, storage });
  fresh.setLogTruncatedHandler(({ scope }) => freshPersistence.restoreScope(scope));
  fresh.addPeer(localPeer(a));
  await fresh.syncAll();
  assert.equal(fresh.count("db", "c"), 29);
  assert.equal(fresh.get("db", "c", "o0").v, 0);
  assert.equal(fresh.get("db", "c", "o5"), undefined, "tombstone survives snapshot");

  a.update("db", "c", "o1", { v: 100 });
  await fresh.syncAll();
  assert.equal(fresh.get("db", "c", "o1").v, 100, "post-snapshot ops flow incrementally");
});

test("empty objects survive durable catch-up", async () => {
  const a = new CRDTNode({ id: "a", retainOps: 0 });
  const b = new CRDTNode({ id: "b" });
  const storage = new MemoryObjectStorage();
  a.addPeer(localPeer(b));
  b.addPeer(localPeer(a));

  a.insert("db", "c", { _id: "empty" });
  a.insert("db", "c", { _id: "filled", v: 1 });
  await b.syncAll();
  assert.equal(a.trimmed, 2);
  await new PersistenceManager({ node: a, storage, segmentBytes: 1024 }).checkpoint();

  const fresh = new CRDTNode({ id: "fresh" });
  const freshPersistence = new PersistenceManager({ node: fresh, storage });
  fresh.setLogTruncatedHandler(({ scope }) => freshPersistence.restoreScope(scope));
  fresh.addPeer(localPeer(a));
  await fresh.syncAll();

  assert.deepEqual(fresh.get("db", "c", "empty"), { _id: "empty" });
  assert.deepEqual(fresh.get("db", "c", "filled"), { _id: "filled", v: 1 });
});

test("snapshot never overwrites newer local writes (LWW)", async () => {
  const a = new CRDTNode({ id: "a", retainOps: 0 });
  const b = new CRDTNode({ id: "b" });
  a.addPeer(localPeer(b));
  b.addPeer(localPeer(a));
  const id = a.insert("db", "c", { v: 1 }); // ts c:1
  await b.syncAll();
  b.update("db", "c", id, { v: 2 }); // b's newer write (higher lamport)
  const snap = a.snapshot(); // a still has v:1
  b.applySnapshot(a.id, snap);
  assert.equal(b.get("db", "c", id).v, 2, "b's newer value wins over stale snapshot");
});

test("snapshot advances the local clock before new writes", () => {
  const source = new CRDTNode({ id: "source" });
  source.insert("db", "c", { _id: "o", v: 1 });
  for (let i = 0; i < 50; i++) source.update("db", "c", "o", { v: i + 2 });

  const fresh = new CRDTNode({ id: "fresh" });
  fresh.applySnapshot(source.id, source.snapshot());
  fresh.update("db", "c", "o", { v: "fresh write" });

  assert.equal(fresh.get("db", "c", "o").v, "fresh write");
  assert.ok(fresh.clock.c > source.clock.c);
});
