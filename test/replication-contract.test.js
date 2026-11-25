import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { CRDTNode } from "../src/crdt.js";
import { httpPeer, startServer } from "../src/server.js";
import { createReplicationScheduler } from "../src/replication-scheduler.js";

async function peerServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return httpPeer(`http://127.0.0.1:${server.address().port}`, "replica");
}

function replica(t, pull) {
  const node = new CRDTNode({ id: "replica" });
  t.after(() => node.db.dispose());
  node.lastSeen.set("source", 7);
  const acks = [];
  const peer = { key: "source", nodeId: "source", pull, ack: async (_id, seq) => { acks.push(seq); } };
  return { node, peer, acks };
}

function operation(seq, extra = {}) {
  return { kind: "putObj", db: "db", coll: "items", id: `row-${seq}`, from: "source", seq,
    shard: "default", ts: { c: seq, n: "source" }, value: { score: seq }, ...extra };
}

for (const status of [401, 403, 404, 429, 500, 502, 503, 504]) {
  test(`replication HTTP ${status} fails pulls, hints and acknowledgements`, async (t) => {
    const peer = await peerServer(t, (_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: 200, node: "source", lastSeq: 99, ops: [], error: "peer unavailable" }));
    });
    for (const action of [() => peer.pull(7, 10), () => peer.hint({ scopes: [] }), () => peer.ack("replica", 7)]) {
      await assert.rejects(action, (error) => error.status === status && /unavailable/.test(error.message));
    }
  });
}

for (const [label, body] of [["HTML", "<h1>upstream unavailable</h1>"], ["empty", ""], ["array", "[]"]]) {
  test(`replication rejects a ${label} success body`, async (t) => {
    const peer = await peerServer(t, (_req, res) => { res.writeHead(200); res.end(body); });
    await assert.rejects(() => peer.pull(0, 10), { code: "INVALID_REPLICATION_RESPONSE" });
  });
}

test("HTTP status cannot be replaced by a JSON body status", async (t) => {
  const peer = await peerServer(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: 503, node: "source", lastSeq: 0, ops: [] }));
  });
  assert.equal((await peer.pull(0, 10)).status, 200);
});

for (const sequence of [undefined, "", "-1", "1.5", "not-a-number", "9007199254740992"]) {
  test(`NDJSON rejects an invalid sequence header: ${String(sequence)}`, { timeout: 5000 }, async (t) => {
    const peer = await peerServer(t, (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson", "x-objydb-node": "source",
        ...(sequence !== undefined ? { "x-objydb-last-seq": sequence } : {}) });
      res.flushHeaders();
    });
    await assert.rejects(() => peer.pull(0, 10), { code: "INVALID_REPLICATION_RESPONSE" });
  });
}

for (const [label, response] of [
  ["missing", null],
  ["HTTP error", { status: 503, error: "unavailable" }],
  ["missing identity", { lastSeq: 99, ops: [] }],
  ["local identity", { node: "replica", lastSeq: 99, ops: [] }],
  ["unknown catch-up origin", { node: "other", lastSeq: 99, ops: [] }],
  ["missing payload", { node: "source", lastSeq: 99 }],
  ["error payload", { node: "source", lastSeq: 99, ops: [], error: "failed" }],
  ["negative sequence", { node: "source", lastSeq: -1, ops: [] }],
  ["fractional sequence", { node: "source", lastSeq: 8.5, ops: [] }],
  ["unsafe sequence", { node: "source", lastSeq: Number.MAX_SAFE_INTEGER + 1, ops: [] }],
  ["regressed sequence", { node: "source", lastSeq: 6, ops: [] }],
]) {
  test(`${label} response cannot advance or acknowledge replication`, async (t) => {
    const { node, peer, acks } = replica(t, async () => response);
    await assert.rejects(() => node.syncPeer(peer, undefined, { until: { source: 8 } }));
    assert.equal(node.lastSeen.get("source"), 7);
    assert.deepEqual(acks, []);
    assert.equal(node.count("db", "items"), 0);
  });
}

test("catch-up cannot finish below its required sequence", async (t) => {
  const { node, peer, acks } = replica(t, async () => ({ node: "source", lastSeq: 7, ops: [] }));
  await assert.rejects(() => node.syncPeer(peer, undefined, { until: { source: 8 } }), { code: "REPLICATION_INCOMPLETE" });
  assert.equal(node.lastSeen.get("source"), 7);
  assert.deepEqual(acks, [7]);
});

for (const target of [-1, null, NaN, Infinity, "8"]) {
  test(`invalid catch-up target ${String(target)} cannot use the cached-cursor fast path`, async (t) => {
    const { node, peer } = replica(t, async () => { assert.fail("invalid targets must fail before pulling"); });
    await assert.rejects(() => node.syncPeer(peer, undefined, { until: { source: target } }), { code: "INVALID_REPLICATION_RESPONSE" });
    assert.equal(node.lastSeen.get("source"), 7);
  });
}

for (const streaming of [false, true]) {
  test(`${streaming ? "NDJSON" : "JSON"} catch-up accepts scoped sequence gaps and valid empty results`, async (t) => {
    const pulls = [];
    const { node, peer } = replica(t, async (after) => {
      pulls.push(after);
      const ops = after === 7 ? [operation(9)] : [];
      return { node: "source", lastSeq: 12, ...(streaming ? { opBatches: (async function* () { yield ops; })() } : { ops }) };
    });
    assert.equal(await node.syncPeer(peer, undefined, { until: { source: 12 } }), 1);
    assert.deepEqual(pulls, [7, 9]);
    assert.equal(node.lastSeen.get("source"), 12);
    assert.equal(node.get("db", "items", "row-9").score, 9);
  });
}

