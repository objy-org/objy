import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CRDTNode } from "../src/crdt.js";
import { PersistenceManager } from "../src/persistence.js";
import { MemoryObjectStorage, S3ObjectStorage } from "../src/object-storage.js";
import { FileService } from "../src/files.js";
import { httpPeer, startServer } from "../src/server.js";
import { CONTEXT_HEADER } from "../src/context-lifecycle.js";

const db = "app", coll = "items";
const collection = { database: db, collection: coll };
const database = { database: db };
const flush = () => new Promise((resolve) => setImmediate(resolve));
function gate() {
  let release, reached;
  const waiting = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { reached = resolve; });
  return { release, reached, waiting, entered };
}

function cluster(t, { storage = new MemoryObjectStorage(), count = 3, wal } = {}) {
  const nodes = Array.from({ length: count }, (_, i) => new CRDTNode({ id: `node-${i}`, url: `http://node-${i}` }));
  const managers = nodes.map((node) => new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0, opBatchSize: 100_000,
    ...(wal ? { localWal: { mode: "on", dir: wal }, ack: "localWal" } : {}) }));
  const offline = new Set();
  const map = { shards: { default: { peers: nodes.map((node) => ({ url: node.url })) } } };
  for (const [i, node] of nodes.entries()) {
    node.replaceShardMap(map);
    managers[i].start();
    node.lifecycle.send = (url, command) => {
      if (offline.has(url)) return Promise.reject(new Error("peer offline"));
      return nodes.find((peer) => peer.url === url).lifecycle.command(command);
    };
    node.createDatabase(db, {});
    node.createCollection(db, coll, {});
  }
  t.after(() => { for (const manager of managers) manager.unsubscribe?.(); for (const node of nodes) node.db.dispose(); });
  return { nodes, managers, storage, offline, map };
}

async function recreate(node, context) {
  if (!context.collection) await node.lifecycle.create(context, null, () => node.createDatabase(context.database, {}));
  await node.lifecycle.create(collection, null, () => node.createCollection(db, coll, {}));
}

