import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CRDTNode } from "../src/crdt.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";

function shardMapFor(shards, peerByShard = {}) {
  return {
    shards: Object.fromEntries(shards.map((shard) => [shard, { peers: peerByShard[shard] || [] }])),
  };
}

function restoredCursor(node, sourceNode, scope) {
  return new Map(node.getStats().lastSeen).get(node._cursorKey(sourceNode, scope));
}

test("local WAL restores acknowledged writes before S3 journal flush", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spread-db-wal-"));
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "n1" });
  const persistence = new PersistenceManager({
    node,
    storage,
    flushMs: 0,
    snapshotMs: 0,
    ack: "localWal",
    localWal: { mode: "on", dir, fsync: true },
  });

  try {
    persistence.start();
    node.insertMany("app", "events", [
      { _id: "e1", value: 1 },
      { _id: "e2", value: 2 },
    ]);
    const flushed = await persistence.afterWrite();

    assert.equal(flushed.records, 1);
    assert.equal(flushed.ops, 2);
    assert.deepEqual(await storage.list("spread-db/"), []);
    assert.equal(readFileSync(join(dir, "n1", "wal.jsonl"), "utf8").trim().split("\n").length, 1);

    const fresh = new CRDTNode({ id: "n1" });
    const restored = await new PersistenceManager({
      node: fresh,
      storage,
      flushMs: 0,
      snapshotMs: 0,
      ack: "localWal",
      localWal: { mode: "on", dir, fsync: true },
    }).restore();

    assert.equal(restored.localWalOps, 2);
    assert.deepEqual(fresh.get("app", "events", "e1"), { _id: "e1", value: 1 });
    assert.deepEqual(fresh.get("app", "events", "e2"), { _id: "e2", value: 2 });
  } finally {
    await persistence.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local WAL splits large bulk writes into smaller durable records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spread-db-wal-split-"));
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "n1" });
  const persistence = new PersistenceManager({
    node,
    storage,
    flushMs: 0,
    snapshotMs: 0,
    ack: "localWal",
    localWal: { mode: "on", dir, fsync: true, maxRecordBytes: 900, maxOpsPerRecord: 2 },
  });

  try {
    persistence.start();
    node.insertMany("app", "events", Array.from({ length: 5 }, (_, i) => ({
      _id: `e${i}`,
      payload: "x".repeat(250),
    })));
    const flushed = await persistence.afterWrite();
    const lines = readFileSync(join(dir, "n1", "wal.jsonl"), "utf8").trim().split("\n");

    assert.ok(flushed.records > 1);
    assert.equal(lines.length, flushed.records);

    const fresh = new CRDTNode({ id: "n1" });
    const restored = await new PersistenceManager({
      node: fresh,
      storage,
      flushMs: 0,
      snapshotMs: 0,
      ack: "localWal",
      localWal: { mode: "on", dir, fsync: true, maxRecordBytes: 900, maxOpsPerRecord: 2 },
    }).restore();

    assert.equal(restored.localWalOps, 5);
    assert.equal(fresh.count("app", "events"), 5);
  } finally {
    await persistence.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journaled writes restore by database, collection, and shard", async () => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "n1" });
  const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0 });
  persistence.start();

  node.insert("app", "users", { _id: "u1", name: "Ada" });
  node.update("app", "users", "u1", { active: true });
  await persistence.stop();

  const keys = await storage.list("spread-db/");
  assert.ok(keys.some((key) => key.startsWith("spread-db/db/app/collection/users/shard/default/journal/n1/")));
  assert.ok(keys.some((key) => key.endsWith(".jsonl")));

  const fresh = new CRDTNode({ id: "n1" });
  const restored = await new PersistenceManager({ node: fresh, storage }).restore();
  assert.equal(restored.journalOps, 2);
  assert.deepEqual(fresh.get("app", "users", "u1"), { _id: "u1", name: "Ada", active: true });
  assert.equal(fresh.seq, 2);
  assert.equal(fresh.trimmed, 2);
});

