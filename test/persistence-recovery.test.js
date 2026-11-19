import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CRDTNode, localPeer } from "../src/crdt.js";
import { PersistenceManager } from "../src/persistence.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { parseNdjsonStream } from "../src/ndjson.js";
import { PrimaryStateStore } from "../src/primary-state.js";
import { readPublished, writePublished } from "./helpers/primary-state.js";

const scope = { database: "app", collection: "items", shard: "default" };
const base = "objydb/db/app/collection/items/shard/default";

function fixture(t, storage = new MemoryObjectStorage()) {
  const nodes = [], managers = [];
  t.after(() => {
    for (const manager of managers) manager.unsubscribe?.();
    for (const node of nodes) node.db.dispose();
  });
  return {
    storage,
    node(id) {
      const node = new CRDTNode({ id });
      nodes.push(node);
      return node;
    },
    persistence(node, options = {}) {
      const manager = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0, opBatchSize: 100_000, ...options });
      managers.push(manager);
      return manager;
    },
  };
}

test("journal recovery uses each operation's origin, not its receiving writer", async (t) => {
  const f = fixture(t), receiver = f.node("receiver"), p = f.persistence(receiver);
  p.start();
  receiver.insertManyCount("app", "items", Array.from({ length: 10 }, (_, i) => ({ _id: String(i), value: i })));
  await p.checkpoint();
  receiver.applyRemote("origin", [{
    kind: "putObj", db: "app", coll: "items", id: "0", value: { value: 999 },
    ts: { c: 50, n: "origin" }, from: "origin", seq: 1, shard: "default",
  }], receiver._cursorKey("origin", scope));
  await p.flush();
  const [journal] = await f.storage.list(`${base}/journal/origin/`);
  const oldKey = `${base}/journal/receiver/1700000000000-0000000000000001-0000000000000001-mixed.jsonl`;
  await f.storage.put(oldKey, await f.storage.get(journal));
  await f.storage.delete([journal]);
  const restored = f.node("restored");
  await f.persistence(restored).restore();
  assert.deepEqual(restored.get("app", "items", "0"), { _id: "0", value: 999 });
  assert.equal(restored.lastSeen.get(restored._cursorKey("origin", scope)), 1);
  assert.equal(restored.lastSeen.get(restored._cursorKey("receiver", scope)), 10);
});

test("journal cleanup preserves remote tails outside the snapshot cut", async (t) => {
  let duringUpload;
  class Storage extends MemoryObjectStorage {
    async put(key, body, type) {
      await super.put(key, body, type);
      if (duringUpload && key.includes("/snapshots/") && key.endsWith(".jsonl")) {
        const action = duringUpload;
        duringUpload = null;
        await action();
      }
    }
  }
  const f = fixture(t, new Storage()), primary = f.node("primary"), receiver = f.node("receiver"), origin = f.node("origin");
  const p = f.persistence(receiver);
  p.start();
  receiver.insertManyCount("app", "items", Array.from({ length: 10 }, (_, i) => ({ _id: String(i), value: i })));
  await p.flush();
  primary.applyRemote("receiver", structuredClone(receiver.log), primary._cursorKey("receiver", scope));
  origin.insert("app", "items", { _id: "padding" });
  origin.applyRemote("receiver", structuredClone(receiver.log), origin._cursorKey("receiver", scope));
  origin.update("app", "items", "0", { value: 999 });
  duringUpload = async () => {
    receiver.applyRemote("origin", [structuredClone(origin.log.at(-1))], receiver._cursorKey("origin", scope));
    await p.flush();
    const [journal] = await f.storage.list(`${base}/journal/origin/`);
    await f.storage.put(`${base}/journal/receiver/1700000000000-0000000000000002-0000000000000002-mixed.jsonl`, await f.storage.get(journal));
    await f.storage.delete([journal]);
  };
  await f.persistence(primary).checkpoint();
  const restored = f.node("restored");
  await f.persistence(restored).restore();
  assert.deepEqual(restored.get("app", "items", "0"), { _id: "0", value: 999 });
});

