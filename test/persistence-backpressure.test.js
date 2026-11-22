import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CRDTNode } from "../src/crdt.js";
import { PersistenceManager } from "../src/persistence.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { startServer, createObjectHookRegistry, shardMapFromHttp } from "../src/server.js";
import { FileService } from "../src/files.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class PausableStorage extends MemoryObjectStorage {
  pause(match = "/journal/") {
    this.block = { match, entered: deferred(), release: deferred() };
    return this.block;
  }
  async put(key, ...args) {
    const block = this.block;
    if (block && key.includes(block.match)) {
      block.entered.resolve();
      await block.release.promise;
    }
    if (this.journalDelay && key.includes("/journal/")) await sleep(this.journalDelay);
    return super.put(key, ...args);
  }
}

async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "condition did not become true");
    await nextTurn();
  }
}

async function fixture(t, { imports, server = false, files, objectHooks, auth = false, id = "backpressure" } = {}) {
  const node = new CRDTNode({ id });
  const storage = new PausableStorage();
  const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0,
    opBatchSize: 1_000_000, imports: { maxBulkBytes: 1024, maxPendingPersistenceBytes: 1024, persistenceWaitMs: 2000, ...imports } });
  persistence.start();
  const state = server ? await startServer({ node, persistence, files, objectHooks, auth,
    clusterSecret: "backpressure-test", environment: {}, bootstrapLogger: null, imports: persistence.imports }) : null;
  if (state) node.url = `http://127.0.0.1:${state.port}`;
  t.after(async () => {
    storage.block?.release.resolve();
    if (state) {
      await state.replication.stop();
      state.server.closeAllConnections();
      await new Promise((resolve) => state.server.close(resolve));
    }
    await persistence.stop().catch(() => {});
    node.db.dispose();
  });
  return { node, storage, persistence, state, base: state ? `http://127.0.0.1:${state.port}` : null };
}

function fill(node) {
  node.insert("test", "items", { _id: "seed", payload: "x".repeat(2048) });
}

function request(base, method, body, options = {}) {
  return fetch(`${base}/api/test/items/object${options.id ? `/${options.id}` : ""}`, {
    method, body: options.ndjson ? body : JSON.stringify(body), signal: options.signal,
    headers: { "content-type": options.ndjson ? "application/x-ndjson" : "application/json", prefer: "return=minimal" },
  });
}

test("uncontended admission is synchronous and does not flush or inspect stats", async (t) => {
  const { persistence } = await fixture(t);
  persistence.getStats = () => { throw new Error("stats must not be collected"); };
  const flush = persistence.flush.bind(persistence);
  persistence.flush = () => { throw new Error("no flush needed"); };
  assert.equal(persistence.withCapacity((waited) => { assert.equal(waited, false); return 42; }), 42);
  persistence.flush = flush;
});

test("admission counts in-flight journal bytes and resumes without polling", async (t) => {
  const { node, storage, persistence } = await fixture(t);
  fill(node);
  const bytes = persistence.pendingBytes;
  const block = storage.pause();
  const flushing = persistence.flush();
  await block.entered.promise;
  assert.equal(persistence.pendingBytes, 0);
  assert.equal(persistence.inflightBytes, bytes);
  let calls = 0;
  const flush = persistence.flush.bind(persistence);
  persistence.flush = () => { calls++; return flush(); };
  let applied = false;
  const waiting = persistence.withCapacity((waited) => { applied = true; assert.equal(waited, true); }, { bytes: 100 });
  await sleep(20);
  assert.equal(applied, false);
  assert.equal(calls, 1);
  assert.equal(persistence.getStats().waitingWriteBytes, 100);
  block.release.resolve();
  await waiting;
  await flushing;
  assert.equal(persistence.backlogBytes(), 0);
  assert.equal(persistence.waitingWrites, 0);
});

