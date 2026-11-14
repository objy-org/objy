import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";

const flags = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
const source = resolve(flags.source || ".");
const count = Number(flags.objects || 100_000);
const batchSize = Number(flags.batch || 10_000);
const payloadBytes = Number(flags.payload || 4096);
const restore = flags.mode === "restore";
const { Store } = await import(pathToFileURL(resolve(source, "src/store.js")));
const { nodeCompression } = await import(pathToFileURL(resolve(source, "src/node-runtime.js")));
let inflations = 0;
const store = new Store({ compression: { ...nodeCompression, decompress(value) { inflations++; return nodeCompression.decompress(value); } } });
const meta = {
  indexes: ["active"], columns: ["score"],
  ...(payloadBytes ? { tiering: { mode: "compressedMemory", offload: ["payload"], minBytes: 1 } } : {}),
};
const idFor = (i) => `${Math.imul(i + 1, 0x9e3779b1) >>> 0}`.padStart(10, "0") + `-${i}`;
const payload = "large object payload ".repeat(Math.ceil(payloadBytes / 21)).slice(0, payloadBytes);
const metrics = { source, count, batchSize, payloadBytes, mode: restore ? "restore" : "insert", batchMs: [], queries: {} };
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
const cpuStart = process.cpuUsage();
if (restore) store.beginBulkLoad();
store.createCollection("bench", "items", meta);
const collection = store.collection("bench", "items");
const loadStart = performance.now();
let setupMs = 0;
for (let start = 0; start < count; start += batchSize) {
  const rows = [];
  for (let i = start; i < Math.min(count, start + batchSize); i++) {
    rows.push({ id: idFor(i), value: { active: i % 2 === 0, score: i, hot: i, payload: `${payload}:${i}` }, ts: { c: i + 1, n: "bench" } });
  }
  const begin = performance.now();
  if (restore) store.applySnapshotObjects("bench", "items", rows, { trustedValues: true });
  else collection.putObjects(rows, { trustedValues: true });
  metrics.batchMs.push(performance.now() - begin);
  if (start === 0 && flags.activeOrder === "true" && !restore) {
    const setupStart = performance.now();
    await store.awaitIndexes("bench", "items");
    collection.find({}, { sortBy: "_id", limit: 1 });
    await collection.idOrder?.ready();
    setupMs += performance.now() - setupStart;
  }
  await new Promise((resolve) => setImmediate(resolve));
}
if (restore) store.endBulkLoad();
metrics.loadMs = performance.now() - loadStart - setupMs;
metrics.setupMs = setupMs;
metrics.activeOrderDuringImport = !restore && flags.activeOrder === "true";
const indexStart = performance.now();
await store.awaitIndexes("bench", "items");
metrics.indexWarmupMs = performance.now() - indexStart;
const orderStart = performance.now();
await collection.idOrder?.ready();
metrics.activeOrderCatchupMs = performance.now() - orderStart;
globalThis.gc?.();
metrics.loadedMemory = process.memoryUsage();
metrics.loadedMaxRssKiB = process.resourceUsage().maxRSS;
await new Promise((resolve) => setImmediate(resolve));
metrics.loadEventLoopMaxMs = delay.max / 1e6;
metrics.loadCpu = process.cpuUsage(cpuStart);
delay.reset();

// The oracle is generated independently of the database and is excluded from
// the steady-state memory sample above.
if (flags.reads !== "false") {
  const expectedIds = Array.from({ length: count }, (_, i) => idFor(i)).sort();
  for (const [name, criteria, options] of [
    ["idFirst50", {}, { sortBy: "_id", limit: 50 }],
    ["idOffset10000", {}, { sortBy: "_id", offset: Math.min(10_000, count - 50), limit: 50 }],
    ["hotFirst50", {}, { sortBy: "hot", limit: 50 }],
    ["columnFirst50", {}, { sortBy: "score", limit: 50 }],
    ["filteredIdFirst50", { active: true }, { sortBy: "_id", limit: 50 }],
  ]) {
    const samples = [];
    const decompressions = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      inflations = 0;
      const begin = performance.now();
      const result = collection.find(criteria, options);
      samples.push(performance.now() - begin);
      decompressions.push(inflations);
      assert.equal(result.length, 50);
      if (name.startsWith("id")) assert.deepEqual(result.map((row) => row._id), expectedIds.slice(options.offset || 0, (options.offset || 0) + 50));
      if (name === "hotFirst50" || name === "columnFirst50") assert.deepEqual(result.map((row) => row.score), Array.from({ length: 50 }, (_, i) => i));
      if (name === "filteredIdFirst50") assert.ok(result.every((row) => row.active));
      await new Promise((resolve) => setImmediate(resolve));
    }
    metrics.queries[name] = { samplesMs: samples, decompressions };
  }
  if (collection.idOrder) {
    const begin = performance.now();
    await collection.idOrder.ready();
    metrics.idOrderWarmupMs = performance.now() - begin;
    inflations = 0;
    const readStart = performance.now();
    const result = collection.find({}, { sortBy: "_id", offset: Math.min(10_000, count - 50), limit: 50 });
    metrics.queries.idReady = { ms: performance.now() - readStart, decompressions: inflations };
    assert.deepEqual(result.map((row) => row._id), expectedIds.slice(Math.min(10_000, count - 50), Math.min(10_000, count - 50) + 50));
    metrics.idOrderBytes = collection.idOrder.bytes;
    const firstStart = performance.now();
    assert.deepEqual(collection.find({}, { sortBy: "_id", limit: 50 }).map((row) => row._id), expectedIds.slice(0, 50));
    metrics.queries.idReadyFirst50 = { ms: performance.now() - firstStart };
    const filteredStart = performance.now();
    const filtered = collection.find({ active: true }, { sortBy: "_id", limit: 50 });
    metrics.queries.filteredIdReadyFirst50 = { ms: performance.now() - filteredStart };
    assert.deepEqual(filtered.map((row) => row._id), expectedIds.filter((id) => Number(id.slice(id.lastIndexOf("-") + 1)) % 2 === 0).slice(0, 50));
  }
}
assert.equal(collection.count(), count);
assert.deepEqual(collection.aggregate({}, { fields: { total: { $sum: "score" }, count: { $count: true } } }), [{ total: count * (count - 1) / 2, count }]);
await new Promise((resolve) => setTimeout(resolve, 20));
delay.disable();
metrics.cpu = process.cpuUsage(cpuStart);
metrics.eventLoopP99Ms = delay.percentile(99) / 1e6;
metrics.eventLoopMaxMs = delay.max / 1e6;
metrics.maxRssKiB = process.resourceUsage().maxRSS;
metrics.finalMemory = process.memoryUsage();
metrics.batchMs.sort((a, b) => a - b);
metrics.batchP50Ms = metrics.batchMs[Math.floor(metrics.batchMs.length * 0.5)];
metrics.batchP95Ms = metrics.batchMs[Math.floor(metrics.batchMs.length * 0.95)];
delete metrics.batchMs;
store.dispose();
console.log(JSON.stringify(metrics));
