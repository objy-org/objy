import { test } from "node:test";
import assert from "node:assert/strict";
import { CRDTNode, localPeer } from "../src/crdt.js";

function shardMapFor(shardNames, peerByShard = {}) {
  return {
    shards: Object.fromEntries(
      shardNames.map((shard) => [shard, { peers: peerByShard[shard] || [] }]),
    ),
  };
}

function sortObjects(objects) {
  return objects.sort((a, b) => a.id.localeCompare(b.id));
}

function expectedForShard(source, shard, ids) {
  return sortObjects(
    ids
      .filter((id) => source.shardForObject("app", "events", id) === shard)
      .map((id) => source.get("app", "events", id))
      .filter(Boolean),
  );
}

function actualObjects(node) {
  return sortObjects(node.list("app", "events"));
}

test("large sharded cluster recovers failed replicas and converges", async () => {
  const shardCount = 6;
  const replicasPerShard = 3;
  const initialObjects = 6000;
  const mutationCount = 1200;
  const shardNames = Array.from({ length: shardCount }, (_, i) => `events-${i}`);
  const writer = new CRDTNode({ id: "writer", retainOps: 0, syncBatchSize: 256 });
  const replicas = new Map();

  writer.replaceShardMap(shardMapFor(shardNames));

  for (const shard of shardNames) {
    replicas.set(
      shard,
      Array.from({ length: replicasPerShard }, (_, i) => {
        const node = new CRDTNode({ id: `${shard}-replica-${i}`, syncBatchSize: 128 });
        node.replaceShardMap(shardMapFor(shardNames, { [shard]: [localPeer(writer)] }));
        return node;
      }),
    );
  }

  const ids = [];
  for (let i = 0; i < initialObjects; i++) {
    const id = `event-${i}`;
    ids.push(id);
    writer.insert("app", "events", {
      id,
      kind: i % 11,
      version: 0,
      active: true,
      payload: { bucket: i % 103, region: `r${i % 7}` },
    });
  }

  for (const shardReplicas of replicas.values()) {
    await Promise.all(shardReplicas.map((node) => node.syncAll()));
  }

  const failed = new Map();
  for (const [shard, shardReplicas] of replicas) {
    failed.set(shard, shardReplicas[0]);
  }

  for (let i = 0; i < mutationCount; i++) {
    const id = ids[(i * 17) % ids.length];
    if (i % 5 === 0) {
      writer.remove("app", "events", id);
    } else {
      writer.update("app", "events", id, {
        version: i + 1,
        active: i % 3 !== 0,
        payload: { bucket: i % 103, region: `r${i % 13}` },
      });
    }
  }

  for (const [shard, shardReplicas] of replicas) {
    const online = shardReplicas.filter((node) => node !== failed.get(shard));
    await Promise.all(online.map((node) => node.syncAll()));
  }

  assert.ok(writer.trimmed > 0, "online shard replicas acked enough for pruning");

  for (const [shard, failedNode] of failed) {
    assert.notDeepEqual(
      actualObjects(failedNode),
      expectedForShard(writer, shard, ids),
      `${failedNode.id} should be stale while failed`,
    );
  }

  for (const failedNode of failed.values()) {
    await failedNode.syncAll();
  }

  for (const [shard, shardReplicas] of replicas) {
    const expected = expectedForShard(writer, shard, ids);
    for (const replica of shardReplicas) {
      assert.deepEqual(actualObjects(replica), expected, `${replica.id} converged for ${shard}`);
    }
  }
});

test("multi-writer shard replicas converge after partition and heal", async () => {
  const shard = "events-0";
  const ids = Array.from({ length: 1500 }, (_, i) => `event-${i}`);
  const nodes = Array.from(
    { length: 5 },
    (_, i) => new CRDTNode({ id: `node-${i}`, retainOps: 64, syncBatchSize: 200 }),
  );

  for (const node of nodes) {
    node.replaceShardMap(
      shardMapFor([shard], {
        [shard]: nodes.filter((peer) => peer !== node).map(localPeer),
      }),
    );
  }

  for (let i = 0; i < ids.length; i++) {
    nodes[i % 2].insert("app", "events", {
      id: ids[i],
      owner: `seed-${i % 2}`,
      score: i,
    });
  }

  for (let round = 0; round < 3; round++) {
    await Promise.all(nodes.map((node) => node.syncAll()));
  }

  for (let i = 0; i < 900; i++) {
    const id = ids[(i * 13) % ids.length];
    if (i % 11 === 0) {
      nodes[3].remove("app", "events", id);
    } else {
      const node = nodes[i % nodes.length];
      node.update("app", "events", id, {
        owner: node.id,
        score: 10_000 + i,
      });
    }
  }

  await Promise.all(nodes.slice(0, 3).map((node) => node.syncAll()));
  assert.notDeepEqual(actualObjects(nodes[4]), actualObjects(nodes[0]), "partitioned node should lag");

  for (let round = 0; round < 6; round++) {
    await Promise.all(nodes.map((node) => node.syncAll()));
  }

  const expected = actualObjects(nodes[0]);
  for (const node of nodes.slice(1)) {
    assert.deepEqual(actualObjects(node), expected, `${node.id} converged after heal`);
  }
});
