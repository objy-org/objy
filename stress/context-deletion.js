import assert from "node:assert/strict";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { CRDTNode } from "../src/crdt.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";
import { startServer, shardMapFromHttp } from "../src/server.js";

const count = Number(process.env.OBJECTS || 1_000_000);
const batchSize = 5000;
const db = "delete_stress", coll = "items";
const nodes = [], managers = [], servers = [];
let pauseUpload = false, release, entered;
const gate = new Promise((resolve) => { release = resolve; });
const atUpload = new Promise((resolve) => { entered = resolve; });
class Storage extends MemoryObjectStorage {
  async put(key, body, type) {
    if (pauseUpload && key.includes("/snapshots/") && key.endsWith(".jsonl")) {
      pauseUpload = false;
      entered();
      await gate;
    }
    return super.put(key, body, type);
  }
}
const storage = new Storage();
const meta = { indexes: ["kind"], columns: ["score"] };
const secret = "isolated-deletion-stress";
const options = { clusterSecret: secret, auth: { enabled: false }, forwardTimeoutMs: 5000 };
const delay = monitorEventLoopDelay({ resolution: 10 });
const results = { objects: count, shards: 2, replicasPerShard: 2 };
let oldOps;
const start = performance.now();
try {
  for (let i = 0; i < 4; i++) {
    const node = new CRDTNode({ id: `delete-stress-${i}` });
    const manager = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0, opBatchSize: 100_000 });
    manager.start();
    const server = await startServer({ node, persistence: manager, ...options });
    node.url = `http://127.0.0.1:${server.port}`;
    nodes.push(node); managers.push(manager); servers.push(server);
  }
  const map = { shards: Object.fromEntries([0, 1].map((shard) => [`shard-${shard}`, { peers: nodes.slice(shard * 2, shard * 2 + 2).map((node) => ({ url: node.url })) }])) };
  for (const node of nodes) {
    node.replaceShardMap(shardMapFromHttp(map, node.id, { secret }));
    node.createDatabase(db);
    node.createCollection(db, coll, meta);
  }
  const insert = async (total, prefix) => {
    for (let offset = 0; offset < total; offset += batchSize) {
      const batches = [[], []];
      for (let i = offset; i < Math.min(total, offset + batchSize); i++) {
        const object = { _id: `${prefix}-${i}`, kind: i % 17, score: i % 1000, details: { label: `asset-${i}`, payload: "x".repeat(160) } };
        const shard = Number(nodes[0].shardForObject(db, coll, object._id).slice(-1));
        batches[shard].push(object);
      }
      for (const [shard, batch] of batches.entries()) {
        const primary = nodes[shard * 2], replica = nodes[shard * 2 + 1];
        primary.insertManyCount(db, coll, batch);
        const ops = structuredClone(primary.log);
        if (!oldOps && prefix === "old") oldOps = ops;
        replica.applyRemote(primary.id, ops);
        primary.log = [];
        primary.trimmed = primary.seq;
      }
      await Promise.all(managers.map((manager) => manager.flush()));
    }
  };
  delay.enable();
  await insert(count, "old");
  results.insertAndJournalMs = Math.round(performance.now() - start);
  for (const node of nodes) await node.awaitIndexes(db, coll);
  assert.equal(nodes[0].count(db, coll) + nodes[2].count(db, coll), count);
  assert.equal(nodes[1].count(db, coll) + nodes[3].count(db, coll), count);
  const snapshotStart = performance.now();
  for (const index of [0, 2]) await managers[index].checkpoint();
  results.snapshotMs = Math.round(performance.now() - snapshotStart);
  results.loadedMemoryMiB = memory();
  console.log("loaded", JSON.stringify(results));

  await new Promise((resolve) => servers[3].server.close(resolve));
  pauseUpload = true;
  const checkpoint = managers[0].checkpoint().catch((error) => assert.equal(error.code, "SNAPSHOT_CONFLICT"));
  await atUpload;
  const deletion = fetch(`${nodes[2].url}/api/${db}/collections/${coll}`, { method: "DELETE" });
  for (let i = 0; !nodes[0].lifecycle.record(db, coll) && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  for (const node of nodes.slice(0, 3)) assert.throws(() => node.insert(db, coll, { _id: "blocked" }), { status: 409 });
  await assert.rejects(nodes[1].lifecycle.create({ database: db, collection: coll }, null, () => nodes[1].createCollection(db, coll)), { status: 409 });
  const id = nodes[2].lifecycle.record(db, coll).id;
  release();
  await checkpoint;
  assert.equal((await deletion).status, 503);
  servers[3] = await startServer({ port: servers[3].port, node: nodes[3], persistence: managers[3], ...options });
  const deleteStart = performance.now();
  const retry = await fetch(`${nodes[1].url}/api/${db}/collections/${coll}`, { method: "DELETE" });
  assert.equal(retry.status, 204, await retry.text());
  results.retryDeleteMs = Math.round(performance.now() - deleteStart);
  assert.equal(nodes[1].lifecycle.record(db, coll).id, id);
  for (const node of nodes) assert.equal(node.count(db, coll), 0);
  const remaining = await storage.list(`objydb/db/${db}/collection/${coll}/`);
  assert.ok(remaining.every((key) => /\/(meta|latest)\.json$/.test(key)), "only fixed-key deletion fences may remain");

  for (const node of nodes) await node.lifecycle.create({ database: db, collection: coll }, null, () => node.createCollection(db, coll, meta));
  const newCount = Math.min(25_000, count);
  await insert(newCount, "new");
  for (const node of nodes) {
    assert.equal(node.applyRemote("delete-stress-0", structuredClone(oldOps)), 0);
    await node.awaitIndexes(db, coll);
  }
  for (const index of [0, 2]) await managers[index].checkpoint();
  const restored = new CRDTNode({ id: "delete-restored" });
  const restoreStart = performance.now();
  await new PersistenceManager({ node: restored, storage }).restore();
  results.restoreNewMs = Math.round(performance.now() - restoreStart);
  assert.equal(restored.count(db, coll), newCount);
  await restored.awaitIndexes(db, coll);
  const aggregate = restored.aggregate(db, coll, {}, { fields: { total: { $sum: "score" }, count: { $count: true } } });
  assert.deepEqual(aggregate, [{ total: Array.from({ length: newCount }, (_, i) => i % 1000).reduce((a, b) => a + b, 0), count: newCount }]);
  assert.equal(restored.get(db, coll, "old-0"), undefined);
  restored.db.dispose();
  results.eventLoopP99Ms = Math.round(delay.percentile(99) / 1e6);
  global.gc?.();
  results.finalMemoryMiB = memory();
  results.totalMs = Math.round(performance.now() - start);
  console.log("deletion stress passed", JSON.stringify(results));
} finally {
  release(); delay.disable();
  for (const manager of managers) manager.unsubscribe?.();
  for (const server of servers) { await server.replication?.stop?.(); await new Promise((resolve) => server.server.close(resolve)); }
  for (const node of nodes) node.db.dispose();
}

function memory() {
  const { heapUsed, rss } = process.memoryUsage();
  return { heap: Math.round(heapUsed / 1048576), rss: Math.round(rss / 1048576) };
}
