import assert from "node:assert/strict";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate as turn } from "node:timers/promises";
import { CRDTNode } from "../../src/crdt.js";
import { nodeCompression, readHeapUsageRatio } from "../../src/node-runtime.js";
import { PersistenceManager } from "../../src/persistence.js";
import { S3ObjectStorage } from "../../src/object-storage.js";
import { startServer } from "../../src/server.js";
import { captureCompaction } from "./compact.js";
import { runCompaction } from "./process.js";
import { DB, COLL, SLOTS, scope, head, row, live, meta, request, sleep } from "./fixture.js";

const send = (message) => process.send?.(message);
process.once("message", async (config) => {
  const storage = new S3ObjectStorage(config.s3);
  const makeNode = () => new CRDTNode({ id: "writer", operationLog: false, storage: { engine: "object", compression: nodeCompression, readHeapUsageRatio } });
  let node = makeNode();
  const persistence = new PersistenceManager({
    node, storage, prefix: "benchmark", snapshotMs: 0, flushMs: 5000, compactJournals: false,
    ack: "localWal", localWal: { mode: "on", dir: `${config.dir}/wal-${config.role}`, fsync: true },
    restoreSnapshotId: config.snapshotId,
  });
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let runtime, stage = "setup", round = -1;
  const memory = () => ({ pid: process.pid, memory: process.memoryUsage(), persistence: persistence.getStats(), loopMaxMs: loop.max / 1e6 });
  const timer = setInterval(() => { send({ type: "sample", stage, round, ...memory() }); loop.reset(); }, 200);
  const close = async () => {
    if (runtime) { runtime.server.closeAllConnections(); await new Promise((resolve) => runtime.server.close(resolve)); runtime = null; }
    await persistence.stop();
    clearInterval(timer);
    loop.disable();
    node.db.dispose();
    storage.client.destroy();
  };
  const verify = async (versions, { failures = true } = {}) => {
    const groups = Array.from({ length: 16 }, (_, i) => ({ kind: `g${i}`, count: 0, sum: 0 }));
    let count = 0, seeds = 0;
    for (const [id, state] of node.db.collection(DB, COLL).meta) {
      assert.equal(state.deleted, null);
      const i = Number(id.slice(2));
      const expected = id.startsWith("r-") ? row(i) : live(i, versions[i]);
      assert.deepEqual(node.get(DB, COLL, id), expected, id);
      if (id.startsWith("r-")) { seeds++; groups[i % 16].count++; groups[i % 16].sum += i % 1000; }
      if (++count % 1024 === 0) await turn();
      if (count % 250000 === 0) send({ type: "progress", stage: "verify", count });
    }
    assert.equal(seeds, config.count);
    assert.equal(count, config.count + SLOTS);
    assert.equal(node.count(DB, COLL, { active: true }), config.count - Math.ceil(config.count / 3) + SLOTS - Math.ceil(SLOTS / 3));
    const actual = node.aggregate(DB, COLL, { seed: true }, { groupBy: "kind", fields: { sum: { $sum: "score" }, count: { $count: true } } });
    assert.deepEqual(actual.toSorted((a, b) => a.kind.localeCompare(b.kind)), groups.toSorted((a, b) => a.kind.localeCompare(b.kind)));
    const total = groups.reduce((sum, g) => sum + g.sum, 0) + versions.reduce((sum, v) => sum + v % 1000, 0);
    assert.deepEqual(node.aggregate(DB, COLL, {}, { fields: { sum: { $sum: "score" }, count: { $count: true } } }), [{ sum: total, count }]);
    let failureObjects = 0;
    if (failures) {
      failureObjects = node.count(DB, "failure_objects");
      assert.equal(failureObjects, 3000);
      for (let i = 0; i < failureObjects; i++) {
        assert.deepEqual(node.get(DB, "failure_objects", `failure-${i}`), { _id: `failure-${i}`, payload: "x".repeat(2048) });
      }
    }
    return { count, seeds, failureObjects, groups: actual.length, correct: true };
  };
  try {
    const start = performance.now();
    if (config.role === "seed") {
      stage = "seed";
      node.db.beginBulkLoad();
      node.createCollection(DB, COLL, meta);
      for (let i = 0; i < config.count; i += 5000) {
        node.insertManyCount(DB, COLL, Array.from({ length: Math.min(5000, config.count - i) }, (_, j) => row(i + j)));
        if (i % 100000 === 0) send({ type: "progress", stage, count: Math.min(config.count, i + 5000) });
        await turn();
      }
      node.insertManyCount(DB, COLL, Array.from({ length: SLOTS }, (_, slot) => live(slot)));
      node.db.endBulkLoad();
    } else {
      stage = "restore";
      await persistence.restore();
    }
    stage = "warmup";
    await node.awaitIndexes(DB, COLL);
    if (config.role === "verify") {
      const readyMs = performance.now() - start;
      stage = "verify";
      const result = await verify(config.versions);
      const manifest = JSON.parse(await storage.get(head));
      if (manifest.id.startsWith("candidate-")) {
        // Every controlled public replacement increments both revision and seq.
        // The only later fixture writes are the 3000 crash-test objects.
        const finalRevision = Math.max(...config.versions);
        const initialSeq = node.seq - finalRevision - result.failureObjects;
        const lastRevision = manifest.seq - initialSeq;
        assert.ok(lastRevision >= 0 && lastRevision <= finalRevision);
        const at = (revision) => Array.from({ length: SLOTS }, (_, slot) => revision < slot ? 0 : revision - (revision - slot) % SLOTS);
        assert.deepEqual(config.versions, at(finalRevision));
        node.db.dispose();
        await turn(); global.gc();
        node = makeNode();
        stage = "verify-snapshot-cut";
        const cutStart = performance.now();
        await new PersistenceManager({ node, storage, prefix: "benchmark", restoreSnapshotId: manifest.id }).restore();
        await node.awaitIndexes(DB, COLL);
        result.cut = { ...await verify(at(lastRevision), { failures: false }), lastRevision, ms: performance.now() - cutStart };
      }
      send({ type: "done", result: { ...result, readyMs, ...memory() } });
      await close();
      process.disconnect();
      return;
    }
    persistence.start();
    runtime = await startServer({
      node, persistence, port: { host: "127.0.0.1", port: 0 }, bootstrapLogger: () => {},
      auth: { jwtSecret: "disposable-compaction-benchmark-secret", accessTokenTtlSeconds: 86400, users: [{ username: "admin", password: "disposable-compaction-password", admin: true }] },
    });
    await node.awaitIndexes("_global", "users");
    const url = `http://127.0.0.1:${runtime.port}`;
    const session = await request(`${url}/api/_global/users/auth`, "", { method: "POST", body: { username: "admin", password: "disposable-compaction-password" } });
    // The first list creates the lazy ID ordering; await it before timing snapshots.
    await request(`${url}/api/${DB}/${COLL}/search`, session.accessToken, { method: "POST", body: { $pageSize: 50, $refDepth: 0 } });
    await node.db.collection(DB, COLL).idOrder?.ready();
    assert.ok(node.db.collection(DB, COLL).idOrder?.complete, "ID ordering must be warm before the comparison");
    if (config.role === "seed") {
      stage = "seed-snapshot";
      const snapshot = await persistence.checkpoint();
      send({ type: "done", result: { snapshot, ms: performance.now() - start } });
      await close();
      process.disconnect();
      return;
    }
    stage = "ready";
    send({ type: "ready", result: { url, token: session.accessToken, seq: node.seq, ms: performance.now() - start, ...memory() } });
    process.on("message", async ({ id, command, ...args }) => {
      try {
        let result;
        if (command === "prepare") {
          round = args.round;
          await persistence.flushLocal(); await persistence.flush(); await turn(); global.gc(); await sleep(100); global.gc();
          stage = "baseline";
          result = { ...memory(), seq: node.seq };
        } else if (command === "snapshot") {
          stage = "snapshot";
          const cpu = process.cpuUsage(), start = performance.now();
          let work;
          if (args.mode === "baseline") {
            const checkpoint = await persistence.checkpoint();
            work = { checkpoint, manifest: JSON.parse(await storage.get(head)) };
          } else {
            const plan = await captureCompaction(persistence, scope);
            work = await runCompaction(plan, { s3: config.s3, onSample: (message) => send({ ...message, type: `compactor-${message.type}`, round }) });
            work.manifest = JSON.parse(await storage.get(work.manifestKey));
            // Disposable benchmark bucket only. The candidate itself never publishes.
            await storage.put(head, JSON.stringify(work.manifest));
          }
          result = { work, ms: performance.now() - start, cpu: process.cpuUsage(cpu), ...memory() };
          stage = "drain";
        } else if (command === "drain") {
          await persistence.flushLocal(); await persistence.flush();
          await node.awaitIndexes(DB, COLL);
          await turn(); global.gc(); await sleep(100); global.gc();
          result = { ...memory(), seq: node.seq };
        } else if (command === "crash") {
          stage = "failure-test";
          node.createCollection(DB, "failure_objects", {});
          node.insertManyCount(DB, "failure_objects", Array.from({ length: 3000 }, (_, i) => ({ _id: `failure-${i}`, payload: "x".repeat(2048) })));
          await persistence.afterWrite();
          const failedScope = { ...scope, collection: "failure_objects" };
          const plan = await captureCompaction(persistence, failedScope);
          const abort = new AbortController();
          await assert.rejects(runCompaction(plan, {
            s3: config.s3, signal: abort.signal, segmentBytes: 1024 * 1024,
            onSample: (message) => { if (message.type === "progress" && message.stage === "upload") abort.abort(new Error("simulated compactor crash")); },
          }), /simulated compactor crash/);
          assert.equal(await storage.get(`${plan.output}/manifest.json`), null);
          result = { killedAfterSegmentUpload: true, stagedFiles: (await storage.list(plan.output)).length, normalHead: await storage.get(head) };
        } else if (command === "close") {
          await close(); send({ id, result: {} }); process.disconnect(); return;
        } else throw new Error(`unknown benchmark command ${command}`);
        send({ id, result });
      } catch (error) { send({ id, error: error.stack }); }
    });
  } catch (error) {
    send({ type: "failed", error: error.stack });
    process.exitCode = 1;
    await close();
    process.disconnect();
  }
});
