import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { CRDTNode } from "../src/crdt.js";
import { PersistenceManager } from "../src/persistence.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { ShardMapStore } from "../src/shard-map-store.js";
import { JUMP_PARTITIONER, ShardMap, jumpHash, normalizeShardMap } from "../src/shard-map.js";
import { startServer, shardMapFromHttp, createObjectHookRegistry } from "../src/server.js";
import { FileService } from "../src/files.js";
import { TOPOLOGY_HEADER } from "../src/live-resharding.js";
import { Readable } from "node:stream";
import { nodeCompression } from "../src/node-runtime.js";

const SECRET = "migration-test";
const headers = { "content-type": "application/json", "x-objydb-cluster-secret": SECRET };

export async function clusterFixture(t, { shards = 2, replicas = 1, spare = 1, storage = new MemoryObjectStorage(), ack = "localWal", hooks, auth = false, timeoutMs = 1000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "objy-live-"));
  const nodes = [];
  const urls = [];
  for (let i = 0; i < shards * replicas + spare; i++) {
    const port = createServer();
    await new Promise((resolve) => port.listen(0, "127.0.0.1", resolve));
    urls.push(`http://127.0.0.1:${port.address().port}`);
    await new Promise((resolve) => port.close(resolve));
  }
  const desired = (count, copies = replicas) => ({ shards: Object.fromEntries(Array.from({ length: count }, (_, i) =>
    [`s${String(i).padStart(3, "0")}`, { peers: urls.slice(i * copies, i * copies + copies).map((url) => ({ url })) }])) });
  const initial = normalizeShardMap(desired(shards));
  for (let i = 0; i < shards * replicas + spare; i++) {
    const node = new CRDTNode({ id: `live-${i}`, retainOps: 4, syncBatchSize: 128, storage: { compression: nodeCompression } });
    const persistence = new PersistenceManager({ node, storage, prefix: "live", durable: true,
      flushMs: 0, snapshotMs: 0, opBatchSize: 1_000_000, ack, localWal: { mode: "on", dir },
      imports: { maxPendingPersistenceBytes: 128 * 1024 * 1024 } });
    const mapStore = new ShardMapStore({ storage, prefix: "live", durable: true, node });
    persistence.start();
    node.url = urls[i];
    const state = await startServer({ port: Number(new URL(urls[i]).port), node, shardMap: initial, persistence, shardMapStore: mapStore, auth, objectHooks: hooks,
      files: new FileService({ storage, prefix: "files" }), environment: { OBJYDB_ADMIN_PASSWORD: "test-password" },
      clusterSecret: SECRET, forwardTimeoutMs: timeoutMs, bootstrapLogger: null });
    node.url = `http://127.0.0.1:${state.port}`;
    nodes.push({ ...state, persistence, mapStore, url: node.url });
  }
  await nodes[0].mapStore.save(initial);
  for (const state of nodes) state.node.replaceShardMap(shardMapFromHttp(initial, state.node.id, { secret: SECRET }));
  t.after(async () => {
    await Promise.all(nodes.map((state) => state.migration.stop()));
    for (const state of nodes) {
      await state.replication.stop();
      state.server.closeAllConnections();
      await new Promise((resolve) => state.server.close(resolve));
      await state.persistence.stop().catch(() => {});
      state.node.db.dispose();
    }
    await rm(dir, { recursive: true, force: true });
  });
  const restart = async (index) => {
    const previous = nodes[index];
    await previous.migration.stop();
    await previous.replication.stop();
    previous.server.closeAllConnections();
    await new Promise((resolve) => previous.server.close(resolve));
    // Simulate process loss without a graceful persistence flush.
    previous.persistence.unsubscribe?.();
    const map = await previous.mapStore.load();
    const node = new CRDTNode({ id: previous.node.id, url: previous.url, shardMap: map, storage: { compression: nodeCompression } });
    const persistence = new PersistenceManager({ node, storage, prefix: "live", durable: true,
      flushMs: 0, snapshotMs: 0, opBatchSize: 1_000_000, ack, localWal: { mode: "on", dir } });
    await persistence.restore();
    node.replaceShardMap(shardMapFromHttp(map, node.id, { secret: SECRET }));
    persistence.start();
    const mapStore = new ShardMapStore({ storage, prefix: "live", durable: true, node });
    const state = await startServer({ port: previous.port, node, persistence, shardMapStore: mapStore,
      auth, objectHooks: hooks, files: new FileService({ storage, prefix: "files" }),
      environment: { OBJYDB_ADMIN_PASSWORD: "test-password" }, clusterSecret: SECRET, forwardTimeoutMs: timeoutMs, bootstrapLogger: null });
    previous.node.db.dispose();
    Object.assign(previous, state, { persistence, mapStore });
    return previous;
  };
  return { nodes, storage, desired, dir, restart };
}