for (const invalid of [operation(8, { seq: 7 }), operation(8, { seq: 100 }), operation(8, { from: "other" }),
  operation(8, { kind: "invalid" }), operation(8, { id: "" }), operation(8, { ts: null })]) {
  test(`invalid batch ${JSON.stringify(invalid)} leaves data and cursors untouched`, async (t) => {
    const { node, peer, acks } = replica(t, async () => ({ node: "source", lastSeq: 9, ops: [invalid] }));
    await assert.rejects(() => node.syncPeer(peer), { code: "INVALID_REPLICATION_RESPONSE" });
    assert.equal(node.count("db", "items"), 0);
    assert.equal(node.lastSeen.get("source"), 7);
    assert.deepEqual(acks, []);
  });
}

test("an interrupted stream retains only its applied prefix and retries from that cursor", async (t) => {
  let interrupted = true;
  const { node, peer, acks } = replica(t, async (after) => ({ node: "source", lastSeq: 9,
    opBatches: (async function* () {
      if (after < 8) yield [operation(8)];
      if (interrupted) throw new Error("stream interrupted");
      yield [operation(9)];
    })(),
  }));
  await assert.rejects(() => node.syncPeer(peer), /stream interrupted/);
  assert.equal(node.lastSeen.get("source"), 8);
  assert.deepEqual(acks, [8]);
  assert.equal(node.count("db", "items"), 1);
  interrupted = false;
  assert.equal(await node.syncPeer(peer, undefined, { until: { source: 9 } }), 1);
  assert.equal(node.lastSeen.get("source"), 9);
  assert.equal(node.count("db", "items"), 2);
});

test("an out-of-order streamed batch cannot acknowledge its invalid suffix", async (t) => {
  const { node, peer, acks } = replica(t, async () => ({ node: "source", lastSeq: 10,
    opBatches: (async function* () { yield [operation(8)]; yield [operation(10), operation(9)]; })(),
  }));
  await assert.rejects(() => node.syncPeer(peer), { code: "INVALID_REPLICATION_RESPONSE" });
  assert.equal(node.lastSeen.get("source"), 8);
  assert.deepEqual(acks, [8]);
  assert.equal(node.count("db", "items"), 1);
});

test("bounded catch-up accepts the existing 410 durable recovery proof", async (t) => {
  const { node, peer } = replica(t, async () => ({ status: 410, node: "source", lastSeq: 12, durableThrough: 12 }));
  node.setLogTruncatedHandler(async () => ({ applied: 0 }));
  assert.equal(await node.syncPeer(peer, undefined, { until: { source: 12 } }), 0);
  assert.equal(node.lastSeen.get("source"), 12);
});

test("acknowledgement failure does not undo successfully received data", async (t) => {
  const { node, peer } = replica(t, async () => ({ node: "source", lastSeq: 8, ops: [operation(8)] }));
  peer.ack = async () => { throw Object.assign(new Error("ack unavailable"), { status: 503 }); };
  assert.equal(await node.syncPeer(peer, undefined, { until: { source: 8 } }), 1);
  assert.equal(node.lastSeen.get("source"), 8);
  assert.equal(node.get("db", "items", "row-8").score, 8);
});

test("failed HTTP hints are reported instead of counted as sent", async (t) => {
  const peer = await peerServer(t, (_req, res) => { res.writeHead(503); res.end(JSON.stringify({ error: "hint unavailable" })); });
  const node = new CRDTNode({ id: "source" });
  node.addPeer(peer);
  const scheduler = createReplicationScheduler({ node });
  t.after(async () => { await scheduler.stop(); node.db.dispose(); });
  node.insert("db", "items", { _id: "one" });
  await scheduler.flushHints();
  assert.equal(scheduler.status().hintsSent, 0);
  assert.equal(scheduler.status().lastHintSentAt, null);
  assert.match(scheduler.status().lastError, /hint unavailable/);
});

test("NDJSON pulls never stream operations beyond their advertised sequence", async (t) => {
  const node = new CRDTNode({ id: "source" });
  node.insert("db", "items", { _id: "before", score: 1 });
  const state = await startServer({ node, auth: false, bootstrapLogger: null, clusterSecret: "sequence-test", port: 0 });
  t.after(async () => {
    await state.replication.stop();
    state.server.closeAllConnections();
    await new Promise((resolve) => state.server.close(resolve));
    node.db.dispose();
  });
  const original = node._opsAfterIterable.bind(node);
  node._opsAfterIterable = function* (...args) {
    yield* original(...args);
    node.insert("db", "items", { _id: "during", score: 2 });
    yield node.log.at(-1);
  };
  const response = await httpPeer(`http://127.0.0.1:${state.port}`, "replica", { secret: "sequence-test" }).pull(0, 100);
  const ops = [];
  for await (const batch of response.opBatches) ops.push(...batch);
  assert.equal(response.lastSeq, 1);
  assert.deepEqual(ops.map((op) => op.id), ["before"]);
  assert.equal(node.seq, 2);
});