for (const context of [collection, database]) {
  const label = context.collection ? "collection" : "database";

  test(`${label} deletion waits for checkpoints, rejects recreation, and restores only new data`, async (t) => {
    const pause = gate();
    let block = false;
    class Storage extends MemoryObjectStorage {
      async put(key, body, type) {
        if (block && key.endsWith(".jsonl") && key.includes("/snapshots/")) { block = false; pause.reached(); await pause.waiting; }
        return super.put(key, body, type);
      }
    }
    const { nodes, managers, storage } = cluster(t, { storage: new Storage() });
    t.after(pause.release);
    nodes[0].insert(db, coll, { _id: "old", value: 1 });
    await managers[0].flush();
    block = true;
    const checkpoint = managers[0].checkpoint().catch((error) => assert.equal(error.code, "SNAPSHOT_CONFLICT"));
    await pause.entered;
    let done = false;
    const deletion = nodes[1].lifecycle.drop(context).then(() => { done = true; });
    for (let i = 0; !nodes[0].lifecycle.record(db, context.collection) && i < 100; i++) await flush();
    assert.equal(done, false);
    assert.throws(() => nodes[0].insert(db, coll, { _id: "blocked" }), /deleting|deleted/);
    await assert.rejects(recreate(nodes[1], context), /pending|active/);
    pause.release();
    await checkpoint;
    await deletion;
    for (const node of nodes) assert.equal(node.get(db, coll, "old"), undefined);
    await recreate(nodes[1], context);
    nodes[1].insert(db, coll, { _id: "new", value: 2 });
    await managers[1].flush();
    await managers[1].checkpoint();
    const restored = new CRDTNode({ id: "restored" });
    t.after(() => restored.db.dispose());
    await new PersistenceManager({ node: restored, storage }).restore();
    assert.equal(restored.get(db, coll, "old"), undefined);
    assert.deepEqual(restored.get(db, coll, "new"), { _id: "new", value: 2 });
  });

  test(`${label} deletion is retryable from another peer after an offline participant returns`, async (t) => {
    const { nodes, managers, storage, offline } = cluster(t);
    nodes[2].insert(db, coll, { _id: "offline-old" });
    await managers[2].flush();
    offline.add(nodes[2].url);
    await assert.rejects(nodes[0].lifecycle.drop(context), { status: 503 });
    const id = nodes[0].lifecycle.record(db, context.collection).id;
    await assert.rejects(recreate(nodes[1], context), { status: 409 });
    assert.throws(() => nodes[0].setCollectionMeta(db, coll, {}), { status: 409 });
    // Unrelated contexts remain usable while a deletion is pending.
    nodes[0].insert("other", "items", { _id: "alive" });
    const restarted = new CRDTNode({ id: nodes[0].id });
    t.after(() => restarted.db.dispose());
    await new PersistenceManager({ node: restarted, storage }).restore();
    assert.equal(restarted.lifecycle.record(db, context.collection).status, "deleting");
    assert.throws(() => restarted.insert(db, coll, { _id: "blocked" }), { status: 409 });
    offline.clear();
    await nodes[1].lifecycle.drop(context);
    assert.equal(nodes[1].lifecycle.record(db, context.collection).id, id);
    assert.equal(nodes[2].get(db, coll, "offline-old"), undefined);
    await nodes[0].lifecycle.drop(context);
    await recreate(nodes[0], context);
    nodes[0].insert(db, coll, { _id: "new" });
  });

  test(`${label} concurrent deletes join without replacing the deletion id`, async (t) => {
    const { nodes } = cluster(t);
    await Promise.all(nodes.map((node) => node.lifecycle.drop(context)));
    const ids = nodes.map((node) => node.lifecycle.record(db, context.collection).id);
    assert.equal(new Set(ids).size, 1);
    assert.ok(nodes.every((node) => node.lifecycle.record(db, context.collection).status === "deleted"));
  });

  test(`${label} deletion fences delayed replication, write continuations and internal retries`, async (t) => {
    const { nodes, managers } = cluster(t);
    nodes[0].insert(db, coll, { _id: "old" });
    const oldOps = structuredClone(nodes[0].log);
    const pause = gate();
    const req = { method: "POST", params: collection, headers: {} };
    const delayedWrite = nodes[1].lifecycle.runRequest(req, false, async () => {
      pause.reached(); await pause.waiting;
      nodes[1].insert(db, coll, { _id: "stale" });
    });
    const rejected = assert.rejects(delayedWrite, { status: 409 });
    await pause.entered;
    const header = nodes[1].lifecycle.requestHeader(req);
    await nodes[0].lifecycle.drop(context);
    const oldRecord = structuredClone(nodes[0].lifecycle.record(db, context.collection));
    for (const node of nodes) await recreate(node, context);
    nodes[0].insert(db, coll, { _id: "new" });
    pause.release();
    await rejected;
    assert.equal(nodes[1].applyRemote(nodes[0].id, oldOps), 0);
    assert.throws(() => nodes[1].lifecycle.runRequest({ method: "POST", params: collection, headers: header }, true, () => {}), { status: 409 });
    await assert.rejects(nodes[1].lifecycle.command({ phase: "prepare", record: oldRecord }), { status: 409 });
    await nodes[1].lifecycle._cleanup(oldRecord);
    await managers[0].flush();
    assert.equal(nodes[0].get(db, coll, "new")._id, "new");
  });
}

test("parent and child deletions cannot independently enter deleting", async (t) => {
  const { nodes, offline } = cluster(t);
  offline.add(nodes[2].url);
  await assert.rejects(nodes[0].lifecycle.drop(collection), { status: 503 });
  await assert.rejects(nodes[1].lifecycle.drop(database), { status: 409 });
  assert.equal(nodes[1].lifecycle.record(db), undefined);
  offline.clear();
  await nodes[1].lifecycle.drop(collection);
  await nodes[0].lifecycle.drop(database);
});

