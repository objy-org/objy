import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { CRDTNode } from "../src/crdt.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";

const OBJECTS = Number(process.env.OBJECTS || 2_000_000);
const OLD_SHARDS = Number(process.env.OLD_SHARDS || 8);
const NEW_SHARDS = Number(process.env.NEW_SHARDS || 12);
const SEGMENT_BYTES = Number(process.env.SEGMENT_BYTES || 32 * 1024 * 1024);

const oldShardNames = Array.from({ length: OLD_SHARDS }, (_, i) => `events-${i}`);
const newShardNames = Array.from({ length: NEW_SHARDS }, (_, i) => `events-${i}`);
const storage = new MemoryObjectStorage();
const oldWriter = new CRDTNode({ id: "old-writer", retainOps: 0, syncBatchSize: 16_384 });

function shardMapFor(shards) {
  return {
    shards: Object.fromEntries(shards.map((shard) => [shard, { peers: [] }])),
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

await timed("insert old cluster objects", () => {
  for (let i = 0; i < OBJECTS; i++) {
    oldWriter.insert("app", "events", {
      id: idAt(i),
      kind: i % 17,
      value: i,
      payload: { bucket: i % 257 },
    });
  }
});

await timed("persist old shard snapshots", async () => {
  const stats = await new PersistenceManager({
    node: oldWriter,
    storage,
    flushMs: 0,
    snapshotMs: 0,
    segmentBytes: SEGMENT_BYTES,
  }).checkpoint();
  assert.equal(stats.scopes, OLD_SHARDS);
  assert.equal(stats.objects, OBJECTS);
});

const latestKeys = await storage.list("spread-db/db/app/collection/events/shard/");
for (const shard of oldShardNames) {
  assert.ok(latestKeys.includes(`spread-db/db/app/collection/events/shard/${shard}/latest.json`));
}
console.log("old persisted shard latest files", OLD_SHARDS);

const newRouter = new CRDTNode({ id: "new-router" });
newRouter.replaceShardMap(shardMapFor(newShardNames));
const expectedCounts = new Map(newShardNames.map((shard) => [shard, 0]));
let moved = 0;
for (let i = 0; i < OBJECTS; i++) {
  const id = idAt(i);
  const oldShard = oldWriter.shardForObject("app", "events", id);
  const newShard = newRouter.shardForObject("app", "events", id);
  expectedCounts.set(newShard, expectedCounts.get(newShard) + 1);
  if (oldShard !== newShard) moved++;
}
console.log("expected new distribution", { moved, counts: Object.fromEntries(expectedCounts) });

const restored = new Map();
await timed("restore new shard nodes from all old shards", async () => {
  for (const shard of newShardNames) {
    const node = new CRDTNode({ id: `${shard}-node`, retainOps: 0, syncBatchSize: 16_384 });
    node.replaceShardMap(shardMapFor(newShardNames));
    const stats = await new PersistenceManager({
      node,
      storage,
      restoreMode: "reshard",
      restoreScopes: [{ database: "app", collection: "events", shard }],
    }).restore();
    assert.equal(stats.snapshots, OLD_SHARDS, `${shard} scanned all old shard snapshots`);
    assert.equal(stats.snapshotObjects, expectedCounts.get(shard), `${shard} imported new owner objects`);
    restored.set(shard, node);
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

console.log("planned reshard restart stress passed", {
  objects: OBJECTS,
  oldShards: OLD_SHARDS,
  newShards: NEW_SHARDS,
  moved,
  movedRatio: Number((moved / OBJECTS).toFixed(4)),
  counts: Object.fromEntries(expectedCounts),
  memory: mem(),
});
