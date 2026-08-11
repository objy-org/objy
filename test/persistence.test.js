import { test } from "node:test";
import assert from "node:assert/strict";
import { CRDTNode } from "../src/crdt.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";

function shardMapFor(shards, peerByShard = {}) {
  return {
    shards: Object.fromEntries(shards.map((shard) => [shard, { peers: peerByShard[shard] || [] }])),
  };
}

test("journaled writes restore by database, collection, and shard", async () => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "n1" });
  const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0 });
  persistence.start();

  node.insert("app", "users", { id: "u1", name: "Ada" });
  node.update("app", "users", "u1", { active: true });
  await persistence.stop();

  const keys = await storage.list("spread-db/");
  assert.ok(keys.some((key) => key.startsWith("spread-db/db/app/collection/users/shard/default/journal/n1/")));

  const fresh = new CRDTNode({ id: "n1" });
  const restored = await new PersistenceManager({ node: fresh, storage }).restore();
  assert.equal(restored.journalOps, 2);
  assert.deepEqual(fresh.get("app", "users", "u1"), { id: "u1", name: "Ada", active: true });
  assert.equal(fresh.seq, 2);
  assert.equal(fresh.trimmed, 2);
});

test("snapshots restore full objects and tombstones", async () => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "n1" });
  const persistence = new PersistenceManager({ node, storage, segmentBytes: 1024 });

  node.insert("app", "users", { id: "u1", name: "Ada" });
  node.insert("app", "users", { id: "u2", name: "Grace" });
  node.remove("app", "users", "u1");
  const written = await persistence.checkpoint();

  assert.equal(written.scopes, 1);
  assert.equal(written.objects, 2);
  assert.ok(await storage.get("spread-db/db/app/collection/users/shard/default/latest.json"));

  const fresh = new CRDTNode({ id: "fresh" });
  const restored = await new PersistenceManager({ node: fresh, storage }).restore();
  assert.equal(restored.snapshots, 1);
  assert.equal(fresh.get("app", "users", "u1"), undefined);
  assert.deepEqual(fresh.get("app", "users", "u2"), { id: "u2", name: "Grace" });
});

test("collection metadata persists outside shard snapshots and restores indexes", async () => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "n1" });
  const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0 });
  persistence.start();

  node.createDatabase("empty", { owner: "platform" });
  node.createCollection("app", "empty_collection");
  node.setCollectionMeta("app", "orders", {
    indexes: ["status"],
    owner: "events-team",
  });
  node.insert("app", "orders", { id: "o1", status: "paid", amount: 10 });
  await persistence.stop();

  const rawMeta = await storage.get("spread-db/db/app/collection/orders/meta.json");
  assert.deepEqual(JSON.parse(rawMeta), {
    indexes: ["status"],
    owner: "events-team",
  });
  assert.deepEqual(JSON.parse(await storage.get("spread-db/db/empty/meta.json")), {
    owner: "platform",
  });
  assert.deepEqual(JSON.parse(await storage.get("spread-db/db/app/collection/empty_collection/meta.json")), {
    indexes: [],
  });

  const fresh = new CRDTNode({ id: "fresh" });
  const restored = await new PersistenceManager({ node: fresh, storage }).restore();
  assert.equal(restored.databases, 1);
  assert.equal(restored.metadata, 2);
  assert.deepEqual(fresh.listDatabases().sort(), ["app", "empty"]);
  assert.deepEqual(fresh.listCollections("app").sort(), ["empty_collection", "orders"]);
  assert.deepEqual(fresh.getCollectionMeta("app", "orders"), {
    indexes: ["status"],
    owner: "events-team",
  });
  assert.deepEqual(fresh.get("app", "orders", "o1"), { id: "o1", status: "paid", amount: 10 });
  assert.equal(fresh.indexStats("app", "orders")[0].entries, 1);
});

