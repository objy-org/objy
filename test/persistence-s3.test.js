import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { CRDTNode } from "../src/crdt.js";
import { S3ObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";
import { PrimaryStateStore } from "../src/primary-state.js";
import { withNode } from "./helpers/launcher.js";

for (const inline of [true, false]) {
  test(`joining process ${inline ? "with" : "without"} an initial map waits for automatic S3 initialization`, { timeout: 30000 }, async (t) => {
    const { mock, cwd, entry, urls, map, config, save, call } = await bootstrapFixture(t);
    const joiningConfig = await save("joining.json", { ...config, cluster: {
      ...config.cluster, ...(inline ? { shardMap: map } : {}),
    } });
    const args = (index, path) => ["--config", path, "--node", `boot-${index}`, "--url", urls[index], "--port", new URL(urls[index]).port];
    const rows = Array.from({ length: 100 }, (_, i) => ({ _id: `boot-row-${i}`, score: i, nested: { tags: ["dynamic", i] } }));
    const publications = () => mock.log.filter((request) => request.method === "PUT" && request.path.includes("/cluster/shard-map.json.publications/"));
    const joining = withNode({ entry, cwd, args: args(1, joiningConfig) }, async (url) => {
      assert.deepEqual((await call(url, "GET", "/cluster/shards")).shardMap.shards, map.shards);
      await call(url, "POST", "/api/databases", { name: "app" });
      await call(url, "POST", "/api/app/collections", { name: "items" });
      const inserted = await call(url, "POST", "/api/app/items/object", rows);
      assert.equal(inserted.inserted, rows.length);
      assert.deepEqual(inserted.items, rows);
      assert.deepEqual(await call(url, "POST", "/api/app/items/search", {
        $aggregate: { fields: { count: { $count: true }, sum: { $sum: "score" } } },
      }), [{ count: 100, sum: 4950 }]);
    });
    joining.catch(() => {});
    try {
      await waitFor(() => mock.log.filter((request) => request.search.includes("list-type=2")).length >= 2);
      assert.equal(mock.objects.size, 0, "a waiting node must not initialize shared state");
      assert.equal((await readdir(cwd)).includes("wal"), false);
      await assert.rejects(fetch(`${urls[1]}/health`, { signal: AbortSignal.timeout(500) }));
      const primaryConfig = await save("primary.json", { ...config, cluster: { ...config.cluster, shardMap: map } });
      await withNode({ entry, cwd, args: args(0, primaryConfig) }, async () => { await joining; });
      assert.equal(publications().length, 1, "only the coordinator publishes the initial map");
      assert.equal(mock.log.some((request) => request.conditional), false);

      const staleConfig = await save("stale.json", { ...config, cluster: { ...config.cluster, shardMap: { invalid: true } } });
      await withNode({ entry, cwd, args: args(0, staleConfig) }, async (primary) => {
        await withNode({ entry, cwd, args: args(1, joiningConfig) }, async (replica) => {
          for (const url of [primary, replica]) {
            assert.deepEqual((await call(url, "GET", "/cluster/shards")).shardMap.shards, map.shards);
            assert.deepEqual(await call(url, "GET", "/api/app/items/object/boot-row-99"), rows[99]);
            assert.deepEqual(await call(url, "POST", "/api/app/items/search", {
              $aggregate: { fields: { count: { $count: true }, sum: { $sum: "score" } } },
            }), [{ count: 100, sum: 4950 }]);
          }
        });
      });
      assert.equal(publications().length, 1, "restarts must never republish the initial map");
    } finally { await joining.catch(() => {}); }
  });
}

for (const inline of [true, false]) {
  test(`missing S3 map times out ${inline ? "on a configured replica" : "without a bootstrap config"} before creating runtime state`, { timeout: 10000 }, async (t) => {
    const { mock, cwd, entry, urls, map, config, save } = await bootstrapFixture(t, { timeoutMs: 50 });
    const path = await save("waiting.json", { ...config, cluster: { ...config.cluster, ...(inline ? { shardMap: map } : {}) } });
    await assert.rejects(promisify(execFile)(process.execPath, [entry, "--config", path, "--node", "boot-1", "--url", urls[1]], {
      cwd, timeout: 5000,
    }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /waiting up to 50ms/);
      assert.match(error.stderr, /S3 shard map is not initialized.*cluster.shardMap/);
      return true;
    });
    assert.equal(mock.objects.size, 0);
    assert.equal((await readdir(cwd)).includes("wal"), false);
  });
}