async function request(state, method, path, body, extra = {}) {
  const response = await fetch(`${state.url}${path}`, { method, headers: { ...headers, ...extra },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function waitFor(check, message = "condition", timeout = 15_000) {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, `${message} timed out`);
    await sleep(5);
  }
}

async function resize(nodes, desired) {
  const result = await request(nodes[0], "PUT", "/cluster/shards", desired);
  assert.equal(result.status, 202, JSON.stringify(result.body));
  await nodes[0].migration.running;
  assert.equal(nodes[0].migration.lastError, null, nodes[0].migration.lastError?.stack);
  assert.equal(nodes[0].node.shardMap.migration, null);
}

async function assertRestored(nodes, storage, expected) {
  for (const state of nodes) {
    const map = await state.mapStore.load();
    const node = new CRDTNode({ id: state.node.id, url: state.url, shardMap: map, storage: { compression: nodeCompression } });
    const persistence = new PersistenceManager({ node, storage, prefix: "live" });
    await persistence.restore();
    for (const [id, value] of expected) {
      const owns = node.ownsShard(node.shardForObject("test", "items", id));
      assert.deepEqual(node.get("test", "items", id), owns ? value : undefined, `${node.id}/${id}`);
    }
    node.db.dispose();
  }
}

test("jump routing matches the published algorithm and moves only the appended/tail bucket", () => {
  const reference = (seed, buckets) => {
    let key = BigInt(seed), previous = -1, next = 0;
    while (next < buckets) {
      previous = next;
      key = BigInt.asUintN(64, key * 2862933555777941757n + 1n);
      next = Math.floor((previous + 1) * 2147483648 / (Number(key >> 33n) + 1));
    }
    return previous;
  };
  for (const buckets of [1, 2, 3, 10, 100]) for (let seed = 0; seed < 2000; seed++) {
    assert.equal(jumpHash(seed, buckets), reference(seed, buckets));
    const grown = jumpHash(seed, buckets + 1);
    assert.ok(grown === buckets || grown === jumpHash(seed, buckets));
  }
  const map = new ShardMap({ topology: { partitioner: JUMP_PARTITIONER }, shards: { a: {}, b: {}, c: {} } });
  assert.equal(map.shardForObject("x", "a", "ä/😀"), map.shardForObject("y", "b", "ä/😀"));
});

test("online grow and shrink preserve complete objects, ownership, indexes and durable restore", async (t) => {
  const { nodes, storage, desired } = await clusterFixture(t);
  const meta = { indexes: ["kind"], columns: ["score"], tiering: { keep: ["kind", "score"] } };
  for (const state of nodes) state.node.setCollectionMeta("test", "items", meta);
  const objects = Array.from({ length: 1500 }, (_, i) => ({ _id: `id-${i}`, kind: `g${i % 5}`, score: i,
    payload: "heavy-".repeat(60), nested: { array: [1, "x", null, { dynamic: true }] } }));
  const result = await request(nodes[0], "POST", "/api/test/items/object", objects, { prefer: "return=minimal" });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const expected = new Map(objects.map((value) => [value._id, value]));
  await resize(nodes, desired(3));
  assert.equal(nodes[0].node.shardMap.topology.partitioner, JUMP_PARTITIONER);
  for (const state of nodes) {
    for (const object of objects) {
      const owns = state.node.ownsShard(state.node.shardForObject("test", "items", object._id));
      assert.deepEqual(state.node.get("test", "items", object._id), owns ? object : undefined);
    }
  }
  const sum = await request(nodes[1], "POST", "/api/test/items/search", {
    $aggregate: { groupBy: "kind", fields: { total: { $sum: "score" }, count: { $count: true } } }, $refDepth: 0,
  });
  assert.equal(sum.status, 200, JSON.stringify(sum.body));
  assert.equal(sum.body.reduce((total, group) => total + group.count, 0), objects.length);
  assert.equal(sum.body.reduce((total, group) => total + group.total, 0), 1499 * 1500 / 2);
  await assertRestored(nodes, storage, expected);
  await resize(nodes, desired(2));
  await assertRestored(nodes, storage, expected);
  assert.equal(nodes[2].node.count("test", "items"), 0);
});

test("copy keeps the source view authoritative and captures writes and deletes from every replica", async (t) => {
  const { nodes, storage, desired } = await clusterFixture(t, { shards: 1, replicas: 2, spare: 2 });
  const originals = Array.from({ length: 600 }, (_, i) => ({ _id: `item-${i}`, value: i, password: `ordinary-field-${i}` }));
  for (const state of nodes.slice(0, 2)) state.node.insertManyCount("test", "items", originals);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const donor = nodes[0].migration;
  const distribute = donor._distribute.bind(donor);
  let entered = false;
  donor._distribute = async (...args) => {
    if (args[2] === "base") { entered = true; await blocked; }
    return distribute(...args);
  };
  const begun = await request(nodes[1], "PUT", "/cluster/shards", desired(2));
  assert.equal(begun.status, 202, JSON.stringify(begun.body));
  await waitFor(() => entered, "copy");
  const expected = new Map(originals.map((object) => [object._id, object]));
  for (let i = 0; i < 80; i++) {
    const writer = nodes[i % 2].node;
    writer.replaceManyCount("test", "items", [{ _id: `item-${i}`, value: i + 5000, password: `unchanged-format-${i}` }]);
    expected.set(`item-${i}`, { _id: `item-${i}`, value: i + 5000, password: `unchanged-format-${i}` });
  }
  for (let i = 80; i < 110; i++) { nodes[1].node.removeMany("test", "items", [`item-${i}`]); expected.set(`item-${i}`, undefined); }
  assert.equal(nodes[0].node.count("test", "items"), 600);
  const denied = await request(nodes[0], "PUT", "/api/test/items/meta", { indexes: ["value"] });
  assert.equal(denied.status, 503);
  release();
  await donor.running;
  assert.equal(donor.lastError, null, donor.lastError?.stack);
  for (const state of nodes) for (const [id, value] of expected) {
    const owns = state.node.ownsShard(state.node.shardForObject("test", "items", id));
    assert.deepEqual(state.node.get("test", "items", id), owns ? value : undefined, `${state.node.id}/${id}`);
  }
  await assertRestored(nodes, storage, expected);
});

test("old topology traffic and unauthorized migration commands cannot write after handover", async (t) => {
  const { nodes, desired } = await clusterFixture(t);
  const old = nodes[0].node.shardMap.topology.id;
  const denied = await fetch(`${nodes[0].url}/cluster/migration`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(denied.status, 401);
  await resize(nodes, desired(3));
  const stale = await request(nodes[0], "POST", "/api/test/items/object", { _id: "stale", value: 1 }, {
    "x-objydb-forwarded": "1", [TOPOLOGY_HEADER]: old,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.operationStarted, false);
  assert.equal(nodes[0].node.get("test", "items", "stale"), undefined);
});

for (const failure of ["transfer", "checkpoint", "commit-before", "commit-after"]) {
  test(`migration retries safely after ${failure} failure`, async (t) => {
    const { nodes, storage, desired } = await clusterFixture(t);
    const objects = Array.from({ length: 700 }, (_, i) => ({ _id: `retry-${i}`, value: i }));
    await request(nodes[0], "POST", "/api/test/items/object", objects, { prefer: "return=minimal" });
    let failed = false;
    const put = storage.put.bind(storage);
    const send = nodes[0].migration._fetch.bind(nodes[0].migration);
    if (failure === "transfer") nodes[0].migration._fetch = async (url, path, ...rest) => {
      if (!failed && path.includes("mode=base")) { failed = true; throw new Error("injected transfer failure"); }
      return send(url, path, ...rest);
    };
    else storage.put = async (key, body, type) => {
      const commit = key.includes("cluster/shard-map.json.publications/") && JSON.parse(body)?.shardMap?.migration?.phase === "committed";
      const match = failure === "checkpoint" ? key.includes("/snapshots/live-") : commit;
      if (!failed && match) {
        failed = true;
        if (failure === "commit-after") await put(key, body, type);
        throw new Error(`injected ${failure}`);
      }
      return put(key, body, type);
    };
    const old = nodes[0].node.shardMap.topology.id;
    await request(nodes[0], "PUT", "/cluster/shards", desired(3));
    await nodes[0].migration.running;
    assert.ok(failed, "fault was exercised");
    if (failure === "commit-after") {
      assert.equal(nodes[0].migration.lastError, null, nodes[0].migration.lastError?.stack);
    } else {
      assert.ok(nodes[0].migration.lastError);
      assert.equal(nodes[0].node.shardMap.topology.id, old);
      if (failure !== "commit-before") {
        const available = await request(nodes[0], "POST", "/api/test/items/search", { $aggregate: { fields: { count: { $count: true } } } });
        assert.equal(available.status, 200);
        assert.equal(available.body[0].count, objects.length);
      } else {
        const blocked = await request(nodes[0], "POST", "/api/test/items/object", { _id: "too-late" });
        assert.equal(blocked.status, 503);
      }
      await resize(nodes, desired(3));
    }
    await assertRestored(nodes, storage, new Map(objects.map((object) => [object._id, object])));
  });
}

test("a destination crash after sealing reloads its durable target before serving", async (t) => {
  const { nodes, storage, desired, restart } = await clusterFixture(t);
  const objects = Array.from({ length: 500 }, (_, i) => ({ _id: `crash-${i}`, value: i }));
  await request(nodes[0], "POST", "/api/test/items/object", objects, { prefer: "return=minimal" });
  const publish = nodes[0].migration._publish.bind(nodes[0].migration);
  let crashed = false;
  nodes[0].migration._publish = async (state) => {
    if (!crashed && state.phase === "committed") { crashed = true; await restart(2); }
    return publish(state);
  };
  await resize(nodes, desired(3));
  assert.ok(crashed);
  for (const object of objects) {
    const owner = nodes.find((state) => state.node.ownsShard(state.node.shardForObject("test", "items", object._id)));
    assert.deepEqual(owner.node.get("test", "items", object._id), object);
  }
  await assertRestored(nodes, storage, new Map(objects.map((object) => [object._id, object])));
});

test("the coordinator resumes a committed migration after process loss", async (t) => {
  const { nodes, desired, restart } = await clusterFixture(t);
  await request(nodes[0], "POST", "/api/test/items/object", [{ _id: "durable", value: 42 }], { prefer: "return=minimal" });
  const all = nodes[0].migration._all.bind(nodes[0].migration);
  nodes[0].migration._all = (peers, phase, ...rest) => {
    if (phase === "activate") throw new Error("injected coordinator crash after commit");
    return all(peers, phase, ...rest);
  };
  await request(nodes[0], "PUT", "/cluster/shards", desired(3));
  await nodes[0].migration.running;
  assert.equal((await nodes[0].mapStore.load()).migration.phase, "committed");
  await restart(0);
  await nodes[0].migration.running;
  assert.equal(nodes[0].migration.lastError, null, nodes[0].migration.lastError?.stack);
  assert.equal((await nodes[0].mapStore.load()).migration, undefined);
  const row = await request(nodes[1], "GET", "/api/test/items/object/durable");
  assert.equal(row.status, 200, JSON.stringify(row.body));
  assert.deepEqual(row.body, { _id: "durable", value: 42 });
});

test("retrying the desired map reconciles a lost final notification after commit", async (t) => {
  const { nodes, desired } = await clusterFixture(t);
  await request(nodes[0], "POST", "/api/test/items/object", { _id: "committed", value: 42 });
  const send = nodes[0].migration._fetch.bind(nodes[0].migration);
  let failed = false;
  nodes[0].migration._fetch = async (url, path, body, ...rest) => {
    if (!failed && url === nodes[1].url && body?.phase === "finished") {
      failed = true;
      throw new Error("injected lost completion notification");
    }
    return send(url, path, body, ...rest);
  };
  await request(nodes[0], "PUT", "/cluster/shards", desired(3));
  await nodes[0].migration.running;
  assert.ok(failed);
  assert.equal((await nodes[0].mapStore.load()).migration, undefined);
  assert.equal(nodes[1].node.shardMap.migration.phase, "committed");
  const retried = await request(nodes[0], "PUT", "/cluster/shards", desired(3));
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  for (const state of nodes) assert.equal(state.node.shardMap.migration, null);
  const changed = await request(nodes[1], "PUT", "/api/test/items/meta", { indexes: ["value"] });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
});

test("restarted destinations before commit force a safe recopy instead of a false ready acknowledgement", async (t) => {
  const { nodes, desired, restart } = await clusterFixture(t);
  await request(nodes[0], "POST", "/api/test/items/object", [{ _id: "recovered", value: 7 }], { prefer: "return=minimal" });
  const all = nodes[0].migration._all.bind(nodes[0].migration);
  let crashed = false;
  nodes[0].migration._all = async (peers, phase, ...rest) => {
    if (phase === "checkpoint" && !crashed) { crashed = true; await restart(2); }
    return all(peers, phase, ...rest);
  };
  await request(nodes[0], "PUT", "/cluster/shards", desired(3));
  await nodes[0].migration.running;
  assert.match(nodes[0].migration.lastError.message, /restarted/);
  assert.equal((await nodes[0].mapStore.load()).migration.phase, "copying");
  await resize(nodes, desired(3));
  const row = await request(nodes[2], "GET", "/api/test/items/object/recovered");
  assert.equal(row.status, 200);
  assert.equal(row.body.value, 7);
});

test("a newly assigned replica can bootstrap a migrated shard with no original local writes", async (t) => {
  const { nodes, desired } = await clusterFixture(t, { spare: 2 });
  const objects = Array.from({ length: 300 }, (_, i) => ({ _id: `bootstrap-${i}`, value: i }));
  await request(nodes[0], "POST", "/api/test/items/object", objects, { prefer: "return=minimal" });
  await resize(nodes, desired(3));
  const map = nodes[0].node.shardMapSnapshot();
  // A new process loads the current S3 map before registering as a replica.
  nodes[3].node.replaceShardMap(shardMapFromHttp(map, nodes[3].node.id, { secret: SECRET }));
  const shard = Object.keys(map.shards).at(-1);
  const added = await request(nodes[0], "POST", "/cluster/peers", { shard, url: nodes[3].url });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  await nodes[3].node.syncAll();
  assert.deepEqual(nodes[3].node.find("test", "items", {}, { sortBy: "_id" }), nodes[2].node.find("test", "items", {}, { sortBy: "_id" }));
});

test("WAL-only restored writers expose a durable catch-up floor instead of silently skipping replica data", async (t) => {
  const { nodes, restart } = await clusterFixture(t, { shards: 1, replicas: 2, spare: 0 });
  nodes[0].node.insertManyCount("test", "items", [{ _id: "wal-only", value: 99 }]);
  await nodes[0].persistence.afterWrite();
  await restart(0);
  assert.equal(nodes[0].node.log.length, 0);
  await nodes[1].node.syncAll();
  assert.deepEqual(nodes[1].node.get("test", "items", "wal-only"), { _id: "wal-only", value: 99 });
  nodes[0].node.update("test", "items", "wal-only", { value: 100 });
  await nodes[0].persistence.afterWrite();
  await nodes[1].node.syncAll();
  assert.equal(nodes[1].node.get("test", "items", "wal-only").value, 100);
});

test("migration preserves hooks, references, virtual structure, vectors, files and public NDJSON CRUD", async (t) => {
  let calls = 0;
  const hooks = createObjectHookRegistry().register("audit", { operations: ["create", "update", "delete"],
    handler: async (_context, next) => { calls++; return next(); } });
  const { nodes, storage, desired } = await clusterFixture(t, { hooks });
  for (const state of nodes.slice(0, 2)) {
    state.node.createCollection("test", "owners");
    state.node.setCollectionMeta("test", "items", { indexes: ["kind"], columns: ["score"],
      hooks: { use: ["audit"] }, structure: [{ condition: {}, apply: { virtual: "not-stored" } }],
      tiering: { mode: "compressedMemory", keep: ["kind", "score"], minBytes: 1 } });
  }
  await request(nodes[0], "POST", "/api/test/owners/object", { _id: "owner", region: "west" });
  const rows = Array.from({ length: 150 }, (_, i) => ({ _id: `feature-${i}`, kind: i % 3, score: i,
    text: "compress-this-".repeat(100), _vec: i === 0 ? [1, 0, 0] : [0, 1, i / 150],
    owner: { type: "reference", collection: "owners", value: "owner" } }));
  const inserted = await request(nodes[0], "POST", "/api/test/items/object", rows.map((row) => JSON.stringify(row)).join("\n"), {
    "content-type": "application/x-ndjson", prefer: "return=minimal",
  });
  assert.equal(inserted.status, 201);
  const before = calls;
  const bytes = new Uint8Array([0, 1, 2, 255, 42]);
  const form = new FormData();
  form.set("object", JSON.stringify({ _id: "attachment", kind: 2, score: 999 }));
  form.set("file", new Blob([bytes], { type: "application/octet-stream" }), "sample.bin");
  const uploaded = await fetch(`${nodes[0].url}/api/test/items/object`, { method: "POST", body: form });
  assert.equal(uploaded.status, 201);
  const blobKeys = await storage.list("files/");
  assert.equal(blobKeys.length, 1);
  const expectedCalls = calls;
  await resize(nodes, desired(3));
  assert.equal(calls, expectedCalls, "migration must not invoke public hooks");
  const query = await request(nodes[2], "POST", "/api/test/items/search", { "owner.object.region": "west", $refDepth: 1, $pageSize: 250 });
  assert.equal(query.status, 200);
  assert.equal(query.body.length, rows.length);
  assert.equal(query.body[0].virtual, "not-stored");
  assert.equal(query.body[0].owner.object.region, "west");
  for (const state of nodes) {
    await state.node.awaitIndexes("test", "items");
    await state.node.awaitVectorIndexes();
    for (const row of state.node.db.collectionSnapshotObjects("test", "items")) {
      assert.equal(row.value?.virtual, undefined);
      assert.equal(row.value?.owner?.object, undefined);
    }
  }
  const vector = await request(nodes[1], "POST", "/api/test/items/search", { $vector: { vector: [1, 0, 0], limit: 1 }, $refDepth: 0 });
  assert.equal(vector.status, 200, JSON.stringify(vector.body));
  assert.equal(vector.body[0]._id, "feature-0");
  const download = await fetch(`${nodes[2].url}/api/test/items/object/attachment/blob`);
  assert.equal(download.status, 200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
  assert.deepEqual(await storage.list("files/"), blobKeys, "blob keys do not move with shards");
  const created = await request(nodes[2], "POST", "/api/test/items/object", { _id: "hook-after", score: 7 });
  assert.equal(created.status, 201);
  assert.equal(calls, expectedCalls + 1, "new owner must install collection hooks");
  assert.ok(before > 0);
  const patched = await request(nodes[2], "PATCH", "/api/test/items/object", JSON.stringify({ _id: "hook-after", $set: { score: 8 } }) + "\n", {
    "content-type": "application/x-ndjson", prefer: "return=minimal",
  });
  assert.equal(patched.status, 200);
  const removed = await request(nodes[2], "DELETE", "/api/test/items/object", JSON.stringify("hook-after") + "\n", {
    "content-type": "application/x-ndjson", prefer: "return=minimal",
  });
  assert.equal(removed.status, 200);
});

test("login, existing JWTs, renewal and permissions survive live ownership changes", async (t) => {
  const { nodes, desired } = await clusterFixture(t, { auth: { jwtSecret: "auth-migration" } });
  const login = await request(nodes[0], "POST", "/api/_global/users/auth", { username: "admin", password: "test-password" });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const token = { authorization: `Bearer ${login.body.accessToken}` };
  const inserted = await request(nodes[0], "POST", "/api/test/items/object", { _id: "secured", value: 1 }, token);
  assert.equal(inserted.status, 201);
  const oldHashes = nodes.flatMap((state) => state.node.find("_global", "users", {})).map((user) => user.password);
  await resize(nodes, desired(3));
  const read = await request(nodes[2], "GET", "/api/test/items/object/secured", undefined, token);
  assert.equal(read.status, 200);
  assert.equal(read.body.value, 1);
  const again = await request(nodes[2], "POST", "/api/_global/users/auth", { username: "admin", password: "test-password" });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const renewed = await request(nodes[1], "POST", "/api/_global/users/renew", { refreshToken: login.body.refreshToken });
  assert.equal(renewed.status, 200);
  const hash = nodes.flatMap((state) => state.node.find("_global", "users", {})).find((user) => user.username === "admin").password;
  assert.ok(oldHashes.includes(hash), "stored credentials are transferred, not rehashed");
  const forbidden = await request(nodes[2], "POST", "/api/_global/users/object", { _id: "forbidden", admin: true }, token);
  assert.equal(forbidden.status, 403);
});

test("appending to the returned map preserves bucket order, and removing a middle bucket is rejected", async (t) => {
  const { nodes, desired } = await clusterFixture(t, { spare: 2 });
  await request(nodes[0], "POST", "/api/test/items/object", Array.from({ length: 400 }, (_, i) => ({ _id: `append-${i}`, value: i })), { prefer: "return=minimal" });
  await resize(nodes, desired(3));
  const before = nodes[0].node.shardMapSnapshot();
  const appended = structuredClone(before);
  appended.shards["aaa-new-shard"] = { peers: [{ url: nodes[3].url }] };
  await resize(nodes, appended);
  const after = nodes[0].node.shardMapSnapshot();
  const configs = Object.values(after.shards);
  assert.equal(configs[0].peers[0].url, nodes[0].url);
  assert.equal(configs[3].peers[0].url, nodes[3].url);
  const invalid = structuredClone(after);
  delete invalid.shards[Object.keys(invalid.shards)[1]];
  const rejected = await request(nodes[0], "PUT", "/cluster/shards", invalid);
  assert.equal(rejected.status, 409);
  assert.match(rejected.body.error, /from the end/);
  assert.equal(nodes[0].node.shardMap.migration, null);
  const count = await request(nodes[3], "POST", "/api/test/items/search", { $aggregate: { fields: { count: { $count: true } } } });
  assert.equal(count.body[0].count, 400);
});

test("long-running NDJSON imports admit batches independently across a handover", async (t) => {
  const { nodes, desired } = await clusterFixture(t, { timeoutMs: 10_000 });
  for (const state of nodes.slice(0, 2)) state.node.createCollection("test", "items");
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const body = Readable.from((async function* () {
    for (let i = 0; i < 10_000; i++) yield JSON.stringify({ _id: `stream-${i}`, score: i }) + "\n";
    await held;
    yield JSON.stringify({ _id: "after-handover", score: 1 }) + "\n";
  })());
  const response = fetch(`${nodes[0].url}/api/test/items/object`, { method: "POST", headers: {
    ...headers, "content-type": "application/x-ndjson", prefer: "return=minimal" }, body, duplex: "half" });
  await waitFor(() => nodes[0].node.count("test", "items") + nodes[1].node.count("test", "items") === 10_000);
  await resize(nodes, desired(3));
  release();
  const result = await response;
  const payload = await result.json();
  assert.equal(result.status, 201, JSON.stringify(payload));
  assert.equal(payload.inserted, 10_001);
});

test("handover drain has a bounded timeout and resumes safely after an outstanding request ends", async (t) => {
  const { nodes, desired } = await clusterFixture(t);
  let release;
  const pending = { promise: new Promise((resolve) => { release = resolve; }) };
  nodes[0].migration.requests.add(pending);
  nodes[0].migration.timeoutMs = 10;
  t.after(() => release());
  await request(nodes[0], "PUT", "/cluster/shards", desired(3));
  await nodes[0].migration.running;
  assert.match(nodes[0].migration.lastError.message, /drain timed out/);
  assert.equal((await nodes[0].mapStore.load()).migration.phase, "sealing");
  nodes[0].migration.requests.delete(pending);
  release();
  nodes[0].migration.timeoutMs = 1000;
  await resize(nodes, desired(3));
});

test("source catalogs, not stale learner caches, define migrated contexts and versions", async (t) => {
  const { nodes, desired } = await clusterFixture(t);
  nodes[2].node.clock.c = 10_000;
  nodes[2].node.insert("test", "items", { _id: "recreated", value: "stale-cache" });
  nodes[2].node.insert("stale-database", "removed", { _id: "old", value: true });
  await request(nodes[0], "POST", "/api/test/items/object", { _id: "recreated", value: "authoritative" });
  await resize(nodes, desired(3));
  for (const state of nodes) {
    assert.ok(!state.node.listDatabases().includes("stale-database"));
    const value = await request(state, "GET", "/api/test/items/object/recreated");
    assert.equal(value.status, 200);
    assert.equal(value.body.value, "authoritative");
  }
});

test("automatic checkpoints stay deferred until local placement cleanup finishes", async (t) => {
  const { nodes, storage, desired } = await clusterFixture(t);
  await request(nodes[0], "POST", "/api/test/items/object", [{ _id: "kept", value: 1 }]);
  const all = nodes[0].migration._all.bind(nodes[0].migration);
  let checked = false;
  nodes[0].migration._all = async (peers, phase, ...rest) => {
    if (phase === "cleanup") {
      checked = true;
      for (const state of nodes) assert.deepEqual(await state.persistence.checkpoint({ automatic: true }), { skipped: "live migration" });
    }
    return all(peers, phase, ...rest);
  };
  await resize(nodes, desired(3));
  assert.ok(checked);
  for (const state of nodes) assert.ok(!(await state.persistence.checkpoint()).skipped);
  await assertRestored(nodes, storage, new Map([["kept", { _id: "kept", value: 1 }]]));
});

test("a lost ingest acknowledgement is replayed without duplicate index or column contributions", async (t) => {
  const { nodes, storage, desired } = await clusterFixture(t);
  for (const state of nodes) state.node.setCollectionMeta("test", "items", {
    indexes: ["kind", "tags"], columns: ["score"], tiering: { keep: ["kind", "tags", "score"] },
  });
  const objects = Array.from({ length: 3000 }, (_, i) => ({ _id: `lost-ack-${i}`, kind: i % 7,
    tags: [`t${i % 3}`, "shared"], score: i, payload: "cold-data-".repeat(100) }));
  await request(nodes[0], "POST", "/api/test/items/object", objects, { prefer: "return=minimal" });
  const receive = nodes[2].migration.receive.bind(nodes[2].migration);
  let failed = false;
  nodes[2].migration.receive = async (...args) => {
    const result = await receive(...args);
    if (args[1] === "base" && !failed) { failed = true; throw Object.assign(new Error("ingest applied but reply lost"), { status: 503 }); }
    return result;
  };
  await request(nodes[0], "PUT", "/cluster/shards", desired(3));
  await nodes[0].migration.running;
  assert.ok(failed);
  assert.match(nodes[0].migration.lastError.message, /reply lost/);
  await resize(nodes, desired(3));
  for (const state of nodes) {
    const response = await request(state, "POST", "/api/test/items/search", { tags: { $contains: "shared" },
      $aggregate: { groupBy: "kind", fields: { total: { $sum: "score" }, count: { $count: true } } } });
    assert.equal(response.status, 200);
    for (const row of response.body) {
      const group = objects.filter((object) => object.kind === row.kind);
      assert.equal(row.count, group.length);
      assert.equal(row.total, group.reduce((sum, object) => sum + object.score, 0));
    }
  }
  await assertRestored(nodes, storage, new Map(objects.map((object) => [object._id, object])));
});

for (const victim of [0, 1]) {
  test(`process ${victim} can restart after copy and recover with replica-origin writes and tombstones`, async (t) => {
    const { nodes, storage, desired, restart } = await clusterFixture(t, { shards: 1, replicas: 2, spare: 2 });
    for (const state of nodes) state.node.setCollectionMeta("test", "items", { indexes: ["group"], columns: ["score"] });
    const objects = Array.from({ length: 600 }, (_, i) => ({ _id: `restart-copy-${i}`, group: i % 4, score: i }));
    await request(nodes[1], "POST", "/api/test/items/object", objects, { prefer: "return=minimal" });
    const expected = new Map(objects.map((object) => [object._id, object]));
    let failed = false;
    const all = nodes[0].migration._all.bind(nodes[0].migration);
    nodes[0].migration._all = async (peers, phase, ...args) => {
      if (!failed && phase === "checkpoint") {
        failed = true;
        const changed = objects.slice(0, 100).map((row) => ({ ...row, score: row.score + 10_000, group: 9 }));
        const updated = await request(nodes[1], "PUT", "/api/test/items/object", changed, { prefer: "return=minimal" });
        assert.equal(updated.status, 200);
        for (const row of changed) expected.set(row._id, row);
        const ids = objects.slice(100, 130).map((row) => row._id);
        assert.equal((await request(nodes[1], "DELETE", "/api/test/items/object", ids)).status, 200);
        for (const id of ids) expected.set(id, undefined);
        if (victim === 0) throw new Error("coordinator process lost after copy");
        await restart(1);
      }
      return all(peers, phase, ...args);
    };
    await request(nodes[0], "PUT", "/cluster/shards", desired(2));
    await nodes[0].migration.running;
    assert.ok(failed);
    assert.ok(nodes[0].migration.lastError);
    if (victim === 0) { await restart(0); await nodes[0].migration.running; }
    else await resize(nodes, desired(2));
    assert.equal(nodes[0].migration.lastError, null, nodes[0].migration.lastError?.stack);
    await assertRestored(nodes, storage, expected);
    for (const state of nodes) {
      const result = await request(state, "POST", "/api/test/items/search", { $aggregate: { groupBy: "group",
        fields: { total: { $sum: "score" }, count: { $count: true } } } });
      assert.equal(result.status, 200);
      assert.equal(result.body.reduce((sum, row) => sum + row.count, 0), 570);
      assert.equal(result.body.find((row) => row.group === 9).total, 1_004_950);
    }
  });
}

test("concurrent topology submissions coalesce the same job and reject a competing map", async (t) => {
  const { nodes, desired } = await clusterFixture(t);
  await request(nodes[0], "POST", "/api/test/items/object", { _id: "one-job", score: 12 });
  let release, entered = false;
  const held = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const distribute = nodes[0].migration._distribute.bind(nodes[0].migration);
  nodes[0].migration._distribute = async (...args) => { if (args[2] === "base") { entered = true; await held; } return distribute(...args); };
  assert.equal((await request(nodes[0], "PUT", "/cluster/shards", desired(3))).status, 202);
  await waitFor(() => entered);
  const id = nodes[0].node.shardMap.migration.id;
  const same = await Promise.all(nodes.map((state) => request(state, "PUT", "/cluster/shards", desired(3))));
  for (const response of same) { assert.equal(response.status, 202); assert.equal(response.body.migration.id, id); }
  const conflict = await request(nodes[1], "PUT", "/cluster/shards", desired(2));
  assert.equal(conflict.status, 409);
  assert.equal(nodes[0].node.shardMap.migration.id, id);
  release();
  await nodes[0].migration.running;
  assert.equal(nodes[0].migration.lastError, null);
  const result = await request(nodes[2], "GET", "/api/test/items/object/one-job");
  assert.deepEqual(result.body, { _id: "one-job", score: 12 });
});

test("mixed column types and compressed indexed fields stay exact across repeated live changes", async (t) => {
  const { nodes, storage, desired } = await clusterFixture(t);
  const values = [0, -2, 3.5, null, "5", true, { nested: [1, "two"] }, [1, 2]];
  for (const state of nodes) state.node.setCollectionMeta("test", "items", {
    indexes: ["kind", "name", "tags"], columns: ["metric", "active"],
    tiering: { mode: "compressedMemory", keep: ["kind", "metric", "active"], minBytes: 1 },
  });
  const objects = Array.from({ length: 1200 }, (_, i) => ({ _id: `types-${i}`, kind: i % 3,
    metric: values[i % values.length], active: i % 2 === 0, name: `repeated-${i % 5}`,
    tags: [`tag${i % 7}`, "shared"], payload: { optional: i, keep: "compress-".repeat(70) } }));
  const expected = new Map(objects.map((row) => [row._id, row]));
  await request(nodes[0], "POST", "/api/test/items/object", objects, { prefer: "return=minimal" });
  const check = async () => {
    for (const state of nodes) {
      const result = await request(state, "POST", "/api/test/items/search", { tags: { $contains: "shared" },
        $aggregate: { groupBy: "kind", fields: { total: { $sum: "metric" }, average: { $avg: "metric" }, count: { $count: true } } } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.length, 3);
      for (const row of result.body) {
        const group = [...expected.values()].filter((value) => value && value.kind === row.kind);
        const numbers = group.map((value) => value.metric).filter((value) => typeof value === "number");
        const total = numbers.reduce((sum, value) => sum + value, 0);
        assert.equal(row.count, group.length);
        assert.equal(row.total, total);
        assert.equal(row.average, numbers.length ? total / numbers.length : null);
      }
    }
  };
  await resize(nodes, desired(3));
  await check();
  const patches = objects.slice(0, 400).map((row, i) => ({ _id: row._id,
    $set: { metric: values[(i + 3) % values.length] }, $unset: ["payload.optional"] }));
  assert.equal((await request(nodes[0], "PATCH", "/api/test/items/object", patches, { prefer: "return=minimal" })).status, 200);
  for (let i = 0; i < patches.length; i++) {
    const old = expected.get(patches[i]._id);
    expected.set(old._id, { ...old, metric: patches[i].$set.metric, payload: { keep: old.payload.keep } });
  }
  const removed = objects.slice(600, 640).map((row) => row._id);
  assert.equal((await request(nodes[0], "DELETE", "/api/test/items/object", removed)).status, 200);
  for (const id of removed) expected.set(id, undefined);
  await resize(nodes, desired(2));
  await check();
  for (const state of nodes) await state.node.awaitIndexes("test", "items");
  await check();
  await assertRestored(nodes, storage, expected);
});
