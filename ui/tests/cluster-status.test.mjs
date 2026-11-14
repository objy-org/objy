import test from "node:test";
import assert from "node:assert/strict";
import { clusterNodes, ClusterMonitor } from "../src/data/cluster-status.js";
import { createServerAdapter } from "../src/data/adapters.js";
import { testServer } from "./helpers/server.mjs";

const config = (id) => ({
  nodes: [
    { node: { id }, reachable: true, memory: { rss: 20, systemTotal: 100 } },
  ],
});

test("node memory uses container/config limits, preserves offline peers, and never invents missing usage", () => {
  const nodes = clusterNodes({
    nodes: [
      {
        node: { id: "first" },
        memory: { rss: 10, systemTotal: 1000 },
        memoryGuard: { rss: 20, limitBytes: 50 },
      },
      { node: { id: "second" }, memory: { rss: 0, systemTotal: 100 } },
      {
        node: { id: "third" },
        reachable: false,
        memory: { rss: 25, systemTotal: 100 },
      },
      { node: { id: "fourth" }, memory: { rss: 25, systemTotal: 0 } },
      { node: { id: "fifth" }, memory: { rss: 125, systemTotal: 100 } },
      { node: { id: "sixth" }, memory: { rss: null, systemTotal: 100 } },
    ],
  });
  assert.deepEqual(
    nodes.map((node) => node.percent),
    [20, 0, null, null, 125, null],
  );
  assert.equal(nodes[0].limitKind, "node limit");
  assert.equal(nodes[1].limitKind, "host memory");
  assert.equal(nodes[2].reachable, false);
  assert.equal(nodes[2].used, null);
  assert.throws(() => clusterNodes({}), /did not return/);
});

test("config uses the authenticated official-client request path and the session lock", async (t) => {
  const server = await testServer({
    auth: { enabled: true },
    environment: { OBJYDB_ADMIN_PASSWORD: "cluster-test-only" },
  });
  t.after(() => server.close());
  let requests = 0,
    locks = 0;
  const adapter = createServerAdapter({
    url: server.url,
    username: "admin",
    password: "cluster-test-only",
    sessionAccess: async (_controls, execute) => {
      locks++;
      return execute();
    },
    fetch: async (url, init) => {
      if (new URL(url).pathname === "/api/config") {
        requests++;
        assert.equal(new URL(url).searchParams.get("details"), "1");
        assert.equal(init.method, "GET");
        assert.match(init.headers.get("authorization"), /^Bearer /);
      }
      return fetch(url, init);
    },
  });
  t.after(() => adapter.close());
  await adapter.open();
  const status = await adapter.getClusterStatus({ details: true });
  assert.equal(requests, 1);
  assert.equal(locks, 1);
  const [node] = clusterNodes(status);
  assert.ok(node.label);
  assert.equal(node.reachable, true);
  assert.ok(node.used > 0);
  assert.ok(node.limit > 0);
  assert.ok(node.percent > 0);
  assert.equal("heapUsed" in node, false);
  assert.equal(node.workers.active, 0);
  assert.ok(node.indexes.ready >= 1);
  assert.equal(node.compression.savedBytes, 0);
  assert.ok(node.uptimeMs >= 0);
  assert.ok(node.shardCount >= 0);
});

test("node details clear unavailable telemetry without inventing healthy states", () => {
  const entry = {
    node: { id: "worker", url: "http://localhost:8080" },
    memory: { heapUsed: 20, heapTotal: 40, heapLimit: 100 },
    process: { uptimeMs: 0 },
    ownedShards: [],
    memoryGuard: { acceptingWrites: false },
    replication: { healthy: false, error: "peer unreachable" },
    restoring: true,
  };
  const [node] = clusterNodes({ nodes: [entry] });
  assert.equal("heapPercent" in node, false);
  assert.equal(node.uptimeMs, 0);
  assert.equal(node.shardCount, 0);
  assert.equal(node.acceptingWrites, false);
  assert.equal(node.replication, "Needs attention");
  assert.equal(node.restoring, true);
  const [offline] = clusterNodes({ nodes: [{ ...entry, reachable: false }] });
  assert.equal(offline.key, node.key);
  for (const field of [
    "workers",
    "indexes",
    "compression",
    "uptimeMs",
    "shardCount",
    "acceptingWrites",
    "replication",
  ])
    assert.equal(offline[field], null);
  const [missing] = clusterNodes({
    nodes: [{ node: entry.node, memory: { heapUsed: -1, heapLimit: 0 } }],
  });
  for (const field of [
    "workers",
    "indexes",
    "compression",
    "uptimeMs",
    "shardCount",
    "acceptingWrites",
    "replication",
  ])
    assert.equal(missing[field], null);
  assert.equal(
    clusterNodes({ nodes: [{ ...entry, replication: { healthy: true } }] })[0]
      .replication,
    "In sync",
  );
  assert.equal(
    clusterNodes({ nodes: [{ ...entry, replication: { healthy: false } }] })[0]
      .replication,
    "Syncing",
  );
});

test("a config permission failure keeps the authenticated session usable for database work", async (t) => {
  const server = await testServer({
    auth: { enabled: true },
    environment: { OBJYDB_ADMIN_PASSWORD: "cluster-test-only" },
  });
  t.after(() => server.close());
  const adapter = createServerAdapter({
    url: server.url,
    username: "admin",
    password: "cluster-test-only",
    fetch: (url, init) =>
      new URL(url).pathname === "/api/config"
        ? Promise.resolve(new Response('{"error":"Denied"}', { status: 403 }))
        : fetch(url, init),
  });
  t.after(() => adapter.close());
  await adapter.open();
  const token = adapter.getSession().accessToken;
  await assert.rejects(
    adapter.getClusterStatus(),
    (error) => error.status === 403,
  );
  assert.equal(adapter.getSession().accessToken, token);
  assert.ok((await adapter.listDatabases()).includes("_global"));
});

