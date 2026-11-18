import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setImmediate as turn, setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const options = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
if (options.probe) await probe(options.probe);
else await benchmark();

async function benchmark() {
  const source = options.source || fileURLToPath(new URL("../", import.meta.url));
  const count = Number(options.objects || 100_000);
  const { CRDTNode } = await import(pathToFileURL(`${source}/src/crdt.js`));
  const { MemoryObjectStorage } = await import(pathToFileURL(`${source}/src/object-storage.js`));
  const { PersistenceManager } = await import(pathToFileURL(`${source}/src/persistence.js`));
  const { nodeCompression } = await import(pathToFileURL(`${source}/src/node-runtime.js`));
  const { startServer } = await import(pathToFileURL(`${source}/src/server.js`));
  let hash, segmentBytes, segmentCount;
  class Storage extends MemoryObjectStorage {
    async put(key, body, type) {
      await turn();
      // Discard segment bodies after hashing: do not benchmark a second RAM copy of the database.
      if (key.endsWith(".jsonl")) {
        hash.update(body); segmentBytes += Buffer.byteLength(body); segmentCount++;
        return;
      }
      return super.put(key, body, type);
    }
  }
  const node = new CRDTNode({ id: "snapshot-benchmark", operationLog: false, storage: { compression: nodeCompression } });
  const storage = new Storage();
  const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0 });
  const loop = monitorEventLoopDelay({ resolution: 5 });
  let server, child;
  try {
    server = await startServer({ node, auth: { enabled: false }, persistence });
    node.createCollection("bench", "items", {
      indexes: ["kind"], columns: ["score"],
      tiering: { mode: "compressedMemory", offload: ["details"], minBytes: 1 },
    });
    for (let first = 0; first < count; first += 1000) {
      node.insertManyCount("bench", "items", Array.from({ length: Math.min(1000, count - first) }, (_, j) => {
        const i = first + j;
        return { _id: `id-${i}`, kind: i % 17, score: i % 1000, details: { label: `asset-${i}`, payload: "payload ".repeat(128) } };
      }));
      await turn();
    }
    await node.awaitIndexes("bench", "items");
    const base = `http://127.0.0.1:${server.port}`;
    assert.equal((await fetch(`${base}/api/bench/items/object`)).status, 200);
    await node.db.collection("bench", "items").idOrder?.ready();
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), `--probe=${base}`], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    await once(child, "message");
    let expected;
    for (let run = 0; run < Number(options.runs || 3); run++) {
      global.gc?.();
      await sleep(30);
      const measurements = once(child, "message");
      child.send("start");
      await measurements;
      loop.enable(); loop.reset();
      let tick = performance.now(), timerOverrunMs = 0;
      const peak = { ...process.memoryUsage() };
      const sampler = setInterval(() => {
        const now = performance.now();
        timerOverrunMs = Math.max(timerOverrunMs, now - tick - 5); tick = now;
        const usage = process.memoryUsage();
        for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], usage[key]);
      }, 5);
      hash = createHash("sha256"); segmentBytes = segmentCount = 0;
      const cpu = process.cpuUsage(), start = performance.now();
      try {
        const written = await persistence.checkpoint();
        const ms = performance.now() - start, used = process.cpuUsage(cpu);
        const reply = once(child, "message"); child.send("stop");
        const [reads] = await reply;
        assert.equal(reads.errors, 0, reads.lastError);
        assert.equal(written.objects, count);
        const signature = { segmentBytes, segmentCount, hash: hash.digest("hex") };
        if (expected) assert.deepEqual(signature, expected);
        expected = signature;
        console.log(JSON.stringify({ source, objects: count, run, snapshotMs: ms, cpuMs: (used.user + used.system) / 1000,
          loopP99Ms: loop.percentile(99) / 1e6, timerOverrunMs, peakMemory: peak, reads, ...signature }));
      } finally { clearInterval(sampler); loop.disable(); }
    }
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit"); child.kill(); await exited;
    }
    if (server) { await server.replication.stop(); await new Promise((resolve) => server.server.close(resolve)); }
    loop.disable(); node.db.dispose();
  }
}

async function probe(base) {
  let running = false, pending = [], samples, errors, lastError;
  const paths = { point: "/api/bench/items/object/id-1?$refDepth=0", list: "/api/bench/items/object?limit=50&$refDepth=0" };
  async function read(kind) {
    while (running) {
      const start = performance.now();
      try {
        const response = await fetch(base + paths[kind], { signal: AbortSignal.timeout(30000) });
        assert.equal(response.status, 200);
        const value = await response.json();
        if (kind === "point") assert.equal(value._id, "id-1");
        else assert.equal(value.length, 50);
        samples[kind].push(performance.now() - start);
      } catch (error) { errors++; lastError = `${kind}: ${error.message}`; }
      await sleep(10);
    }
  }
  process.on("message", async (command) => {
    if (command === "start") {
      samples = { point: [], list: [] }; errors = 0; lastError = undefined; running = true;
      pending = Object.keys(paths).map(read);
      process.send("started");
    } else if (command === "stop") {
      running = false; await Promise.all(pending);
      process.send({ errors, lastError, ...Object.fromEntries(Object.entries(samples).map(([kind, values]) => [kind, quantiles(values)])) });
    }
  });
  process.send("ready");
}

function quantiles(values) {
  const sorted = values.sort((a, b) => a - b);
  const p = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 0;
  return { count: sorted.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: p(1) };
}