test("WAL in-flight bytes remain accounted until the append completes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "objy-admission-wal-"));
  const node = new CRDTNode({ id: "wal" });
  const persistence = new PersistenceManager({ node, storage: new MemoryObjectStorage(), flushMs: 0,
    snapshotMs: 0, opBatchSize: 1_000_000, ack: "localWal", localWal: { mode: "on", dir, fsync: true } });
  const append = deferred();
  persistence.start();
  fill(node);
  const bytes = persistence.localWalPendingBytes;
  const original = persistence.localWal.append.bind(persistence.localWal);
  persistence.localWal.append = async (...args) => { await append.promise; return original(...args); };
  t.after(async () => { append.resolve(); await persistence.stop(); node.db.dispose(); await rm(dir, { recursive: true, force: true }); });
  const flushed = persistence.flushLocal();
  assert.equal(persistence.localWalPendingBytes, 0);
  assert.equal(persistence.localWalInflightBytes, bytes);
  append.resolve();
  await flushed;
  assert.equal(persistence.localWalInflightBytes, 0);
});

test("concurrent waiters recheck capacity and retained request bytes are bounded", async (t) => {
  const { node, storage, persistence } = await fixture(t);
  fill(node);
  const block = storage.pause();
  const first = persistence.withCapacity(() => node.update("test", "items", "seed", { changed: true }), { bytes: 600 });
  await block.entered.promise;
  await assert.rejects(persistence.withCapacity(() => assert.fail("must not apply"), { bytes: 600 }),
    (error) => error.status === 503 && error.body.reason === "waiting capacity exhausted");
  let applied = 0;
  const second = persistence.withCapacity(() => { applied++; }, { bytes: 400 });
  block.release.resolve();
  await first;
  await second;
  assert.equal(applied, 1);
  assert.equal(persistence.backlogBytes(), 0);
  assert.equal(persistence.waitingWriteBytes, 0);
});

test("waiting request count is bounded even for zero-byte callers", async (t) => {
  const { node, storage, persistence } = await fixture(t);
  fill(node);
  const block = storage.pause();
  const waits = Array.from({ length: 64 }, () => persistence.withCapacity(() => {}));
  await assert.rejects(persistence.withCapacity(() => {}), (error) => error.status === 503);
  assert.equal(persistence.waitingWrites, 64);
  block.release.resolve();
  await Promise.all(waits);
  assert.equal(persistence.waitingWrites, 0);
});

for (const persistenceWaitMs of [0, 25]) {
  test(`capacity wait obeys persistenceWaitMs=${persistenceWaitMs}`, async (t) => {
    const { node, storage, persistence } = await fixture(t, { imports: { persistenceWaitMs } });
    fill(node);
    storage.pause();
    await assert.rejects(persistence.withCapacity(() => assert.fail("must not apply")), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, "PERSISTENCE_BACKPRESSURE");
      assert.equal(error.headers["x-objydb-pressure"], "persistence");
      return true;
    });
    assert.equal(persistence.waitingWrites, 0);
    assert.equal(persistence.waitingWriteBytes, 0);
  });
}

test("storage failures requeue journal bytes once and reject waiting writes", async (t) => {
  const { node, storage, persistence } = await fixture(t);
  fill(node);
  const bytes = persistence.pendingBytes;
  const block = storage.pause();
  const waiting = persistence.withCapacity(() => assert.fail("must not apply"));
  await block.entered.promise;
  block.release.reject(new Error("S3 unavailable"));
  await assert.rejects(waiting, (error) => error.status === 503 && error.message.includes("S3 unavailable"));
  assert.ok(Math.abs(persistence.pendingBytes - bytes) <= 2);
  assert.equal(persistence.getStats().pendingOps, 1);
  assert.equal(persistence.inflightBytes, 0);
  storage.block = null;
  await persistence.flush();
  assert.equal(persistence.backlogBytes(), 0);
});

