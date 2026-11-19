import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir, totalmem, freemem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { S3ObjectStorage } from "../../src/object-storage.js";
import { PrimaryStateStore } from "../../src/primary-state.js";
import { DB, COLL, SLOTS, head, row, live, sleep, request, quantiles } from "./fixture.js";

const exec = promisify(execFile), args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
const count = Number(args.objects || 100000), order = (args.order || "baseline,compactor,compactor,baseline").split(",");
assert.ok(Number.isSafeInteger(count) && count > 0);
assert.ok(order.every((mode) => mode === "baseline" || mode === "compactor"));
const dir = await mkdtemp(join(tmpdir(), "objy-compaction-bench-")), name = `objy-compaction-${dir.split("-").at(-1).toLowerCase()}`, volume = `${name}-data`;
const children = [], samples = [], osSamples = [], rounds = [], restores = [], events = [], versions = Array(SLOTS).fill(0);
let rpcSerial = 0, revision = 1, s3, storage, writer, sampler, round = -1;
const report = { dir, count, order, startedAt: new Date().toISOString(), hostTotalBytes: totalmem(), hostFreeBytes: freemem(), rawObjectBytes: Buffer.byteLength(JSON.stringify(row(123456))) };
const log = (event, value = {}) => { const item = { at: new Date().toISOString(), event, ...value }; events.push(item); console.log(JSON.stringify(item)); };
function launch(role, data = {}) {
  const child = fork(new URL("./peer.js", import.meta.url), [], { execArgv: ["--expose-gc", "--max-old-space-size=8192"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.push(child);
  child.waiters = new Map();
  child.stdout.pipe(createWriteStream(join(dir, `${role}.stdout`)));
  child.stderr.pipe(createWriteStream(join(dir, `${role}.stderr`)));
  child.exit = new Promise((resolve) => child.once("exit", resolve));
  child.ready = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.on("message", (message) => {
      if (message.id) {
        const waiter = child.waiters.get(message.id);
        if (waiter) { child.waiters.delete(message.id); clearTimeout(waiter.timer); message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message.result); }
      } else if (message.type === "sample" || message.type === "compactor-sample") samples.push({ role, ...message });
      else if (message.type === "ready" || message.type === "done") resolve(message.result);
      else if (message.type === "failed") reject(new Error(message.error));
      else log(message.type, { role, ...message });
    });
    child.once("exit", (code) => {
      if (code) reject(new Error(`${role} exited ${code}`));
      for (const waiter of child.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`${role} exited`)); }
      child.waiters.clear();
    });
  });
  child.send({ role, dir, count, s3, ...data });
  child.ready.catch(() => {});
  return child;
}
function rpc(command, data = {}) {
  const id = ++rpcSerial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { writer.waiters.delete(id); reject(new Error(`${command} timed out`)); }, 3600000);
    writer.waiters.set(id, { resolve, reject, timer });
    writer.send({ id, command, ...data });
  });
}
function traffic(state) {
  const records = [], timers = [], inflight = new Set();
  let writes = 0, skipped = 0, sequence = 0, writing = false;
  for (const [kind, interval] of Object.entries({ point: 50, list: 200, write: 400, health: 200 })) {
    timers.push(setInterval(() => {
      if (inflight.size >= 256 || (kind === "write" && writing)) { skipped++; return; }
      if (kind === "write") writing = true;
      const task = (async () => {
        const start = performance.now();
        let error;
        try {
          if (kind === "write") {
            const items = Array.from({ length: 100 }, () => { const value = revision++; return live(value % SLOTS, value); });
            const result = await request(`${state.url}/api/${DB}/${COLL}/object`, state.token, {
              method: "PUT", body: items.map((item) => JSON.stringify(item)).join("\n") + "\n",
              headers: { "content-type": "application/x-ndjson", prefer: "return=minimal" },
            });
            assert.equal(result.replaced, 100);
            for (const item of items) versions[Number(item._id.slice(2))] = item.revision;
            writes += items.length;
          } else if (kind === "point") {
            const i = ++sequence * 7919 % count;
            assert.deepEqual(await request(`${state.url}/api/${DB}/${COLL}/object/r-${i}?refDepth=0`, state.token), row(i));
          } else if (kind === "list") {
            const result = await request(`${state.url}/api/${DB}/${COLL}/search`, state.token, { method: "POST", body: { $pageSize: 50, $refDepth: 0 } });
            assert.equal(result.length, 50);
            for (const object of result) assert.deepEqual(object, row(Number(object._id.slice(2))));
          } else await request(`${state.url}/health`, "");
        } catch (value) { error = value.stack; }
        records.push({ kind, ms: performance.now() - start, error });
      })().finally(() => { inflight.delete(task); if (kind === "write") writing = false; });
      inflight.add(task);
    }, interval));
  }
  return async () => {
    timers.forEach(clearInterval);
    await Promise.all(inflight);
    return { writes, skipped, errors: records.filter((record) => record.error), latency: Object.fromEntries(["point", "list", "write", "health"].map((kind) => [kind, quantiles(records.filter((r) => r.kind === kind && !r.error).map((r) => r.ms))])) };
  };
}

