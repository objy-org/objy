import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { shardMapFromHttp, startRestoreStatusServer, startServer } from "./server.js";
import { CRDTNode } from "./crdt.js";
import { loadConfig } from "./config.js";
import { createFileService } from "./files.js";
import { createPersistence } from "./persistence.js";
import { createReplicationScheduler } from "./replication-scheduler.js";
import { createRestoreStatus } from "./restore-status.js";
import { createShardMapStore } from "./shard-map-store.js";
import { createObjectHookRegistry } from "./object-hooks.js";
import { loadPlugins } from "./plugin-loader.js";
import { resolveSystemSecrets } from "./system-secrets.js";
import { isTopologyResharding } from "./shard-map.js";
import { nodeCompression, readHeapUsageRatio } from "./node-runtime.js";
import { isPrimary } from "./primary-state.js";
import { DEFAULT_REPLICATION_TIMEOUT_MS } from "./interfaces/cluster.js";

const config = loadConfig();

const node = new CRDTNode({
  id: config.node.id,
  url: config.node.url,
  retainOps: config.node.retainOps,
  syncBatchSize: config.node.syncBatchSize,
  storage: { ...config.storage, compression: nodeCompression, readHeapUsageRatio },
  vector: config.vector,
});
const shardMapStore = createShardMapStore(config.cluster.shardMapStore, config.persistence, node);
const persistence = createPersistence(node, config.persistence, config.imports);
let storedShardMap = await shardMapStore?.load();
if (shardMapStore?.durable && !storedShardMap) {
  if (config.cluster.shardMap) node.replaceShardMap(config.cluster.shardMap);
  if (config.cluster.shardMap && isPrimary(node)) {
    storedShardMap = await shardMapStore.initialize(config.cluster.shardMap);
    console.log(`shard map ${storedShardMap.topology.id} initialized in S3`);
  } else {
    const timeoutMs = config.cluster.replicationTimeoutMs || DEFAULT_REPLICATION_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    console.log(`waiting up to ${timeoutMs}ms for the coordinator to initialize the S3 shard map`);
    while (!(storedShardMap = await shardMapStore.load())) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("S3 shard map is not initialized; start its coordinator with cluster.shardMap in the config");
      await sleep(Math.min(1000, remaining));
    }
  }
}
const configuredShardMap = storedShardMap || config.cluster.shardMap;
if (configuredShardMap) node.replaceShardMap(configuredShardMap);
const sharedSecrets = config.persistence.mode === "s3"
  ? { storage: persistence.storage, prefix: config.persistence.prefix }
  : config.cluster.shardMapStore.mode === "s3"
    ? { storage: shardMapStore.storage, prefix: config.cluster.shardMapStore.prefix }
    : {};
const secrets = await resolveSystemSecrets({
  jwtSecret: config.auth.jwtSecret,
  clusterSecret: config.cluster.secret,
  ...sharedSecrets,
  localPath: sharedSecrets.storage
    ? resolve(config.persistence.localWal.dir, encodeURIComponent(node.id), "system-secrets.json")
    : resolve(config.persistence.localWal.dir, "..", "system-secrets.json"),
  primary: isPrimary(node),
  node,
});
config.auth = { ...config.auth, jwtSecret: secrets.jwtSecret };
config.cluster.secret = secrets.clusterSecret;
if (configuredShardMap) {
  node.replaceShardMap(shardMapFromHttp(configuredShardMap, node.id, {
    secret: config.cluster.secret,
    timeoutMs: config.cluster.replicationTimeoutMs,
  }));
}
if (isTopologyResharding(node.shardMapSnapshot()) && (!persistence?.durable || !shardMapStore?.durable)) {
  throw new Error("resharding requires S3 persistence and an S3 shard map store");
}
const replication = createReplicationScheduler({
  node,
  hintsEnabled: config.cluster.hints.enabled,
  antiEntropyMs: config.cluster.syncMs,
  debounceMs: config.cluster.hints.debounceMs,
  maxScopesPerHint: config.cluster.hints.maxScopesPerHint,
});
const files = createFileService(config.files, config.persistence);
const restoreStatus = createRestoreStatus();
const restoreServer = await startRestoreStatusServer({
  port: config.server.port,
  node,
  restoreStatus,
  replication,
});

if (persistence) {
  node.setLogTruncatedHandler?.(({ scope }) => persistence.restoreScope(scope));
  const restored = await persistence.restore({ progress: restoreStatus });
  if (restored.reshardCheckpoint && shardMapStore?.durable && persistence.durable) {
    let readiness = await persistence.reshardReadiness();
    restored.reshardReadiness = readiness;
    let activeMap;
    if (isPrimary(node)) {
      while (!readiness.ready) {
        restoreStatus.waiting({ topologyId: readiness.topologyId });
        await sleep(1000);
        readiness = await persistence.reshardReadiness();
      }
      const finalized = await shardMapStore.finalize(readiness.topologyId);
      activeMap = finalized.shardMap;
      restored.reshardFinalized = true;
    } else {
      restoreStatus.waiting({ topologyId: readiness.topologyId });
      activeMap = await shardMapStore.waitForActive(readiness.topologyId);
    }
    node.replaceShardMap(shardMapFromHttp(activeMap, node.id, {
      secret: config.cluster.secret,
      timeoutMs: config.cluster.replicationTimeoutMs,
    }));
    restoreStatus.done(restored);
  }
  persistence.start();
  console.log(`persistence restored ${restored.snapshotObjects} snapshot objects and ${restored.journalOps} journal ops`);
} else {
  restoreStatus.done({ disabled: true });
}
await restoreServer.close();

const objectHooks = createObjectHookRegistry();
await loadPlugins(config.plugins, { configPath: config.configPath, node, objectHooks });

const state = await startServer({
  port: restoreServer.port,
  maxJsonBytes: config.server.maxJsonBytes,
  cors: config.server.cors,
  node,
  shardMapStore,
  auth: config.auth,
  persistence,
  files,
  restoreStatus,
  memoryGuard: config.memoryGuard,
  clusterSecret: config.cluster.secret,
  forwardTimeoutMs: config.cluster.forwardTimeoutMs,
  replicationTimeoutMs: config.cluster.replicationTimeoutMs,
  replication,
  imports: config.imports,
  objectHooks,
});
replication.start();
console.log(`OBJY DB node ${state.node.id} listening on http://localhost:${state.port}`);

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await state.migration?.stop();
  await replication.stop();
  await new Promise((resolve) => state.server.close(resolve));
  try {
    await persistence?.stop();
  } catch (err) {
    console.error(`persistence flush failed during shutdown: ${err.message}`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