test("cancelling a waiter does not cancel the shared persistence flush", async (t) => {
  const { node, storage, persistence } = await fixture(t);
  fill(node);
  const block = storage.pause();
  const abort = new AbortController();
  const waiting = persistence.withCapacity(() => assert.fail("cancelled write"), { signal: abort.signal });
  await block.entered.promise;
  const other = persistence.withCapacity(() => 7);
  abort.abort(new Error("client disconnected"));
  await assert.rejects(waiting, /client disconnected/);
  assert.ok(persistence.inflightBytes > 0);
  block.release.resolve();
  assert.equal(await other, 7);
  assert.equal(persistence.waitingWrites, 0);
});

test("shutdown cancels waiters and restarting renews admission", async (t) => {
  const { node, storage, persistence } = await fixture(t);
  fill(node);
  const block = storage.pause();
  const waiting = persistence.withCapacity(() => assert.fail("stopping write"));
  await block.entered.promise;
  const stopping = persistence.stop();
  await assert.rejects(waiting, /persistence is stopping/);
  block.release.resolve();
  await stopping;
  assert.throws(() => persistence.withCapacity(() => {}), /persistence is stopping/);
  persistence.start();
  assert.equal(persistence.withCapacity(() => 8), 8);
});

test("a paused checkpoint is joined instead of repeatedly flushing", async (t) => {
  const { node, storage, persistence } = await fixture(t);
  fill(node);
  await persistence.flush();
  const block = storage.pause("/snapshots/");
  const checkpoint = persistence.checkpoint();
  await block.entered.promise;
  node.update("test", "items", "seed", { changed: true });
  assert.equal(persistence.flushPaused, true);
  let applied = false;
  const waiting = persistence.withCapacity(() => { applied = true; });
  await sleep(20);
  assert.equal(applied, false);
  block.release.resolve();
  await checkpoint;
  await waiting;
  assert.equal(applied, true);
});

for (const ndjson of [false, true]) {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    test(`${ndjson ? "NDJSON" : "JSON"} ${method} waits before mutation`, async (t) => {
      const { node, storage, persistence, base } = await fixture(t, { server: true });
      node.insert("test", "items", { _id: "target", score: 1, retained: "original" });
      await persistence.flush();
      fill(node);
      const block = storage.pause();
      const body = method === "DELETE" ? (ndjson ? "\"target\"\n" : { ids: ["target"] })
        : method === "PATCH" ? [{ _id: "target", $set: { score: 2 } }]
        : [{ _id: method === "POST" ? "new" : "target", score: 2 }];
      const payload = ndjson && method !== "DELETE" ? body.map(JSON.stringify).join("\n") + "\n" : body;
      const pending = request(base, method, payload, { ndjson });
      await block.entered.promise;
      await until(() => persistence.waitingWrites === 1);
      assert.equal(node.get("test", "items", "target").score, 1);
      assert.equal(node.get("test", "items", "new"), undefined);
      if (method === "PATCH") node.update("test", "items", "target", { retained: "changed while waiting" });
      block.release.resolve();
      const response = await pending;
      assert.equal(response.status, method === "POST" ? 201 : 200, await response.text());
      if (method === "DELETE") assert.equal(node.get("test", "items", "target"), undefined);
      else {
        const row = node.get("test", "items", method === "POST" ? "new" : "target");
        assert.equal(row.score, 2);
        if (method === "PATCH") assert.equal(row.retained, "changed while waiting");
      }
    });
  }
}

test("single writes use the gate and hooks run only once while waiting", async (t) => {
  let hooks = 0;
  const objectHooks = createObjectHookRegistry().register("count", async (_context, next) => { hooks++; return next(); });
  const { node, storage, persistence, base } = await fixture(t, { server: true, objectHooks });
  node.setCollectionMeta("test", "items", { hooks: { update: ["count"] } });
  fill(node);
  const block = storage.pause();
  const pending = request(base, "PATCH", { $set: { score: 7 } }, { id: "seed" });
  await block.entered.promise;
  await until(() => persistence.waitingWrites === 1);
  assert.equal(hooks, 1);
  block.release.resolve();
  const response = await pending;
  assert.equal(response.status, 200, await response.text());
  assert.equal(hooks, 1);
  assert.equal(node.get("test", "items", "seed").score, 7);
});