try {
  log("starting", { dir, count, order });
  await exec("docker", ["volume", "create", volume]);
  await exec("docker", ["run", "-d", "--name", name, "--memory=1g", "--cpus=2", "-p", "127.0.0.1::9000", "-e", "MINIO_ROOT_USER=compaction-admin", "-e", "MINIO_ROOT_PASSWORD=disposable-compaction-storage", "--mount", `type=volume,source=${volume},target=/data`, "minio/minio:latest", "server", "/data"]);
  const endpoint = `http://${(await exec("docker", ["port", name, "9000/tcp"])).stdout.trim()}`;
  let healthy = false;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${endpoint}/minio/health/live`)).ok) { healthy = true; break; } } catch {} await sleep(500); }
  assert.ok(healthy, "isolated S3 ready");
  s3 = { bucket: "compaction-benchmark", endpoint, region: "us-east-1", accessKeyId: "compaction-admin", secretAccessKey: "disposable-compaction-storage", forcePathStyle: true };
  storage = new S3ObjectStorage(s3);
  const seed = launch("seed");
  report.seed = await seed.ready;
  await seed.exit;
  log("seed-complete", report.seed);
  writer = launch("writer");
  const state = await writer.ready;
  report.writerReadyMs = state.ms;
  let busy = false;
  sampler = setInterval(async () => {
    if (busy) return;
    const worker = samples.findLast((sample) => sample.role === "writer" && sample.type === "compactor-sample" && sample.round === round);
    const pids = [writer.pid, worker?.pid].filter(Boolean);
    busy = true;
    try {
      const { stdout } = await exec("ps", ["-p", pids.join(","), "-o", "pid=,rss=,%cpu="]);
      osSamples.push({ at: Date.now(), round, rows: stdout.trim().split("\n").filter(Boolean).map((line) => { const [pid, rssKiB, cpuPercent] = line.trim().split(/\s+/).map(Number); return { pid, rssKiB, cpuPercent }; }) });
    } catch {} finally { busy = false; }
  }, 500);
  for (const mode of order) {
    round++;
    log("round-start", { round, mode });
    const before = await rpc("prepare", { round });
    const warmTraffic = traffic(state);
    await sleep(5000);
    const baseline = await warmTraffic();
    const stop = traffic(state), started = Date.now();
    let work, probes;
    try { work = await rpc("snapshot", { mode }); } finally { probes = await stop(); }
    const ended = Date.now(), after = await rpc("drain");
    const relevant = samples.filter((sample) => sample.round === round && (sample.stage === "snapshot" || sample.type === "compactor-sample"));
    const main = relevant.filter((sample) => sample.type === "sample"), child = relevant.filter((sample) => sample.type === "compactor-sample");
    const during = osSamples.filter((sample) => sample.round === round && sample.at >= started && sample.at <= ended);
    const result = {
      round, mode, before, after, baseline, probes, work,
      peakMainHeapMiB: Math.max(work.memory.heapUsed, ...main.map((s) => s.memory.heapUsed)) / 1048576,
      peakMainRssMiB: Math.max(work.memory.rss, ...main.map((s) => s.memory.rss)) / 1048576,
      peakChildHeapMiB: child.length ? Math.max(...child.map((s) => s.memory.heapUsed)) / 1048576 : 0,
      peakChildRssMiB: Math.max(work.work.peakRssKiB || 0, ...child.map((s) => s.memory.rss / 1024)) / 1024,
      peakCombinedRssMiB: during.length ? Math.max(...during.map((s) => s.rows.reduce((sum, r) => sum + r.rssKiB, 0))) / 1024 : null,
      peakPendingMiB: Math.max(work.persistence.pendingBytes, ...main.map((s) => s.persistence.pendingBytes)) / 1048576,
    };
    rounds.push(result);
    log("round-complete", { round, mode, ms: work.ms, probes, peakMainHeapMiB: result.peakMainHeapMiB, peakCombinedRssMiB: result.peakCombinedRssMiB });
    await writeFile(join(dir, `round-${round}.json`), JSON.stringify(result, null, 2));
    assert.equal(probes.errors.length, 0);
    assert.equal(baseline.errors.length, 0);
  }
  log("crash-test-start");
  const oldHead = (await new PrimaryStateStore({ storage }).read(head)).body;
  report.failure = await rpc("crash");
  assert.equal(report.failure.normalHead, oldHead);
  assert.ok(report.failure.stagedFiles > 0);
  log("crash-test-passed", { stagedFiles: report.failure.stagedFiles });
  await rpc("close");
  await writer.exit;
  clearInterval(sampler);
  for (const mode of ["baseline", "compactor"]) {
    const source = rounds.findLast((item) => item.mode === mode);
    if (!source) continue;
    await new PrimaryStateStore({ storage }).publish(head, source.work.work.manifest);
    const validator = launch("verify", { versions });
    const result = await validator.ready;
    await validator.exit;
    restores.push({ mode, ...result });
    log("restore-verified", { mode, count: result.count, readyMs: result.readyMs });
  }
  report.passed = restores.every((r) => r.correct) && rounds.every((r) => !r.probes.errors.length);
} catch (error) {
  report.error = error.stack;
  report.passed = false;
  log("failed", { error: error.stack });
} finally {
  clearInterval(sampler);
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGTERM");
    await child.exit;
  }
  storage?.client.destroy();
  try { await exec("docker", ["rm", "-f", name]); } catch {}
  try { await exec("docker", ["volume", "rm", volume]); } catch {}
  await rm(join(dir, "wal-seed"), { recursive: true, force: true });
  await rm(join(dir, "wal-writer"), { recursive: true, force: true });
  Object.assign(report, { rounds, restores, samples, osSamples, events, completedAt: new Date().toISOString() });
  await writeFile(join(dir, "results.json"), JSON.stringify(report, null, 2));
  log("finished", { passed: report.passed, report: join(dir, "results.json") });
  if (!report.passed) process.exitCode = 1;
}
