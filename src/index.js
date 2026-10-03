import { shardMapFromHttp, startRestoreStatusServer, startServer } from "./server.js";
import { CRDTNode } from "./crdt.js";
import { loadConfig } from "./config.js";
import { createFileService } from "./files.js";
import { createPersistence } from "./persistence.js";
import { createReplicationScheduler } from "./replication-scheduler.js";
import { createRestoreStatus } from "./restore-status.js";
import { createShardMapStore } from "./shard-map-store.js";

const config = loadConfig();

const node = new CRDTNode({
  id: config.node.id,
  url: config.node.url,
  retainOps: config.node.retainOps,
  syncBatchSize: config.node.syncBatchSize,
  storage: config.storage,
  vector: config.vector,
});
const shardMapStore = createShardMapStore(config.cluster.shardMapStore, config.persistence);
const storedShardMap = await shardMapStore?.load();
const configuredShardMap = storedShardMap || config.cluster.shardMap;
if (configuredShardMap) {
  node.replaceShardMap(shardMapFromHttp(configuredShardMap, node.id, {
    secret: config.cluster.secret,
    timeoutMs: config.cluster.replicationTimeoutMs,
  }));
}
const replication = createReplicationScheduler({
  node,
  hintsEnabled: config.cluster.hints.enabled,
  antiEntropyMs: config.cluster.syncMs,
  debounceMs: config.cluster.hints.debounceMs,
  maxScopesPerHint: config.cluster.hints.maxScopesPerHint,
});
const persistence = createPersistence(node, config.persistence);
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
  persistence.start();
  console.log(`persistence restored ${restored.snapshotObjects} snapshot objects and ${restored.journalOps} journal ops`);
} else {
  restoreStatus.done({ disabled: true });
}
await new Promise((resolve) => restoreServer.server.close(resolve));

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
});
replication.start();
console.log(`spread-db node ${state.node.id} listening on http://localhost:${state.port}`);

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
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