test("S3 access denial fails startup instead of bootstrapping or waiting", { timeout: 10000 }, async (t) => {
  const { mock, cwd, entry, urls, map, config, save } = await bootstrapFixture(t, { denyReads: true });
  const path = await save("denied.json", { ...config, cluster: { ...config.cluster, shardMap: map } });
  await assert.rejects(promisify(execFile)(process.execPath, [entry, "--config", path, "--node", "boot-0", "--url", urls[0]], {
    cwd, timeout: 5000,
  }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /AccessDenied/);
    assert.doesNotMatch(error.stdout, /waiting|initialized/);
    return true;
  });
  assert.equal(mock.objects.size, 0);
  assert.equal((await readdir(cwd)).includes("wal"), false);
});

async function bootstrapFixture(t, options = {}) {
  const mock = createMockS3Server(options);
  const port = await mock.start();
  const cwd = await mkdtemp(join(tmpdir(), "objy-map-startup-"));
  t.after(async () => { await mock.stop(); await rm(cwd, { recursive: true, force: true }); });
  const entry = fileURLToPath(new URL("../bin/objy.js", import.meta.url));
  const sockets = [createServer(), createServer()];
  const urls = [];
  for (const server of sockets) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    urls.push(`http://127.0.0.1:${server.address().port}`);
  }
  for (const server of sockets) await new Promise((resolve) => server.close(resolve));
  const map = { shards: Object.fromEntries(urls.map((url, index) => [`shard-${index}`, { peers: [{ url }] }])) };
  const s3 = { bucket: "test", endpoint: `http://127.0.0.1:${port}`, accessKeyId: "test", secretAccessKey: "test" };
  const config = {
    server: { port: 0 }, auth: { enabled: false },
    cluster: { replicationTimeoutMs: options.timeoutMs || 10000, shardMapStore: { mode: "s3" } },
    persistence: { mode: "s3", prefix: "bootstrap", s3, flushMs: 0, snapshotMs: 0,
      ack: "localWal", localWal: { mode: "on", dir: join(cwd, "wal"), fsync: true } },
  };
  const storage = new S3ObjectStorage(s3);
  const save = async (name, document) => {
    const path = join(cwd, name);
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });
    return path;
  };
  const call = async (url, method, path, body) => {
    const secrets = JSON.parse((await new PrimaryStateStore({ storage }).read("bootstrap/system/secrets.json")).body);
    const response = await fetch(url + path, { method,
      headers: { "content-type": "application/json", "x-objydb-cluster-secret": secrets.clusterSecret },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
    return JSON.parse(text);
  };
  return { mock, cwd, entry, urls, map, config, save, call };
}

async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "startup did not reach shard-map waiting");
    await sleep(10);
  }
}

