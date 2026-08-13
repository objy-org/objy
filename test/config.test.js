import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, normalizeConfig } from "../src/config.js";
import { CRDTNode } from "../src/crdt.js";
import { createPersistence } from "../src/persistence.js";
import { shardMapFromHttp, startServer } from "../src/server.js";

const TEST_AUTH = { jwtSecret: "test-jwt-secret" };

test("normalizes a single-node config with runtime defaults", () => {
  const config = normalizeConfig({
    node: {
      id: "node-a",
      url: "http://localhost:8080",
    },
    server: {
      port: 8080,
    },
    auth: TEST_AUTH,
  });

  assert.equal(config.node.id, "node-a");
  assert.equal(config.node.url, "http://localhost:8080");
  assert.equal(config.server.port, 8080);
  assert.equal(config.storage.engine, "shape");
  assert.deepEqual(config.vector, {
    enabled: true,
    field: "_vec",
    hnsw: {
      M: 16,
      efConstruction: 200,
      efSearch: 0,
    },
  });
  assert.deepEqual(config.memoryGuard, {
    enabled: false,
    limitMb: null,
    rejectWritesPercent: 85,
    resumeWritesPercent: 78,
    checkMs: 1000,
  });
  assert.equal(config.node.retainOps, 256);
  assert.equal(config.node.syncBatchSize, 1024);
  assert.equal(config.cluster.syncMs, 2500);
  assert.equal(config.cluster.forwardTimeoutMs, 60000);
  assert.equal(config.cluster.replicationTimeoutMs, 60000);
  assert.deepEqual(config.cluster.hints, {
    enabled: true,
    debounceMs: 25,
    maxScopesPerHint: 128,
  });
  assert.equal(config.cluster.secret, "test-jwt-secret");
  assert.equal(config.auth.jwtSecret, "test-jwt-secret");
  assert.equal(config.persistence.mode, "off");
  assert.equal(config.persistence.ack, "memory");
  assert.deepEqual(config.persistence.snapshotRetention, {
    keepLatest: 0,
    keepForMs: 0,
  });
  assert.deepEqual(config.persistence.journalRetention, {
    keepLatest: 0,
    keepForMs: 0,
  });
  assert.equal(config.persistence.restoreSnapshotId, null);
  assert.deepEqual(config.persistence.localWal, {
    mode: "off",
    dir: ".spread-db/wal",
    fsync: true,
    flushMs: 0,
  });
});

test("shared config requires node id from the command line", () => {
  assert.throws(
    () => normalizeConfig({
      node: { retainOps: 256, syncBatchSize: 4096 },
      auth: TEST_AUTH,
    }),
    /node id is required/,
  );
});

test("loads node identity overrides from cli arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "spread-db-config-"));
  const path = join(dir, "cluster.json");
  writeFileSync(path, JSON.stringify({
    node: { retainOps: 0, syncBatchSize: 4096 },
    cluster: {
      syncMs: 250,
      forwardTimeoutMs: 1250,
      replicationTimeoutMs: 5000,
      hints: {
        enabled: false,
        debounceMs: 5,
        maxScopesPerHint: 4,
      },
      secret: "cluster-secret",
      shardMap: {
        shards: {
          "events-0": { peers: [] },
        },
      },
    },
    persistence: {
      mode: "memory",
      restoreMode: "reshard",
      flushMs: 25,
      snapshotDirtyOnly: false,
      snapshotRole: "none",
      snapshotRetention: {
        keepLatest: 7,
        keepForMs: 86_400_000,
      },
      journalRetention: {
        keepLatest: 25,
        keepForMs: 3_600_000,
      },
      restoreSnapshotId: "20260813T100000000Z-restore",
      ack: "localWal",
      localWal: {
        dir: ".tmp/wal",
        fsync: false,
        flushMs: 10,
      },
    },
    storage: {
      engine: "object",
      object: {
        valueDirectory: {
          minRefs: 3,
          maxCandidatesPerPath: 8,
          maxPaths: 64,
          maxStringLength: 64,
          maxKeyBytes: 128,
        },
      },
    },
    memoryGuard: {
      enabled: true,
      limitMb: 1024,
      rejectWritesPercent: 90,
      resumeWritesPercent: 80,
      checkMs: 500,
    },
    auth: TEST_AUTH,
  }));

  const config = loadConfig([
    "--config", path,
    "--node", "node-b",
    "--url", "http://localhost:9010",
    "--port", "9010",
  ], dir);
  assert.equal(config.node.id, "node-b");
  assert.equal(config.node.url, "http://localhost:9010");
  assert.equal(config.node.retainOps, 0);
  assert.equal(config.node.syncBatchSize, 4096);
  assert.equal(config.server.port, 9010);
  assert.equal(config.cluster.syncMs, 250);
  assert.equal(config.cluster.forwardTimeoutMs, 1250);
  assert.equal(config.cluster.replicationTimeoutMs, 5000);
  assert.deepEqual(config.cluster.hints, {
    enabled: false,
    debounceMs: 5,
    maxScopesPerHint: 4,
  });
  assert.equal(config.cluster.secret, "cluster-secret");
  assert.equal(config.cluster.shardMap.shards["events-0"].peers.length, 0);
  assert.equal(config.storage.engine, "object");
  assert.equal(config.storage.object.valueDirectory.minRefs, 3);
  assert.equal(config.storage.object.valueDirectory.maxCandidatesPerPath, 8);
  assert.equal(config.storage.object.valueDirectory.maxPaths, 64);
  assert.equal(config.storage.object.valueDirectory.maxStringLength, 64);
  assert.equal(config.storage.object.valueDirectory.maxKeyBytes, 128);
  assert.deepEqual(config.memoryGuard, {
    enabled: true,
    limitMb: 1024,
    rejectWritesPercent: 90,
    resumeWritesPercent: 80,
    checkMs: 500,
  });
  assert.equal(config.persistence.mode, "memory");
  assert.equal(config.persistence.restoreMode, "reshard");
  assert.equal(config.persistence.flushMs, 25);
  assert.equal(config.persistence.snapshotDirtyOnly, false);
  assert.equal(config.persistence.snapshotRole, "none");
  assert.deepEqual(config.persistence.snapshotRetention, {
    keepLatest: 7,
    keepForMs: 86_400_000,
  });
  assert.deepEqual(config.persistence.journalRetention, {
    keepLatest: 25,
    keepForMs: 3_600_000,
  });
  assert.equal(config.persistence.restoreSnapshotId, "20260813T100000000Z-restore");
  assert.equal(config.persistence.ack, "localWal");
  assert.deepEqual(config.persistence.localWal, {
    mode: "on",
    dir: ".tmp/wal",
    fsync: false,
    flushMs: 10,
  });
});