test("new journals have one verified origin and covered files need no body read", async (t) => {
  const f = fixture(t), node = f.node("receiver"), p = f.persistence(node, { journalRetention: { keepLatest: 10 } });
  p.start();
  node.insert("app", "items", { _id: "local", value: 1 });
  node.applyRemote("origin", [{ kind: "putObj", db: "app", coll: "items", id: "remote", value: { value: 2 }, from: "origin", seq: 1, ts: { c: 5, n: "origin" }, shard: "default" }], node._cursorKey("origin", scope));
  await p.flush();
  const keys = await f.storage.list(`${base}/journal/`);
  assert.equal(keys.length, 2);
  for (const key of keys) {
    assert.match(key, /\.origin\.jsonl$/);
    const origin = decodeURIComponent(key.split("/").at(-2));
    for (const line of (await f.storage.get(key)).trim().split("\n")) assert.equal(JSON.parse(line).from, origin);
  }
  await p.checkpoint();
  const getStream = f.storage.getStream.bind(f.storage);
  f.storage.getStream = async (key) => {
    assert.ok(!key.includes("/journal/"), "covered verified journals should not be downloaded");
    return getStream(key);
  };
  const restored = f.node("restored");
  await f.persistence(restored).restore();
  assert.equal(restored.count("app", "items"), 2);
});

test("unknown journal origins are replayed conservatively without inventing coverage", async (t) => {
  const f = fixture(t), writer = f.node("writer");
  writer.insert("app", "items", { _id: "x", value: 1 });
  await f.persistence(writer).checkpoint();
  await f.storage.put(`${base}/journal/writer/1700000000000-0000000000000001-0000000000000001-unknown.jsonl`, JSON.stringify({
    kind: "putObj", db: "app", coll: "items", id: "x", value: { value: 999 }, seq: 1, ts: { c: 50, n: "unknown" }, shard: "default",
  }) + "\n");
  const restored = f.node("writer");
  await f.persistence(restored).restore();
  assert.equal(restored.get("app", "items", "x").value, 999);
  assert.equal(restored.lastSeen.get(restored._cursorKey("writer", scope)), 1);
});

test("journals cannot inject operations into another context", async (t) => {
  const f = fixture(t);
  await f.storage.put(`${base}/journal/writer/invalid.jsonl`, JSON.stringify({
    kind: "putObj", db: "other", coll: "items", id: "x", value: {}, from: "writer", seq: 1, ts: { c: 1, n: "writer" }, shard: "default",
  }) + "\n");
  await assert.rejects(f.persistence(f.node("restored")).restore(), /another context/);
});

test("restoring a peer snapshot preserves the local sequence through another restart", async (t) => {
  const f = fixture(t), writer = f.node("writer"), peer = f.node("peer");
  writer.insertManyCount("app", "items", Array.from({ length: 5 }, (_, i) => ({ _id: String(i), value: i })));
  peer.applyRemote("writer", structuredClone(writer.log), peer._cursorKey("writer", scope));
  await f.persistence(peer).checkpoint();
  const first = f.node("writer"), p = f.persistence(first);
  await p.restore();
  assert.equal(first.seq, 5);
  p.start();
  first.insert("app", "items", { _id: "after-restart", value: 999 });
  await p.flush();
  assert.equal(first.seq, 6);
  const second = f.node("writer");
  await f.persistence(second).restore();
  assert.deepEqual(second.get("app", "items", "after-restart"), { _id: "after-restart", value: 999 });
});

