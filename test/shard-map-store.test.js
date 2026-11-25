import { test } from "node:test";
import assert from "node:assert/strict";
import { CRDTNode } from "../src/crdt.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { ShardMapStore } from "../src/shard-map-store.js";
import { normalizeShardMap, planLiveShardMap, publishShardMap, SHARD_MAP_VERSION, TOPOLOGY_ACTIVE, TOPOLOGY_RESHARDING } from "../src/shard-map.js";
import { readPublished } from "./helpers/primary-state.js";

test("shard map store saves and loads map JSON from object storage", async () => {
  const storage = new MemoryObjectStorage();
  const store = new ShardMapStore({ storage, prefix: "objydb", key: "cluster/shard-map.json" });
  const shardMap = {
    shards: {
      "shard-0": { peers: [{ url: "http://localhost:8080" }] },
      "shard-1": { peers: [{ url: "http://localhost:8081" }] },
    },
  };

  const saved = await store.save(shardMap);

  assert.ok(await readPublished(storage, "objydb/cluster/shard-map.json"));
  const loaded = await store.load();
  assert.deepEqual(loaded, saved.shardMap);
  assert.equal(loaded.version, SHARD_MAP_VERSION);
  assert.equal(loaded.topology.state, TOPOLOGY_ACTIVE);
  assert.deepEqual(Object.keys(loaded.shards), ["shard-0", "shard-1"]);
});

const bootstrapMap = { shards: { a: { peers: [{ url: "http://primary" }, { url: "http://replica" }] } } };

test("concurrent initialization reuses one publication and never replaces the stored map", async () => {
  const storage = new MemoryObjectStorage();
  const store = new ShardMapStore({ storage });
  const results = await Promise.all(Array.from({ length: 20 }, () => store.initialize(bootstrapMap)));
  for (const result of results) assert.deepEqual(result, normalizeShardMap(bootstrapMap));
  assert.equal((await storage.list()).length, 1);
  assert.deepEqual(await store.initialize({ invalid: true }), results[0]);
  assert.equal((await storage.list()).length, 1);
});

test("initialization rechecks storage inside the publication queue", async () => {
  const storage = new MemoryObjectStorage();
  const store = new ShardMapStore({ storage });
  assert.equal(await store.load(), null);
  let release;
  store.pending = new Promise((resolve) => { release = resolve; });
  const initializing = store.initialize(bootstrapMap);
  const existing = (await new ShardMapStore({ storage }).save({ shards: {
    other: { peers: [{ url: "http://already-published" }] },
  } })).shardMap;
  release();
  assert.deepEqual(await initializing, existing);
  assert.equal((await storage.list()).length, 1);
});

test("only the configured coordinator can initialize a missing map", async (t) => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "replica", url: "http://replica", shardMap: bootstrapMap });
  t.after(() => node.db.dispose());
  await assert.rejects(new ShardMapStore({ storage, node }).initialize(bootstrapMap), { code: "PRIMARY_REQUIRED" });
  assert.deepEqual(await storage.list(), []);
  node.url = "http://primary";
  const store = new ShardMapStore({ storage, node });
  assert.deepEqual(await store.initialize(bootstrapMap), normalizeShardMap(bootstrapMap));
});

for (const [label, map] of [
  ["empty", { shards: {} }],
  ["missing peers", { shards: { a: { peers: [] } } }],
  ["unaddressable", { shards: { a: { peers: [{ nodeId: "primary" }] } } }],
  ["offline reshard", publishShardMap(bootstrapMap, { shards: {
    a: { peers: [{ url: "http://primary" }] }, b: { peers: [{ url: "http://replica" }] },
  } })],
]) {
  test(`initialization rejects bootstrap map (${label}) without publishing`, async () => {
    const storage = new MemoryObjectStorage();
    await assert.rejects(new ShardMapStore({ storage }).initialize(map), /initial shard map/);
    assert.deepEqual(await storage.list(), []);
  });
}

test("initialization leaves an existing pending migration untouched", async () => {
  const storage = new MemoryObjectStorage();
  const store = new ShardMapStore({ storage });
  const source = normalizeShardMap(bootstrapMap);
  const target = planLiveShardMap(source, { shards: {
    a: { peers: [{ url: "http://primary" }] }, b: { peers: [{ url: "http://replica" }] },
  } });
  const pending = { ...source, migration: { id: target.topology.id, phase: "copying", source, target } };
  await store.publishState(pending);
  const before = [...storage.objects];
  assert.deepEqual(await store.initialize(bootstrapMap), normalizeShardMap(pending));
  assert.deepEqual([...storage.objects], before);
});