test("HTTP disconnect discards the waiting batch", async (t) => {
  const { node, storage, persistence, base } = await fixture(t, { server: true });
  fill(node);
  const block = storage.pause();
  const abort = new AbortController();
  const pending = request(base, "POST", [{ _id: "cancelled" }], { signal: abort.signal });
  await block.entered.promise;
  await until(() => persistence.waitingWrites === 1);
  abort.abort();
  await assert.rejects(pending, /abort/i);
  await until(() => persistence.waitingWrites === 0);
  block.release.resolve();
  await persistence.flushing;
  assert.equal(node.get("test", "items", "cancelled"), undefined);
});

test("file upload cancelled by a capacity timeout removes its staged blob", async (t) => {
  const blobs = new MemoryObjectStorage();
  const files = new FileService({ storage: blobs });
  const { node, storage, base } = await fixture(t, { server: true, files, imports: { persistenceWaitMs: 25 } });
  fill(node);
  storage.pause();
  const body = new FormData();
  body.set("object", JSON.stringify({ _id: "file" }));
  body.set("file", new Blob(["hello"], { type: "text/plain" }), "hello.txt");
  const response = await fetch(`${base}/api/test/items/object`, { method: "POST", body });
  assert.equal(response.status, 503, await response.text());
  assert.equal(node.get("test", "items", "file"), undefined);
  assert.deepEqual(await blobs.list(""), []);
});

for (const streamed of [false, true]) {
  test(`${streamed ? "NDJSON" : "JSON"} replication does not advance its cursor before capacity is available`, async (t) => {
    const { node, storage, persistence } = await fixture(t);
    const source = new CRDTNode({ id: "source" });
    t.after(() => source.db.dispose());
    source.insert("test", "items", { _id: "replicated", score: 9 });
    fill(node);
    const block = storage.pause();
    const payload = { nodeId: source.id, lastSeq: source.seq, ops: source.log };
    let acked = false;
    const peer = { id: "source", pull: async () => streamed
      ? { ...payload, ops: undefined, opBatches: (async function* () { yield payload.ops; })() }
      : payload, ack: async () => { acked = true; } };
    const syncing = node.syncPeer(peer);
    await block.entered.promise;
    assert.equal(node.lastSeen.get("source"), undefined);
    assert.equal(acked, false);
    assert.equal(node.get("test", "items", "replicated"), undefined);
    block.release.resolve();
    await syncing;
    assert.equal(node.lastSeen.get("source"), 1);
    assert.equal(acked, true);
    assert.equal(node.get("test", "items", "replicated").score, 9);
    assert.equal(persistence.waitingWrites, 0);
  });
}

test("replication timeout leaves both data and cursor unapplied", async (t) => {
  const { node, storage } = await fixture(t, { imports: { persistenceWaitMs: 25 } });
  const source = new CRDTNode({ id: "source" });
  t.after(() => source.db.dispose());
  source.insert("test", "items", { _id: "unapplied" });
  fill(node);
  storage.pause();
  await assert.rejects(node.syncPeer({ id: "source", pull: async () => ({ nodeId: source.id, lastSeq: source.seq, ops: source.log }) }), (error) => error.status === 503);
  assert.equal(node.lastSeen.get("source"), undefined);
  assert.equal(node.get("test", "items", "unapplied"), undefined);
});