for (const shards of [["default"], ["left", "right"]]) {
  test(`snapshot coverage includes real replication cursors for ${shards.join(", ")}`, async (t) => {
    const f = fixture(t), origin = f.node("origin"), replica = f.node("replica");
    origin.replaceShardMap({ shards: Object.fromEntries(shards.map((name) => [name, { peers: [] }])) });
    replica.replaceShardMap({ shards: Object.fromEntries(shards.map((name) => [name, { peers: [localPeer(origin)] }])) });
    origin.insertManyCount("app", "items", Array.from({ length: 100 }, (_, i) => ({ _id: String(i), value: i })));
    await replica.syncAll();
    assert.equal(replica.count("app", "items"), 100);
    await f.persistence(replica).checkpoint();
    const restored = f.node("origin");
    await f.persistence(restored).restore();
    assert.equal(restored.seq, 100);
    assert.equal(restored.count("app", "items"), 100);
  });
}

test("WAL-only recovery remains durable through new writes and a second crash", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "objy-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = fixture(t), options = { ack: "localWal", localWal: { mode: "on", dir, fsync: true } };
  const first = f.node("writer"), p1 = f.persistence(first, options);
  p1.start();
  first.createCollection("app", "items", { indexes: ["value"] });
  first.insert("app", "items", { _id: "before-crash", value: 1 });
  await p1.afterWrite();
  p1.unsubscribe();
  const second = f.node("writer"), p2 = f.persistence(second, options);
  await p2.restore();
  p2.start();
  second.insert("app", "items", { _id: "after-crash", value: 2 });
  await p2.afterWrite();
  await p2.flush();
  assert.equal((await readFile(p2.localWal.filePath, "utf8")).length, 0);
  p2.unsubscribe();
  const third = f.node("writer");
  await f.persistence(third, options).restore();
  assert.deepEqual(third.get("app", "items", "before-crash"), { _id: "before-crash", value: 1 });
  assert.deepEqual(third.get("app", "items", "after-crash"), { _id: "after-crash", value: 2 });
  assert.deepEqual(third.getCollectionMeta("app", "items").indexes, ["value"]);
});

for (const format of ["jsonl", "json"]) {
  test(`streamed ${format} snapshots preserve Unicode across byte boundaries`, async (t) => {
    class Storage extends MemoryObjectStorage {
      async getStream(key) {
        const body = await this.get(key);
        return body === null ? null : Readable.from(Array.from(Buffer.from(body), (byte) => Buffer.from([byte])));
      }
    }
    const f = fixture(t, new Storage()), writer = f.node("writer");
    const expected = { _id: "unicode", text: "M\u00fcnchen \u20ac \ud83d\ude00 \u65e5\u672c\u8a9e" };
    writer.insert("app", "items", expected);
    await f.persistence(writer).checkpoint();
    if (format === "json") {
      const manifest = JSON.parse(await readPublished(f.storage, `${base}/latest.json`));
      for (const segment of manifest.segments) {
        const rows = (await f.storage.get(segment.key)).trim().split("\n").map(JSON.parse);
        segment.key = segment.key.replace(/\.jsonl$/, ".json");
        segment.format = "json";
        await f.storage.put(segment.key, JSON.stringify(rows));
      }
      await writePublished(f.storage, `${base}/latest.json`, JSON.stringify(manifest));
    }
    const restored = f.node("restored");
    await f.persistence(restored).restore();
    assert.deepEqual(restored.get("app", "items", "unicode"), expected);
  });
}

test("the shared decoder preserves NDJSON values and byte limits", async () => {
  const object = { text: "\ud83d\ude00 \u00e4 \u65e5\u672c\u8a9e" }, line = JSON.stringify(object);
  const bytes = Buffer.byteLength(line);
  for (const chunks of [[line + "\n"], [...Buffer.from(line + "\n")].map((byte) => Uint8Array.of(byte))]) {
    const values = [];
    for await (const entry of parseNdjsonStream(Readable.from(chunks), { maxObjectBytes: bytes })) values.push(entry);
    assert.deepEqual(values, [{ line: 1, bytes, value: object }]);
    await assert.rejects(async () => {
      for await (const entry of parseNdjsonStream(Readable.from(chunks), { maxObjectBytes: bytes - 1 })) void entry;
    }, { status: 413 });
  }
});

