import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "@objy/client";
import { CRDTNode } from "../src/crdt.js";
import { MemoryObjectStorage, S3ObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";
import { startServer, shardMapFromHttp } from "../src/server.js";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
const count = Number(args.objects || 100_000);
const payloadBytes = Number(args.payload || 1024);
const delayMs = Number(args.delay || 0);
const budget = Number(args.budget || 256) * 1024 * 1024;
const batchSize = Number(args.batch || 1000);
const shards = Number(args.shards || 1), replicas = Number(args.replicas || 1);
const dir = await mkdtemp(join(tmpdir(), "objy-backpressure-"));

class DelayedStorage extends (args.s3 ? S3ObjectStorage : MemoryObjectStorage) {
  async put(key, body, type) {
    if (delayMs && key.includes("/journal/")) await sleep(delayMs);
    return super.put(key, body, type);
  }
}

const storage = new DelayedStorage({ bucket: "admission-test", endpoint: args.s3,
  accessKeyId: "admission-test", secretAccessKey: "admission-test-local-only" });
const peers = [];
const prefix = `backpressure-benchmark-${Date.now()}`;
for (let i = 0; i < shards * replicas; i++) {
  const node = new CRDTNode({ id: `bench-${i}`, retainOps: shards * replicas === 1 ? 256 : 10_000 });
  const persistence = new PersistenceManager({
    node, storage, prefix, flushMs: 5000, snapshotMs: 0, durable: !!args.s3,
    ack: "localWal", localWal: { mode: "on", dir, fsync: true },
  });
  persistence.start();
  const server = await startServer({
    node, persistence, auth: false, environment: {}, bootstrapLogger: null, clusterSecret: "benchmark-only",
    forwardTimeoutMs: 60000, port: { host: "127.0.0.1", port: 0 },
    imports: { maxBulkObjects: batchSize, maxPendingPersistenceBytes: budget },
  });
  node.url = `http://127.0.0.1:${server.port}`;
  peers.push({ node, persistence, server });
}
if (peers.length > 1) {
  const map = { shards: Object.fromEntries(Array.from({ length: shards }, (_, i) => [
    `shard-${i}`, { peers: peers.slice(i * replicas, (i + 1) * replicas).map(({ node }) => ({ url: node.url })) },
  ])) };
  for (const { node } of peers) node.replaceShardMap(shardMapFromHttp(map, node.id, { secret: "benchmark-only", timeoutMs: 60000 }));
}
const { node, persistence, server } = peers[0];
const client = createClient({ url: `http://127.0.0.1:${server.port}`, timeoutMs: 0 });
const items = client.database("benchmark").collection("events");
const readMs = [], writeMs = [];
const lag = monitorEventLoopDelay({ resolution: 10 });
let peakRss = 0, peakHeap = 0, pendingPeak = 0, running = true, probeError;
let result, error;

try {
  await client.database("benchmark").createCollection("events", { indexes: ["kind"], columns: ["score"] });
  await items.insert({ _id: "probe", score: -1, kind: "probe" });
  await persistence.flush();
  lag.enable();
  const probes = (async () => {
    while (running) {
      const started = performance.now();
      await items.get("probe");
      readMs.push(performance.now() - started);
      const writeStart = performance.now();
      await items.patch("probe", { $set: { tick: writeMs.length } });
      writeMs.push(performance.now() - writeStart);
      const memory = process.memoryUsage();
      peakRss = Math.max(peakRss, memory.rss);
      peakHeap = Math.max(peakHeap, memory.heapUsed);
      for (const { persistence } of peers) {
        const stats = persistence.getStats();
        pendingPeak = Math.max(pendingPeak, stats.pendingBytes + (stats.inflightBytes || 0) +
          (stats.localWal?.pendingBytes || 0) + (stats.localWal?.inflightBytes || 0));
      }
      await sleep(10);
    }
  })().catch((err) => { probeError = err.message; });
  const started = performance.now();
  try {
    result = await items.import(async function* () {
      const payload = "x".repeat(payloadBytes);
      for (let n = 0; n < count; n++) yield { _id: `event-${n}`, kind: n % 17, score: n, payload };
    });
  } catch (err) {
    error = { status: err.status, body: err.body };
  }
  const importMs = performance.now() - started;
  running = false;
  await probes;
  for (const { persistence } of peers) await persistence.flush();
  if (!error && peers.length > 1) {
    for (const { node } of peers) {
      await node.syncAll();
      assert.deepEqual(node.lastSyncFailures || [], []);
    }
  }
  for (const { node } of peers) await node.awaitIndexes("benchmark", "events");
  const inserted = await items.count({ kind: { $ne: "probe" } });
  if (!error) {
    assert.equal(inserted, count);
    const rows = await items.search({ kind: { $ne: "probe" }, $aggregate: { fields: { sum: { $sum: "score" } } } });
    assert.equal(rows[0].sum, count * (count - 1) / 2);
    const counts = new Map();
    for (let n = 0; n < count; n++) {
      const shard = node.shardForObject("benchmark", "events", `event-${n}`);
      counts.set(shard, (counts.get(shard) || 0) + 1);
    }
    for (const { node: replica } of peers) {
      let expected = 0;
      for (const [shard, size] of counts) if (replica.ownsShard(shard)) expected += size;
      const hasProbe = replica.ownsShard(replica.shardForObject("benchmark", "events", "probe"));
      assert.equal(replica.count("benchmark", "events"), expected + Number(hasProbe));
    }
  }
  let restoredObjects;
  if (!error && args.restore) {
    for (const { server } of peers) await server.replication.stop();
    for (const { persistence } of peers) await persistence.stop();
    const fresh = new CRDTNode({ id: node.id, url: node.url });
    fresh.replaceShardMap(node.shardMapSnapshot());
    const restored = new PersistenceManager({ node: fresh, storage, prefix: persistence.prefix, flushMs: 0, snapshotMs: 0, durable: !!args.s3 });
    await restored.restore();
    restoredObjects = fresh.count("benchmark", "events");
    assert.equal(restoredObjects, node.count("benchmark", "events"));
    for (const id of ["event-0", `event-${count - 1}`]) {
      if (fresh.ownsShard(fresh.shardForObject("benchmark", "events", id))) {
        assert.deepEqual(fresh.get("benchmark", "events", id), node.get("benchmark", "events", id));
      }
    }
    fresh.db.dispose();
  }
  console.log(JSON.stringify({
    storage: args.s3 ? "local S3-compatible storage; real fsynced local WAL" : "in-memory S3 adapter with optional journal delay; real fsynced local WAL",
    shards, replicas, restoredObjects, count, payloadBytes, delayMs, budget, batchSize, result, error, probeError,
    inserted, importMs: Math.round(importMs), objectsPerSecond: Math.round(inserted / (importMs / 1000)),
    read: summary(readMs), write: summary(writeMs),
    peakRssMiB: Math.round(peakRss / 1024 / 1024), peakHeapMiB: Math.round(peakHeap / 1024 / 1024),
    pendingPeakMiB: Math.round(pendingPeak / 1024 / 1024), lagP99Ms: lag.percentile(99) / 1e6,
  }));
} finally {
  running = false;
  lag.disable();
  for (const { node, persistence, server } of peers) {
    await server.replication.stop();
    server.server.closeAllConnections();
    await new Promise((resolve) => server.server.close(resolve));
    await persistence.stop();
    node.db.dispose();
  }
  storage.client?.destroy();
  await rm(dir, { recursive: true, force: true });
}

function summary(samples) {
  samples.sort((a, b) => a - b);
  const percentile = (p) => Math.round((samples[Math.min(samples.length - 1, Math.floor(samples.length * p))] || 0) * 100) / 100;
  return { samples: samples.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
}