test("startup journal restore bypasses admission but live catch-up uses it", async (t) => {
  const { node, persistence } = await fixture(t);
  const scope = { database: "test", collection: "items", shard: "default" };
  const source = new CRDTNode({ id: "source" });
  t.after(() => source.db.dispose());
  source.insert("test", "items", { _id: "journal" });
  let admitted = 0;
  persistence.withCapacity = (apply) => { admitted++; return apply(); };
  persistence._admitRestoredJournalOps("source", scope, source.log);
  assert.equal(admitted, 1);
  assert.ok(node.get("test", "items", "journal"));
  await persistence.stop();
  assert.throws(() => persistence._admitRestoredJournalOps("source", scope, source.log), /persistence is stopping/);
  assert.equal(admitted, 1);
  const fresh = new CRDTNode({ id: "startup" });
  t.after(() => fresh.db.dispose());
  const boot = new PersistenceManager({ node: fresh, storage: new MemoryObjectStorage() });
  boot.withCapacity = () => assert.fail("startup restore must bypass admission");
  boot._admitRestoredJournalOps("source", scope, source.log);
  assert.ok(fresh.get("test", "items", "journal"));
});

for (const collection of [undefined, "items"]) {
  test(`${collection ? "collection" : "database"} deletion fences a waiting write`, async (t) => {
    const { node, storage, persistence, base } = await fixture(t, { server: true });
    fill(node);
    const block = storage.pause();
    const pending = request(base, "POST", [{ _id: "must-not-revive" }]);
    await block.entered.promise;
    await until(() => persistence.waitingWrites === 1);
    const deleting = node.lifecycle.drop({ database: "test", ...(collection ? { collection } : {}) });
    await until(() => node.lifecycle.record("test", collection)?.status === "deleting");
    block.release.resolve();
    const response = await pending;
    assert.equal(response.status, 409, await response.text());
    await deleting;
    assert.equal(node.db.isDatabaseDeleted("test") || node.db.isCollectionDeleted("test", "items"), true);
  });
}

test("permissions are rechecked against current data after waiting", async (t) => {
  const auth = { jwtSecret: "permission-test", users: [{ _id: "reader", username: "reader", password: "secret",
    permissions: [{ query: { owner: "reader" }, perm: "crud" }] }] };
  const { node, storage, persistence, base } = await fixture(t, { server: true, auth });
  const login = await fetch(`${base}/api/_global/users/auth`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "reader", password: "secret" }) });
  const session = await login.json();
  assert.equal(login.status, 200, JSON.stringify(session));
  node.insert("test", "items", { _id: "owned", owner: "reader", score: 1 });
  await persistence.flush();
  fill(node);
  const block = storage.pause();
  const pending = fetch(`${base}/api/test/items/object`, { method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify([{ _id: "owned", $set: { score: 2 } }]) });
  await block.entered.promise;
  await until(() => persistence.waitingWrites === 1);
  node.update("test", "items", "owned", { owner: "other" });
  block.release.resolve();
  const response = await pending;
  assert.equal(response.status, 403, await response.text());
  assert.equal(node.get("test", "items", "owned").score, 1);
});

test("NDJSON timeout reports completed batches without applying the waiting batch", async (t) => {
  const { node, storage, base } = await fixture(t, { server: true,
    imports: { maxBulkObjects: 1, persistenceWaitMs: 25, maxBulkBytes: 4096 } });
  storage.pause();
  const response = await request(base, "POST", JSON.stringify({ _id: "first", payload: "x".repeat(2048) }) +
    '\n{"_id":"second"}\n', { ndjson: true });
  const body = await response.json();
  assert.equal(response.status, 503, JSON.stringify(body));
  assert.equal(body.inserted, 1);
  assert.ok(node.get("test", "items", "first"));
  assert.equal(node.get("test", "items", "second"), undefined);
});

