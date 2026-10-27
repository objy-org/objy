import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { CRDTNode } from "../src/crdt.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";
import { finalizeShardMap, publishShardMap, TOPOLOGY_ACTIVE, TOPOLOGY_RESHARDING } from "../src/shard-map.js";

const OBJECTS = Number(process.env.OBJECTS || 2_000_000);
const OLD_SHARDS = Number(process.env.OLD_SHARDS || 8);
const NEW_SHARDS = Number(process.env.NEW_SHARDS || 12);
const SEGMENT_BYTES = Number(process.env.SEGMENT_BYTES || 32 * 1024 * 1024);

const oldShardNames = Array.from({ length: OLD_SHARDS }, (_, i) => `events-${i}`);
const desiredShardNames = Array.from({ length: NEW_SHARDS }, (_, i) => `slot-${String(i).padStart(4, "0")}`);
const storage = new MemoryObjectStorage();
const oldWriter = new CRDTNode({ id: "old-writer", retainOps: 0, syncBatchSize: 16_384 });
const oldPersistence = new PersistenceManager({
  node: oldWriter,
  storage,
  flushMs: 0,
  snapshotMs: 0,
  segmentBytes: SEGMENT_BYTES,
});

function shardMapFor(shards, peerByShard = {}) {
  return {
    shards: Object.fromEntries(shards.map((shard) => [shard, { peers: peerByShard[shard] || [] }])),
  };
}

function idAt(i) {
  return `event-${i}`;
}