test("topology changes fail closed while deletion is pending", async (t) => {
  const { nodes, offline, map } = cluster(t);
  offline.add(nodes[2].url);
  await assert.rejects(nodes[0].lifecycle.drop(collection), { status: 503 });
  await assert.rejects(nodes[1].lifecycle.assertTopologyMutable(), { status: 409 });
  nodes[1].replaceShardMap({ shards: { other: map.shards.default } });
  offline.clear();
  await assert.rejects(nodes[1].lifecycle.drop(collection), { status: 409 });
  nodes[1].replaceShardMap(map);
  await nodes[1].lifecycle.drop(collection);
});

test("S3 per-key deletion failures are not reported as successful cleanup", async () => {
  const storage = new S3ObjectStorage({ bucket: "test", accessKeyId: "test", secretAccessKey: "test" });
  storage.ensureBucket = async () => {};
  storage.client.send = async () => ({ Errors: [{ Key: "old-object", Code: "AccessDenied" }] });
  await assert.rejects(storage.delete(["old-object"]), /old-object: AccessDenied/);
  storage.client.destroy();
});

test("failed blob cleanup leaves the same deletion pending until a successful retry", async (t) => {
  const { nodes, storage } = cluster(t);
  const files = new FileService({ storage, prefix: "files" });
  const meta = files.metadata(db, coll, "old", "text/plain");
  await files.put(db, coll, "old", meta, { body: Buffer.from("hello") });
  for (const node of nodes) node.lifecycle.files = files;
  const remove = storage.delete.bind(storage);
  let fail = true;
  storage.delete = async (keys) => { if (fail && keys.some((key) => key.startsWith("files/"))) throw new Error("storage unavailable"); return remove(keys); };
  await assert.rejects(nodes[0].lifecycle.drop(collection), { status: 503 });
  const id = nodes[0].lifecycle.record(db, coll).id;
  await assert.rejects(recreate(nodes[0], collection), { status: 409 });
  fail = false;
  await nodes[1].lifecycle.drop(collection);
  assert.equal(nodes[1].lifecycle.record(db, coll).id, id);
  assert.equal(await storage.getBlob(meta.key), null);
});

test("old WAL metadata and operations cannot restore a deleted context after recreation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "objydb-delete-wal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { nodes, managers, storage } = cluster(t, { count: 1, wal: dir });
  const node = nodes[0], manager = managers[0];
  node.insert(db, coll, { _id: "old" });
  await manager.flushLocal();
  const oldWal = (await manager.localWal.readRecords()).records;
  await node.lifecycle.drop(database);
  await recreate(node, database);
  node.insert(db, coll, { _id: "new" });
  await manager.flush();
  // Simulate an old WAL surviving cleanup on another disk/crashed process.
  const recovered = new CRDTNode({ id: node.id });
  t.after(() => recovered.db.dispose());
  const p = new PersistenceManager({ node: recovered, storage, localWal: { mode: "on", dir: join(dir, "recovery") }, flushMs: 0, snapshotMs: 0 });
  await p.localWal.append(oldWal);
  await p.restore();
  assert.equal(recovered.get(db, coll, "old"), undefined);
  assert.equal(recovered.get(db, coll, "new")._id, "new");
});

