import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { CRDTNode, localPeer } from "../src/crdt.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";

const OBJECTS = Number(process.env.OBJECTS || 2_000_000);
const SHARDS = Number(process.env.SHARDS || 8);
const REPLICAS_PER_SHARD = Number(process.env.REPLICAS_PER_SHARD || 2);
const BATCH = Number(process.env.SYNC_BATCH_SIZE || 16_384);
const SEGMENT_BYTES = Number(process.env.SEGMENT_BYTES || 32 * 1024 * 1024);

const shardNames = Array.from({ length: SHARDS }, (_, i) => `events-${i}`);
const writer = new CRDTNode({ id: "writer", retainOps: 0, syncBatchSize: BATCH });
const storage = new MemoryObjectStorage();

function fullShardMap() {
  return {
    shards: Object.fromEntries(shardNames.map((shard) => [shard, { peers: [] }])),
  };
}

function singleShardMap(shard, peers = []) {
  return {
    shards: {
      [shard]: { peers },
    },
  };
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

function idAt(i) {
  return `event-${i}`;
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

console.log("sharded persistence stress start", {
  OBJECTS,
  SHARDS,
  REPLICAS_PER_SHARD,
  BATCH,
  SEGMENT_BYTES,
}, mem());

writer.replaceShardMap(fullShardMap());

const expectedCounts = new Map(shardNames.map((shard) => [shard, 0]));
await timed("insert writer objects", () => {
  for (let i = 0; i < OBJECTS; i++) {
    const id = idAt(i);
    const shard = writer.shardForObject("app", "events", id);
    expectedCounts.set(shard, expectedCounts.get(shard) + 1);
    writer.insert("app", "events", {
      id,
      kind: i % 17,
      value: i,
      active: i % 3 !== 0,
      payload: { bucket: i % 257 },
    });
  }
});

let replicas = new Map();
for (const shard of shardNames) {
  replicas.set(
    shard,
    Array.from({ length: REPLICAS_PER_SHARD }, (_, i) => {
      const node = new CRDTNode({ id: `${shard}-replica-${i}`, retainOps: 0, syncBatchSize: BATCH });
      node.replaceShardMap(singleShardMap(shard, [localPeer(writer)]));
      return node;
    }),
  );
}

await timed("sync all shard replicas", async () => {
  await Promise.all([...replicas.values()].flat().map((node) => node.syncAll()));
});
assert.equal(writer.log.length, 0, "writer log should be pruned after all shard replicas ack");
console.log("after replica sync", { writerSeq: writer.seq, trimmed: writer.trimmed, logLength: writer.log.length }, mem());

await timed("replica consistency checks", () => {
  for (const [shard, nodes] of replicas) {
    for (const node of nodes) {
      assert.equal(node.count("app", "events"), expectedCounts.get(shard), `${node.id} count`);
    }
  }

  for (const idx of sampleIndexes()) {
    const id = idAt(idx);
    const shard = writer.shardForObject("app", "events", id);
    for (const node of replicas.get(shard)) {
      assert.deepEqual(node.get("app", "events", id), writer.get("app", "events", id), `${node.id} has ${id}`);
    }

    const sibling = shardNames[(shardNames.indexOf(shard) + 1) % shardNames.length];
    for (const node of replicas.get(sibling)) {
      assert.equal(node.get("app", "events", id), undefined, `${node.id} does not have foreign ${id}`);
    }
  }
});

const checkpointNodes = new Map(shardNames.map((shard) => [shard, replicas.get(shard)[0]]));
replicas = new Map(shardNames.map((shard) => [shard, [checkpointNodes.get(shard)]]));
forceGc();

await timed("checkpoint one replica per shard", async () => {
  for (const [shard, node] of checkpointNodes) {
    const stats = await new PersistenceManager({
      node,
      storage,
      flushMs: 0,
      snapshotMs: 0,
      segmentBytes: SEGMENT_BYTES,
    }).checkpoint();
    assert.equal(stats.scopes, 1, `${shard} checkpoint scope`);
    assert.equal(stats.objects, expectedCounts.get(shard), `${shard} checkpoint object count`);
  }
});

const latestKeys = await storage.list("spread-db/db/app/collection/events/shard/");
for (const shard of shardNames) {
  assert.ok(latestKeys.includes(`spread-db/db/app/collection/events/shard/${shard}/latest.json`));
}
console.log("persistent shard latest files", shardNames.length);

const restoredReplicas = new Map();
await timed("restore fresh replicas from persisted shard snapshots", async () => {
  for (const shard of shardNames) {
    const node = new CRDTNode({ id: `${shard}-restored`, retainOps: 0, syncBatchSize: BATCH });
    node.replaceShardMap(singleShardMap(shard));
    const stats = await new PersistenceManager({ node, storage }).restore();
    assert.equal(stats.snapshots, 1, `${shard} restored one snapshot`);
    assert.equal(stats.snapshotObjects, expectedCounts.get(shard), `${shard} restored object count`);
    restoredReplicas.set(shard, node);
  }
});

await timed("restored replica consistency checks", () => {
  for (const [shard, node] of restoredReplicas) {
    assert.equal(node.count("app", "events"), expectedCounts.get(shard), `${node.id} count`);
  }

  for (const idx of sampleIndexes()) {
    const id = idAt(idx);
    const shard = writer.shardForObject("app", "events", id);
    assert.deepEqual(restoredReplicas.get(shard).get("app", "events", id), writer.get("app", "events", id));

    const sibling = shardNames[(shardNames.indexOf(shard) + 1) % shardNames.length];
    assert.equal(restoredReplicas.get(sibling).get("app", "events", id), undefined);
  }
});

console.log("sharded persistence stress passed", {
  objects: OBJECTS,
  shards: SHARDS,
  replicasPerShard: REPLICAS_PER_SHARD,
  writerSeq: writer.seq,
  trimmed: writer.trimmed,
  logLength: writer.log.length,
  counts: Object.fromEntries(expectedCounts),
  memory: mem(),
});
