import { createServer } from "node:http";
import { createAuthService } from "./auth.js";
import { localClusterStatus } from "./cluster-status.js";
import { CRDTNode } from "./crdt.js";
import { HttpRouter, json } from "./http-router.js";
import { createAuthInterface } from "./interfaces/auth.js";
import { createClusterInterface, httpPeer, shardMapFromHttp } from "./interfaces/cluster.js";
import { createPublicObjectInterface } from "./interfaces/public-object.js";
import { createUiInterface } from "./interfaces/ui.js";
import { createClientInterface } from "./interfaces/client.js";
import { createCorsHandler } from "./http-cors.js";
import { normalizeClusterSecret } from "./cluster-secret.js";
import { createMemoryGuard } from "./memory-guard.js";
import { createObjectHookRegistry, createObjectHookRunner } from "./object-hooks.js";
import { createReplicationScheduler } from "./replication-scheduler.js";
import { ShardRequestRouter } from "./shard-router.js";

export { createObjectHookRegistry, httpPeer, shardMapFromHttp };

export async function startRestoreStatusServer({
  port = 0,
  node,
  memoryGuard,
  replication,
  restoreStatus,
} = {}) {
  const n = node || new CRDTNode();
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        node: n.id,
        restoring: restoreStatus?.restoring === true,
        restore: restoreStatus?.snapshot?.() || null,
      });
    }
    if (url.pathname === "/api/config" || url.pathname === "/cluster/status") {
      return json(res, 200, {
        ...localClusterStatus(n, memoryGuard, replication, restoreStatus, {
          details: url.searchParams.get("details") === "1",
        }),
        local: true,
        reachable: true,
      });
    }
    return json(res, 503, {
      error: "database is restoring",
      restore: restoreStatus?.snapshot?.() || null,
    }, { "retry-after": "5" });
  });

  await new Promise((resolve) => server.listen(port, resolve));
  return { server, port: server.address().port };
}

export async function startServer({
  port = 0,
  peers = [],
  shardMap,
  node,
  shardMapStore,
  auth,
  persistence,
  durability,
  files,
  memoryGuard,
  clusterSecret,
  forwardTimeoutMs,
  replicationTimeoutMs,
  replication,
  restoreStatus,
  replicationHints,
  maxJsonBytes,
  imports,
  objectHooks,
  interfaces = [],
  useDefaultInterfaces = true,
  cors = false,
} = {}) {
  const handleCors = createCorsHandler(cors);
  const n = node || new CRDTNode();
  const authService = createAuthService(n, auth);
  const secret = normalizeClusterSecret(clusterSecret ?? auth?.clusterSecret ?? auth?.jwtSecret);
  const guard = createMemoryGuard(memoryGuard);
  const hookRunner = createObjectHookRunner(n, objectHooks || createObjectHookRegistry());
  const scheduler = replication || createReplicationScheduler({ node: n, ...normalizeReplicationHintOptions(replicationHints) });
  const state = { node: n, auth: authService, server: null, port, router: null, memoryGuard: guard, replication: scheduler, restoreStatus, objectHooks: hookRunner };
  if (persistence?.restoreScope) {
    n.setLogTruncatedHandler?.(({ scope }) => persistence.restoreScope(scope));
  }

  if (shardMap) n.replaceShardMap(shardMapFromHttp(shardMap, n.id, { secret, timeoutMs: replicationTimeoutMs }));
  for (const peer of peers) n.addPeer(httpPeer(peer, n.id, { secret, timeoutMs: replicationTimeoutMs }));

  const router = new HttpRouter({ maxBodyBytes: maxJsonBytes });
  const context = createInterfaceContext({
    node: n,
    shardMapStore,
    auth: authService,
    persistence,
    durability,
    files,
    memoryGuard: guard,
    restoreStatus,
    clusterSecret: secret,
    forwardTimeoutMs,
    replicationScheduler: scheduler,
    imports,
    objectHooks: hookRunner,
  });
  const activeInterfaces = [
    ...(useDefaultInterfaces ? defaultInterfaces() : []),
    ...interfaces,
  ];
  for (const iface of activeInterfaces) await registerInterface(iface, router, context);

  const server = createServer(async (req, res) => {
    try {
      if (handleCors(req, res)) return;
      if (await router.handle(req, res)) return;
      json(res, 404, { error: "not found" });
    } catch (err) {
      if (!res.writableEnded) json(res, err.status || 500, err.body || { error: err.message }, err.headers || {});
    }
  });
  server.once("close", () => hookRunner.dispose());

  await new Promise((resolve) => server.listen(port, resolve));
  state.server = server;
  state.port = server.address().port;
  state.router = router;
  n.startIndexWarmup?.();
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
    createClientInterface(),
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
  restoreStatus,
  clusterSecret,
  forwardTimeoutMs,
  replicationScheduler,
  imports,
  objectHooks,
}) {
  const durableWrite = durability || {
    afterWrite: () => persistence?.afterWrite?.() || Promise.resolve({ records: 0, ops: 0 }),
    getStats: () => persistence?.getStats?.() || null,
  };
  return {
    node,
    shardMapStore,
    auth,
    files,
    imports,
    clusterSecret,
    memoryGuard,
    restoreStatus,
    routing: new ShardRequestRouter({ node, forwardTimeoutMs, clusterSecret }),
    objectHooks,
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