test("short but valid snapshots fail without advancing recovery coverage", async (t) => {
  const f = fixture(t), writer = f.node("writer");
  writer.insertManyCount("app", "items", [{ _id: "one" }, { _id: "two" }]);
  await f.persistence(writer).checkpoint();
  const manifest = JSON.parse(await readPublished(f.storage, `${base}/latest.json`));
  const key = manifest.segments[0].key;
  await f.storage.put(key, (await f.storage.get(key)).split("\n")[0] + "\n");
  const restored = f.node("restored");
  await assert.rejects(f.persistence(restored).restore(), /count|incomplete/i);
  assert.equal(restored.lastSeen.get(restored._cursorKey("writer", scope)) || 0, 0);
});

test("snapshot manifests cannot cross database, collection, or shard boundaries", async (t) => {
  const f = fixture(t), writer = f.node("writer");
  writer.insert("app", "items", { _id: "private" });
  await f.persistence(writer).checkpoint();
  await f.storage.put("objydb/db/other/collection/items/shard/default/latest.json", await readPublished(f.storage, `${base}/latest.json`));
  await assert.rejects(f.persistence(f.node("restored")).restore(), /context|scope/i);
});

test("a timed-out snapshot PUT cannot replace the primary's newer checkpoint after restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "objy-publication-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let block = false, delayed;
  class Storage extends MemoryObjectStorage {
    async put(key, body, type) {
      if (block && key.startsWith(`${base}/latest.json.publications/`)) {
        block = false;
        delayed = () => super.put(key, body, type);
        throw new Error("client timed out");
      }
      return super.put(key, body, type);
    }
  }
  const f = fixture(t, new Storage()), old = f.node("primary"), current = f.node("primary");
  const options = { durable: true, localWal: { mode: "on", dir, fsync: true } };
  const p1 = f.persistence(old, options), p2 = f.persistence(current, options);
  p1.start();
  old.insert("app", "items", { _id: "x", value: 1 });
  block = true;
  await assert.rejects(p1.checkpoint(), /client timed out/);
  p1.unsubscribe();
  await p2.restore();
  p2.start();
  current.update("app", "items", "x", { value: 2 });
  await p2.checkpoint();
  await delayed();
  const restored = f.node("restored");
  await f.persistence(restored).restore();
  assert.deepEqual(restored.get("app", "items", "x"), { _id: "x", value: 2 });
});

test("a lagging replica cannot publish less coverage even without a concurrent writer", async (t) => {
  const f = fixture(t), current = f.node("current"), lagging = f.node("lagging");
  current.insert("app", "items", { _id: "x", value: 1 });
  lagging.applyRemote("current", structuredClone(current.log), lagging._cursorKey("current", scope));
  current.update("app", "items", "x", { value: 2 });
  await f.persistence(current).checkpoint();
  const head = await readPublished(f.storage, `${base}/latest.json`);
  await assert.rejects(f.persistence(lagging).checkpoint(), { code: "SNAPSHOT_CONFLICT" });
  assert.equal(await readPublished(f.storage, `${base}/latest.json`), head);
});

test("retention never removes an unpublished checkpoint candidate", async (t) => {
  const f = fixture(t), node = f.node("writer"), p = f.persistence(node, { snapshotRetention: { keepLatest: 1 } });
  node.insert("app", "items", { _id: "x", value: 1 });
  await p.checkpoint();
  const candidateKey = `${base}/snapshots/20000101T000000000Z-in-progress/segment-000000.jsonl`;
  await f.storage.put(candidateKey, "still uploading");
  node.update("app", "items", "x", { value: 2 });
  await p.checkpoint();
  assert.equal(await f.storage.get(candidateKey), "still uploading");
});