for (const stopSignal of ["SIGINT", "SIGTERM"]) {
  test(`launcher flushes S3 journals on ${stopSignal} and restores full objects on restart`, { timeout: 30000 }, async (t) => {
    const mock = createMockS3Server();
    const port = await mock.start();
    const cwd = await mkdtemp(join(tmpdir(), "objy-launcher-s3-"));
    t.after(async () => { await mock.stop(); await rm(cwd, { recursive: true, force: true }); });
    const entry = fileURLToPath(new URL("../bin/objy.js", import.meta.url));
    await writeFile(join(cwd, "objydb.config.json"), JSON.stringify({
      node: { id: "launcher-durable" }, server: { port: 0 },
      auth: { enabled: false }, cluster: { secret: "launcher-test-secret" },
      persistence: {
        mode: "s3", ack: "localWal", flushMs: 0, snapshotMs: 0,
        localWal: { mode: "on", dir: join(cwd, "wal"), fsync: true },
        s3: { bucket: "test", endpoint: `http://127.0.0.1:${port}`, accessKeyId: "test", secretAccessKey: "test" },
      },
    }));
    const rows = [{ _id: "a", kind: "one", score: 10, payload: "cold ".repeat(100) },
      { _id: "b", kind: "two", score: 20, nested: { values: [null, false, "dynamic"] } }];
    const call = async (url, method, path, body) => {
      const response = await fetch(url + path, {
        method,
        headers: { "content-type": "application/json", prefer: "return=minimal" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
      assert.ok(response.ok, `${method} ${path}: ${response.status}`);
      return response.json();
    };
    await withNode({ entry, cwd, stopSignal }, async (url) => {
      await call(url, "POST", "/api/app/items/object", rows);
      await call(url, "PUT", "/api/app/items/meta", { indexes: ["kind"], columns: ["score"],
        tiering: { mode: "compressedMemory", offload: ["payload"], minBytes: 1 } });
      assert.equal([...mock.objects.keys()].some((key) => key.includes("/journal/")), false);
    });
    assert.ok([...mock.objects.keys()].some((key) => key.includes("/journal/")));
    await withNode({ entry, cwd }, async (url) => {
      assert.deepEqual(await call(url, "GET", "/api/app/items/object/a"), rows[0]);
      assert.deepEqual(await call(url, "GET", "/api/app/items/object/b"), rows[1]);
      assert.deepEqual(await call(url, "POST", "/api/app/items/search", {
        $aggregate: { fields: { total: { $sum: "score" }, count: { $count: true } } },
      }), [{ total: 30, count: 2 }]);
      const meta = await call(url, "GET", "/api/app/items/meta");
      assert.deepEqual(meta.columns, ["score"]);
      assert.deepEqual(meta.indexes, ["kind"]);
    });
  });
}

test("S3 persistence adapter stores journals through an S3-compatible API", async () => {
  const mock = createMockS3Server();
  const port = await mock.start();
  try {
    const storage = new S3ObjectStorage({
      bucket: "objydb-test",
      endpoint: `http://127.0.0.1:${port}`,
      region: "us-east-1",
      accessKeyId: "test",
      secretAccessKey: "test",
      forcePathStyle: true,
    });
    const node = new CRDTNode({ id: "n1" });
    const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0 });
    persistence.start();
    node.insert("app", "users", { _id: "u1", name: "Ada" });
    await persistence.stop();

    assert.ok([...mock.objects.keys()].some((key) => key.startsWith("objydb/db/app/collection/users/shard/default/journal/n1/")));

    const fresh = new CRDTNode({ id: "fresh" });
    await new PersistenceManager({ node: fresh, storage }).restore();
    assert.deepEqual(fresh.get("app", "users", "u1"), { _id: "u1", name: "Ada" });
  } finally {
    await mock.stop();
  }
});

test("S3 adapter creates non-us-east-1 buckets with a location constraint", async () => {
  const mock = createMockS3Server({ bucketExists: false });
  const port = await mock.start();
  try {
    const storage = new S3ObjectStorage({
      bucket: "objydb-test",
      endpoint: `http://127.0.0.1:${port}`,
      region: "fsn1",
      accessKeyId: "test",
      secretAccessKey: "test",
      forcePathStyle: true,
    });

    await storage.put("probe.json", "{}");

    const createBucket = mock.log.find((entry) => entry.method === "PUT" && entry.path.replace(/\/$/, "") === "/objydb-test");
    assert.ok(createBucket);
    assert.match(createBucket.body, /<LocationConstraint>fsn1<\/LocationConstraint>/);
  } finally {
    await mock.stop();
  }
});

test("S3 publication works without ETags or conditional requests", async () => {
  const mock = createMockS3Server();
  const port = await mock.start();
  const storage = new S3ObjectStorage({ bucket: "test", endpoint: `http://127.0.0.1:${port}`, accessKeyId: "test", secretAccessKey: "test" });
  try {
    const states = new PrimaryStateStore({ storage });
    assert.equal((await states.read("head")).body, null);
    const first = await states.publish("head", "one");
    await states.publish("head", "two", { previous: first.revision });
    await assert.rejects(states.publish("head", "stale", { previous: first.revision }), { code: "SNAPSHOT_CONFLICT" });
    assert.equal((await states.read("head")).body, "two");
    await states.prune("head", 1);
    assert.equal((await storage.list("head.publications/")).length, 1);
    assert.equal(mock.log.some((entry) => entry.conditional), false);
  } finally {
    await mock.stop();
  }
});

function createMockS3Server({ bucketExists = true, denyReads = false } = {}) {
  const objects = new Map();
  const log = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const parts = url.pathname.replace(/^\//, "").split("/");
    const key = parts.slice(1).join("/");
    if (denyReads && req.method === "GET") {
      log.push({ method: req.method, path: url.pathname, search: url.search });
      res.writeHead(403, { "content-type": "application/xml" });
      res.end("<Error><Code>AccessDenied</Code></Error>");
      return;
    }
    const readBody = () => new Promise((resolve) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

    if (req.method === "HEAD" && !key) {
      res.writeHead(bucketExists ? 200 : 404, { "content-type": "application/xml" });
      res.end();
      return;
    }

    if (req.method === "PUT" && !key) {
      readBody().then((body) => {
        log.push({ method: req.method, path: url.pathname, search: url.search, body });
        res.writeHead(200, { "content-type": "application/xml" });
        res.end();
      });
      return;
    }

    if (req.method === "PUT" && key) {
      readBody().then((body) => {
        const conditional = !!(req.headers["if-none-match"] || req.headers["if-match"]);
        log.push({ method: req.method, path: url.pathname, search: url.search, body, conditional });
        if (conditional) {
          res.writeHead(501, { "content-type": "application/xml" });
          res.end("<Error><Code>NotImplemented</Code></Error>");
          return;
        }
        objects.set(key, body);
        res.writeHead(200);
        res.end();
      });
      return;
    }

    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      log.push({ method: req.method, path: url.pathname, search: url.search });
      const prefix = url.searchParams.get("prefix") || "";
      const contents = [...objects.keys()]
        .filter((objectKey) => objectKey.startsWith(prefix))
        .sort()
        .map((objectKey) => {
          return `<Contents><Key>${escapeXml(objectKey)}</Key><Size>${objects.get(objectKey).length}</Size></Contents>`;
        })
        .join("");
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
        `<IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
      );
      return;
    }

    if (req.method === "GET" && key) {
      log.push({ method: req.method, path: url.pathname, search: url.search });
      if (!objects.has(key)) {
        res.writeHead(404, { "content-type": "application/xml" });
        res.end(`<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(objects.get(key));
      return;
    }

    if (req.method === "POST" && url.searchParams.has("delete")) {
      readBody().then((body) => {
        const keys = [...body.matchAll(/<Key>(.*?)<\/Key>/g)].map((match) => match[1].replace(/&amp;/g, "&"));
        for (const key of keys) objects.delete(key);
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(`<DeleteResult>${keys.map((key) => `<Deleted><Key>${escapeXml(key)}</Key></Deleted>`).join("")}</DeleteResult>`);
      });
      return;
    }

    log.push({ method: req.method, path: url.pathname, search: url.search });
    res.writeHead(404, { "content-type": "application/xml" });
    res.end(`<?xml version="1.0"?><Error><Code>NotFound</Code></Error>`);
  });

  return {
    objects,
    log,
    start: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
    stop: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
