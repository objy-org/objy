import { test } from "node:test";
import assert from "node:assert/strict";
import { CRDTNode, localPeer } from "../src/crdt.js";
import { startServer } from "../src/server.js";

const TEST_AUTH = { jwtSecret: "test-jwt-secret" };

function startTestServer(options = {}) {
  return startServer({ auth: TEST_AUTH, ...options });
}

async function tokenFor(port) {
  const res = await fetch(`http://localhost:${port}/api/_global/users/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "123" }),
  });
  return (await res.json()).accessToken;
}

function shardMapFor(shardNames, peerByShard = {}) {
  return {
    shards: Object.fromEntries(
      shardNames.map((shard) => [shard, { peers: peerByShard[shard] || [] }]),
    ),
  };
}

test("top-level shards apply globally to every database and collection", () => {
  const a = new CRDTNode({ id: "a" });
  const b = new CRDTNode({ id: "b" });
  a.replaceShardMap({
    shards: {
      "shard-0": { peers: [localPeer(b)] },
      "shard-1": { peers: [] },
    },
  });

  assert.deepEqual(a.shardMapSnapshot(), {
    shards: {
      "shard-0": { peers: [{ nodeId: "b", key: "b" }] },
      "shard-1": { peers: [] },
    },
  });
  assert.deepEqual(a.shardMap.shardsForCollection("app", "users"), ["shard-0", "shard-1"]);
  assert.deepEqual(a.shardMap.shardsForCollection("analytics", "events"), ["shard-0", "shard-1"]);
  assert.equal(a.peersForShard("shard-0")[0].nodeId, "b");
});

test("HTTP shard map conversion accepts compact global shard maps", async () => {
  const a = await startTestServer({ port: 0, node: new CRDTNode({ id: "a" }) });
  try {
    const b = await startTestServer({
      port: 0,
      node: new CRDTNode({ id: "b" }),
      shardMap: {
        shards: {
          "shard-0": {
            peers: [{ url: `http://localhost:${a.port}` }],
          },
          "shard-1": {
            peers: [],
          },
        },
      },
    });
    try {
      const peer = b.node.peersForShard("shard-0")[0];
      assert.equal(peer.url, `http://localhost:${a.port}`);
      assert.equal(typeof peer.pull, "function");
    } finally {
      b.server.close();
    }
  } finally {
    a.server.close();
  }
});

test("peers are grouped by global shard", async () => {
  const a = new CRDTNode({ id: "a" });
  const b = new CRDTNode({ id: "b" });
  const c = new CRDTNode({ id: "c" });

  a.addPeerToShard({
    shard: "shard-0",
    peer: localPeer(b),
  });
  a.addPeerToShard({
    shard: "shard-1",
    peer: localPeer(c),
  });

  assert.equal(a.peersForShard("shard-0")[0].nodeId, "b");
  assert.equal(a.peersForShard("shard-1")[0].nodeId, "c");
  assert.deepEqual(a.shardMapSnapshot(), {
    shards: {
      "shard-0": {
        peers: [{ nodeId: "b", key: "b" }],
      },
      "shard-1": {
        peers: [{ nodeId: "c", key: "c" }],
      },
    },
  });
});

test("node url limits sync targets to shards owned by this node", () => {
  const node = new CRDTNode({ id: "node-a", url: "http://localhost:8080" });
  node.replaceShardMap({
    shards: {
      "shard-0": {
        peers: [
          { url: "http://localhost:8080" },
          { url: "http://localhost:8081" },
        ],
      },
      "shard-1": {
        peers: [
          { url: "http://localhost:8082" },
          { url: "http://localhost:8083" },
        ],
      },
    },
  });

  assert.deepEqual(node.ownedShardTargets().map((target) => target.shard), ["shard-0"]);
});

test("dynamic HTTP peer add updates the shard map and syncs", async () => {
  const shardMap = {
    shards: {
      "shard-0": {
        peers: [],
      },
    },
  };
  const a = await startTestServer({ port: 0, node: new CRDTNode({ id: "a" }), shardMap });
  const b = await startTestServer({ port: 0, node: new CRDTNode({ id: "b" }) });
  try {
    const token = await tokenFor(a.port);
    await fetch(`http://localhost:${a.port}/api/app/users/object`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: "u1", name: "Ada" }),
    });

    const add = await fetch(`http://localhost:${b.port}/cluster/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shard: "shard-0",
        url: `http://localhost:${a.port}`,
      }),
    });
    assert.equal(add.status, 201);

    const map = await (await fetch(`http://localhost:${b.port}/cluster/shards`)).json();
    assert.equal(map.shardMap.shards["shard-0"].peers[0].url, `http://localhost:${a.port}`);

    await b.node.syncAll();
    assert.deepEqual(b.node.get("app", "users", "u1"), { id: "u1", name: "Ada" });
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("server can start from a shard map", async () => {
  const a = await startTestServer({ port: 0, node: new CRDTNode({ id: "a" }) });
  try {
    const b = await startTestServer({
      port: 0,
      node: new CRDTNode({ id: "b" }),
      shardMap: {
        shards: {
          "shard-0": {
            peers: [{ url: `http://localhost:${a.port}` }],
          },
        },
      },
    });
    try {
      assert.equal(b.node.peersForShard("shard-0")[0].url, `http://localhost:${a.port}`);
    } finally {
      b.server.close();
    }
  } finally {
    a.server.close();
  }
});

