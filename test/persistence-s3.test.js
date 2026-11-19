import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { CRDTNode } from "../src/crdt.js";
import { S3ObjectStorage } from "../src/object-storage.js";
import { PersistenceManager } from "../src/persistence.js";
import { PrimaryStateStore } from "../src/primary-state.js";

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

function createMockS3Server({ bucketExists = true } = {}) {
  const objects = new Map();
  const log = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const parts = url.pathname.replace(/^\//, "").split("/");
    const key = parts.slice(1).join("/");
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
