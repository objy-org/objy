import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createObjectHookRegistry } from "../src/object-hooks.js";
import { CRDTNode } from "../src/crdt.js";
import { startServer } from "../src/server.js";
import { createFileService } from "../src/files.js";
import { loadPlugins } from "../src/plugin-loader.js";

const configPath = fileURLToPath(new URL("../spread-db.config.json", import.meta.url));
const auth = { jwtSecret: "objy-integration-secret" };

async function startObjyNode({ id, port = 0, url, shardMap, files } = {}) {
  const node = new CRDTNode({ id: id || "objy-edge", url });
  const objectHooks = createObjectHookRegistry();
  await loadPlugins([{
    file: "./plugins/objy.js",
    options: { runtime: "../new-objy/index.js" },
  }], { configPath, node, objectHooks });
  const state = await startServer({ port, node, objectHooks, auth, shardMap, files });
  return { ...state, objectHooks, base: `http://localhost:${state.port}` };
}

async function closeNode(state) {
  state.server.closeAllConnections?.();
  await new Promise((resolve) => state.server.close(resolve));
}

async function request(base, path, method = "GET", body, token) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function adminApi(base) {
  const login = await request(base, "/api/_global/users/auth", "POST", {
    username: "admin", password: "123",
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const token = login.body.accessToken;
  return { token, call: (path, method, body) => request(base, path, method, body, token) };
}

async function createCollection(call, database, name, objy = {}) {
  const created = await call(`/api/${database}/collections`, "POST", {
    name, meta: { hooks: { use: ["objy"] }, objy },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
}

test("OBJY reference hydration, nested properties, validation and failed-handler continuation", async (t) => {
  const state = await startObjyNode();
  t.after(() => closeNode(state));
  const { call } = await adminApi(state.base);
  assert.equal((await call("/api/databases", "POST", { name: "app" })).status, 201);
  await createCollection(call, "app", "Person");
  await createCollection(call, "app", "Article");

  assert.equal((await call("/api/app/Person/object", "POST", {
    _id: "author", name: "Ada",
  })).status, 201);
  const article = await call("/api/app/Article/object", "POST", {
    _id: "story",
    author: { type: "reference", family: "Person", value: "author" },
    profile: { type: "bag", properties: {
      views: { type: "number", value: 2 },
      nested: { type: "bag", properties: { published: { type: "boolean", value: true } } },
    } },
  });
  assert.equal(article.status, 201, JSON.stringify(article.body));
  assert.equal(article.body.author.object.name, "Ada");
  assert.equal(article.body.profile.properties.nested.properties.published.value, true);
  assert.equal(state.node.get("app", "Article", "story").author.object, undefined);

  assert.equal((await call("/api/app/Person/object/author", "PATCH", {
    $set: { name: "Grace" },
  })).status, 200);
  assert.equal((await call("/api/app/Article/object/story")).body.author.object.name, "Grace");

  const invalidCreate = await call("/api/app/Article/object", "POST", {
    _id: "bad", profile: { type: "bag", properties: { views: { type: "number", value: "two" } } },
  });
  assert.equal(invalidCreate.status, 400, JSON.stringify(invalidCreate.body));
  assert.equal(state.node.get("app", "Article", "bad"), undefined);

  const invalidUpdate = await call("/api/app/Article/object/story", "PATCH", {
    $set: { profile: { type: "bag", properties: { views: { type: "number", value: "many" } } } },
  });
  assert.equal(invalidUpdate.status, 400, JSON.stringify(invalidUpdate.body));
  assert.equal(state.node.get("app", "Article", "story").profile.properties.views.value, 2);
  const malformedPatch = await call("/api/app/Article/object/story", "PATCH", {
    $set: "not an object",
  });
  assert.equal(malformedPatch.status, 400, JSON.stringify(malformedPatch.body));
  assert.equal(state.node.get("app", "Article", "story").profile.properties.views.value, 2);

  const invalidBulk = await call("/api/app/Article/object", "POST", [
    { _id: "bulk-valid", title: "would be written" },
    { _id: "bulk-invalid", count: { type: "number", value: "wrong" } },
  ]);
  assert.equal(invalidBulk.status, 400, JSON.stringify(invalidBulk.body));
  assert.equal(state.node.get("app", "Article", "bulk-valid"), undefined);
  assert.equal(state.node.get("app", "Article", "bulk-invalid"), undefined);

  const failedHandler = await call("/api/app/Article/object", "POST", {
    _id: "handler-failure",
    onCreate: {
      first: { action: 'throw new Error("expected failure")' },
      second: { action: 'done({ continued: true })' },
    },
  });
  assert.equal(failedHandler.status, 201, JSON.stringify(failedHandler.body));
  assert.deepEqual(failedHandler.body, { continued: true });
  assert.ok(state.node.get("app", "Article", "handler-failure"));
});

test("OBJY-enabled multipart writes preserve blob CRUD and run handlers", async (t) => {
  const files = createFileService({ mode: "memory", prefix: "objy-test-files" });
  const state = await startObjyNode({ files });
  t.after(() => closeNode(state));
  const { call, token } = await adminApi(state.base);
  assert.equal((await call("/api/databases", "POST", { name: "app" })).status, 201);
  await createCollection(call, "app", "Document", { structure: { status: "draft" } });

  const upload = async (method, path, object, content) => {
    const form = new FormData();
    form.set("object", new Blob([JSON.stringify(object)], { type: "application/json" }));
    form.set("file", new Blob([content], { type: "text/plain" }), "note.txt");
    const response = await fetch(state.base + path, {
      method,
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const path = "/api/app/Document/object";
  const created = await upload("POST", path, {
    _id: "doc", onCreate: { run: { action: "afterObj.handled = true; done()" } },
  }, "first file");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.status, "draft");
  assert.equal(created.body.handled, true);
  const firstKey = created.body._file.key;
  const download = async () => fetch(`${state.base}${path}/doc/blob`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(await (await download()).text(), "first file");

  const updated = await upload("PUT", `${path}/doc`, {
    status: "final", onChange: { run: { action: 'done({ changed: true })' } },
  }, "second file");
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body, { changed: true });
  assert.equal(await (await download()).text(), "second file");
  assert.equal(await files.storage.getBlob(firstKey), null);

  const deleted = await call(`${path}/doc`, "DELETE");
  assert.equal(deleted.status, 204);
  assert.equal(state.node.get("app", "Document", "doc"), undefined);
});

test("OBJY handler timeout does not block later handlers or later requests", { timeout: 30_000 }, async (t) => {
  const state = await startObjyNode();
  t.after(() => closeNode(state));
  const { call } = await adminApi(state.base);
  assert.equal((await call("/api/databases", "POST", { name: "app" })).status, 201);
  await createCollection(call, "app", "Task");

  const timedOut = await call("/api/app/Task/object", "POST", {
    _id: "slow",
    onCreate: {
      slow: { action: "while (true) {}" },
      after: { action: 'done({ continued: true })' },
    },
  });
  assert.equal(timedOut.status, 201, JSON.stringify(timedOut.body));
  assert.deepEqual(timedOut.body, { continued: true });
  assert.ok(state.node.get("app", "Task", "slow"));
  const next = await call("/api/app/Task/object", "POST", {
    _id: "fast", onCreate: { run: { action: 'done("ready")' } },
  });
  assert.equal(next.status, 201, JSON.stringify(next.body));
  assert.equal(next.body, "ready");
});

test("OBJY persists nested schedule changes and removes obsolete occurrences", async (t) => {
  const state = await startObjyNode();
  t.after(() => closeNode(state));
  const { call } = await adminApi(state.base);
  assert.equal((await call("/api/databases", "POST", { name: "app" })).status, 201);
  await createCollection(call, "app", "Task");
  const path = "/api/app/Task/object/scheduled";
  const firstDate = "2030-01-01T12:00:00.000Z";
  const secondDate = "2030-01-02T12:00:00.000Z";
  assert.equal((await call("/api/app/Task/object", "POST", {
    _id: "scheduled",
    nested: { type: "bag", properties: {
      reminder: { type: "event", date: firstDate, action: "done()" },
    } },
  })).status, 201);
  assert.deepEqual(state.node.get("app", "Task", "scheduled")._aggregatedEvents,
    [{ propName: "nested.reminder", date: firstDate }]);
  assert.equal((await call(path, "PATCH", {
    $set: { "nested.properties.reminder.date": secondDate },
  })).status, 200);
  assert.deepEqual(state.node.get("app", "Task", "scheduled")._aggregatedEvents,
    [{ propName: "nested.reminder", date: secondDate }]);
  assert.equal((await call(path, "PATCH", {
    $unset: ["nested.properties.reminder"],
  })).status, 200);
  assert.equal(state.node.get("app", "Task", "scheduled")._aggregatedEvents, undefined);
});

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function idForShard(node, database, collection, shard) {
  for (let i = 0; i < 10_000; i++) {
    const id = `objy-${i}`;
    if (node.shardForObject(database, collection, id) === shard) return id;
  }
  throw new Error(`no id maps to ${shard}`);
}

test("OBJY runs once at ingress and resolves data across two OBJY DB shards", async (t) => {
  const [portA, portB] = await Promise.all([freePort(), freePort()]);
  const urlA = `http://localhost:${portA}`;
  const urlB = `http://localhost:${portB}`;
  const shardMap = { shards: {
    "shard-a": { peers: [{ url: urlA }] },
    "shard-b": { peers: [{ url: urlB }] },
  } };
  const a = await startObjyNode({ id: "objy-shard-a", port: portA, url: urlA, shardMap });
  t.after(() => closeNode(a));
  const b = await startObjyNode({ id: "objy-shard-b", port: portB, url: urlB, shardMap });
  t.after(() => closeNode(b));
  let ingressRuns = 0;
  let ownerRuns = 0;
  a.objectHooks.register("count", async (_context, next) => { ingressRuns++; await next(); });
  b.objectHooks.register("count", async (_context, next) => { ownerRuns++; await next(); });
  const { call } = await adminApi(urlA);
  assert.equal((await call("/api/databases", "POST", { name: "app" })).status, 201);
  for (const name of ["Parent", "Child", "Rule"]) {
    const objy = name === "Child" ? { inheritFamily: "Parent" }
      : name === "Rule" ? { affectable: true } : {};
    const created = await call("/api/app/collections", "POST", {
      name, meta: { hooks: { use: ["count", "objy"] }, objy },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  }
  const parentId = idForShard(a.node, "app", "Parent", "shard-b");
  const childId = idForShard(a.node, "app", "Child", "shard-b");
  const ruleId = idForShard(a.node, "app", "Rule", "shard-a");
  assert.equal((await call("/api/app/Parent/object", "POST", {
    _id: parentId, inherited: "remote",
  })).status, 201);
  assert.equal((await call("/api/app/Rule/object", "POST", {
    _id: ruleId, affects: { kind: "target" }, bonus: 9,
  })).status, 201);
  ingressRuns = 0;
  ownerRuns = 0;

  const created = await call("/api/app/Child/object", "POST", {
    _id: childId, kind: "target", inherits: [parentId],
    onCreate: { run: { action: 'done({ from: "handler" })' } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body, { from: "handler" });
  assert.equal(ingressRuns, 1);
  assert.equal(ownerRuns, 0);
  assert.equal(a.node.get("app", "Child", childId), undefined);
  assert.ok(b.node.get("app", "Child", childId));
  const read = await call(`/api/app/Child/object/${childId}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.inherited, "remote");
  assert.equal(read.body.bonus, 9);
});