test("rejects invalid persistence snapshot roles", () => {
  assert.throws(
    () => normalizeConfig({
      node: { id: "node-a" },
      persistence: { mode: "memory", snapshotRole: "everyone" },
      auth: TEST_AUTH,
    }),
    /persistence.snapshotRole/,
  );
});

test("rejects invalid storage engines", () => {
  assert.throws(
    () => normalizeConfig({
      node: { id: "node-a" },
      storage: { engine: "unknown" },
      auth: TEST_AUTH,
    }),
    /storage\.engine/,
  );
});

test("rejects invalid memory guard hysteresis", () => {
  assert.throws(
    () => normalizeConfig({
      node: { id: "node-a" },
      memoryGuard: {
        enabled: true,
        rejectWritesPercent: 80,
        resumeWritesPercent: 90,
      },
      auth: TEST_AUTH,
    }),
    /memoryGuard\.resumeWritesPercent/,
  );
});

test("rejects local WAL ack when the WAL is explicitly disabled", () => {
  assert.throws(
    () => normalizeConfig({
      node: { id: "node-a" },
      persistence: { mode: "memory", ack: "localWal", localWal: { mode: "off" } },
      auth: TEST_AUTH,
    }),
    /requires persistence.localWal.mode on/,
  );
});

test("infers Hetzner object storage region from the endpoint location", () => {
  const config = normalizeConfig({
    node: { id: "node-a" },
    persistence: {
      mode: "s3",
      s3: {
        bucket: "spread-db",
        endpoint: "https://fsn1.your-objectstorage.com",
        region: "us-east-1",
      },
    },
    auth: TEST_AUTH,
  });

  assert.equal(config.persistence.s3.region, "fsn1");
});

test("rejects mismatched Hetzner object storage region and endpoint", () => {
  assert.throws(
    () => normalizeConfig({
      node: { id: "node-a" },
      persistence: {
        mode: "s3",
        s3: {
          bucket: "spread-db",
          endpoint: "https://fsn1.your-objectstorage.com",
          region: "nbg1",
        },
      },
      auth: TEST_AUTH,
    }),
    /persistence\.s3\.region must be fsn1/,
  );
});

test("runtime pieces can be started from normalized config", async () => {
  const config = normalizeConfig({
    node: { id: "node-a", retainOps: 0, syncBatchSize: 128 },
    server: { port: 0 },
    cluster: {
      shardMap: {
        shards: {
          "events-0": { peers: [] },
        },
      },
    },
    persistence: { mode: "memory", flushMs: 0, snapshotMs: 0 },
    auth: TEST_AUTH,
  });

  const node = new CRDTNode({
    id: config.node.id,
    retainOps: config.node.retainOps,
    syncBatchSize: config.node.syncBatchSize,
    storage: config.storage,
  });
  node.replaceShardMap(shardMapFromHttp(config.cluster.shardMap, node.id, { secret: config.cluster.secret }));
  const persistence = createPersistence(node, config.persistence);
  persistence.start();
  const state = await startServer({ port: config.server.port, node, auth: config.auth, persistence });

  try {
    assert.equal(state.node.id, "node-a");
    assert.equal(state.node.syncBatchSize, 128);
    assert.deepEqual(state.node.shardMap.shardsForCollection("app", "events"), ["events-0"]);
  } finally {
    await persistence.stop();
    state.server.close();
  }
});

test("json shard map peer urls become HTTP replication peers", () => {
  const node = new CRDTNode({ id: "node-b" });
  const config = normalizeConfig({
    node: {
      id: "node-b",
      url: "http://localhost:8082",
    },
    server: {
      port: 8082,
    },
    cluster: {
      shardMap: {
        shards: {
          "events-0": {
            peers: [{ url: "http://localhost:8081" }],
          },
        },
      },
    },
    auth: TEST_AUTH,
  });

  node.replaceShardMap(shardMapFromHttp(config.cluster.shardMap, node.id, { secret: config.cluster.secret }));
  const peer = node.peersForShard("events-0")[0];
  assert.equal(peer.url, "http://localhost:8081");
  assert.equal(peer.secret, "test-jwt-secret");
  assert.equal(typeof peer.pull, "function");
});
