import { shardMapFromHttp, startServer } from "./server.js";
import { CRDTNode } from "./crdt.js";
import { loadConfig } from "./config.js";
import { createPersistence } from "./persistence.js";
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
  node.replaceShardMap(shardMapFromHttp(configuredShardMap, node.id));
}
const persistence = createPersistence(node, config.persistence);
if (persistence) {
  const restored = await persistence.restore();
  persistence.start();
  console.log(`persistence restored ${restored.snapshotObjects} snapshot objects and ${restored.journalOps} journal ops`);
}

const state = await startServer({
  port: config.server.port,
  node,
  shardMapStore,
  auth: config.auth,
  persistence,
});
console.log(`spread-db node ${state.node.id} listening on http://localhost:${state.port}`);

let syncing = false;
const timer = setInterval(() => {
  if (syncing) return;
  syncing = true;
  state.node.syncAll()
    .catch((err) => console.error(`replication sync failed: ${err.message}`))
    .finally(() => {
      syncing = false;
    });
}, config.cluster.syncMs);

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
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
