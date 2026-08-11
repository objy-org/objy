import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { ShardMapStore } from "../src/shard-map-store.js";

test("shard map store saves and loads map JSON from object storage", async () => {
  const storage = new MemoryObjectStorage();
  const store = new ShardMapStore({ storage, prefix: "spread-db", key: "cluster/shard-map.json" });
  const shardMap = {
    shards: {
      "shard-0": { peers: [{ url: "http://localhost:8080" }] },
      "shard-1": { peers: [{ url: "http://localhost:8081" }] },
    },
  };

  await store.save(shardMap);

  assert.ok(await storage.get("spread-db/cluster/shard-map.json"));
  assert.deepEqual(await store.load(), shardMap);
});
