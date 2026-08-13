import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { CRDTNode } from "../src/crdt.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";

const count = Number(process.env.OBJECTS || 1_000_000);
const batchSize = Number(process.env.BATCH_SIZE || 25_000);
const segmentBytes = Number(process.env.SEGMENT_BYTES || 32 * 1024 * 1024);

const storage = new MemoryObjectStorage();
const writer = new CRDTNode({ id: "writer", retainOps: 0, syncBatchSize: 4096 });
const persistence = new PersistenceManager({
  node: writer,
  storage,
  flushMs: 0,
  snapshotMs: 0,
  opBatchSize: batchSize,
  segmentBytes,
});

const marks = [];

function mark(label) {
  const now = performance.now();
  const prev = marks.length ? marks[marks.length - 1].time : marks[0]?.time || now;
  marks.push({ label, time: now });
  console.log(`${label}: ${((now - prev) / 1000).toFixed(2)}s ${formatMem()}`);
}

function formatMem() {
  const m = process.memoryUsage();
  return `rss=${mb(m.rss)} heap=${mb(m.heapUsed)}`;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

marks.push({ label: "start", time: performance.now() });
console.log(`persistence stress: ${count.toLocaleString()} objects, batch=${batchSize}, segmentBytes=${segmentBytes}`);
console.log(`start: ${formatMem()}`);

persistence.start();
for (let i = 0; i < count; i++) {
  writer.insert("app", "events", {
    _id: `event-${i}`,
    kind: i % 17,
    value: i,
    active: i % 3 !== 0,
    payload: { bucket: i % 257 },
  });
  if ((i + 1) % batchSize === 0) await persistence.flush();
}
await persistence.flush();
mark("insert and journal flush");

const journalPrefix = "spread-db/db/app/collection/events/shard/default/journal/";
const journalBefore = (await storage.list(journalPrefix)).length;
assert.ok(journalBefore > 0, "journals should exist before checkpoint");
console.log(`journals before checkpoint: ${journalBefore}`);

const checkpoint = await persistence.checkpoint();
mark("checkpoint and compact");

const journalAfter = (await storage.list(journalPrefix)).length;
assert.equal(journalAfter, 0, "journals should be compacted after checkpoint");
console.log(`checkpoint scopes=${checkpoint.scopes} objects=${checkpoint.objects} segments=${checkpoint.segments}`);
console.log(`journals after checkpoint: ${journalAfter}`);

await persistence.stop();

const restored = new CRDTNode({ id: "restored", retainOps: 0, syncBatchSize: 4096 });
const restoreStats = await new PersistenceManager({ node: restored, storage }).restore();
mark("restore");

assert.equal(restored.count("app", "events"), count);
for (const id of ["event-0", `event-${Math.floor(count / 2)}`, `event-${count - 1}`]) {
  assert.deepEqual(restored.get("app", "events", id), writer.get("app", "events", id));
}
console.log(`restore snapshots=${restoreStats.snapshots} snapshotObjects=${restoreStats.snapshotObjects} journalOps=${restoreStats.journalOps}`);
console.log("consistency check passed");