test("switching or forgetting a connection rejects its late telemetry and cancels its request", async (t) => {
  const changes = [],
    monitor = new ClusterMonitor({ onChange: (state) => changes.push(state) });
  t.after(() => monitor.close());
  let resolveFirst, signal;
  const first = monitor.setSource({
    getClusterStatus: (options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    },
  });
  await Promise.resolve();
  await monitor.setSource({ getClusterStatus: async () => config("second") });
  assert.equal(signal.aborted, true);
  resolveFirst(config("first"));
  await first;
  assert.equal(monitor.state.nodes[0].label, "second");
  assert.ok(
    !changes.some((state) =>
      state.nodes.some((node) => node.label === "first"),
    ),
  );
  monitor.setSource(null);
  assert.equal(monitor.state.status, "idle");
  assert.deepEqual(monitor.state.nodes, []);
});

test("manual refresh coalesces requests and requests detailed config", async (t) => {
  const monitor = new ClusterMonitor();
  t.after(() => monitor.close());
  let requests = 0,
    resolve;
  const source = {
    getClusterStatus: (options) => {
      assert.equal(options.details, true);
      requests++;
      return new Promise((done) => {
        resolve = done;
      });
    },
  };
  const first = monitor.setSource(source);
  await Promise.resolve();
  assert.equal(monitor.refresh(), first);
  assert.equal(monitor.state.refreshing, true);
  assert.equal(requests, 1);
  resolve(config("first"));
  await first;
  assert.ok(monitor.state.updatedAt > 0);
  assert.ok(!monitor.state.refreshing);
  monitor.setSource(source);
  assert.equal(requests, 1);
  const second = monitor.refresh();
  await Promise.resolve();
  assert.equal(requests, 2);
  resolve(config("first"));
  await second;
});

test("no timed refresh or retry; explicit refresh clears failures and recovers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const monitor = new ClusterMonitor();
  t.after(() => monitor.close());
  let requests = 0;
  await monitor.setSource({
    getClusterStatus: async () => {
      if (++requests === 2)
        throw Object.assign(new Error("Denied"), { status: 403 });
      return config("first");
    },
  });
  assert.equal(monitor.state.nodes.length, 1);
  t.mock.timers.tick(3_600_000);
  await Promise.resolve();
  assert.equal(requests, 1);
  await monitor.refresh();
  assert.equal(requests, 2);
  assert.deepEqual(monitor.state.nodes, []);
  assert.match(monitor.state.error, /global administrator/);
  t.mock.timers.tick(3_600_000);
  await Promise.resolve();
  assert.equal(requests, 2);
  await monitor.refresh();
  assert.equal(requests, 3);
  assert.equal(monitor.state.status, "ready");
});

test("detailed metrics are per-node, retain zeroes, and distinguish absent values", () => {
  const indexes = {
    ready: 3,
    building: 2,
    error: 1,
    workers: {
      fieldIndex: { active: 2, type: "same_thread_task" },
      columns: { active: 0, type: "same_thread_task" },
      vectorIndex: { active: 1, type: "same_thread_task" },
    },
  };
  const compression = {
    nodes: [
      {
        nodeId: "second",
        savedBytes: 900,
        savedPercent: 90,
        compressedObjects: 10,
      },
      {
        nodeId: "first",
        savedBytes: 50,
        savedPercent: 25,
        compressedObjects: 2,
      },
    ],
  };
  const [first, second, missing, offline] = clusterNodes({
    nodes: [
      { node: { id: "first" }, indexes },
      {
        node: { id: "second" },
        indexes: {
          ready: 0,
          building: 0,
          error: 0,
          workers: { columns: { active: 0 } },
        },
      },
      {
        node: { id: "missing" },
        indexes: {
          ready: null,
          building: 0,
          error: 0,
          workers: { columns: { active: null } },
        },
      },
      { node: { id: "first" }, indexes, reachable: false },
    ],
    compression,
  });
  assert.deepEqual(first.indexes, {
    ready: 3,
    building: 2,
    error: 1,
    total: 6,
    percent: 50,
  });
  assert.equal(first.workers.active, 3);
  assert.deepEqual(
    first.workers.groups.map((g) => g.active),
    [2, 0, 1],
  );
  assert.equal(first.compression.savedBytes, 50);
  assert.equal(second.compression.savedBytes, 900);
  assert.equal(second.indexes.total, 0);
  assert.equal(second.indexes.percent, null);
  assert.equal(second.workers.active, 0);
  assert.equal(missing.indexes, null);
  assert.equal(missing.workers.active, null);
  assert.equal(missing.compression, null);
  assert.equal(offline.indexes, null);
  assert.equal(offline.workers, null);
  assert.equal(offline.compression, null);
  const [overhead] = clusterNodes({
    nodes: [{ node: { url: "http://only-url" } }],
    compression: {
      nodes: [
        {
          url: "http://only-url",
          savedBytes: -20,
          savedPercent: -5,
          compressedObjects: 1,
        },
      ],
    },
  });
  assert.equal(overhead.compression.savedBytes, -20);
  assert.equal(overhead.compression.savedPercent, -5);
});