function mem() {
  const used = process.memoryUsage();
  return {
    rssMb: Math.round(used.rss / 1024 / 1024),
    heapUsedMb: Math.round(used.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(used.heapTotal / 1024 / 1024),
  };
}

async function timed(label, fn) {
  const start = performance.now();
  const result = await fn();
  const seconds = ((performance.now() - start) / 1000).toFixed(2);
  console.log(`${label}: ${seconds}s`, mem());
  return result;
}

function sampleIndexes() {
  return [
    0,
    1,
    42,
    999,
    Math.floor(OBJECTS / 4),
    Math.floor(OBJECTS / 2),
    OBJECTS - 2,
    OBJECTS - 1,
  ].filter((value, index, all) => value >= 0 && value < OBJECTS && all.indexOf(value) === index);
}

function forceGc() {
  if (typeof global.gc === "function") global.gc();
}

console.log("planned reshard restart stress start", {
  OBJECTS,
  OLD_SHARDS,
  NEW_SHARDS,
  SEGMENT_BYTES,
}, mem());

oldWriter.replaceShardMap(shardMapFor(oldShardNames));
oldPersistence.start();
oldWriter.createCollection("app", "events", {
  indexes: ["kind"],
  columns: ["value"],
});

await timed("insert old cluster objects", () => {
  for (let i = 0; i < OBJECTS; i++) {
    oldWriter.insert("app", "events", {
      _id: idAt(i),
      kind: i % 17,
      value: i,
      payload: { bucket: i % 257 },
    });
  }
});

await timed("persist old shard snapshots", async () => {
  const stats = await oldPersistence.checkpoint();
  assert.equal(stats.scopes, OLD_SHARDS);
  assert.equal(stats.objects, OBJECTS);
});
await oldPersistence.stop();

const latestKeys = await storage.list("objydb/db/app/collection/events/shard/");
const sourceLatest = new Map();
for (const shard of oldShardNames) {
  const key = `objydb/db/app/collection/events/shard/${shard}/latest.json`;
  assert.ok(latestKeys.includes(key));
  sourceLatest.set(key, await storage.get(key));
}
console.log("old persisted shard latest files", OLD_SHARDS);

const desiredPeers = Object.fromEntries(desiredShardNames.map((shard, index) => [
  shard,
  [{ url: `http://target-${index}` }],
]));
const targetMap = publishShardMap(oldWriter.shardMapSnapshot(), shardMapFor(desiredShardNames, desiredPeers));
const newShardNames = Object.keys(targetMap.shards).sort();
assert.equal(targetMap.topology.state, TOPOLOGY_RESHARDING);
assert.equal(newShardNames.some((shard) => oldShardNames.includes(shard)), false);

const newRouter = new CRDTNode({ id: "new-router" });
newRouter.replaceShardMap(targetMap);
const expectedCounts = new Map(newShardNames.map((shard) => [shard, 0]));
const expectedGroups = new Map(newShardNames.map((shard) => [
  shard,
  Array.from({ length: 17 }, (_, kind) => ({ kind, total: 0, count: 0 })),
]));
let moved = 0;
for (let i = 0; i < OBJECTS; i++) {
  const id = idAt(i);
  const oldShard = oldWriter.shardForObject("app", "events", id);
  const newShard = newRouter.shardForObject("app", "events", id);
  expectedCounts.set(newShard, expectedCounts.get(newShard) + 1);
  const group = expectedGroups.get(newShard)[i % 17];
  group.total += i;
  group.count++;
  if (oldShard !== newShard) moved++;
}
console.log("expected new distribution", { moved, counts: Object.fromEntries(expectedCounts) });

const restored = new Map();
let lastPersistence;
await timed("restore new shard nodes from all old shards", async () => {
  for (const [index, shard] of newShardNames.entries()) {
    const node = new CRDTNode({
      id: `${shard}-node`,
      url: `http://target-${index}`,
      retainOps: 0,
      syncBatchSize: 16_384,
    });
    node.replaceShardMap(targetMap);
    lastPersistence = new PersistenceManager({
      node,
      storage,
      restoreScopes: [{ database: "app", collection: "events", shard }],
    });
    const stats = await lastPersistence.restore();
    assert.equal(stats.snapshots, OLD_SHARDS, `${shard} scanned all old shard snapshots`);
    assert.equal(stats.snapshotObjects, expectedCounts.get(shard), `${shard} imported new owner objects`);
    assert.equal(stats.reshardCheckpoint.scopes, 1, `${shard} checkpointed its target scope`);
    await node.awaitIndexes("app", "events");
    restored.set(shard, node);
    forceGc();
  }
});

for (const [key, manifest] of sourceLatest) assert.equal(await storage.get(key), manifest);
const readiness = await lastPersistence.reshardReadiness();
assert.equal(readiness.ready, true);
assert.equal(readiness.expectedScopes, NEW_SHARDS);
const finalizedMap = finalizeShardMap(targetMap, readiness.topologyId);
assert.equal(finalizedMap.topology.state, TOPOLOGY_ACTIVE);

const replicaPeers = Object.fromEntries(desiredShardNames.map((slot, index) => [slot, [
  { url: `http://target-${index}` },
  { url: `http://replica-${index}` },
]]));
const replicatedMap = publishShardMap(finalizedMap, shardMapFor(desiredShardNames, replicaPeers));
assert.equal(replicatedMap.topology.id, finalizedMap.topology.id);

await timed("restore one replica per finalized shard", async () => {
  for (const [index, shard] of newShardNames.entries()) {
    const replica = new CRDTNode({
      id: `${shard}-replica`,
      url: `http://replica-${index}`,
      retainOps: 0,
      syncBatchSize: 16_384,
    });
    replica.replaceShardMap(replicatedMap);
    const stats = await new PersistenceManager({ node: replica, storage }).restore();
    assert.equal(stats.snapshots, 1, `${shard} replica restored only its finalized target snapshot`);
    assert.equal(replica.count("app", "events"), expectedCounts.get(shard), `${shard} replica count`);
    forceGc();
  }
});

await timed("new shard consistency checks", () => {
  let total = 0;
  for (const [shard, node] of restored) {
    const count = node.count("app", "events");
    assert.equal(count, expectedCounts.get(shard), `${shard} count`);
    total += count;
  }
  assert.equal(total, OBJECTS);

  for (const idx of sampleIndexes()) {
    const id = idAt(idx);
    const shard = newRouter.shardForObject("app", "events", id);
    assert.deepEqual(restored.get(shard).get("app", "events", id), oldWriter.get("app", "events", id));

    const sibling = newShardNames[(newShardNames.indexOf(shard) + 1) % newShardNames.length];
    assert.equal(restored.get(sibling).get("app", "events", id), undefined);
  }
});

await timed("new shard index and column checks", () => {
  const spec = {
    groupBy: "kind",
    fields: {
      total: { $sum: "value" },
      count: { $count: true },
    },
    $sort: { kind: 1 },
  };

  for (const [shard, node] of restored) {
    assert.equal(node.queryPath("app", "events", { kind: 3 }), "index-exact", `${shard} query path`);
    assert.equal(
      node.aggregatePath("app", "events", {}, spec),
      "aggregate-group-index",
      `${shard} aggregate path`,
    );
    assert.equal(
      node.count("app", "events", { kind: 3 }),
      expectedGroups.get(shard)[3].count,
      `${shard} indexed count`,
    );
    assert.deepEqual(
      node.aggregate("app", "events", {}, spec),
      expectedGroups.get(shard).filter((group) => group.count),
      `${shard} grouped aggregate`,
    );
  }
});

console.log("planned reshard restart stress passed", {
  objects: OBJECTS,
  oldShards: OLD_SHARDS,
  newShards: NEW_SHARDS,
  moved,
  movedRatio: Number((moved / OBJECTS).toFixed(4)),
  topology: replicatedMap.topology.id,
  counts: Object.fromEntries(expectedCounts),
  memory: mem(),
});