for (const ndjson of [false, true]) {
  test(`replication POST ${ndjson ? "NDJSON" : "JSON"} is gated before cursor and data changes`, async (t) => {
    const { node, storage, persistence, base } = await fixture(t, { server: true });
    const source = new CRDTNode({ id: "source" });
    t.after(() => source.db.dispose());
    source.insert("test", "items", { _id: "push" });
    fill(node);
    const block = storage.pause();
    const pending = fetch(`${base}/replicate${ndjson ? "?node=source" : ""}`, { method: "POST",
      headers: { "content-type": ndjson ? "application/x-ndjson" : "application/json", "x-objydb-cluster-secret": "backpressure-test" },
      body: ndjson ? source.log.map(JSON.stringify).join("\n") + "\n" : JSON.stringify({ node: "source", ops: source.log }) });
    await block.entered.promise;
    await until(() => persistence.waitingWrites === 1);
    assert.equal(node.lastSeen.get("source"), undefined);
    block.release.resolve();
    const response = await pending;
    assert.equal(response.status, 200, await response.text());
    assert.ok(node.get("test", "items", "push"));
    assert.equal(node.lastSeen.get("source"), 1);
  });
}

test("routing-only ingress ignores its own backlog; owner timeout includes earlier shard writes", async (t) => {
  const a = await fixture(t, { server: true, id: "a" });
  const b = await fixture(t, { server: true, id: "b", imports: { persistenceWaitMs: 25 } });
  const map = { shards: { a: { peers: [{ url: a.base }] }, b: { peers: [{ url: b.base }] } } };
  for (const peer of [a, b]) peer.node.replaceShardMap(shardMapFromHttp(map, peer.node.id, { secret: "backpressure-test" }));
  const idFor = (shard, prefix) => {
    for (let n = 0; ; n++) if (a.node.shardForObject("test", "items", `${prefix}${n}`) === shard) return `${prefix}${n}`;
  };
  fill(a.node);
  a.storage.pause();
  const remoteId = idFor("b", "remote");
  const forwarded = await request(a.base, "POST", [{ _id: remoteId }]);
  assert.equal(forwarded.status, 201, await forwarded.text());
  assert.ok(b.node.get("test", "items", remoteId));
  assert.equal(a.persistence.waitingWrites, 0);
  a.storage.block.release.resolve();
  await a.persistence.flush();
  fill(b.node);
  b.storage.pause();
  const localId = idFor("a", "local"), waitingId = idFor("b", "waiting");
  const failed = await request(a.base, "POST", [{ _id: localId }, { _id: waitingId }]);
  const body = await failed.json();
  assert.equal(failed.status, 503, JSON.stringify(body));
  assert.equal(body.inserted, 1);
  assert.ok(a.node.get("test", "items", localId));
  assert.equal(b.node.get("test", "items", waitingId), undefined);
});

for (const ndjson of [false, true]) {
  test(`disconnect cancels a forwarded ${ndjson ? "NDJSON" : "JSON"} waiting batch`, async (t) => {
    const a = await fixture(t, { server: true, id: "a" });
    const b = await fixture(t, { server: true, id: "b" });
    const map = { shards: { a: { peers: [{ url: a.base }] }, b: { peers: [{ url: b.base }] } } };
    for (const peer of [a, b]) peer.node.replaceShardMap(shardMapFromHttp(map, peer.node.id, { secret: "backpressure-test" }));
    let id;
    for (let n = 0; !id; n++) if (a.node.shardForObject("test", "items", `cancel-${n}`) === "b") id = `cancel-${n}`;
    fill(b.node);
    const block = b.storage.pause();
    const abort = new AbortController();
    const pending = request(a.base, "POST", ndjson ? JSON.stringify({ _id: id }) + "\n" : [{ _id: id }], { signal: abort.signal, ndjson });
    await block.entered.promise;
    await until(() => b.persistence.waitingWrites === 1);
    abort.abort();
    await assert.rejects(pending, /abort/i);
    await until(() => b.persistence.waitingWrites === 0);
    block.release.resolve();
    await b.persistence.flushing;
    assert.equal(b.node.get("test", "items", id), undefined);
  });
}