test("lifecycle control is authenticated and repeated HTTP deletes return 204", async (t) => {
  const node = new CRDTNode({ id: "http" });
  const storage = new MemoryObjectStorage();
  const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0 });
  persistence.start();
  const server = await startServer({ node, persistence, clusterSecret: "cluster-test", auth: {
    jwtSecret: "auth-test", users: [{ _id: "admin", username: "admin", password: "123", admin: true }],
  } });
  const url = `http://127.0.0.1:${server.port}`;
  node.url = url;
  t.after(async () => { persistence.unsubscribe?.(); node.db.dispose(); await new Promise((resolve) => server.server.close(resolve)); });
  const login = await fetch(`${url}/api/_global/users/auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "123" }) });
  const { accessToken } = await login.json();
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
  const request = (path, method, body) => fetch(url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await request("/api/app/collections", "POST", { name: "items" })).status, 201);
  assert.equal((await request("/api/app/items/object", "POST", { _id: "old" })).status, 201);
  assert.equal((await request("/cluster/context", "POST", {})).status, 401);
  assert.equal((await request("/api/app/collections/items", "DELETE")).status, 204);
  assert.equal((await request("/api/app/collections/items", "DELETE")).status, 204);
  assert.equal((await request("/api/app/items/object", "POST", { _id: "blocked" })).status, 409);
  assert.equal((await request("/api/app/items/meta", "PUT", {})).status, 409);
  assert.equal((await request("/api/app/collections", "POST", { name: "items" })).status, 201);
  assert.equal((await request("/api/app/items/object", "POST", { _id: "new" })).status, 201);
  assert.equal(node.get(db, coll, "old"), undefined);
  assert.equal(node.get(db, coll, "new")._id, "new");
  const untrusted = await fetch(`${url}/api/app/items/object`, {
    method: "POST", headers: { ...headers, [CONTEXT_HEADER]: "not-a-trusted-internal-ticket" }, body: JSON.stringify({ _id: "untrusted-header" }),
  });
  assert.equal(untrusted.status, 201, "client-supplied lifecycle headers must not control internal fencing");
});

test("a peer missing recreation learns the active context during normal replication", async (t) => {
  const { nodes, managers, storage } = cluster(t, { count: 2 });
  const options = { clusterSecret: "replica-test", auth: { enabled: false } };
  const source = await startServer({ node: nodes[0], persistence: managers[0], ...options });
  const replica = await startServer({ node: nodes[1], persistence: managers[1], ...options });
  t.after(async () => { await new Promise((resolve) => source.server.close(resolve)); await new Promise((resolve) => replica.server.close(resolve)); });
  nodes[0].url = `http://127.0.0.1:${source.port}`;
  nodes[1].url = `http://127.0.0.1:${replica.port}`;
  const map = { shards: { default: { peers: nodes.map((node) => ({ url: node.url })) } } };
  for (const node of nodes) node.replaceShardMap(map);
  await nodes[0].lifecycle.drop(collection);
  assert.equal(nodes[1].lifecycle.record(db, coll).status, "deleted");
  // Recreate only on the source, simulating an unavailable metadata fan-out.
  await recreate(nodes[0], collection);
  nodes[0].insert(db, coll, { _id: "new", value: 42 });
  await managers[0].flush();
  const peer = httpPeer(nodes[0].url, nodes[1].id, { secret: "replica-test" });
  await nodes[1].syncPeer(peer);
  assert.deepEqual(nodes[1].get(db, coll, "new"), { _id: "new", value: 42 });
  let reads = 0;
  const get = storage.get.bind(storage);
  storage.get = async (key) => { if (key.endsWith("context-state.json")) reads++; return get(key); };
  await nodes[1].syncPeer(peer);
  assert.equal(reads, 0, "unchanged replication must not poll shared lifecycle state");
});

test("a pending file upload is drained and cleaned before deletion completes", async (t) => {
  const pause = gate();
  class Storage extends MemoryObjectStorage {
    async putBlob(...args) { pause.reached(); await pause.waiting; return super.putBlob(...args); }
  }
  const { nodes, storage } = cluster(t, { storage: new Storage(), count: 1 });
  const node = nodes[0];
  const files = new FileService({ storage, prefix: "files" });
  node.lifecycle.files = files;
  files.lifecycle = node.lifecycle;
  const meta = files.metadata(db, coll, "old", "text/plain");
  t.after(pause.release);
  const upload = node.lifecycle.runRequest({ method: "POST", params: collection, headers: {} }, false, async () => {
    await files.put(db, coll, "old", meta, { body: Buffer.from("hello") });
    node.insert(db, coll, { _id: "old", _file: meta });
  });
  const rejected = assert.rejects(upload, { status: 409 });
  await pause.entered;
  let finished = false;
  const deletion = node.lifecycle.drop(collection).then(() => { finished = true; });
  await flush();
  assert.equal(finished, false);
  pause.release();
  await rejected;
  await deletion;
  assert.equal(await storage.getBlob(meta.key), null);
});

