import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { CRDTNode, localPeer } from "../src/crdt.js";

const OBJECTS = Number(process.env.OBJECTS || 1_000_000);
const SHARDS = Number(process.env.SHARDS || 8);
const MUTATIONS = Number(process.env.MUTATIONS || 100_000);
const BATCH = Number(process.env.SYNC_BATCH_SIZE || 16_384);

const shardNames = Array.from({ length: SHARDS }, (_, i) => `events-${i}`);
// This direct localPeer stress keeps the writer log intact; trimmed catch-up is covered by persistence/server tests.
const writer = new CRDTNode({ id: "writer", retainOps: OBJECTS + MUTATIONS + 1, syncBatchSize: BATCH });
const onlineReplicas = shardNames.map((shard) => new CRDTNode({ id: `${shard}-online`, syncBatchSize: BATCH }));

function shardMapFor(peerByShard = {}) {
  return {
    shards: Object.fromEntries(shardNames.map((shard) => [shard, { peers: peerByShard[shard] || [] }])),
  };
}

function idAt(i) {
  return `event-${i}`;
}

function mutationIndex(i) {
  return (i * 7919) % OBJECTS;
}

function isDeleteMutation(i) {
  return i % 10 === 0;
}

function expectedValue(idNumber) {
  let value = idNumber;
  for (let i = 0; i < MUTATIONS; i++) {
    const idx = mutationIndex(i);
    if (idx !== idNumber) continue;
    if (isDeleteMutation(i)) return undefined;
    value = OBJECTS + i;
  }
  return value;
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
    ...Array.from({ length: 20 }, (_, i) => mutationIndex(i * 499 + 17)),
  ].filter((value, index, all) => value >= 0 && value < OBJECTS && all.indexOf(value) === index);
}

writer.replaceShardMap(shardMapFor());
for (let i = 0; i < SHARDS; i++) {
  onlineReplicas[i].replaceShardMap(shardMapFor({ [shardNames[i]]: [localPeer(writer)] }));
}

const expectedCounts = new Map(shardNames.map((shard) => [shard, 0]));
const deleted = new Set();

console.log("million-object stress start", { OBJECTS, SHARDS, MUTATIONS, BATCH }, mem());

await timed("insert writer objects", () => {
  for (let i = 0; i < OBJECTS; i++) {
    const id = idAt(i);
    expectedCounts.set(writer.shardForObject("app", "events", id), expectedCounts.get(writer.shardForObject("app", "events", id)) + 1);
    writer.insert("app", "events", { _id: id, v: i });
  }
});

await timed("initial online shard replica sync", async () => {
  await Promise.all(onlineReplicas.map((node) => node.syncAll()));
});

console.log("after initial sync", { writerSeq: writer.seq, trimmed: writer.trimmed, logLength: writer.log.length }, mem());

await timed("mutate writer while fresh replicas are absent", () => {
  for (let i = 0; i < MUTATIONS; i++) {
    const idx = mutationIndex(i);
    const id = idAt(idx);
    if (isDeleteMutation(i)) {
      if (!deleted.has(id)) {
        deleted.add(id);
        const shard = writer.shardForObject("app", "events", id);
        expectedCounts.set(shard, expectedCounts.get(shard) - 1);
      }
      writer.remove("app", "events", id);
    } else {
      writer.update("app", "events", id, { v: OBJECTS + i });
    }
  }
});

await timed("online shard replicas catch up after mutations", async () => {
  await Promise.all(onlineReplicas.map((node) => node.syncAll()));
});

console.log("after mutation sync", { writerSeq: writer.seq, trimmed: writer.trimmed, logLength: writer.log.length }, mem());

await timed("consistency checks", () => {
  for (let i = 0; i < SHARDS; i++) {
    const shard = shardNames[i];
    const expectedCount = expectedCounts.get(shard);
    assert.equal(onlineReplicas[i].count("app", "events"), expectedCount, `${onlineReplicas[i].id} count`);
  }

  for (const idx of sampleIndexes()) {
    const id = idAt(idx);
    const shard = writer.shardForObject("app", "events", id);
    const shardIndex = shardNames.indexOf(shard);
    const expected = expectedValue(idx);
    const online = onlineReplicas[shardIndex].get("app", "events", id);

    if (expected === undefined) {
      assert.equal(online, undefined, `${id} deleted on online replica`);
    } else {
      assert.equal(online.v, expected, `${id} online value`);
    }

    for (let offset = 1; offset < Math.min(SHARDS, 4); offset++) {
      const other = (shardIndex + offset) % SHARDS;
      assert.equal(onlineReplicas[other].get("app", "events", id), undefined, `${id} not on sibling online shard`);
    }
  }
});

console.log("million-object stress passed", {
  objects: OBJECTS,
  shards: SHARDS,
  mutations: MUTATIONS,
  writerSeq: writer.seq,
  trimmed: writer.trimmed,
  logLength: writer.log.length,
  counts: Object.fromEntries(expectedCounts),
  memory: mem(),
});
