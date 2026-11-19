import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CRDTNode } from "../src/crdt.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";
import { PrimaryStateStore, isPrimary, primaryFor, publicationKeys, isPublicationKey } from "../src/primary-state.js";
import { ShardMapStore } from "../src/shard-map-store.js";
import { publishShardMap } from "../src/shard-map.js";
import { startServer, shardMapFromHttp } from "../src/server.js";
import { resolveSystemSecrets } from "../src/system-secrets.js";

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), "objy-primary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("publication order survives a fresh process even when its previous PUT never became visible", async (t) => {
  const path = join(await temporary(t), "clock.json");
  const module = new URL("../src/primary-state.js", import.meta.url).href;
  const code = `import { PrimaryStateStore } from ${JSON.stringify(module)};
    const storage = { list: async () => [], get: async () => null, put: async (key) => process.stdout.write(JSON.stringify(key)) };
    await new PrimaryStateStore({ storage, clockPath: ${JSON.stringify(path)} }).publish("head", "value");`;
  const run = async () => JSON.parse((await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code])).stdout);
  const first = await run(), second = await run();
  assert.ok(second > first);
  assert.equal(JSON.parse(await readFile(path, "utf8")), 2);
});

test("ownership epochs fence delayed publications from an old primary", async () => {
  const storage = new MemoryObjectStorage();
  const old = new PrimaryStateStore({ storage, epoch: () => 0 });
  const first = await old.publish("head", "old");
  const next = new PrimaryStateStore({ storage, epoch: () => 1 });
  await next.publish("head", "new");
  await storage.put(first.key.replace(/-\d{16}-/, "-9000000000000000-"), "late old owner");
  assert.equal((await next.read("head")).body, "new");
  for (let i = 0; i < 20; i++) { await next.publish("head", String(i)); await next.prune("head"); }
  assert.equal((await storage.list("head.publications/")).length, 2);
  assert.equal((await next.read("head")).body, "19");
  await assert.rejects(old.publish("head", "obsolete owner"), /newer primary/);
});

test("a new owner adopts unchanged and missing state before late old-owner PUTs arrive", async () => {
  const storage = new MemoryObjectStorage();
  const old = new PrimaryStateStore({ storage, epoch: () => 0 });
  const first = await old.publish("unchanged", "same value");
  const next = new PrimaryStateStore({ storage, epoch: () => 1 });
  await next.adopt("unchanged", await next.read("unchanged"));
  await next.adopt("missing", await next.read("missing"));
  await storage.put(first.key.replace(/-\d{16}-/, "-9000000000000000-"), "late previous value");
  await storage.put(first.key.replace("unchanged", "missing"), "late first publication");
  assert.equal((await next.read("unchanged")).body, "same value");
  assert.equal((await next.read("missing")).body, null);
});

test("publication paths do not reserve valid database or collection names", async () => {
  const storage = new MemoryObjectStorage(), states = new PrimaryStateStore({ storage });
  const key = "db/app.json.publications/collection/items.publications/meta.json";
  const legacy = "db/app.json.publications/collection/items.publications/shard/default/snapshots/id/segment-1.jsonl";
  const published = await states.publish(key, { indexes: [] });
  assert.deepEqual(publicationKeys([published.key, legacy]), [key, legacy]);
  assert.equal(isPublicationKey(legacy), false);
  assert.equal(isPublicationKey(published.key), true);
});

test("a stopped ownership handover fences late heads, unchanged metadata and lifecycle state", async (t) => {
  const storage = new MemoryObjectStorage();
  const old = new CRDTNode({ id: "old", url: "http://old" });
  const original = { shards: { default: { peers: [{ url: old.url }] } } };
  old.replaceShardMap(original);
  const writer = new PersistenceManager({ node: old, storage, flushMs: 0, snapshotMs: 0 });
  writer.start();
  t.after(() => { writer.unsubscribe?.(); old.db.dispose(); });
  old.createCollection("app", "items", { indexes: ["kind"], columns: ["score"] });
  old.insert("app", "items", { _id: "one", kind: "kept", score: 7 });
  await writer.checkpoint();
  await writer.states.publish(writer.lifecycle.path, { version: 1, contexts: {} });
  const head = "objydb/db/app/collection/items/shard/default/latest.json";
  const meta = "objydb/db/app/collection/items/meta.json";
  const previous = JSON.parse((await writer.states.read(head)).body);
  const late = [], put = storage.put.bind(storage);
  storage.put = async (key, body, type) => { late.push(() => put(key, body, type)); throw new Error("ambiguous timeout"); };
  await assert.rejects(writer.states.publish(head, { ...previous, objectCount: 999 }), /timeout/);
  await assert.rejects(writer.states.publish(meta, { indexes: ["wrong"] }), /timeout/);
  await assert.rejects(writer.states.publish(writer.lifecycle.path, { version: 1, contexts: {
    '["app","items"]': { database: "app", collection: "items", id: "abandoned", status: "deleting", cursors: {}, peers: [old.url], topology: writer.lifecycle._topology() },
  } }), /timeout/);
  storage.put = put;
  writer.unsubscribe();
  const map = publishShardMap(original, { shards: { default: { peers: [{ url: "http://new" }] } } });
  const restore = async (id) => {
    const node = new CRDTNode({ id, url: "http://new", shardMap: map });
    t.after(() => node.db.dispose());
    await new PersistenceManager({ node, storage }).restore();
    await node.awaitIndexes("app", "items");
    assert.equal(node.lifecycle.record("app", "items"), undefined);
    assert.deepEqual(node.getCollectionMeta("app", "items"), old.getCollectionMeta("app", "items"));
    assert.deepEqual(node.get("app", "items", "one"), { _id: "one", kind: "kept", score: 7 });
  };
  await restore("new");
  for (const upload of late) await upload();
  await restore("new-again");
});