test("replacing the shard map swaps peer membership", () => {
  const a = new CRDTNode({ id: "a" });
  const b = new CRDTNode({ id: "b" });
  const c = new CRDTNode({ id: "c" });

  a.addPeerToShard({ shard: "0", peer: localPeer(b) });
  a.replaceShardMap({
    shards: {
      "0": {
        peers: [localPeer(c)],
      },
    },
  });

  assert.equal(a.peersForShard("0").length, 1);
  assert.equal(a.peersForShard("0")[0].nodeId, "c");
});

test("large object-sharded dataset replicates only to owning shard nodes", async () => {
  const shardCount = 8;
  const objectCount = 4000;
  const replicas = Array.from({ length: shardCount }, (_, i) => new CRDTNode({ id: `replica-${i}` }));
  const writer = new CRDTNode({ id: "writer", syncBatchSize: 300 });
  const shardNames = Array.from({ length: shardCount }, (_, i) => `events-${i}`);

  writer.replaceShardMap(shardMapFor(shardNames));

  for (let i = 0; i < shardCount; i++) {
    replicas[i].replaceShardMap(shardMapFor(shardNames, { [`events-${i}`]: [localPeer(writer)] }));
  }

  const expected = new Map(shardNames.map((shard) => [shard, []]));
  for (let i = 0; i < objectCount; i++) {
    const id = `event-${i}`;
    const shard = writer.shardForObject("app", "events", id);
    expected.get(shard).push(id);
    writer.insert("app", "events", {
      id,
      kind: i % 5,
      payload: { bucket: i % 97 },
    });
  }

  await Promise.all(replicas.map((replica) => replica.syncAll()));

  for (let i = 0; i < shardCount; i++) {
    const shard = `events-${i}`;
    const replica = replicas[i];
    assert.equal(replica.count("app", "events"), expected.get(shard).length);

    for (const id of expected.get(shard).slice(0, 5)) {
      assert.equal(replica.get("app", "events", id).id, id);
    }

    const foreignShard = `events-${(i + 1) % shardCount}`;
    const foreignId = expected.get(foreignShard)[0];
    if (foreignId) assert.equal(replica.get("app", "events", foreignId), undefined);
  }
});

test("new shard replica recovers only its shard by scoped snapshot", async () => {
  const shardCount = 4;
  const initialReplicas = Array.from(
    { length: shardCount },
    (_, i) => new CRDTNode({ id: `initial-${i}` }),
  );
  const writer = new CRDTNode({ id: "writer", retainOps: 0, syncBatchSize: 128 });
  const shards = Object.fromEntries(initialReplicas.map((_, i) => [`events-${i}`, { peers: [] }]));

  writer.replaceShardMap({ shards });

  for (let i = 0; i < shardCount; i++) {
    initialReplicas[i].replaceShardMap(shardMapFor(Object.keys(shards), { [`events-${i}`]: [localPeer(writer)] }));
  }

  const byShard = new Map(Object.keys(shards).map((shard) => [shard, []]));
  for (let i = 0; i < 1200; i++) {
    const id = `event-${i}`;
    const shard = writer.shardForObject("app", "events", id);
    byShard.get(shard).push(id);
    writer.insert("app", "events", { id, value: i });
  }

  await Promise.all(initialReplicas.map((replica) => replica.syncAll()));
  assert.ok(writer.trimmed > 0, "writer pruned after initial shard replicas acked");

  const fresh = new CRDTNode({ id: "fresh" });
  fresh.replaceShardMap(shardMapFor(Object.keys(shards), { "events-0": [localPeer(writer)] }));

  await fresh.syncAll();
  assert.equal(fresh.count("app", "events"), byShard.get("events-0").length);

  for (const id of byShard.get("events-0").slice(0, 10)) {
    assert.equal(fresh.get("app", "events", id).id, id);
  }

  const foreignId = byShard.get("events-1")[0];
  assert.equal(fresh.get("app", "events", foreignId), undefined);
});