test("journal flush splits large batches by byte budget", async () => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "n1" });
  const persistence = new PersistenceManager({
    node,
    storage,
    flushMs: 0,
    snapshotMs: 0,
    opBatchSize: 100,
    journalMaxBytes: 900,
  });
  persistence.start();

  node.insertMany("app", "events", Array.from({ length: 6 }, (_, i) => ({
    _id: `e${i}`,
    payload: "x".repeat(250),
  })));
  await persistence.stop();

  const keys = await storage.list("spread-db/db/app/collection/events/shard/default/journal/n1/");
  assert.ok(keys.length > 1);

  const fresh = new CRDTNode({ id: "fresh" });
  const restored = await new PersistenceManager({ node: fresh, storage }).restore();
  assert.equal(restored.journalOps, 6);
  assert.equal(fresh.count("app", "events"), 6);
});

test("snapshots restore full objects and tombstones", async () => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "n1" });
  const persistence = new PersistenceManager({ node, storage, segmentBytes: 1024 });

  node.insert("app", "users", { _id: "u1", name: "Ada" });
  node.insert("app", "users", { _id: "u2", name: "Grace" });
  node.remove("app", "users", "u1");
  const written = await persistence.checkpoint();

  assert.equal(written.scopes, 1);
  assert.equal(written.objects, 2);
  assert.ok(await storage.get("spread-db/db/app/collection/users/shard/default/latest.json"));
  assert.ok((await storage.list("spread-db/")).some((key) => key.includes("/snapshots/") && key.endsWith(".jsonl")));

  const fresh = new CRDTNode({ id: "fresh" });
  const restored = await new PersistenceManager({ node: fresh, storage }).restore();
  assert.equal(restored.snapshots, 1);
  assert.equal(fresh.get("app", "users", "u1"), undefined);
  assert.deepEqual(fresh.get("app", "users", "u2"), { _id: "u2", name: "Grace" });
});

test("restore reads legacy JSON snapshot and journal segments", async () => {
  const storage = new MemoryObjectStorage();
  const writer = new CRDTNode({ id: "legacy-writer" });
  writer.insert("app", "users", { _id: "u1", name: "Ada" });

  const scopePrefix = "spread-db/db/app/collection/users/shard/default";
  const snapshotId = "20260817T000000000Z-000001-legacy";
  const segmentKey = `${scopePrefix}/snapshots/${snapshotId}/segment-000000.json`;
  const snapshot = writer.snapshot({ database: "app", collection: "users" });
  await storage.put(segmentKey, JSON.stringify(snapshot.collections[0].objects));
  await storage.put(`${scopePrefix}/latest.json`, JSON.stringify({
    version: 1,
    id: snapshotId,
    node: writer.id,
    seq: writer.seq,
    createdAt: "2026-08-17T00:00:00.000Z",
    database: "app",
    collection: "users",
    shard: "default",
    cursors: { [writer.id]: writer.seq },
    objectCount: 1,
    segments: [{ key: segmentKey, count: 1 }],
  }));

  writer.update("app", "users", "u1", { active: true });
  await storage.put(
    `${scopePrefix}/journal/${writer.id}/1723852800000-0000000000000002-0000000000000002-legacy.json`,
    JSON.stringify({ version: 1, node: writer.id, ops: [writer.log.at(-1)] }),
  );

  const streamingStorage = {
    get: async (key) => {
      if (key === segmentKey) throw new Error("legacy snapshot segment must be streamed");
      return storage.get(key);
    },
    getStream: (key) => storage.getStream(key),
    list: (prefix) => storage.list(prefix),
  };
  const fresh = new CRDTNode({ id: "fresh" });
  const restored = await new PersistenceManager({ node: fresh, storage: streamingStorage }).restore();

  assert.equal(restored.snapshots, 1);
  assert.equal(restored.journalOps, 1);
  assert.deepEqual(fresh.get("app", "users", "u1"), { _id: "u1", name: "Ada", active: true });
});