test("timed-out first metadata/head publications cannot arrive after deletion and recreate old data", async (t) => {
  const { nodes, managers, storage } = cluster(t, { count: 1 });
  const node = nodes[0], manager = managers[0];
  const metaKey = "objydb/db/app/collection/items/meta.json";
  const headKey = "objydb/db/app/collection/items/shard/default/latest.json";
  // These requests acquired If-None-Match before deletion but their server-side
  // completion was delayed beyond the client's failed request.
  await node.lifecycle.drop(database);
  await recreate(node, database);
  assert.equal(await storage.putConditional(metaKey, JSON.stringify({ indexes: ["old"] }), null), false);
  assert.equal(await storage.putConditional(headKey, JSON.stringify({ id: "old-snapshot" }), null), false);
  node.insert(db, coll, { _id: "new" });
  await manager.flush();
  const restored = new CRDTNode({ id: "restored" });
  t.after(() => restored.db.dispose());
  await new PersistenceManager({ node: restored, storage }).restore();
  assert.equal(restored.get(db, coll, "new")._id, "new");
  assert.deepEqual(restored.getCollectionMeta(db, coll).indexes, []);
});

test("a failed completion write can resume after coordinator restart", async (t) => {
  const { nodes, managers, storage, map } = cluster(t);
  let fail = true;
  const put = storage.putConditional.bind(storage);
  storage.putConditional = async (path, body, etag) => {
    if (fail && path.endsWith("context-state.json") && Object.values(JSON.parse(body).contexts).some((record) => record.status === "deleted")) {
      fail = false; throw new Error("connection lost before completion");
    }
    return put(path, body, etag);
  };
  await assert.rejects(nodes[0].lifecycle.drop(collection), { status: 503 });
  const id = nodes[0].lifecycle.record(db, coll).id;
  managers[0].unsubscribe();
  const replacement = new CRDTNode({ id: nodes[0].id, url: nodes[0].url, shardMap: map });
  const manager = new PersistenceManager({ node: replacement, storage });
  await manager.restore();
  manager.start();
  replacement.lifecycle.send = nodes[0].lifecycle.send;
  nodes[0].db.dispose();
  nodes[0] = replacement;
  t.after(() => { manager.unsubscribe(); replacement.db.dispose(); });
  assert.equal(replacement.lifecycle.record(db, coll).id, id);
  await nodes[1].lifecycle.drop(collection);
  assert.equal(nodes[1].lifecycle.record(db, coll).status, "deleted");
});

test("normal bulk writes do not read or write shared lifecycle state", async (t) => {
  const { nodes, storage } = cluster(t, { count: 1 });
  const node = nodes[0];
  await node.lifecycle.drop(collection);
  await recreate(node, collection);
  storage.getVersioned = storage.putConditional = async () => { throw new Error("unexpected shared-state I/O on object writes"); };
  node.insertManyCount(db, coll, Array.from({ length: 1000 }, (_, i) => ({ _id: `new-${i}`, score: i })));
  assert.equal(node.count(db, coll), 1000);
});

test("invalid durable lifecycle state fails closed instead of forgetting deletion", async (t) => {
  const { nodes, storage } = cluster(t);
  await storage.put(nodes[0].lifecycle.path, JSON.stringify({ version: 999, contexts: {} }));
  await assert.rejects(nodes[0].lifecycle.load(), { status: 503 });
  await assert.rejects(nodes[0].lifecycle.drop(collection), { status: 503 });
  assert.ok(nodes[0].getCollectionMeta(db, coll));
});

