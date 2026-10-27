import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { ShardMapStore } from "../src/shard-map-store.js";
import { SHARD_MAP_VERSION, TOPOLOGY_ACTIVE, TOPOLOGY_RESHARDING } from "../src/shard-map.js";

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

  assert.ok(await storage.get("objydb/cluster/shard-map.json"));
  const loaded = await store.load();
  assert.deepEqual(loaded, saved.shardMap);
  assert.equal(loaded.version, SHARD_MAP_VERSION);
  assert.equal(loaded.topology.state, TOPOLOGY_ACTIVE);
  assert.deepEqual(Object.keys(loaded.shards), ["shard-0", "shard-1"]);
});

test("legacy shard maps migrate in place without renaming shards", async () => {
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

  const persisted = JSON.parse(await storage.get("objydb/cluster/shard-map.json"));
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