test("initialization retries an ambiguously accepted publication without rewriting it", async () => {
  const storage = new MemoryObjectStorage();
  const put = storage.put.bind(storage);
  storage.put = async (...args) => { await put(...args); throw new Error("response lost after PUT"); };
  const store = new ShardMapStore({ storage });
  await assert.rejects(store.initialize(bootstrapMap), /response lost/);
  storage.put = put;
  const before = [...storage.objects];
  assert.deepEqual(await store.initialize(bootstrapMap), normalizeShardMap(bootstrapMap));
  assert.deepEqual([...storage.objects], before);
});

test("initialization retries a failed publication through the same queue", async () => {
  const storage = new MemoryObjectStorage();
  const put = storage.put.bind(storage);
  storage.put = async () => { throw new Error("PUT unavailable"); };
  const store = new ShardMapStore({ storage });
  await assert.rejects(store.initialize(bootstrapMap), /PUT unavailable/);
  assert.deepEqual(await storage.list(), []);
  storage.put = put;
  assert.deepEqual(await store.initialize(bootstrapMap), normalizeShardMap(bootstrapMap));
});

test("storage errors and corrupt persisted maps are never treated as missing maps", async () => {
  const storage = new MemoryObjectStorage();
  const store = new ShardMapStore({ storage });
  const list = storage.list.bind(storage);
  storage.list = async () => { throw new Error("AccessDenied"); };
  await assert.rejects(store.initialize(bootstrapMap), /AccessDenied/);
  storage.list = list;
  await storage.put("objydb/cluster/shard-map.json", "{broken");
  const before = [...storage.objects];
  await assert.rejects(store.initialize(bootstrapMap), SyntaxError);
  assert.deepEqual([...storage.objects], before);
});

test("legacy shard maps load without writing and migrate on primary publication", async () => {
  const storage = new MemoryObjectStorage();
  const store = new ShardMapStore({ storage });
  await storage.put("objydb/cluster/shard-map.json", JSON.stringify({
    version: 1,
    shardMap: {
      shards: {
        "shard-0": { peers: [{ url: "http://node-a" }] },
        "shard-1": { peers: [{ url: "http://node-b" }] },
      },
    },
  }));

  const migrated = await store.load();
  assert.equal(migrated.version, SHARD_MAP_VERSION);
  assert.equal(migrated.topology.state, TOPOLOGY_ACTIVE);
  assert.deepEqual(Object.keys(migrated.shards), ["shard-0", "shard-1"]);

  assert.equal((await storage.list()).length, 1);
  await store.save(migrated);
  const persisted = JSON.parse(await readPublished(storage, "objydb/cluster/shard-map.json"));
  assert.equal(persisted.version, 2);
  assert.deepEqual(persisted.shardMap, migrated);
});

test("publishing changes peers in place and creates one stable reshard generation", async () => {
  const storage = new MemoryObjectStorage();
  const store = new ShardMapStore({ storage });
  const initial = (await store.save({
    shards: {
      "shard-0": { peers: [{ url: "http://old-a" }] },
      "shard-1": { peers: [{ url: "http://old-b" }] },
    },
  })).shardMap;

  const peersChanged = (await store.save({
    shards: {
      "logical-0": { peers: [{ url: "http://new-a" }, { url: "http://new-a2" }] },
      "logical-1": { peers: [{ url: "http://new-b" }, { url: "http://new-b2" }] },
    },
  })).shardMap;
  assert.equal(peersChanged.topology.id, initial.topology.id);
  assert.deepEqual(Object.keys(peersChanged.shards), ["shard-0", "shard-1"]);
  assert.equal(peersChanged.shards["shard-0"].peers[0].url, "http://new-a");

  const desiredThree = {
    shards: {
      "logical-0": { peers: [{ url: "http://target-a" }] },
      "logical-1": { peers: [{ url: "http://target-b" }] },
      "logical-2": { peers: [{ url: "http://target-c" }] },
    },
  };
  const reshard = (await store.save(desiredThree)).shardMap;
  assert.equal(reshard.topology.state, TOPOLOGY_RESHARDING);
  assert.equal(reshard.topology.source.id, initial.topology.id);
  assert.deepEqual(reshard.topology.source.shards, ["shard-0", "shard-1"]);
  assert.equal(Object.keys(reshard.shards).every((shard) => shard.startsWith(`${reshard.topology.id}-s`)), true);

  const retry = (await store.save(desiredThree)).shardMap;
  assert.equal(retry.topology.id, reshard.topology.id);
  await assert.rejects(() => store.save({
    shards: {
      a: { peers: [] },
      b: { peers: [] },
      c: { peers: [] },
      d: { peers: [] },
    },
  }), /unfinished/);

  const waiting = store.waitForActive(reshard.topology.id, { pollMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const finalized = (await store.finalize(reshard.topology.id)).shardMap;
  assert.deepEqual(await waiting, finalized);
  assert.equal(finalized.topology.state, TOPOLOGY_ACTIVE);
  assert.equal(finalized.topology.source, undefined);
});
