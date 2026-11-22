import { test } from "node:test";
import assert from "node:assert/strict";
import { CRDTNode } from "../src/crdt.js";
import { nodeCompression } from "../src/node-runtime.js";
import { aggregateObjects, aggregateLegacyObjects } from "../src/aggregate.js";
import { ShardRequestRouter } from "../src/shard-router.js";
import { startServer } from "../src/server.js";
import { FileService } from "../src/files.js";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tiering = { mode: "compressedMemory", keep: ["group", "score", "rank", "tags"], minBytes: 1 };
const meta = { indexes: ["group", "tags"], columns: ["score"], tiering };
const rows = (count = 64) => Array.from({ length: count }, (_, i) => ({
  _id: `id-${i}`, group: i % 4, score: i, rank: i % 7, tags: ["all", `tag-${i % 3}`],
  payload: { amount: i, text: "Unrelated cold object data. ".repeat(256) },
}));

function fixture(engine = "object") {
  let decompressions = 0;
  const node = new CRDTNode({
    id: "hydration", operationLog: false,
    storage: { engine, compression: { ...nodeCompression, decompress(value) { decompressions++; return nodeCompression.decompress(value); } } },
  });
  let serial = 0;
  return {
    node,
    get decompressions() { return decompressions; },
    reset() { decompressions = 0; },
    async collection(data = rows(), info = meta) {
      const name = `items-${serial++}`;
      node.createCollection("db", name, info);
      node.insertManyCount("db", name, data);
      await node.awaitIndexes("db", name);
      return { name, data, collection: node.db.collection("db", name) };
    },
  };
}

