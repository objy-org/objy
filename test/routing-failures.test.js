import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { CRDTNode } from "../src/crdt.js";
import { startServer, shardMapFromHttp, httpPeer } from "../src/server.js";
import { ShardRequestRouter } from "../src/shard-router.js";
import { ndjsonReadable } from "../src/ndjson.js";

const SECRET = "routing-failure-test";

async function pair(t) {
  const states = [];
  t.after(async () => {
    for (const state of states) {
      await state.replication.stop();
      state.server.closeAllConnections();
      await new Promise((resolve) => state.server.close(resolve));
      state.node.db.dispose();
    }
  });
  for (const id of ["a", "b", "entry"]) {
    states.push(await startServer({ node: new CRDTNode({ id, retainOps: 10000 }), port: 0,
      auth: false, clusterSecret: SECRET, bootstrapLogger: null }));
  }
  const urls = states.map((state) => `http://127.0.0.1:${state.port}`);
  const map = { shards: { s0: { peers: urls.slice(0, 2).map((url) => ({ url })) } } };
  for (const [i, state] of states.entries()) {
    state.node.url = urls[i];
    state.node.replaceShardMap(shardMapFromHttp(map, state.node.id, { secret: SECRET }));
    state.replication.enabled = false;
  }
  const request = async (i, method, body, streaming = false) => {
    const response = await fetch(`${urls[i]}/api/test/items/object`, { method,
      headers: { "content-type": streaming ? "application/x-ndjson" : "application/json", prefer: "return=minimal" },
      body: streaming ? ndjsonReadable(body) : JSON.stringify(body), ...(streaming ? { duplex: "half" } : {}),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { states, request, urls };
}

for (const streaming of [false, true]) {
  test(`writes on a stale replica do not trigger synchronous catch-up (${streaming ? "NDJSON" : "JSON"})`, async (t) => {
    const { states: [a, b], request } = await pair(t);
    const created = await request(0, "POST", [{ _id: "not-replicated", value: 1 }], streaming);
    assert.equal(created.status, 201);
    assert.equal(created.headers.has("x-objydb-write-context"), false);
    let pulls = 0;
    b.node.peersForShard("s0")[0].pull = async () => { pulls++; throw new Error("partition"); };
    const patched = await request(1, "PATCH", [{ _id: "not-replicated", $set: { value: 2 } }], streaming);
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.updated, 0);
    assert.equal(patched.body.skipped, 1);
    assert.equal(patched.headers.has("x-objydb-write-context"), false);
    assert.equal((await request(1, "POST", [{ _id: "survivor", value: 3 }], streaming)).status, 201);
    assert.equal(pulls, 0);
    assert.equal(a.node.get("test", "items", "not-replicated").value, 1);
    assert.equal(b.node.get("test", "items", "not-replicated"), undefined);
    assert.equal(b.node.get("test", "items", "survivor").value, 3);
  });
}

test("an applied write with a failed acknowledgement is not re-originated on a fallback", async (t) => {
  const { states: [a, b], request } = await pair(t);
  a.auth.durability.afterWrite = async () => { throw Object.assign(new Error("acknowledgement failed after mutation"), { status: 503 }); };
  const response = await request(2, "POST", [{ _id: "uncertain", value: 1 }], true);
  assert.equal(response.status, 503);
  assert.equal(a.node.get("test", "items", "uncertain").value, 1);
  assert.equal(b.node.get("test", "items", "uncertain"), undefined);
  assert.equal(b.node.seq, 0);
});

test("surviving replicas remain writable without electing a write owner", async (t) => {
  const { states: [a, b], request } = await pair(t);
  b.node.peersForShard("s0")[0].pull = async () => { throw new Error("primary down"); };
  assert.equal((await request(1, "POST", [{ _id: "survivor", value: 1 }])).status, 201);
  assert.equal((await request(1, "PATCH", [{ _id: "survivor", $set: { value: 2 } }])).body.updated, 1);
  assert.equal(b.node.get("test", "items", "survivor").value, 2);
  assert.equal(a.node.get("test", "items", "survivor"), undefined);
});

test("forwarded handover errors are reframed after the handling flag changes", async (t) => {
  const { states: [a, b], urls } = await pair(t);
  a.migration.sealed = b.migration.sealed = true;
  const response = await fetch(`${urls[2]}/api/test/items/object/unavailable`, { signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(body));
  assert.equal(JSON.parse(body).operationStarted, true);
});

test("replication timeouts and cancellation cover a body stalled after headers", { timeout: 5000 }, async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson", "x-objydb-node": "source", "x-objydb-last-seq": "1" });
    res.flushHeaders();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await httpPeer(url, "test", { timeoutMs: 25 }).pull(0, 10);
  await assert.rejects(async () => { for await (const _batch of response.opBatches) assert.fail("unexpected row"); });
  const controller = new AbortController();
  const cancelled = await httpPeer(url, "test", { timeoutMs: 60_000 }).pull(0, 10, undefined, { signal: controller.signal });
  controller.abort();
  await assert.rejects(async () => { for await (const _batch of cancelled.opBatches) assert.fail("unexpected row"); });
});

for (const mode of ["forwardJson", "forwardNdjson", "forwardRaw"]) {
  test(`${mode} never retries an ambiguous mutation on a different replica`, async () => {
    const node = new CRDTNode({ id: "entry", url: "http://entry", shardMap: { shards: { s: { peers: [{ url: "http://first" }, { url: "http://second" }] } } } });
    const router = new ShardRequestRouter({ node });
    const attempts = [];
    router[mode] = async (_req, peer) => { attempts.push(peer.url); throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); };
    const method = mode === "forwardNdjson" ? "forwardToShardNdjson" : mode === "forwardRaw" ? "forwardToShardRaw" : "forwardToShard";
    const response = await router[method]({ headers: {} }, "s", "/object", { method: "PATCH", items: [], body: [] });
    assert.equal(response.status, 503);
    assert.deepEqual(attempts, ["http://first"]);
    attempts.length = 0;
    router[mode] = async (_req, peer) => {
      attempts.push(peer.url);
      if (peer.url === "http://first") throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      return { status: 200, body: { updated: 1 } };
    };
    assert.equal((await router[method]({ headers: {} }, "s", "/object", { method: "PATCH", items: [], body: [] })).status, 200);
    assert.deepEqual(attempts, ["http://first", "http://second"]);
    attempts.length = 0;
    router[mode] = async (_req, peer) => {
      attempts.push(peer.url);
      return peer.url === "http://first" ? { status: 503, body: { operationStarted: false } } : { status: 200, body: { updated: 1 } };
    };
    assert.equal((await router[method]({ headers: {} }, "s", "/object", { method: "PATCH", items: [], body: [] })).status, 200);
    assert.deepEqual(attempts, ["http://first", "http://second"]);
    attempts.length = 0;
    router[mode] = async (_req, peer) => { attempts.push(peer.url); return { status: 503, body: { operationStarted: true } }; };
    assert.equal((await router[method]({ headers: {} }, "s", "/object", { method: "PATCH", items: [], body: [] })).status, 503);
    assert.deepEqual(attempts, ["http://first"]);
    node.db.dispose();
  });
}