test("restore seeds replication cursors from persisted source nodes", async () => {
  const snapshotStorage = new MemoryObjectStorage();
  const snapshotWriter = new CRDTNode({ id: "snapshot-writer" });
  snapshotWriter.insert("app", "events", { _id: "e1", value: 1 });
  await new PersistenceManager({ node: snapshotWriter, storage: snapshotStorage }).checkpoint();

  const snapshotReplica = new CRDTNode({ id: "snapshot-replica" });
  await new PersistenceManager({ node: snapshotReplica, storage: snapshotStorage }).restore();
  assert.equal(
    restoredCursor(snapshotReplica, "snapshot-writer", { database: "app", collection: "events", shard: "default" }),
    snapshotWriter.seq,
  );

  const journalStorage = new MemoryObjectStorage();
  const journalWriter = new CRDTNode({ id: "journal-writer" });
  const journalPersistence = new PersistenceManager({ node: journalWriter, storage: journalStorage, flushMs: 0, snapshotMs: 0 });
  journalPersistence.start();
  journalWriter.insert("app", "events", { _id: "e1", value: 1 });
  journalWriter.update("app", "events", "e1", { value: 2 });
  await journalPersistence.stop();

  const journalReplica = new CRDTNode({ id: "journal-replica" });
  await new PersistenceManager({ node: journalReplica, storage: journalStorage }).restore();
  assert.equal(
    restoredCursor(journalReplica, "journal-writer", { database: "app", collection: "events", shard: "default" }),
    journalWriter.seq,
  );
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
  node.insert("app", "orders", { _id: "o1", status: "paid", amount: 10 });
  await persistence.stop();

  const rawMeta = await storage.get("spread-db/db/app/collection/orders/meta.json");
  assert.deepEqual(JSON.parse(rawMeta), {
    indexes: ["status"],
    columnIndexes: [],
    owner: "events-team",
  });
  assert.deepEqual(JSON.parse(await storage.get("spread-db/db/empty/meta.json")), {
    owner: "platform",
  });
  assert.deepEqual(JSON.parse(await storage.get("spread-db/db/app/collection/empty_collection/meta.json")), {
    indexes: [],
    columnIndexes: [],
  });

  const fresh = new CRDTNode({ id: "fresh" });
  const restored = await new PersistenceManager({ node: fresh, storage }).restore();
  assert.equal(restored.databases, 1);
  assert.equal(restored.metadata, 2);
  assert.deepEqual(fresh.listDatabases().sort(), ["app", "empty"]);
  assert.deepEqual(fresh.listCollections("app").sort(), ["empty_collection", "orders"]);
  assert.deepEqual(fresh.getCollectionMeta("app", "orders"), {
    indexes: ["status"],
    columnIndexes: [],
    owner: "events-team",
  });
  assert.deepEqual(fresh.get("app", "orders", "o1"), { _id: "o1", status: "paid", amount: 10 });
  await fresh.awaitIndexes("app", "orders");
  assert.equal(fresh.indexStats("app", "orders")[0].entries, 1);
  assert.equal(fresh.indexStats("app", "orders")[0].orderedEntries, 1);
  assert.deepEqual(
    fresh.find("app", "orders", {}, { sortBy: "status", limit: 1 }).map((order) => order._id),
    ["o1"],
  );
});

test("restore makes objects readable before configured indexes finish warming", async () => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "n1" });
  const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0 });
  persistence.start();
  node.setCollectionMeta("app", "orders", {
    indexes: ["status"],
    columnIndexes: ["amount"],
  });
  node.insertMany("app", "orders", Array.from({ length: 50 }, (_, i) => ({
    _id: `o${i}`,
    status: i % 2 ? "open" : "paid",
    amount: i,
  })));
  await persistence.checkpoint();
  await persistence.stop();

  const fresh = new CRDTNode({ id: "fresh" });
  await new PersistenceManager({ node: fresh, storage }).restore();
  const readiness = fresh.indexReadiness().collections.find((entry) => entry.database === "app" && entry.collection === "orders");

  assert.equal(readiness.fieldIndexes.find((index) => index.path === "status").status, "pending");
  assert.equal(fresh.queryPath("app", "orders", { status: "paid" }), "scan");
  assert.equal(fresh.count("app", "orders", { status: "paid" }), 25);

  fresh.startIndexWarmup();
  assert.equal(
    fresh.indexReadiness().collections
      .find((entry) => entry.database === "app" && entry.collection === "orders")
      .fieldIndexes.find((index) => index.path === "status").status,
    "building",
  );
  await fresh.awaitIndexes("app", "orders");
  assert.equal(fresh.queryPath("app", "orders", { status: "paid" }), "index-exact");
  assert.equal(fresh.indexStats("app", "orders").find((entry) => entry.type === "field" && entry.path === "status").entries, 50);
});

