import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { createWriteStream } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { S3ObjectStorage } from "../src/object-storage.js";
import { ShardMapStore } from "../src/shard-map-store.js";
import { ndjsonReadable } from "../src/ndjson.js";
import { mixedLoad } from "./live-load.js";

const args = new Map(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
const count = Number(args.get("objects") || 1_000_000);
const copies = Number(args.get("replicas") || 2);
const payloadBytes = Number(args.get("payload") || 512);
const failure = args.get("failure") !== "false";
const mixed = args.get("mixed") === "true";
const fault = args.get("fault") || "destination";
const writerRouting = args.get("writer-routing") || "stable";
const profile = args.get("profile") || "mixed";
const root = resolve(new URL("..", import.meta.url).pathname);
const dir = await mkdtemp(join(tmpdir(), "objy-live-stress-"));
const name = `objy-live-test-${randomUUID().slice(0, 8)}`;
const secret = randomUUID();
const httpHeaders = { "content-type": "application/json", "x-objydb-cluster-secret": secret };
const processes = [];
const urls = [];
const report = { count, copies, payloadBytes, failure, mixed, fault, writerRouting, profile, phases: {}, samples: [], directory: dir };
let load;
let migrationLabel = "grow";
let wantedMap;
let probing = false;
let probeTask;
let installed = false;
let storagePaused = false;
let sampling = null;
const resourceTimer = setInterval(() => {
  if (!sampling) sampling = sampleResources().catch((error) => { report.resourceSamplingError = error.message; }).finally(() => { sampling = null; });
}, 1000);
resourceTimer.unref();

try {
  execFileSync("docker", ["run", "--rm", "-d", "--name", name, "-p", "127.0.0.1::9000",
    "-e", "MINIO_ROOT_USER=objy-test", "-e", "MINIO_ROOT_PASSWORD=objy-test-password",
    "minio/minio:latest", "server", "/data"], { stdio: "pipe" });
  installed = true;
  const port = execFileSync("docker", ["port", name, "9000/tcp"], { encoding: "utf8" }).trim().split(":").at(-1);
  const s3 = { bucket: "objy-live-test", endpoint: `http://127.0.0.1:${port}`, region: "us-east-1",
    accessKeyId: "objy-test", secretAccessKey: "objy-test-password", forcePathStyle: true };
  for (let i = 0; i < 3 * copies; i++) urls.push(`http://127.0.0.1:${await unusedPort()}`);
  const desired = (shards) => ({ shards: Object.fromEntries(Array.from({ length: shards }, (_, i) =>
    [`shard-${String(i).padStart(3, "0")}`, { peers: urls.slice(i * copies, (i + 1) * copies).map((url) => ({ url })) }])) });
  const storage = new S3ObjectStorage(s3);
  const maps = new ShardMapStore({ storage, prefix: "stress", durable: true });
  await retry(() => maps.save(desired(2)));
  const config = {
    node: { retainOps: 256, syncBatchSize: 5000 }, server: { port: 0 }, auth: { enabled: false },
    cluster: { secret, syncMs: 2500, forwardTimeoutMs: 60_000,
      shardMapStore: { mode: "s3", prefix: "stress" } },
    persistence: { mode: "s3", prefix: "stress", s3, flushMs: 5000, snapshotMs: Number(args.get("snapshot-ms") || 0),
      ack: "localWal", localWal: { mode: "on", dir: join(dir, "wal") } },
    files: { mode: "s3", prefix: "stress/files" }, memoryGuard: { enabled: false },
  };
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await timed("initialBoot", async () => {
    for (let i = 0; i < urls.length; i++) await start(i, configPath);
  });
  await call(0, "POST", "/api/databases", { name: "stress" });
  const meta = {
    indexes: ["kind", "active", ...(mixed ? ["tags"] : [])], columns: ["score"],
    tiering: { mode: "compressedMemory", keep: ["kind", "active", "score", "owner"], minBytes: 128 },
  };
  await call(0, "POST", "/api/stress/collections", { name: "items", meta });
  await call(0, "POST", "/api/stress/collections", { name: "owners" });
  await call(0, "POST", "/api/stress/owners/object", Array.from({ length: 16 }, (_, i) => ({ _id: `owner-${i}`, region: `region-${i % 4}` })));
  const batch = 2000;
  await timed("insert", async () => {
    for (let start = 0; start < count; start += batch) {
      const rows = Array.from({ length: Math.min(batch, count - start) }, (_, i) => objectAt(start + i));
      const result = await stream(start / batch % (2 * copies), "POST", rows);
      assert.equal(result.inserted, rows.length);
      if (start % 100_000 === 0) console.log(`insert ${start}/${count}`);
    }
  });
  await retry(() => verify(count));
  report.before = await stats();
  if (mixed) {
    load = mixedLoad({ count, call, stream, objectAt, nodes: urls.length, writerRouting, profile });
    load.start("baseline");
    if (args.get("rebuild") === "true") {
      const started = performance.now();
      await call(0, "PUT", "/api/stress/items/meta", { ...meta, indexes: [...meta.indexes, "bucket"], columns: ["score", "active"] });
      report.metaRebuildRequestMs = performance.now() - started;
    }
    await sleep(10_000);
    load.assertHealthy();
  }
  probing = true;
  probeTask = probe();
  const changed = new Map();
  const writer = async () => {
    for (let i = 0; i < Math.min(2000, count); i += 20) {
      const rows = Array.from({ length: Math.min(20, count - i) }, (_, offset) => ({ ...objectAt(i + offset), score: 20_000 + i + offset }));
      await retry(() => stream(i / 20 % (2 * copies), "PUT", rows));
      for (const row of rows) changed.set(row._id, row.score);
      await sleep(5);
    }
  };
  await timed("grow", async () => {
    load?.setPhase("grow:prepare");
    wantedMap = desired(3);
    const begun = await call(0, "PUT", "/cluster/shards", wantedMap);
    assert.ok(begun.migration);
    const writes = mixed ? Promise.resolve() : writer();
    if (failure) {
      if (mixed) await waitStage("copy");
      const victim = fault === "coordinator" ? 0 : fault === "source" ? copies : processes.length - 1;
      report.failureInjected = { fault, victim, state: (await call(0, "GET", "/cluster/shards")).migration };
      if (fault === "storage") {
        execFileSync("docker", ["pause", name], { stdio: "pipe" }); storagePaused = true;
        await sleep(3000);
        execFileSync("docker", ["unpause", name], { stdio: "pipe" }); storagePaused = false;
      } else {
        await kill(victim);
        if (victim !== 0) {
          await waitMigration(false);
          const state = await call(0, "GET", "/cluster/shards");
          assert.ok(state.migration.error, "dead participant must prevent commit");
          assert.equal(Object.keys(state.shardMap.shards).length, 2);
        } else await sleep(1000);
        await start(victim, configPath);
        if (victim !== 0) await call(0, "PUT", "/cluster/shards", desired(3));
      }
    }
    await writes;
    await waitMigration(true);
  });
  probing = false;
  await probeTask;
  if (load) {
    load.setPhase("after-grow"); await sleep(5000); await load.stop(); load.assertHealthy();
    await indexesReady("after-grow");
    await retry(() => load.verify());
  }
  await retry(() => verify(count, changed));
  report.after = await stats();
  await timed("crashRestart", async () => {
    for (let i = 0; i < processes.length; i++) await kill(i);
    for (let i = 0; i < processes.length; i++) await start(i, configPath);
  });
  await retry(() => verify(count, changed));
  if (load) { await indexesReady("after-crash"); await retry(() => load.verify()); load.start("before-shrink"); await sleep(2000); }
  await timed("shrink", async () => {
    migrationLabel = "shrink";
    load?.setPhase("shrink:prepare");
    wantedMap = desired(2);
    await call(0, "PUT", "/cluster/shards", wantedMap);
    await waitMigration(true);
  });
  if (load) {
    load.setPhase("after-shrink"); await sleep(5000); await load.stop(); load.assertHealthy();
    await indexesReady("after-shrink");
    await retry(() => load.verify());
  }
  await retry(() => verify(count, changed));
  report.final = await stats();
  report.latency = summarize(report.samples);
  if (load) report.load = load.snapshot();
  report.samples = undefined;
  await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(`LIVE_RESHARD_RESULT ${JSON.stringify(report)}`);
} catch (error) {
  report.error = error.message;
  report.processExits = processes.map(({ child }, index) => ({ index, exitCode: child.exitCode, signal: child.signalCode }));
  throw error;
} finally {
  clearInterval(resourceTimer);
  probing = false;
  await load?.stop();
  if (load) report.load = load.snapshot();
  await probeTask?.catch(() => {});
  await sampling;
  if (report.samples) { report.latency = summarize(report.samples); report.samples = undefined; }
  await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
  for (let i = 0; i < processes.length; i++) await kill(i);
  if (storagePaused) execFileSync("docker", ["unpause", name], { stdio: "pipe" });
  if (installed) execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" });
  if (args.get("keep") !== "true") await rm(join(dir, "wal"), { recursive: true, force: true });
}

async function sampleResources() {
  const active = processes.filter((state) => state.child.exitCode === null && state.child.signalCode === null);
  if (!active.length) return;
  const pids = active.map((state) => state.child.pid);
  let cpu = 0, rss = 0, heap = 0;
  const samples = execFileSync("ps", ["-p", pids.join(","), "-o", "pcpu=,rss="], { encoding: "utf8" }).trim().split("\n");
  for (const sample of samples) {
    const [percent, kib] = sample.trim().split(/\s+/).map(Number);
    cpu += percent || 0; rss += (kib || 0) * 1024;
  }
  const states = await Promise.all(urls.map(async (url) => {
    try {
      const response = await fetch(`${url}/cluster/status`, { headers: httpHeaders, signal: AbortSignal.timeout(1000) });
      return await response.json();
    } catch { return null; }
  }));
  for (const state of states) heap += state?.memory?.heapUsed || 0;
  const peak = report.resourcePeak ||= { sampledCpuPercent: 0, rssBytes: 0, heapBytes: 0, samples: 0 };
  peak.sampledCpuPercent = Math.max(peak.sampledCpuPercent, cpu);
  peak.rssBytes = Math.max(peak.rssBytes, rss);
  peak.heapBytes = Math.max(peak.heapBytes, heap);
  peak.samples++;
}

async function start(index, configPath) {
  const output = createWriteStream(join(dir, `node-${index}.log`), { flags: "a" });
  const trace = "const real=globalThis.fetch;globalThis.fetch=async(...args)=>{try{return await real(...args)}catch(error){console.error('TEST_FETCH_ERROR',JSON.stringify({url:String(args[0]),message:error.message,cause:error.cause?.message,code:error.cause?.code}));throw error}}";
  const diagnostic = mixed ? ["--import", `data:text/javascript;base64,${Buffer.from(trace).toString("base64")}`] : [];
  const child = spawn(process.execPath, ["--max-old-space-size=2048", ...diagnostic, join(root, "src/index.js"), "--config", configPath,
    "--node", `stress-${index}`, "--url", urls[index], "--port", new URL(urls[index]).port], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
  processes[index] = { child, output };
  await retry(async () => {
    if (child.exitCode !== null) throw new Error(`node ${index} exited ${child.exitCode}; see ${dir}`);
    const response = await fetch(`${urls[index]}/health`, { signal: AbortSignal.timeout(3000) });
    const status = await response.json();
    assert.equal(status.restore?.status === "restoring" || status.restoring === true, false);
    const ready = await fetch(`${urls[index]}/api/databases`);
    assert.equal(ready.status, 200);
  }, 180_000);
}
async function kill(index) {
  const state = processes[index];
  if (!state || state.child.exitCode !== null || state.child.signalCode !== null) return;
  const exit = new Promise((resolve) => state.child.once("exit", resolve));
  state.child.kill("SIGKILL");
  await exit;
  state.output.end();
}
async function call(index, method, path, body, observe) {
  const response = await fetch(`${urls[index]}${path}`, { method, headers: httpHeaders,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) })
    .catch((error) => { throw Object.assign(error, { status: 0 }); });
  observe?.({ status: response.status, path: response.headers.get("x-objydb-query-path") });
  const text = await response.text();
  const result = text ? JSON.parse(text) : null;
  if (!response.ok) throw Object.assign(new Error(`${method} ${path}: ${response.status} ${text}`), { status: response.status });
  return result;
}
async function stream(index, method, rows, observe) {
  const response = await fetch(`${urls[index]}/api/stress/items/object`, { method,
    headers: { ...httpHeaders, "content-type": "application/x-ndjson", prefer: "return=minimal" },
    body: ndjsonReadable(rows), duplex: "half", signal: AbortSignal.timeout(120_000) })
    .catch((error) => { throw Object.assign(error, { status: 0 }); });
  observe?.({ status: response.status, path: response.headers.get("x-objydb-query-path") });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(`${method} stream: ${response.status} ${JSON.stringify(result)}`), { status: response.status, body: result });
  return result;
}
async function waitMigration(success) {
  const end = Date.now() + 15 * 60_000;
  for (;;) {
    const state = await call(0, "GET", "/cluster/shards");
    if (load) {
      load.assertHealthy();
      load.setPhase(`${migrationLabel}:${state.migration?.stage || state.migration?.phase || "complete"}`);
    }
    if (!state.migration) { assert.ok(success); return; }
    if (!state.migration.running && state.migration.error) {
      if (success && mixed && (report.retries?.length || 0) < 2) {
        (report.retries ||= []).push({ phase: migrationLabel, error: state.migration.error });
        console.log(`retry ${migrationLabel}: ${state.migration.error}`);
        await call(0, "PUT", "/cluster/shards", wantedMap);
        continue;
      }
      assert.ok(!success, state.migration.error); return;
    }
    assert.ok(Date.now() < end, `migration stalled: ${JSON.stringify(state.migration)}`);
    await sleep(100);
  }
}
async function waitStage(stage) {
  const end = Date.now() + 120_000;
  for (;;) {
    const state = await call(0, "GET", "/cluster/shards");
    load?.assertHealthy();
    if (state.migration?.stage === stage) {
      const target = await call(urls.length - 1, "GET", "/cluster/status");
      const copied = target.compression?.liveObjects || 0;
      if (stage !== "copy" || copied >= Math.min(512, Math.floor(count / 4))) {
        report.pendingObjectsAtFault = copied;
        load?.setPhase(`grow:${stage}`); return;
      }
    }
    assert.ok(state.migration?.running && Date.now() < end, `did not reach ${stage}: ${JSON.stringify(state.migration)}`);
    await sleep(20);
  }
}
async function indexesReady(stage) {
  const started = performance.now();
  await retry(async () => {
    for (let i = 0; i < urls.length; i++) {
      const state = await call(i, "GET", "/cluster/status");
      assert.equal(state.indexes.error, 0, `${stage}/${i} index errors`);
      assert.equal(state.indexes.building, 0, `${stage}/${i} indexes warming`);
    }
  }, 180_000);
  (report.indexWarmupMs ||= {})[stage] = performance.now() - started;
  load?.setPhase(`${stage}:indexes-ready`);
}
async function verify(total, changed = new Map()) {
  const expected = Array.from({ length: 17 }, () => ({ count: 0, sum: 0, min: Infinity, max: -Infinity }));
  for (let i = 0; i < total; i++) {
    const score = changed.get(`object-${i}`) ?? i % 1000;
    const group = expected[i % 17];
    group.count++; group.sum += score; group.min = Math.min(group.min, score); group.max = Math.max(group.max, score);
  }
  for (let node = 0; node < urls.length; node++) {
    const rows = await call(node, "POST", "/api/stress/items/search", { ...(mixed ? { kind: { $lt: 17 } } : {}), $aggregate: { groupBy: "kind",
      fields: { count: { $count: true }, total: { $sum: "score" }, min: { $min: "score" }, max: { $max: "score" } } }, $refDepth: 0 });
    assert.equal(rows.length, 17);
    for (const row of rows) assert.deepEqual({ count: row.count, sum: row.total, min: row.min, max: row.max }, expected[row.kind]);
  }
  for (let i = 0; i < Math.min(total, 100); i++) {
    const index = i * 7919 % total;
    const row = await call(i % urls.length, "GET", `/api/stress/items/object/object-${index}?q=${encodeURIComponent(JSON.stringify({ $refDepth: 1 }))}`);
    const expected = objectAt(index);
    expected.score = changed.get(expected._id) ?? expected.score;
    assert.equal(row.score, expected.score);
    assert.equal(row.payload, expected.payload);
    assert.deepEqual(row.dynamic, expected.dynamic);
    assert.equal(row.owner.object.region, `region-${index % 16 % 4}`);
  }
}
function objectAt(i) {
  return { _id: `object-${i}`, kind: i % 17, score: i % 1000, active: i % 2 === 0,
    owner: { type: "reference", collection: "owners", value: `owner-${i % 16}` },
    payload: `object:${i}:` + "payload-".repeat(Math.ceil(payloadBytes / 8)),
    dynamic: i % 3 ? { values: [i, null, "value", true] } : { nested: { value: `v${i}` } },
    ...(mixed ? { tags: [`tag${i % 7}`, "all"], bucket: `b${i % 5}`,
      ...(i < 1000 ? { _vec: i === 0 ? [1, 0, 0, 0] : [0, 1, i / 1000, 0] } : {}) } : {}) };
}
async function probe() {
  while (probing) {
    const start = performance.now();
    let status;
    try { await call(0, "GET", "/api/stress/items/object/object-42"); status = 200; }
    catch (error) { status = error.status || 0; }
    report.samples.push({ ms: performance.now() - start, status });
    await sleep(20);
  }
}
async function stats() {
  return Promise.all(urls.map(async (_, i) => {
    const state = await call(i, "GET", "/cluster/status");
    return { id: state.node.id, heap: state.memory.heapUsed, rss: state.memory.rss, owned: state.ownedShards, migration: state.migration };
  }));
}
async function timed(phase, run) {
  console.log(`${phase} start`);
  const started = performance.now();
  await run();
  report.phases[phase] = performance.now() - started;
  console.log(`${phase} ${report.phases[phase].toFixed(1)}ms`);
}
async function retry(run, timeout = 120_000) {
  const end = Date.now() + timeout;
  for (;;) {
    try { return await run(); }
    catch (error) { if (Date.now() > end) throw error; await sleep(100); }
  }
}
function summarize(samples) {
  const ms = samples.filter((sample) => sample.status === 200).map((sample) => sample.ms).sort((a, b) => a - b);
  const percentile = (p) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))];
  return { requests: samples.length, unavailable: samples.filter((sample) => sample.status !== 200).length,
    p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: ms.at(-1) };
}
async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