test("collection removal deletes the persisted collection prefix", async () => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "n1" });
  const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0 });
  persistence.start();

  node.createCollection("app", "orders", { indexes: ["status"] });
  node.insert("app", "orders", { id: "o1", status: "paid" });
  await persistence.checkpoint();
  assert.ok(await storage.get("spread-db/db/app/collection/orders/meta.json"));
  assert.ok((await storage.list("spread-db/db/app/collection/orders/")).length > 0);

  node.removeCollection("app", "orders");
  await persistence.flush();
  assert.deepEqual(await storage.list("spread-db/db/app/collection/orders/"), []);

  const fresh = new CRDTNode({ id: "fresh" });
  await new PersistenceManager({ node: fresh, storage }).restore();
  assert.deepEqual(fresh.listCollections("app"), []);
  assert.equal(fresh.get("app", "orders", "o1"), undefined);
});

test("checkpoints are partitioned per object shard", async () => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "n1" });
  node.replaceShardMap(shardMapFor(["events-0", "events-1", "events-2"]));
  const persistence = new PersistenceManager({ node, storage, segmentBytes: 2048 });

  for (let i = 0; i < 100; i++) {
    node.insert("app", "events", { id: `event-${i}`, kind: i % 5, value: i });
  }

  const written = await persistence.checkpoint();
  assert.equal(written.scopes, 3);

  const keys = await storage.list("spread-db/db/app/collection/events/shard/");
  for (const shard of ["events-0", "events-1", "events-2"]) {
    assert.ok(keys.includes(`spread-db/db/app/collection/events/shard/${shard}/latest.json`));
  }

  const fresh = new CRDTNode({ id: "fresh" });
  const restored = await new PersistenceManager({ node: fresh, storage }).restore();
  assert.equal(restored.snapshots, 3);
  assert.equal(fresh.count("app", "events"), 100);
});

test("failed journal flush is kept pending and can be retried", async () => {
  class FlakyStorage extends MemoryObjectStorage {
    constructor() {
      super();
      this.failures = 1;
    }

    async put(key, body, contentType) {
      if (this.failures > 0) {
        this.failures--;
        throw new Error("temporary S3 failure");
      }
      return super.put(key, body, contentType);
    }
  }

  const storage = new FlakyStorage();
  const node = new CRDTNode({ id: "n1" });
  const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0 });
  persistence.start();
  node.insert("app", "users", { id: "u1", name: "Ada" });

  await assert.rejects(() => persistence.flush(), /temporary S3 failure/);
  assert.equal(persistence.getStats().pendingOps, 1);
  await persistence.flush();

  const fresh = new CRDTNode({ id: "fresh" });
  await new PersistenceManager({ node: fresh, storage }).restore();
  assert.deepEqual(fresh.get("app", "users", "u1"), { id: "u1", name: "Ada" });
});

test("checkpoint compacts journal segments for the snapshotted scope", async () => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "n1" });
  const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0 });
  persistence.start();

  node.insert("app", "users", { id: "u1", name: "Ada" });
  node.insert("app", "users", { id: "u2", name: "Grace" });
  await persistence.flush();

  const journalPrefix = "spread-db/db/app/collection/users/shard/default/journal/";
  assert.equal((await storage.list(journalPrefix)).length, 1);

  await persistence.checkpoint();
  assert.equal((await storage.list(journalPrefix)).length, 0);
  assert.ok(await storage.get("spread-db/db/app/collection/users/shard/default/latest.json"));

  const fresh = new CRDTNode({ id: "fresh" });
  await new PersistenceManager({ node: fresh, storage }).restore();
  assert.equal(fresh.count("app", "users"), 2);
});

test("restore only hydrates shards owned by an explicitly scoped replica", async () => {
  const storage = new MemoryObjectStorage();
  const writer = new CRDTNode({ id: "writer" });
  writer.replaceShardMap(shardMapFor(["events-0", "events-1"]));

  for (let i = 0; i < 200; i++) {
    writer.insert("app", "events", { id: `event-${i}`, value: i });
  }
  await new PersistenceManager({ node: writer, storage, segmentBytes: 2048 }).checkpoint();

  const scoped = new CRDTNode({ id: "scoped" });
  scoped.replaceShardMap(shardMapFor(["events-0", "events-1"], { "events-0": [] }));
  await new PersistenceManager({
    node: scoped,
    storage,
    restoreScopes: [{ database: "app", collection: "events", shard: "events-0" }],
  }).restore();

  const expectedScoped = writer
    .list("app", "events")
    .filter((object) => writer.shardForObject("app", "events", object.id) === "events-0")
    .length;
  assert.equal(scoped.count("app", "events"), expectedScoped);

  const global = new CRDTNode({ id: "global" });
  await new PersistenceManager({ node: global, storage }).restore();
  assert.equal(global.count("app", "events"), 200);
});