test("collection removal deletes the persisted collection prefix", async () => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "n1" });
  const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0 });
  persistence.start();

  node.createCollection("app", "orders", { indexes: ["status"] });
  node.insert("app", "orders", { _id: "o1", status: "paid" });
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
    node.insert("app", "events", { _id: `event-${i}`, kind: i % 5, value: i });
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
  node.insert("app", "users", { _id: "u1", name: "Ada" });

  await assert.rejects(() => persistence.flush(), /temporary S3 failure/);
  assert.equal(persistence.getStats().pendingOps, 1);
  await persistence.flush();

  const fresh = new CRDTNode({ id: "fresh" });
  await new PersistenceManager({ node: fresh, storage }).restore();
  assert.deepEqual(fresh.get("app", "users", "u1"), { _id: "u1", name: "Ada" });
});

test("checkpoint compacts journal segments for the snapshotted scope", async () => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "n1" });
  const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0 });
  persistence.start();

  node.insert("app", "users", { _id: "u1", name: "Ada" });
  node.insert("app", "users", { _id: "u2", name: "Grace" });
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

test("snapshot retention prunes old snapshot folders but keeps latest restore pointer", async () => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "n1" });
  const persistence = new PersistenceManager({
    node,
    storage,
    snapshotRetention: { keepLatest: 2 },
  });

  node.insert("app", "users", { _id: "u1", version: 1 });
  const first = await persistence.checkpoint();
  node.update("app", "users", "u1", { version: 2 });
  const second = await persistence.checkpoint();
  node.update("app", "users", "u1", { version: 3 });
  const third = await persistence.checkpoint();

  const snapshotPrefix = "spread-db/db/app/collection/users/shard/default/snapshots/";
  const keys = await storage.list(snapshotPrefix);
  assert.equal(keys.some((key) => key.includes(`/${first.id}/`)), false);
  assert.ok(keys.some((key) => key.includes(`/${second.id}/`)));
  assert.ok(keys.some((key) => key.includes(`/${third.id}/`)));

  const latest = JSON.parse(await storage.get("spread-db/db/app/collection/users/shard/default/latest.json"));
  assert.equal(latest.id, third.id);
});

test("journal retention keeps incremental history without replaying covered journal segments", async () => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "n1" });
  const persistence = new PersistenceManager({
    node,
    storage,
    flushMs: 0,
    snapshotMs: 0,
    journalRetention: { keepLatest: 10 },
  });
  persistence.start();

  node.insert("app", "users", { _id: "u1", version: 1 });
  await persistence.flush();
  const checkpoint = await persistence.checkpoint();
  assert.ok(checkpoint.id);

  const journalPrefix = "spread-db/db/app/collection/users/shard/default/journal/";
  assert.equal((await storage.list(journalPrefix)).length, 1);

  node.update("app", "users", "u1", { version: 2 });
  await persistence.flush();
  assert.equal((await storage.list(journalPrefix)).length, 2);

  const fresh = new CRDTNode({ id: "fresh" });
  const restored = await new PersistenceManager({ node: fresh, storage }).restore();
  assert.equal(restored.snapshots, 1);
  assert.equal(restored.journalOps, 1);
  assert.equal(restored.skippedJournals, 1);
  assert.deepEqual(fresh.get("app", "users", "u1"), { _id: "u1", version: 2 });
});