test("WAL acknowledgement does not chase writes accepted after its barrier", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "objydb-wal-barrier-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { nodes, managers } = cluster(t, { count: 1, wal: dir });
  const node = nodes[0], manager = managers[0];
  node.insert(db, coll, { _id: "before-barrier" });
  const append = manager.localWal.append.bind(manager.localWal);
  let calls = 0;
  manager.localWal.append = async (records) => {
    const written = await append(records);
    node.insert("other", coll, { _id: `after-barrier-${++calls}` });
    return written;
  };
  await manager.flushLocal();
  assert.equal(calls, 1);
  assert.equal(manager.localWalPending.length, 1);
  assert.equal((await manager.localWal.readRecords()).records.some((record) => record.ops?.some((op) => op.id === "before-barrier")), true);
});

test("learned peer identities do not count as a topology change", async (t) => {
  const { nodes } = cluster(t);
  nodes[0].shardMap.allPeers().find((peer) => peer.url === nodes[1].url).nodeId = nodes[1].id;
  nodes[2].shardMap.allPeers().find((peer) => peer.url === nodes[0].url).nodeId = nodes[0].id;
  await nodes[0].lifecycle.drop(collection);
  assert.ok(nodes.every((node) => node.lifecycle.record(db, coll).status === "deleted"));
});

test("deleting a database retires child state and preserves its origin cutoffs", async (t) => {
  const { nodes, managers, storage } = cluster(t, { count: 1 });
  const node = nodes[0];
  node.applyRemote("retired-origin", [{ kind: "putObj", from: "retired-origin", seq: 123, ts: { c: 10, n: "retired-origin" }, db, coll, id: "old", shard: "default", value: { score: 1 } }]);
  await node.lifecycle.drop(collection);
  node.lastSeen.clear();
  await node.lifecycle.drop(database);
  assert.equal(node.lifecycle.record(db, coll), undefined);
  assert.equal(node.lifecycle.record(db).cursors["retired-origin"], 123);
  await recreate(node, database);
  node.insert(db, coll, { _id: "new" });
  await managers[0].flush();
  const raw = JSON.parse(await storage.get(node.lifecycle.path));
  assert.equal(Object.keys(raw.contexts).length, 1, "parent retirement replaces child control history");
});

test("file and persistence prefixes may overlap without removing publication fences", async (t) => {
  const { nodes, storage } = cluster(t, { count: 1 });
  const files = new FileService({ storage, prefix: "objydb" });
  nodes[0].lifecycle.files = files;
  const meta = files.metadata(db, coll, "old", "text/plain");
  await files.put(db, coll, "old", meta, { body: Buffer.from("test") });
  await nodes[0].lifecycle.drop(collection);
  assert.equal(await storage.getBlob(meta.key), null);
  const head = "objydb/db/app/collection/items/shard/default/latest.json";
  assert.equal(await storage.putConditional(head, "{}", null), false);
});

test("custom metadata cannot be confused with persistence envelopes or deletion markers", async (t) => {
  const { nodes, managers, storage } = cluster(t, { count: 1 });
  const node = nodes[0], manager = managers[0];
  const meta = { deletedBy: "application-field", __objyMeta: "application-field", version: 1, revision: "application-field", meta: { custom: true } };
  node.setCollectionMeta(db, coll, meta);
  await manager.flush();
  let restored = new CRDTNode({ id: "unmanaged" });
  await new PersistenceManager({ node: restored, storage }).restore();
  assert.equal(restored.getCollectionMeta(db, coll).deletedBy, "application-field");
  restored.db.dispose();
  await node.lifecycle.drop(collection);
  await node.lifecycle.create(collection, null, () => node.createCollection(db, coll, meta));
  await manager.flush();
  restored = new CRDTNode({ id: "managed" });
  t.after(() => restored.db.dispose());
  await new PersistenceManager({ node: restored, storage }).restore();
  assert.equal(restored.getCollectionMeta(db, coll).deletedBy, "application-field");
  assert.deepEqual(restored.getCollectionMeta(db, coll).meta, { custom: true });
});