test("many pressured NDJSON batches preserve CRUD, field indexes, columns, and journal restore", async (t) => {
  const size = 10_000;
  const { node, storage, persistence, base } = await fixture(t, { server: true,
    imports: { maxBulkObjects: 100, maxBulkBytes: 256 * 1024, maxPendingPersistenceBytes: 4096 } });
  node.createCollection("test", "items", { indexes: ["kind"], columns: ["score"] });
  await persistence.flush();
  storage.journalDelay = 1;
  const send = async (method, objectAt, count = size) => {
    const body = Array.from({ length: count }, (_, n) => JSON.stringify(objectAt(n))).join("\n") + "\n";
    const response = await request(base, method, body, { ndjson: true });
    const result = await response.json();
    assert.equal(response.status, method === "POST" ? 201 : 200, JSON.stringify(result));
    assert.equal(result[{ POST: "inserted", PUT: "replaced", PATCH: "updated", DELETE: "deleted" }[method]], count);
  };
  const check = async (count, sum, kind) => {
    await node.awaitIndexes("test", "items");
    assert.equal(node.count("test", "items"), count);
    assert.equal(node.count("test", "items", { kind }), count);
    const rows = node.aggregate("test", "items", {}, { fields: { sum: { $sum: "score" }, count: { $count: true } } });
    assert.equal(rows[0].sum, sum);
    assert.equal(rows[0].count, count);
  };
  await send("POST", (n) => ({ _id: `item-${n}`, kind: "original", score: n, payload: "x".repeat(1024) }));
  await check(size, size * (size - 1) / 2, "original");
  await send("PUT", (n) => ({ _id: `item-${n}`, kind: "replaced", score: n * 2 }));
  await check(size, size * (size - 1), "replaced");
  assert.equal(node.count("test", "items", { kind: "original" }), 0);
  await send("PATCH", (n) => ({ _id: `item-${n}`, $set: { kind: "patched", score: n * 3 } }));
  await check(size, size * (size - 1) / 2 * 3, "patched");
  await send("DELETE", (n) => `item-${n}`, size / 2);
  const remainingSum = (size * (size - 1) - size / 2 * (size / 2 - 1)) / 2 * 3;
  await check(size / 2, remainingSum, "patched");
  assert.deepEqual(node.get("test", "items", `item-${size - 1}`), { _id: `item-${size - 1}`, kind: "patched", score: (size - 1) * 3 });
  await persistence.stop();
  const fresh = new CRDTNode({ id: node.id });
  t.after(() => fresh.db.dispose());
  await new PersistenceManager({ node: fresh, storage, flushMs: 0, snapshotMs: 0 }).restore();
  assert.equal(fresh.count("test", "items"), size / 2);
  assert.deepEqual(fresh.get("test", "items", `item-${size - 1}`), node.get("test", "items", `item-${size - 1}`));
  assert.equal(fresh.get("test", "items", "item-0"), undefined);
});

test("later locally owned shard groups refresh patch state after an earlier group yields", async (t) => {
  const { node, persistence, base } = await fixture(t, { server: true, imports: { maxPendingPersistenceBytes: 1024 * 1024 } });
  node.replaceShardMap(shardMapFromHttp({ shards: {
    a: { peers: [{ url: base }] }, b: { peers: [{ url: base }] },
  } }, node.id, { secret: "backpressure-test" }));
  const ids = new Map();
  for (let n = 0; ids.size < 2; n++) ids.set(node.shardForObject("test", "items", `item-${n}`), `item-${n}`);
  const [first, second] = ids.values();
  node.insertMany("test", "items", [first, second].map((_id) => ({ _id, retained: "original" })));
  await persistence.flush();
  const replace = node.replaceManyCount.bind(node);
  node.replaceManyCount = (...args) => {
    const count = replace(...args);
    if (args[2][0]._id === first) queueMicrotask(() => node.update("test", "items", second, { retained: "changed" }));
    return count;
  };
  const response = await request(base, "PATCH", [first, second].map((_id) => ({ _id, $set: { score: 7 } })));
  assert.equal(response.status, 200, await response.text());
  assert.equal(node.get("test", "items", second).retained, "changed");
  assert.equal(node.get("test", "items", second).score, 7);
});
