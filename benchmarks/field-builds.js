import assert from "node:assert/strict";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop, setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const options = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
const source = options.source || fileURLToPath(new URL("../", import.meta.url));
const count = Number(options.objects || 100_000);
const updates = Math.min(count, Number(options.updates || 100_000));
const batch = 10_000;
const payload = "Asset history and documentation. ".repeat(256);
const { CRDTNode } = await import(pathToFileURL(`${source}/src/crdt.js`));
const { nodeCompression } = await import(pathToFileURL(`${source}/src/node-runtime.js`));
const codecs = { compress: 0, decompress: 0 };
const compression = { ...nodeCompression };
for (const operation of Object.keys(codecs)) compression[operation] = (value) => {
  codecs[operation]++;
  return nodeCompression[operation](value);
};
const tiering = { mode: "compressedMemory", keep: ["group", "active", "score", "details.rank", "tags"], minBytes: 1 };
const meta = { indexes: ["group", "active", "tags"], columns: ["score", "details.rank"], tiering };
const node = new CRDTNode({ id: "field-benchmark", operationLog: false, storage: { compression } });
const collection = node.db.collection("bench", "items");
const delay = monitorEventLoopDelay({ resolution: 10 });
const results = { objects: count, updates, operationLog: false, serializedObjectBytes: 0, stages: [] };
delay.enable();

function row(i, updated = false) {
  return {
    _id: `id-${i}`, group: (i + (updated ? 1 : 0)) % 16, active: i % 3 !== 0,
    score: updated ? i * 3 + 100 : i, details: { rank: i % 97, text: `${payload}${i}` },
    tags: ["asset", `tag-${i % 7}`], history: [{ event: "created", detail: `${payload}${i * 13}` }],
  };
}

async function measure(name, run) {
  await yieldToEventLoop();
  codecs.compress = codecs.decompress = 0;
  delay.reset();
  let peakHeap = process.memoryUsage().heapUsed;
  let lastTick = performance.now(), maxTimerDelayMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxTimerDelayMs = Math.max(maxTimerDelayMs, now - lastTick - 10);
    lastTick = now;
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }, 10);
  const cpu = process.cpuUsage();
  const start = performance.now();
  await run();
  const ms = performance.now() - start;
  const used = process.cpuUsage(cpu);
  const calls = { ...codecs };
  await sleep(20);
  clearInterval(timer);
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  global.gc?.();
  const result = {
    name, ms, cpuMs: (used.user + used.system) / 1000, codecs: calls,
    loopP99Ms: delay.percentile(99) / 1e6, loopMaxMs: delay.max / 1e6, maxTimerDelayMs,
    peakSampledHeapBytes: peakHeap, memory: process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS,
  };
  results.stages.push(result);
  console.log(JSON.stringify(result));
}

function verify(updated = false) {
  const expected = Array.from({ length: 16 }, (_, group) => ({ group, count: 0, total: 0, low: Infinity, high: -Infinity }));
  for (let i = 0; i < count; i++) {
    const changed = updated && i < updates;
    const group = expected[(i + (changed ? 1 : 0)) % 16];
    const score = changed ? i * 3 + 100 : i;
    group.count++; group.total += score; group.low = Math.min(group.low, score); group.high = Math.max(group.high, score);
  }
  const actual = node.aggregate("bench", "items", {}, {
    groupBy: "group", fields: { count: { $count: true }, total: { $sum: "score" }, low: { $min: "score" }, high: { $max: "score" } },
  }).sort((a, b) => a.group - b.group);
  assert.deepEqual(actual, expected);
  for (let j = 0; j < Math.min(count, 257); j++) {
    const i = Math.floor(j * count / Math.min(count, 257));
    assert.deepEqual(node.get("bench", "items", `id-${i}`), row(i, updated && i < updates));
  }
  assert.equal(node.count("bench", "items", { tags: { $contains: "asset" } }), count);
  assert.equal(collection.indexDirtyRids.size, 0);
}

try {
  results.serializedObjectBytes = Buffer.byteLength(JSON.stringify(row(42)));
  node.createCollection("bench", "items", { tiering });
  await measure("load", async () => {
    for (let first = 0; first < count; first += batch) {
      node.insertManyCount("bench", "items", Array.from({ length: Math.min(batch, count - first) }, (_, j) => row(first + j)));
      await yieldToEventLoop();
    }
  });
  await measure("initial index and column build", async () => {
    node.setCollectionMeta("bench", "items", meta);
    await node.awaitIndexes("bench", "items");
  });
  verify();
  await measure("background index and column rebuild", async () => {
    collection.scheduleIndexBuildsFromMeta();
    await node.awaitIndexes("bench", "items");
  });
  verify();

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const blocked = collection.derivedStateScheduler.schedule("benchmark barrier", () => gate);
  await yieldToEventLoop();
  try {
    await measure("bulk replacements before catch-up", async () => {
      for (let first = 0; first < updates; first += batch) {
        node.replaceManyCount("bench", "items", Array.from({ length: Math.min(batch, updates - first) }, (_, j) => row(first + j, true)));
        await yieldToEventLoop();
      }
    });
    await measure("dirty index and column catch-up", async () => {
      release();
      await blocked;
      await node.awaitIndexes("bench", "items");
    });
    verify(true);
  } finally { release(); }
  console.log(`RESULT ${JSON.stringify({ ...results, correct: true })}`);
} finally { delay.disable(); node.db.dispose(); }