test("restore and checkpoint use node url ownership when a full global map is loaded", async () => {
  const storage = new MemoryObjectStorage();
  const shardMap = {
    shards: {
      "shard-0": {
        peers: [{ url: "http://node-a" }, { url: "http://node-b" }],
      },
      "shard-1": {
        peers: [{ url: "http://node-c" }, { url: "http://node-d" }],
      },
    },
  };
  const writer = new CRDTNode({ id: "writer" });
  writer.replaceShardMap(shardMap);

  for (let i = 0; i < 200; i++) {
    writer.insert("app", "events", { id: `event-${i}`, value: i });
  }
  await new PersistenceManager({ node: writer, storage, segmentBytes: 2048 }).checkpoint();

  const owned = new CRDTNode({ id: "node-a", url: "http://node-a" });
  owned.replaceShardMap(shardMap);
  const restored = await new PersistenceManager({ node: owned, storage }).restore();

  const expected = writer
    .list("app", "events")
    .filter((object) => writer.shardForObject("app", "events", object.id) === "shard-0");
  assert.equal(restored.snapshots, 1);
  assert.equal(owned.count("app", "events"), expected.length);

  const checkpointStorage = new MemoryObjectStorage();
  const checkpoint = await new PersistenceManager({ node: owned, storage: checkpointStorage }).checkpoint();
  assert.equal(checkpoint.scopes, 1);
  assert.ok(await checkpointStorage.get("spread-db/db/app/collection/events/shard/shard-0/latest.json"));
  assert.equal(await checkpointStorage.get("spread-db/db/app/collection/events/shard/shard-1/latest.json"), null);
});

test("planned reshard restore redistributes old shard snapshots and journals through the new map", async () => {
  const storage = new MemoryObjectStorage();
  const oldWriter = new CRDTNode({ id: "old-writer" });
  oldWriter.replaceShardMap(shardMapFor(["old-0", "old-1"]));
  const persistence = new PersistenceManager({ node: oldWriter, storage, flushMs: 0, snapshotMs: 0 });
  persistence.start();

  for (let i = 0; i < 300; i++) {
    oldWriter.insert("app", "events", { id: `event-${i}`, value: i, version: 0 });
  }
  await persistence.checkpoint();

  for (let i = 0; i < 30; i++) {
    oldWriter.update("app", "events", `event-${i * 7}`, { value: 1000 + i, version: 1 });
  }
  await persistence.flush();

  const newShardNames = ["new-0", "new-1", "new-2"];
  const router = new CRDTNode({ id: "router" });
  router.replaceShardMap(shardMapFor(newShardNames));
  const restored = new Map();

  for (const shard of newShardNames) {
    const node = new CRDTNode({ id: `${shard}-node` });
    node.replaceShardMap(shardMapFor(newShardNames));
    await new PersistenceManager({
      node,
      storage,
      restoreMode: "reshard",
      restoreScopes: [{ database: "app", collection: "events", shard }],
    }).restore();
    restored.set(shard, node);
  }

  const counts = Object.fromEntries(newShardNames.map((shard) => [shard, restored.get(shard).count("app", "events")]));
  assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), 300);

  for (let i = 0; i < 300; i++) {
    const id = `event-${i}`;
    const shard = router.shardForObject("app", "events", id);
    const expected = oldWriter.get("app", "events", id);
    assert.deepEqual(restored.get(shard).get("app", "events", id), expected);

    for (const other of newShardNames.filter((candidate) => candidate !== shard)) {
      assert.equal(restored.get(other).get("app", "events", id), undefined);
    }
  }
});