test("bootstrap retries publish the same durably saved secrets after an ambiguous failure", async (t) => {
  let delayed;
  const storage = new MemoryObjectStorage(), put = storage.put.bind(storage);
  storage.put = async (key, body, type) => { delayed = () => put(key, body, type); throw new Error("timed out"); };
  const options = { storage, prefix: "isolated", localPath: join(await temporary(t), "secrets.json") };
  await assert.rejects(resolveSystemSecrets(options), /timed out/);
  storage.put = put;
  const second = await resolveSystemSecrets(options);
  await delayed();
  assert.deepEqual(await resolveSystemSecrets(options), second);
  await assert.rejects(resolveSystemSecrets({ storage: new MemoryObjectStorage(), primary: false, timeoutMs: 1 }), /start the cluster primary/);
});

test("concurrent local bootstrap reads only complete secret files", async (t) => {
  const directory = await temporary(t), localPath = join(directory, "secrets.json");
  const results = await Promise.all(Array.from({ length: 12 }, () => resolveSystemSecrets({ localPath })));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.deepEqual(await readdir(directory), ["secrets.json"]);
});

test("a delayed first bootstrap cannot replace secrets from a newer ownership epoch", async (t) => {
  const storage = new MemoryObjectStorage(), directory = await temporary(t);
  const original = { shards: { default: { peers: [{ url: "http://old" }] } } };
  const old = new CRDTNode({ id: "old", url: "http://old", shardMap: original });
  const next = new CRDTNode({ id: "next", url: "http://next", shardMap: publishShardMap(original, {
    shards: { default: { peers: [{ url: "http://next" }] } },
  }) });
  t.after(() => { old.db.dispose(); next.db.dispose(); });
  const put = storage.put.bind(storage);
  let delayed;
  storage.put = async (...args) => { delayed = () => put(...args); throw new Error("ambiguous first bootstrap"); };
  await assert.rejects(resolveSystemSecrets({ storage, node: old, localPath: join(directory, "old", "secrets.json") }), /ambiguous/);
  storage.put = put;
  const expected = await resolveSystemSecrets({ storage, node: next, localPath: join(directory, "next", "secrets.json") });
  await delayed();
  assert.deepEqual(await resolveSystemSecrets({ storage, primary: false }), expected);
});