test("one primary serializes publications and rejects stale expected revisions", async () => {
  const storage = new MemoryObjectStorage();
  const states = new PrimaryStateStore({ storage });
  const first = await states.publish("head", "first");
  const outcomes = await Promise.allSettled([states.publish("head", "second", { previous: first.revision }), states.publish("head", "third", { previous: first.revision })]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((result) => result.status === "rejected").reason.code, "SNAPSHOT_CONFLICT");
  assert.equal((await states.read("head")).body, "second");
});

for (const context of ["database", "collection"]) {
  test(`failed upload retries cannot resurrect a deleted and recreated ${context}`, async (t) => {
    let block = true, release, reached;
    const gate = new Promise((resolve) => { release = resolve; });
    const atGate = new Promise((resolve) => { reached = resolve; });
    class Storage extends MemoryObjectStorage {
      async put(key, body, type) {
        if (block && key.includes("/journal/")) {
          block = false;
          reached();
          await gate;
          throw new Error("injected upload failure");
        }
        return super.put(key, body, type);
      }
    }
    const f = fixture(t, new Storage()), node = f.node("writer"), p = f.persistence(node);
    p.start();
    node.createDatabase("app", {});
    node.createCollection("app", "items", {});
    node.insert("app", "items", { _id: "old", value: 1 });
    const job = p.flush();
    const rejected = assert.rejects(job, /injected upload failure/);
    await atGate;
    if (context === "database") { node.removeDatabase("app"); node.createDatabase("app", {}); }
    else node.removeCollection("app", "items");
    node.createCollection("app", "items", {});
    node.insert("app", "items", { _id: "new", value: 2 });
    release();
    await rejected;
    await p.flush();
    const restored = f.node("restored");
    await f.persistence(restored).restore();
    assert.equal(restored.get("app", "items", "old"), undefined);
    assert.deepEqual(restored.get("app", "items", "new"), { _id: "new", value: 2 });
  });
}

test("a cross-node delete/recreate fences an in-flight first checkpoint", async (t) => {
  let block = false, release, reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const atGate = new Promise((resolve) => { reached = resolve; });
  t.after(release);
  class Storage extends MemoryObjectStorage {
    async put(key, body, type) {
      if (block && key.includes("/snapshots/") && key.endsWith(".jsonl")) {
        block = false;
        reached();
        await gate;
      }
      return super.put(key, body, type);
    }
  }
  const f = fixture(t, new Storage()), old = f.node("old"), owner = f.node("owner");
  const p1 = f.persistence(old), p2 = f.persistence(owner);
  old.url = "http://old";
  owner.url = "http://owner";
  const map = { shards: { default: { peers: [{ url: old.url }, { url: owner.url }] } } };
  for (const node of [old, owner]) {
    node.replaceShardMap(map);
    node.lifecycle.send = (url, command) => (url === old.url ? old : owner).lifecycle.command(command);
  }
  p1.start();
  old.createCollection("app", "items", {});
  old.insert("app", "items", { _id: "old-incarnation", value: 1 });
  await p1.flush();
  await p2.restore();
  p2.start();
  block = true;
  const job = p1.checkpoint();
  await atGate;
  const deletion = owner.lifecycle.drop({ database: "app", collection: "items" });
  for (let i = 0; !old.db.isCollectionDeleted("app", "items") && i < 100; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(old.lifecycle.record("app", "items").status, "deleting");
  await assert.rejects(owner.lifecycle.create(scope, null, () => owner.createCollection("app", "items", {})), /pending/);
  release();
  await job.catch((error) => { assert.equal(error.code, "SNAPSHOT_CONFLICT"); });
  await deletion;
  await owner.lifecycle.create(scope, null, () => owner.createCollection("app", "items", {}));
  owner.insert("app", "items", { _id: "new-incarnation", value: 2 });
  await p2.flush();
  const restored = f.node("restored");
  await f.persistence(restored).restore();
  assert.equal(restored.get("app", "items", "old-incarnation"), undefined);
  assert.deepEqual(restored.get("app", "items", "new-incarnation"), { _id: "new-incarnation", value: 2 });
});