test("restore can target a retained checkpoint id", async () => {
  const storage = new MemoryObjectStorage();
  const node = new CRDTNode({ id: "n1" });
  const persistence = new PersistenceManager({
    node,
    storage,
    flushMs: 0,
    snapshotMs: 0,
    journalRetention: { keepLatest: 10 },
    snapshotRetention: { keepLatest: 5 },
  });
  persistence.start();

  node.createCollection("app", "users", { indexes: ["version"] });
  node.insert("app", "users", { _id: "u1", version: 1 });
  await persistence.flush();
  const first = await persistence.checkpoint();
  node.update("app", "users", "u1", { version: 2 });
  node.setCollectionMeta("app", "users", { indexes: [] });
  await persistence.flush();
  const second = await persistence.checkpoint();

  const latest = new CRDTNode({ id: "latest" });
  await new PersistenceManager({ node: latest, storage }).restore();
  assert.deepEqual(latest.get("app", "users", "u1"), { _id: "u1", version: 2 });

  const earlier = new CRDTNode({ id: "earlier" });
  await new PersistenceManager({
    node: earlier,
    storage,
    restoreSnapshotId: first.id,
  }).restore();
  assert.notEqual(first.id, second.id);
  assert.deepEqual(earlier.get("app", "users", "u1"), { _id: "u1", version: 1 });
  assert.deepEqual(earlier.getCollectionMeta("app", "users"), {
    indexes: ["version"],
    columnIndexes: [],
  });
});

test("automatic checkpoints are dirty-only and primary-only", async () => {
  const shardMap = shardMapFor(["events-0"], {
    "events-0": [{ url: "http://node-a" }, { url: "http://node-b" }],
  });

  const primaryStorage = new MemoryObjectStorage();
  const primary = new CRDTNode({ id: "node-a", url: "http://node-a" });
  primary.replaceShardMap(shardMap);
  const primaryPersistence = new PersistenceManager({ node: primary, storage: primaryStorage, flushMs: 0, snapshotMs: 0 });
  primaryPersistence.start();
  primary.insert("app", "events", { _id: "e1", value: 1 });

  const first = await primaryPersistence.checkpoint({ automatic: true });
  assert.equal(first.scopes, 1);
  assert.equal(first.objects, 1);
  assert.ok(await primaryStorage.get("spread-db/db/app/collection/events/shard/events-0/latest.json"));
  assert.equal(primaryPersistence.getStats().dirtyScopes, 0);

  const clean = await primaryPersistence.checkpoint({ automatic: true });
  assert.equal(clean.scopes, 0);

  const secondaryStorage = new MemoryObjectStorage();
  const secondary = new CRDTNode({ id: "node-b", url: "http://node-b" });
  secondary.replaceShardMap(shardMap);
  const secondaryPersistence = new PersistenceManager({ node: secondary, storage: secondaryStorage, flushMs: 0, snapshotMs: 0 });
  secondaryPersistence.start();
  secondary.insert("app", "events", { _id: "e1", value: 1 });

  const skipped = await secondaryPersistence.checkpoint({ automatic: true });
  assert.equal(skipped.scopes, 0);
  assert.equal(await secondaryStorage.get("spread-db/db/app/collection/events/shard/events-0/latest.json"), null);

  const manual = await secondaryPersistence.checkpoint();
  assert.equal(manual.scopes, 1);
  assert.ok(await secondaryStorage.get("spread-db/db/app/collection/events/shard/events-0/latest.json"));

  await primaryPersistence.stop();
  await secondaryPersistence.stop();
});

test("restore only hydrates shards owned by an explicitly scoped replica", async () => {
  const storage = new MemoryObjectStorage();
  const writer = new CRDTNode({ id: "writer" });
  writer.replaceShardMap(shardMapFor(["events-0", "events-1"]));

  for (let i = 0; i < 200; i++) {
    writer.insert("app", "events", { _id: `event-${i}`, value: i });
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
    .filter((object) => writer.shardForObject("app", "events", object._id) === "events-0")
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
    writer.insert("app", "events", { _id: `event-${i}`, value: i });
  }
  await new PersistenceManager({ node: writer, storage, segmentBytes: 2048 }).checkpoint();

  const owned = new CRDTNode({ id: "node-a", url: "http://node-a" });
  owned.replaceShardMap(shardMap);
  const restored = await new PersistenceManager({ node: owned, storage }).restore();

  const expected = writer
    .list("app", "events")
    .filter((object) => writer.shardForObject("app", "events", object._id) === "shard-0");
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
    oldWriter.insert("app", "events", { _id: `event-${i}`, value: i, version: 0 });
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