async function cluster(t) {
  const storage = new MemoryObjectStorage(), nodes = [], servers = [], managers = [], maps = [];
  t.after(async () => {
    for (const manager of managers) await manager.stop();
    for (const server of servers) if (server.listening) await new Promise((resolve) => server.close(resolve));
    for (const node of nodes) node.db.dispose();
  });
  for (let i = 0; i < 3; i++) {
    const node = new CRDTNode({ id: `node-${i}` });
    const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0 });
    const map = new ShardMapStore({ storage, node });
    const server = await startServer({ port: 0, node, persistence, shardMapStore: map,
      auth: { enabled: false }, clusterSecret: "isolated-secret", forwardTimeoutMs: 250 });
    node.url = `http://127.0.0.1:${server.port}`;
    nodes.push(node); servers.push(server.server); managers.push(persistence); maps.push(map);
    persistence.start();
  }
  const shardMap = { shards: { a: { peers: nodes.slice(0, 2).map((node) => ({ url: node.url })) }, b: { peers: [{ url: nodes[2].url }] } } };
  for (const node of nodes) node.replaceShardMap(shardMapFromHttp(shardMap, node.id, { secret: "isolated-secret" }));
  await maps[0].save(shardMap);
  const request = async (index, path, method = "GET", body) => {
    const response = await fetch(`${nodes[index].url}${path}`, { method, headers: {
      "content-type": "application/json", "x-objydb-cluster-secret": "isolated-secret",
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let value;
    try { value = text ? JSON.parse(text) : null; }
    catch { assert.fail(`${method} ${path}: HTTP ${response.status}, ${text.slice(0, 200)}`); }
    return { status: response.status, body: value };
  };
  return { storage, nodes, servers, managers, maps, shardMap, request };
}

test("administration routes to one database owner; only shard primaries publish checkpoints", async (t) => {
  const f = await cluster(t);
  const db = "app", coll = "items";
  const owner = f.nodes.findIndex((node) => isPrimary(node, db));
  const receiving = (owner + 1) % f.nodes.length;
  assert.equal((await f.request(receiving, "/api/databases", "POST", { name: db, meta: { label: "shared" } })).status, 201);
  assert.equal((await f.request(receiving, `/api/${db}/collections`, "POST", { name: coll, meta: { indexes: ["kind"] } })).status, 201);
  const updated = await f.request(receiving, `/api/${db}/${coll}/meta`, "PUT", { indexes: ["score"], columns: ["value"] });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  for (const node of f.nodes) assert.deepEqual(node.getCollectionMeta(db, coll), updated.body);
  await Promise.all(f.managers.map((manager) => manager.flush()));
  const metaKeys = await f.storage.list(`objydb/db/${db}/collection/${coll}/meta.json.publications/`);
  assert.equal(metaKeys.length, 1, "replicas do not publish copies of metadata");
  const replica = f.nodes[1];
  const id = Array.from({ length: 20 }, (_, i) => `id-${i}`).find((id) => replica.shardForObject(db, coll, id) === "a");
  replica.insert(db, coll, { _id: id, kind: "replicated", score: 7 });
  f.nodes[0].applyRemote(replica.id, structuredClone(replica.log));
  assert.equal((await f.managers[1].checkpoint()).scopes, 0);
  assert.equal((await f.managers[0].checkpoint()).scopes, 1);
  assert.equal((await f.request(receiving, `/api/${db}/collections/${coll}`, "DELETE")).status, 204);
  assert.equal((await f.request(receiving, `/api/${db}/collections`, "POST", { name: coll })).status, 201);
  assert.equal((await f.request(receiving, `/api/databases/${db}`, "DELETE")).status, 204);
  for (const node of f.nodes) assert.equal(node.getCollectionMeta(db, coll), null);
});

test("concurrent peer additions retain every addition and online primary replacement is rejected", async (t) => {
  const f = await cluster(t);
  const urls = Array.from({ length: 20 }, (_, i) => `http://127.0.0.1:1/extra-${i}`);
  const results = await Promise.all(urls.map((url, i) => f.request(i % 3, "/cluster/peers", "POST", { shard: "a", url })));
  for (const result of results) assert.equal(result.status, 201, JSON.stringify(result.body));
  const stored = await f.maps[0].load();
  assert.equal(stored.shards.a.peers.length, urls.length + 2);
  for (const url of urls) assert.ok(stored.shards.a.peers.some((peer) => peer.url === url));
  const changed = structuredClone(stored);
  changed.shards.a.peers.reverse();
  const rejected = await f.request(1, "/cluster/shards", "PUT", { shardMap: changed });
  assert.equal(rejected.status, 409);
  assert.deepEqual(await f.maps[0].load(), stored);
  const offline = publishShardMap(stored, changed);
  assert.equal(offline.ownershipEpoch, (stored.ownershipEpoch || 0) + 1);
});

test("an offline administrative primary does not promote a replica or block ordinary local object writes", async (t) => {
  const f = await cluster(t);
  const db = "app", owner = f.nodes.findIndex((node) => isPrimary(node, db));
  const receiving = (owner + 1) % 3;
  assert.equal(primaryFor(f.nodes[receiving], db).url, f.nodes[owner].url);
  await new Promise((resolve) => f.servers[owner].close(resolve));
  const denied = await f.request(receiving, "/api/databases", "POST", { name: db });
  assert.equal(denied.status, 503);
  assert.equal(f.nodes[receiving].getDatabaseMeta(db), null);
  f.nodes[receiving].insert("unrelated", "objects", { _id: "still-usable" });
  assert.equal(f.nodes[receiving].count("unrelated", "objects"), 1);
});

test("membership changes and cross-owner deletion share the same administrative ordering", async (t) => {
  const f = await cluster(t), coll = "items";
  const db = ["app", "other", "cross-owner"].find((name) => isPrimary(f.nodes[2], name));
  assert.ok(db, "test requires distinct topology and database owners");
  await f.request(1, "/api/databases", "POST", { name: db });
  await f.request(1, `/api/${db}/collections`, "POST", { name: coll });
  const id = Array.from({ length: 20 }, (_, i) => String(i)).find((id) => f.nodes[0].shardForObject(db, coll, id) === "a");
  f.nodes[0].insert(db, coll, { _id: id });
  let release, reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { reached = resolve; });
  t.after(release);
  const put = f.storage.put.bind(f.storage);
  f.storage.put = async (key, ...args) => {
    if (key.includes("/snapshots/") && key.endsWith(".jsonl")) { reached(); await gate; }
    return put(key, ...args);
  };
  const checkpoint = assert.rejects(f.managers[0].checkpoint(), { code: "SNAPSHOT_CONFLICT" });
  await entered;
  const deletion = f.request(1, `/api/${db}/collections/${coll}`, "DELETE");
  for (let i = 0; !f.nodes[0].lifecycle.record(db, coll) && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(f.nodes[0].lifecycle.record(db, coll).status, "deleting");
  const addition = f.request(2, "/cluster/peers", "POST", { shard: "a", url: f.nodes[2].url });
  release();
  await checkpoint;
  assert.equal((await deletion).status, 204);
  assert.equal((await addition).status, 201);
  const stored = await f.maps[0].load();
  for (const node of f.nodes) assert.deepEqual(node.shardMapSnapshot(), stored);
  const recreated = await f.request(2, `/api/${db}/collections`, "POST", { name: coll });
  assert.equal(recreated.status, 201, JSON.stringify(recreated.body));
});

test("queued administrative requests keep their original context ticket across forwarding", async (t) => {
  const f = await cluster(t), coll = "items";
  const db = ["app", "other", "cross-owner"].find((name) => isPrimary(f.nodes[2], name));
  await f.request(1, "/api/databases", "POST", { name: db });
  await f.request(1, `/api/${db}/collections`, "POST", { name: coll });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(release);
  const lifecycle = f.nodes[2].lifecycle;
  const held = lifecycle.administer(db, () => gate);
  const update = f.request(1, `/api/${db}/${coll}/meta`, "PUT", { indexes: ["stale"] });
  for (let i = 0; lifecycle.administration.get(db) === held && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.notEqual(lifecycle.administration.get(db), held, "metadata request must be queued before deleting");
  const context = { database: db, collection: coll };
  await f.nodes[0].lifecycle.drop(context);
  for (const node of f.nodes) await node.lifecycle.create(context, null, () => node.createCollection(db, coll, { indexes: ["fresh"] }));
  release();
  assert.equal((await update).status, 409);
  for (const node of f.nodes) assert.deepEqual(node.getCollectionMeta(db, coll).indexes, ["fresh"]);
});

test("a delayed lifecycle read cannot replace newer deletion state in memory", async (t) => {
  const f = await cluster(t), db = "app", coll = "items";
  await f.request(1, "/api/databases", "POST", { name: db });
  await f.request(1, `/api/${db}/collections`, "POST", { name: coll });
  const lifecycle = f.nodes[0].lifecycle;
  const read = lifecycle.states.read.bind(lifecycle.states);
  let release, reached, block = true;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { reached = resolve; });
  t.after(release);
  lifecycle.states.read = async (...args) => {
    const value = await read(...args);
    if (block && args[0] === lifecycle.path) { block = false; reached(); await gate; }
    return value;
  };
  const loading = lifecycle.load();
  await entered;
  await lifecycle.drop({ database: db, collection: coll });
  const revision = lifecycle.stateRevision;
  release();
  await loading;
  assert.equal(lifecycle.stateRevision, revision);
  assert.equal(lifecycle.record(db, coll).status, "deleted");
  assert.throws(() => f.nodes[0].insert(db, coll, { _id: "must-stay-blocked" }), { status: 409 });
});

test("a missed completion notification does not permanently block administration on another shard", async (t) => {
  const f = await cluster(t), coll = "items";
  const db = ["app", "other", "cross-owner"].find((name) => isPrimary(f.nodes[0], name));
  await f.request(0, "/api/databases", "POST", { name: db });
  await f.request(0, `/api/${db}/collections`, "POST", { name: coll });
  const send = f.nodes[0].lifecycle.send;
  f.nodes[0].lifecycle.send = (url, body) => body.phase === "finish" && url === f.nodes[2].url
    ? Promise.reject(new Error("lost completion notification")) : send(url, body);
  assert.equal((await f.request(0, `/api/${db}/collections/${coll}`, "DELETE")).status, 204);
  assert.equal(f.nodes[2].lifecycle.record(db, coll).status, "deleting");
  const recreated = await f.request(2, `/api/${db}/collections`, "POST", { name: coll });
  assert.equal(recreated.status, 201, JSON.stringify(recreated.body));
  for (const node of f.nodes) assert.equal(node.lifecycle.record(db, coll).status, "active");
});