for (const engine of ["object", "shape"]) {
  test(`${engine}: replacements, deletes and stale remote writes need no old object body`, async () => {
    const f = fixture(engine);
    try {
      const { name, data, collection } = await f.collection();
      f.reset();
      const rejected = data.map((row) => ({ kind: "putObj", db: "db", coll: name, id: row._id, value: {}, ts: collection.meta.get(row._id).ts, seq: 1 }));
      assert.equal(f.node.applyRemote("remote", rejected), 0);
      assert.equal(f.decompressions, 0);
      const changed = data.map((row) => ({ ...row, group: 9, score: row.score + 1, tags: ["new"] }));
      assert.equal(f.node.replaceManyCount("db", name, changed), data.length);
      assert.equal(f.decompressions, 0);
      assert.equal(f.node.count("db", name, { tags: { $contains: "all" } }), 0);
      assert.equal(f.node.count("db", name, { group: 9 }), data.length);
      assert.equal(f.node.removeMany("db", name, data.map((row) => row._id)).deleted, data.length);
      assert.equal(f.decompressions, 0);
      assert.equal(collection.indexes.get("group").forward.size, 0);
      assert.equal(f.node.count("db", name), 0);
    } finally { f.node.db.dispose(); }
  });

  test(`${engine}: actual applied batch size and indexed-value ownership remain correct`, async () => {
    const f = fixture(engine);
    try {
      const { name, data, collection } = await f.collection();
      data[0].tags.push("not-stored");
      f.reset();
      const stale = { id: data[1]._id, value: {}, ts: collection.meta.get(data[1]._id).ts };
      const applied = collection.putObjects([
        ...Array.from({ length: 5000 }, () => stale),
        { id: data[0]._id, value: { ...rows(1)[0], score: 123, tags: ["replacement"] }, ts: f.node.nextTs() },
      ]);
      assert.equal(applied.length, 1);
      assert.equal(f.decompressions, 0);
      assert.equal(collection.indexDirtyRids.size, 0);
      assert.equal(f.node.count("db", name, { tags: { $contains: "all" } }), data.length - 1);
      assert.equal(f.node.count("db", name, { tags: { $contains: "not-stored" } }), 0);
      assert.equal(f.node.get("db", name, data[0]._id).score, 123);
      collection.scheduleIndexBuildsFromMeta();
      const tags = ["queued"];
      f.node.replaceManyCount("db", name, [{ ...rows(1)[0], tags }]);
      tags.push("mutated-after-write");
      await f.node.awaitIndexes("db", name);
      assert.equal(f.node.count("db", name, { tags: { $contains: "queued" } }), 1);
      assert.equal(f.node.count("db", name, { tags: { $contains: "mutated-after-write" } }), 0);
    } finally { f.node.db.dispose(); }
  });

  test(`${engine}: counts, aggregate scans and partial-index verification read only required fields`, async () => {
    const f = fixture(engine);
    try {
      const { name, data, collection } = await f.collection();
      const criteria = { group: 2, rank: { $gte: 2 } };
      const selected = data.filter((row) => row.group === 2 && row.rank >= 2);
      const spec = { groupBy: "group", fields: { sum: { $sum: "score" }, avg: { $avg: "score" }, min: { $min: "score" }, max: { $max: "score" }, count: { $count: true } } };
      f.reset();
      assert.equal(f.node.count("db", name, { rank: { $gte: 2 } }), data.filter((row) => row.rank >= 2).length);
      assert.equal(f.node.count("db", name, criteria), selected.length);
      assert.deepEqual(f.node.aggregate("db", name, criteria, spec), aggregateObjects(selected, spec));
      const scanSpec = { ...spec, groupBy: ["group", "rank"], fields: { ...spec.fields, rank: { $sum: "rank" } }, $pageSize: 100 };
      assert.deepEqual(f.node.aggregate("db", name, {}, scanSpec), aggregateObjects(data, scanSpec));
      const legacy = { groupBy: "group", sum: ["score", "rank"], min: ["rank"], max: ["rank"], avg: ["rank"] };
      assert.deepEqual(f.node.aggregate("db", name, {}, legacy), aggregateLegacyObjects(data, legacy));
      collection.rebuildDerivedState();
      assert.equal(f.decompressions, 0);
      assert.deepEqual(f.node.get("db", name, "id-10"), data[10]);
      f.reset();
      const cold = { fields: { sum: { $sum: "payload.amount" } } };
      assert.deepEqual(f.node.aggregate("db", name, {}, cold), [{ sum: data.reduce((n, row) => n + row.payload.amount, 0) }]);
      assert.equal(f.decompressions, data.length);
      f.reset();
      assert.equal(f.node.count("db", name, { $where: (object) => object.payload.amount % 2 === 0 }), data.length / 2);
      assert.equal(f.decompressions, data.length);
    } finally { f.node.db.dispose(); }
  });

  test(`${engine}: container indexes overlapping columns retain stable values without cold reads`, async () => {
    const f = fixture(engine);
    try {
      const profile = { score: 1, labels: ["original"] };
      const data = [{ ...rows(1)[0], profile }];
      const { name, collection } = await f.collection(data, { ...meta, indexes: ["profile"], columns: ["profile.score"] });
      profile.labels.push("not-stored");
      assert.deepEqual(collection.indexes.get("profile").valueForRid(0), { score: 1, labels: ["original"] });
      f.reset();
      const next = { score: 9, labels: ["updated"] };
      f.node.replaceManyCount("db", name, [{ ...data[0], profile: next }]);
      next.labels.push("not-stored-either");
      assert.equal(f.decompressions, 0);
      assert.deepEqual(collection.indexes.get("profile").valueForRid(0), { score: 9, labels: ["updated"] });
      assert.deepEqual(f.node.get("db", name, "id-0").profile, { score: 9, labels: ["updated"] });
    } finally { f.node.db.dispose(); }
  });

  test(`${engine}: filtered vector ranking hydrates only winners and keeps exact scores`, async () => {
    const f = fixture(engine);
    try {
      const data = rows().map((row, i) => ({ ...row, _vec: [1, i % 3 + 1, 1] }));
      const { name } = await f.collection(data);
      const query = [1, 2, 1];
      const expected = f.node.rankVectorRows("db", name, f.node.find("db", name, { group: 2 }), query, 3);
      f.reset();
      const actual = new ShardRequestRouter({ node: f.node }).vectorSearchLocalShards("db", name, { group: 2 }, { queryVec: query, limit: 3 });
      assert.equal(f.decompressions, 3);
      assert.deepEqual(actual, expected);
    } finally { f.node.db.dispose(); }
  });

  test(`${engine}: durable WAL replay replaces and deletes compressed objects without old-body reads`, async () => {
    const f = fixture(engine), restored = fixture(engine);
    const dir = await mkdtemp(join(tmpdir(), "objy-hydration-wal-"));
    const options = { storage: new MemoryObjectStorage(), flushMs: 0, snapshotMs: 0, ack: "localWal", localWal: { mode: "on", dir, fsync: true } };
    const persistence = new PersistenceManager({ node: f.node, ...options });
    persistence.start();
    try {
      const { name, data } = await f.collection(rows(128));
      const changed = data.map((row) => ({ ...row, group: 9, score: row.score + 10 }));
      f.node.replaceManyCount("db", name, changed);
      f.node.removeMany("db", name, data.slice(0, 16).map((row) => row._id));
      const recreated = data.slice(0, 8).map((row) => ({ ...row, group: 3, score: 999 }));
      f.node.replaceManyCount("db", name, recreated);
      await persistence.afterWrite();
      await new PersistenceManager({ node: restored.node, ...options }).restore();
      restored.node.startIndexWarmup();
      await restored.node.awaitIndexes("db", name);
      assert.equal(restored.decompressions, 0);
      const expected = new Map(changed.map((row) => [row._id, row]));
      for (const row of data.slice(0, 16)) expected.delete(row._id);
      for (const row of recreated) expected.set(row._id, row);
      assert.equal(restored.node.count("db", name), expected.size);
      assert.equal(restored.node.count("db", name, { group: 9 }), 112);
      for (const row of expected.values()) assert.deepEqual(restored.node.get("db", name, row._id), row);
      for (const row of data.slice(8, 16)) assert.equal(restored.node.get("db", name, row._id), undefined);
    } finally {
      await persistence.stop();
      f.node.db.dispose(); restored.node.db.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const filesEnabled of [false, true]) {
  test(`HTTP mutation hydration and response contracts, files=${filesEnabled}`, async () => {
    const f = fixture();
    const storage = new MemoryObjectStorage();
    const files = filesEnabled ? new FileService({ storage }) : null;
    let routing;
    const state = await startServer({
      node: f.node, port: 0,
      files,
      interfaces: [{ name: "capture-routing", register(_router, context) { routing = context.routing; } }],
      auth: { jwtSecret: "hydration-test-only-secret", users: [{ _id: "admin", username: "admin", password: "test-only", admin: true }] },
    });
    try {
      const base = `http://127.0.0.1:${state.port}`;
      const login = await fetch(`${base}/api/_global/users/auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "test-only" }) });
      const session = await login.json();
      assert.equal(login.status, 200);
      const request = async (method, name, body, { id, streaming = true, token = session.accessToken } = {}) => {
        const response = await fetch(`${base}/api/db/${name}/object${id ? `/${id}` : ""}`, {
          method, headers: { authorization: `Bearer ${token}`, prefer: "return=minimal", "content-type": streaming ? "application/x-ndjson" : "application/json" },
          body: body === undefined ? undefined : streaming ? body.map((row) => JSON.stringify(row)).join("\n") + "\n" : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
      };
      for (const streaming of [true, false]) for (const method of ["PUT", "PATCH", "DELETE"]) {
        const { name, data } = await f.collection(rows(20));
        f.reset();
        const body = method === "PUT" ? data : method === "PATCH" ? data.map(({ _id }) => ({ _id, $set: { rank: 100 } })) : data.map(({ _id }) => ({ _id }));
        const result = await request(method, name, body, { streaming });
        assert.deepEqual(result, { status: 200, body: method === "PUT" ? { replaced: 20 } : method === "PATCH" ? { updated: 20, skipped: 0 } : { deleted: 20, skipped: 0 } });
        assert.equal(f.decompressions, method === "PATCH" || filesEnabled ? 20 : 0);
        if (method !== "DELETE") assert.equal(f.node.get("db", name, "id-0").rank, method === "PATCH" ? 100 : 0);
      }
      if (filesEnabled) {
        for (const method of ["PUT", "PATCH", "DELETE"]) {
          const { name, data } = await f.collection(rows(3));
          const attached = data.map((row) => ({ ...row, _file: files.metadata("db", name, row._id, "text/plain") }));
          for (const row of attached) await storage.putBlob(row._file.key, Buffer.from("bytes"), "text/plain");
          f.node.replaceManyCount("db", name, attached);
          f.reset();
          const body = method === "PUT" ? data : method === "PATCH" ? data.map(({ _id }) => ({ _id, $unset: ["_file"] })) : data.map(({ _id }) => ({ _id }));
          assert.equal((await request(method, name, body)).status, 200);
          assert.equal(f.decompressions, data.length);
          for (const row of attached) assert.equal(await storage.getBlob(row._file.key), null);
        }

        const { name, data } = await f.collection(rows(1));
        const oldFile = files.metadata("db", name, "id-0", "text/plain");
        const concurrentFile = files.metadata("db", name, "id-0", "text/plain");
        await storage.putBlob(oldFile.key, Buffer.from("old"), "text/plain");
        await storage.putBlob(concurrentFile.key, Buffer.from("concurrent"), "text/plain");
        f.node.replaceManyCount("db", name, [{ ...data[0], _file: oldFile }]);
        routing.groupByShard = (_req, _db, _coll, items) => [
          { local: false, shard: "remote", items: items.filter((row) => row._id === "remote") },
          { local: true, shard: null, items: items.filter((row) => row._id !== "remote") },
        ];
        routing.forwardToShardNdjson = async () => {
          await Promise.resolve();
          f.node.replaceManyCount("db", name, [{ ...data[0], _file: concurrentFile }]);
          return { status: 200, body: { updated: 1, skipped: 0 } };
        };
        const result = await request("PATCH", name, [{ _id: "remote", $set: { rank: 7 } }, { _id: "id-0", $set: { rank: 8 } }]);
        assert.deepEqual(result, { status: 200, body: { updated: 2, skipped: 0 } });
        assert.ok(await storage.getBlob(concurrentFile.key));
        assert.ok(await storage.getBlob(oldFile.key));
        assert.equal(f.node.get("db", name, "id-0").rank, 8);
        assert.deepEqual(f.node.get("db", name, "id-0")._file, concurrentFile);
      }
      if (!filesEnabled) {
        const { name, data } = await f.collection();
        f.reset();
        const put = await request("PUT", name, data[0], { id: "id-0", streaming: false });
        assert.deepEqual(put, { status: 200, body: data[0] });
        assert.equal(f.decompressions, 1);
        f.reset();
        const patch = await request("PATCH", name, { $set: { rank: 99 } }, { id: "id-0", streaming: false });
        assert.deepEqual(patch, { status: 200, body: { ...data[0], rank: 99 } });
        assert.equal(f.decompressions, 2);
        f.reset();
        assert.deepEqual(await request("DELETE", name, undefined, { id: "id-0", streaming: false }), { status: 204, body: null });
        assert.equal(f.decompressions, 0);

        f.node.createCollection("db", "users");
        const [user] = state.auth.prepareWriteObjects("db", "users", await state.auth.hashWritePasswords([{ _id: "limited", username: "limited", password: "test-only", permissions: [{ perm: "crud", query: { group: 2 } }] }]));
        f.node.insertManyCount("db", "users", [user]);
        const token = (await state.auth.login("db", "users", "limited", "test-only")).accessToken;
        f.reset();
        const allowed = await request("PUT", name, [{ ...data[2], rank: 200 }], { token });
        assert.equal(allowed.status, 200);
        assert.equal(f.decompressions, 1); // Account authorization must inspect cold credentials, if present.
        const denied = await request("PUT", name, [{ ...data[2], group: 3 }], { token });
        assert.equal(denied.status, 403);
        assert.equal(f.decompressions, 1);
        assert.equal(f.node.get("db", name, "id-2").rank, 200);

        const info = { indexes: ["username"], tiering: { mode: "compressedMemory", keep: ["username", "password"], minBytes: 1 } };
        const [userData] = await state.auth.hashWritePasswords([{ _id: "account", username: "account", password: "test-only", payload: "cold user data ".repeat(512) }]);
        const users = await f.collection([userData], info);
        f.reset();
        const [prepared] = state.auth.prepareWriteObjects("db", users.name, [{ _id: "account", username: "account" }]);
        assert.equal(prepared.password, userData.password);
        assert.throws(() => state.auth.prepareWriteObjects("db", users.name, [{ ...userData, _id: "conflict" }]), /username already exists/);
        assert.equal(f.decompressions, 0);
      }
    } finally {
      await state.replication.stop();
      await new Promise((resolve) => state.server.close(resolve));
      f.node.db.dispose();
    }
  });
}
