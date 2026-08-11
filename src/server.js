import { createServer } from "node:http";
import { createAuthService } from "./auth.js";
import { CRDTNode } from "./crdt.js";
import { HttpRouter, json } from "./http-router.js";
import { createAuthInterface } from "./interfaces/auth.js";
import { createClusterInterface, httpPeer, shardMapFromHttp } from "./interfaces/cluster.js";
import { createPublicObjectInterface } from "./interfaces/public-object.js";
import { createUiInterface } from "./interfaces/ui.js";
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
  interfaces = [],
  useDefaultInterfaces = true,
} = {}) {
  const n = node || new CRDTNode();
  const authService = createAuthService(n, auth);
  const state = { node: n, auth: authService, server: null, port, router: null };

  if (shardMap) n.replaceShardMap(shardMapFromHttp(shardMap, n.id));
  for (const peer of peers) n.addPeer(httpPeer(peer, n.id));

  const router = new HttpRouter();
  const context = createInterfaceContext({ node: n, shardMapStore, auth: authService, persistence });
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

export function createInterfaceContext({ node, shardMapStore, auth, persistence, durability }) {
  return {
    node,
    shardMapStore,
    auth,
    routing: new ShardRequestRouter({ node }),
    durability: durability || {
      afterWrite: () => persistence?.afterWrite?.() || Promise.resolve({ records: 0, ops: 0 }),
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
