import { createServer } from "node:http";
import { createAuthService } from "./auth.js";
import { CRDTNode } from "./crdt.js";
import { HttpRouter, json } from "./http-router.js";
import { createAuthInterface } from "./interfaces/auth.js";
import { createClusterInterface, httpPeer, shardMapFromHttp } from "./interfaces/cluster.js";
import { createPublicObjectInterface } from "./interfaces/public-object.js";
import { createUiInterface } from "./interfaces/ui.js";
import { createMemoryGuard } from "./memory-guard.js";
import { createReplicationScheduler } from "./replication-scheduler.js";
import { ShardRequestRouter } from "./shard-router.js";

export { httpPeer, shardMapFromHttp };

export async function startServer({
  port = 0,
  peers = [],
  shardMap,
  node,
  shardMapStore,
  auth,
  persistence,
  files,
  memoryGuard,
  clusterSecret,
  forwardTimeoutMs,
  replicationTimeoutMs,
  replication,
  replicationHints,
  interfaces = [],
  useDefaultInterfaces = true,
} = {}) {
  const n = node || new CRDTNode();
  const authService = createAuthService(n, auth);
  const secret = normalizeClusterSecret(clusterSecret ?? auth?.clusterSecret ?? auth?.jwtSecret);
  const guard = createMemoryGuard(memoryGuard);
  const scheduler = replication || createReplicationScheduler({ node: n, ...normalizeReplicationHintOptions(replicationHints) });
  const state = { node: n, auth: authService, server: null, port, router: null, memoryGuard: guard, replication: scheduler };

  if (shardMap) n.replaceShardMap(shardMapFromHttp(shardMap, n.id, { secret, timeoutMs: replicationTimeoutMs }));
  for (const peer of peers) n.addPeer(httpPeer(peer, n.id, { secret, timeoutMs: replicationTimeoutMs }));

  const router = new HttpRouter();
  const context = createInterfaceContext({
    node: n,
    shardMapStore,
    auth: authService,
    persistence,
    files,
    memoryGuard: guard,
    clusterSecret: secret,
    forwardTimeoutMs,
    replicationScheduler: scheduler,
  });
  const activeInterfaces = [
    ...(useDefaultInterfaces ? defaultInterfaces() : []),
    ...interfaces,
  ];
  for (const iface of activeInterfaces) await registerInterface(iface, router, context);

  const server = createServer(async (req, res) => {
    try {
      if (await router.handle(req, res)) return;
      json(res, 404, { error: "not found" });
    } catch (err) {
      if (!res.writableEnded) json(res, err.status || 500, { error: err.message });
    }
  });

  await new Promise((resolve) => server.listen(port, resolve));
  state.server = server;
  state.port = server.address().port;
  state.router = router;
  n.startVectorIndexWarmup().catch((err) => {
    console.error(`vector index warmup failed: ${err.message}`);
  });
  return state;
}

export function defaultInterfaces() {
  return [
    createClusterInterface(),
    createAuthInterface(),
    createPublicObjectInterface(),
    createUiInterface(),
  ];
}

export function createInterfaceContext({
  node,
  shardMapStore,
  auth,
  persistence,
  files,
  durability,
  memoryGuard,
  clusterSecret,
  forwardTimeoutMs,
  replicationScheduler,
}) {
  const durableWrite = durability || {
    afterWrite: () => persistence?.afterWrite?.() || Promise.resolve({ records: 0, ops: 0 }),
  };
  return {
    node,
    shardMapStore,
    auth,
    files,
    clusterSecret,
    memoryGuard,
    routing: new ShardRequestRouter({ node, forwardTimeoutMs }),
    replicationScheduler,
    durability: {
      ...durableWrite,
      afterWrite: async () => {
        const result = await durableWrite.afterWrite();
        replicationScheduler?.afterLocalWrite?.();
        return result;
      },
    },
    data: {
      node,
      store: node.db,
    },
    replication: {
      syncAll: () => node.syncAll(),
      httpPeer,
    },
    cluster: {
      shardMapStore,
      shardMapFromHttp,
    },
  };
}

function normalizeClusterSecret(secret) {
  return typeof secret === "string" && secret.length > 0 ? secret : null;
}

function normalizeReplicationHintOptions(options = {}) {
  const { enabled, ...rest } = options || {};
  return {
    ...rest,
    ...(enabled !== undefined ? { hintsEnabled: enabled } : {}),
  };
}

async function registerInterface(iface, router, context) {
  if (typeof iface === "function") {
    await iface(router, context);
    return;
  }
  if (iface && typeof iface.register === "function") {
    await iface.register(router, context);
    return;
  }
  throw new TypeError("interface must be a function or an object with register(router, context)");
}
