import { test } from "node:test";
import assert from "node:assert/strict";
import { CRDTNode, localPeer } from "../src/crdt.js";
import { createReplicationScheduler } from "../src/replication-scheduler.js";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(10);
  }
  assert.ok(check(), "condition did not become true before timeout");
}

test("local writes coalesce into one shard hint per peer", async () => {
  const source = new CRDTNode({ id: "source" });
  const hints = [];
  const peer = {
    key: "peer",
    url: "http://peer",
    hint: async (body) => hints.push(body),
  };
  source.replaceShardMap({
    shards: {
      "shard-a": { peers: [peer] },
    },
  });
  const scheduler = createReplicationScheduler({ node: source, debounceMs: 0 });

  try {
    source.insertMany("app", "events", [
      { _id: "a", value: 1 },
      { _id: "b", value: 2 },
      { _id: "c", value: 3 },
    ]);
    await scheduler.flushHints();

    assert.equal(hints.length, 1);
    assert.equal(hints[0].node, "source");
    assert.deepEqual(hints[0].scopes.map((scope) => scope.shard), ["shard-a"]);
  } finally {
    await scheduler.stop();
  }
});

test("received hints trigger existing pull replication without re-hinting remote ops", async () => {
  const source = new CRDTNode({ id: "source" });
  const replica = new CRDTNode({ id: "replica" });
  const outgoingHints = [];
  const sourcePeer = localPeer(source);
  const replicaPeer = {
    key: "replica",
    nodeId: "replica",
    hint: async (body) => outgoingHints.push(body),
  };
  const shardMap = {
    shards: {
      default: { peers: [sourcePeer, replicaPeer] },
    },
  };
  source.replaceShardMap(shardMap);
  replica.replaceShardMap(shardMap);
  const scheduler = createReplicationScheduler({ node: replica, debounceMs: 0 });

  try {
    source.insert("app", "events", { _id: "e1", value: 1 });
    const result = scheduler.receiveHint({
      node: "source",
      scopes: [{ shard: "default", lastSeq: source.seq }],
    });

    assert.deepEqual(result, { accepted: 1, matchedPeer: true });
    await waitFor(() => replica.get("app", "events", "e1")?.value === 1);
    await scheduler.flushHints();
    assert.equal(outgoingHints.length, 0);
  } finally {
    await scheduler.stop();
  }
});

test("unknown hint senders are rejected before pull scheduling", async () => {
  const node = new CRDTNode({ id: "replica" });
  node.replaceShardMap({
    shards: {
      default: { peers: [localPeer(new CRDTNode({ id: "known" }))] },
    },
  });
  const scheduler = createReplicationScheduler({ node });

  try {
    const result = scheduler.receiveHint({
      node: "unknown",
      scopes: [{ shard: "default" }],
    });
    assert.deepEqual(result, { accepted: 0, matchedPeer: false });
    assert.equal(scheduler.status().queuedPulls, 0);
  } finally {
    await scheduler.stop();
  }
});

test("anti-entropy status reports partial failures and clears stale errors after success", async () => {
  const source = new CRDTNode({ id: "source" });
  const replica = new CRDTNode({ id: "replica" });
  source.insert("app", "events", { _id: "e1", value: 1 });

  const flakyPeer = {
    key: "flaky",
    pull: async () => {
      throw new Error("offline");
    },
  };
  replica.replaceShardMap({
    shards: {
      default: { peers: [localPeer(source), flakyPeer] },
    },
  });
  const scheduler = createReplicationScheduler({ node: replica });

  try {
    await scheduler.syncAll("anti-entropy");
    assert.equal(replica.get("app", "events", "e1").value, 1);
    assert.equal(scheduler.status().lastSyncFailures.length, 1);
    assert.match(scheduler.status().lastError, /sync: 1 peer sync\(s\) failed/);
    assert.equal(scheduler.status().lastSyncAt, null);

    flakyPeer.pull = async () => ({ status: 200, nodeId: "flaky", lastSeq: 0, ops: [] });
    await scheduler.syncAll("anti-entropy");
    assert.deepEqual(scheduler.status().lastSyncFailures, []);
    assert.equal(scheduler.status().lastError, null);
    assert.ok(scheduler.status().lastSyncAt);
  } finally {
    await scheduler.stop();
  }
});