test("a timed-out cleanup CAS cannot erase identical metadata after recreation (S3 ETag ABA)", async (t) => {
  const metaKey = "objydb/db/app/collection/items/meta.json";
  let pause = false, delayed;
  class ContentEtagStorage extends MemoryObjectStorage {
    etag(key) {
      const body = this.objects.get(key)?.body;
      return body === undefined ? null : createHash("sha256").update(body).digest("hex");
    }
    async getVersioned(key) { return { body: await this.get(key), etag: this.etag(key) }; }
    async cas(key, body, etag) {
      if (this.etag(key) !== etag) return false;
      await super.put(key, body);
      return true;
    }
    async putConditional(key, body, etag) {
      if (pause && key === metaKey && JSON.parse(body).deletedBy) {
        pause = false;
        delayed = () => this.cas(key, body, etag);
        throw new Error("client timed out while S3 still had the request");
      }
      return this.cas(key, body, etag);
    }
  }
  const { nodes, managers, storage } = cluster(t, { storage: new ContentEtagStorage(), count: 2 });
  await nodes[0].lifecycle.drop(collection);
  for (const node of nodes) await recreate(node, collection);
  await managers[0].flush();
  pause = true;
  await assert.rejects(nodes[0].lifecycle.drop(collection), { status: 503 });
  await nodes[1].lifecycle.drop(collection);
  for (const node of nodes) await recreate(node, collection);
  nodes[1].insert(db, coll, { _id: "new" });
  await managers[1].flush();
  assert.equal(await delayed(), false);
  const restored = new CRDTNode({ id: "restored" });
  t.after(() => restored.db.dispose());
  await new PersistenceManager({ node: restored, storage }).restore();
  assert.equal(restored.get(db, coll, "new")._id, "new");
  assert.deepEqual(restored.getCollectionMeta(db, coll).indexes, []);
});

test("simultaneous parent/child deletes have exactly one pending lifecycle", async (t) => {
  const { nodes, offline } = cluster(t);
  offline.add(nodes[2].url);
  const results = await Promise.allSettled([nodes[0].lifecycle.drop(database), nodes[1].lifecycle.drop(collection)]);
  assert.deepEqual(results.map((result) => result.reason.status).sort(), [409, 503]);
  const pending = [...nodes[0].lifecycle.records.values()].filter((record) => record.status === "deleting");
  assert.equal(pending.length, 1);
  offline.clear();
  await nodes[1].lifecycle.drop(pending[0]);
});

test("200 mixed delete/recreate cycles preserve new writes and reject old operations", async (t) => {
  const { nodes, managers, offline } = cluster(t);
  for (let round = 0; round < 200; round++) {
    const context = round % 5 ? collection : database;
    const owner = nodes[round % nodes.length];
    owner.insert(db, coll, { _id: `old-${round}`, score: round });
    const old = structuredClone(owner.log);
    offline.add(nodes[(round + 1) % nodes.length].url);
    await assert.rejects(owner.lifecycle.drop(context), { status: 503 });
    offline.clear();
    await Promise.all(nodes.map((node) => node.lifecycle.drop(context)));
    for (const node of nodes) await recreate(node, context);
    owner.insertManyCount(db, coll, Array.from({ length: 7 }, (_, i) => ({ _id: `new-${round}-${i}`, score: i })));
    for (const node of nodes) {
      if (node !== owner) node.applyRemote(owner.id, structuredClone(owner.log));
      assert.equal(node.applyRemote(owner.id, structuredClone(old)), 0);
      assert.equal(node.count(db, coll), 7);
      assert.deepEqual(node.aggregate(db, coll, {}, { fields: { count: { $count: true }, total: { $sum: "score" } } }), [{ count: 7, total: 21 }]);
    }
    if (round % 20 === 0) await managers[round % managers.length].checkpoint();
  }
});
