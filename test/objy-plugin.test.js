import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createObjectHookRegistry } from "../src/object-hooks.js";
import { CRDTNode } from "../src/crdt.js";
import { startServer } from "../src/server.js";
import { loadPlugins } from "../src/plugin-loader.js";

test("OBJY file plugin adds object behavior through OBJY DB hooks", async (t) => {
  const node = new CRDTNode({ id: "objy-plugin" });
  const objectHooks = createObjectHookRegistry();
  await loadPlugins([{
    file: "./plugins/objy.js",
    options: { runtime: "../new-objy/index.js" },
  }], {
    configPath: fileURLToPath(new URL("../spread-db.config.json", import.meta.url)),
    node,
    objectHooks,
  });
  const state = await startServer({ node, objectHooks, auth: { jwtSecret: "plugin-test-secret" } });
  t.after(async () => {
    state.server.closeAllConnections?.();
    await new Promise((resolve) => state.server.close(resolve));
  });
  const base = `http://localhost:${state.port}`;
  const login = await request(base, "/api/_global/users/auth", "POST", { username: "admin", password: "123" });
  assert.equal(login.status, 200);
  const token = login.body.accessToken;
  const api = (path, method = "GET", body) => request(base, path, method, body, token);

  assert.equal((await api("/api/databases", "POST", { name: "app" })).status, 201);
  for (const name of ["Affectable", "Task", "Things"]) {
    assert.equal((await api("/api/app/collections", "POST", {
      name, meta: { hooks: { use: ["objy"] } },
    })).status, 201);
  }

  const defaults = await api("/api/app/Affectable/object", "POST", {
    _id: "defaults", affects: { kind: "task" }, bonus: 7,
  });
  assert.equal(defaults.status, 201, JSON.stringify(defaults.body));
  const parent = await api("/api/app/Task/object", "POST", {
    _id: "parent", kind: "parent", inherited: "yes",
  });
  assert.equal(parent.status, 201);
  const created = await api("/api/app/Task/object", "POST", {
    _id: "child", kind: "task", inherits: ["parent"],
    onCreate: { run: { action: "afterObj.responseOnly = true; done()" } },
    onChange: { run: { action: "afterObj.changedHandler = true; done()" } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.bonus, 7);
  assert.equal(created.body.inherited, "yes");
  assert.equal(created.body.responseOnly, true);
  assert.equal(node.get("app", "Task", "child").bonus, undefined);
  assert.equal(node.get("app", "Task", "child").responseOnly, undefined);
  const due = "2030-01-01T00:00:00.000Z";
  assert.equal((await api("/api/app/Task/object", "POST", {
    _id: "scheduled", reminder: { type: "event", date: due, action: "done()" },
  })).status, 201);
  assert.deepEqual(node.get("app", "Task", "scheduled")._aggregatedEvents,
    [{ propName: "reminder", date: due }]);

  const read = await api("/api/app/Task/object/child");
  assert.equal(read.status, 200);
  assert.equal(read.body.bonus, 7);
  assert.equal(read.body.inherited, "yes");

  const bulk = await api("/api/app/Task/object", "POST", [
    { _id: "bulk-1", kind: "task" },
    { _id: "bulk-2", kind: "task" },
  ]);
  assert.equal(bulk.status, 201);
  assert.equal(bulk.body.items.length, 2);
  assert.ok(bulk.body.items.every((item) => item.bonus === 7));
  const queried = await api("/api/app/Task/object?q=%7B%22kind%22%3A%22task%22%7D");
  assert.equal(queried.status, 200);
  assert.equal(queried.body.length, 3);
  assert.ok(queried.body.every((item) => item.bonus === 7));

  const streamed = await fetch(`${base}/api/app/Task/object`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-ndjson",
      prefer: "return=minimal",
    },
    body: '{"_id":"stream-1","kind":"task"}\n{"_id":"stream-2","kind":"task"}\n',
  });
  assert.equal(streamed.status, 201);
  assert.deepEqual(await streamed.json(), { inserted: 2 });
  assert.equal((await api("/api/app/Task/object/stream-1")).body.bonus, 7);
  const plural = await api("/api/app/Things/object", "POST", { _id: "one" });
  assert.equal(plural.status, 201);
  assert.equal(plural.body.role, "Things");

  assert.equal((await api("/api/app/collections", "POST", { name: "users" })).status, 201);
  assert.equal((await api("/api/app/users/object", "POST", {
    _id: "writer", username: "writer", password: "secret",
    permissions: [{ query: {}, perm: "c" }],
  })).status, 201);
  const writerLogin = await request(base, "/api/app/users/auth", "POST", {
    username: "writer", password: "secret",
  });
  assert.equal(writerLogin.status, 200);
  const writerCreate = await request(base, "/api/app/Task/object", "POST", {
    _id: "write-only", onCreate: { run: { action: "afterObj.handled = true; done()" } },
  }, writerLogin.body.accessToken);
  assert.equal(writerCreate.status, 201, JSON.stringify(writerCreate.body));
  assert.equal(writerCreate.body.handled, true);
  const writerStream = await fetch(`${base}/api/app/Task/object`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${writerLogin.body.accessToken}`,
      "content-type": "application/x-ndjson",
      prefer: "return=minimal",
    },
    body: '{"_id":"write-only-stream","onCreate":{"run":{"action":"done()"}}}\n',
  });
  assert.equal(writerStream.status, 201);
  assert.deepEqual(await writerStream.json(), { inserted: 1 });

  const bulkUpdated = await api("/api/app/Task/object", "PATCH", [
    { _id: "bulk-1", $set: { title: "One" } },
    { _id: "bulk-2", $set: { title: "Two" } },
  ]);
  assert.equal(bulkUpdated.status, 200);
  assert.deepEqual(bulkUpdated.body.items.map((item) => item.title), ["One", "Two"]);

  const patched = await api("/api/app/Task/object/child", "PATCH", { $set: { title: "Changed" } });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.title, "Changed");
  assert.equal(patched.body.bonus, 7);
  assert.equal(patched.body.changedHandler, true);
  assert.equal(node.get("app", "Task", "child").bonus, undefined);
  assert.equal(node.get("app", "Task", "child").changedHandler, undefined);

  const removed = await api("/api/app/Task/object/child", "DELETE");
  assert.equal(removed.status, 204);
  assert.equal(node.get("app", "Task", "child"), undefined);
  const bulkRemoved = await api("/api/app/Task/object", "DELETE", ["bulk-1", "bulk-2"]);
  assert.equal(bulkRemoved.status, 200);
  assert.equal(bulkRemoved.body.deleted, 2);

  const handlerCreate = await api("/api/app/Task/object", "POST", {
    _id: "returning",
    onCreate: {
      first: { action: 'afterObj.steps = ["first"]; done("first")' },
      second: { action: 'afterObj.steps.push("second"); done({ steps: afterObj.steps })' },
    },
    onChange: { run: { action: "done(false)" } },
    onDelete: { run: { action: "done({ deleted: beforeObj._id })" } },
  });
  assert.equal(handlerCreate.status, 201);
  assert.deepEqual(handlerCreate.body, { steps: ["first", "second"] });
  assert.equal(node.get("app", "Task", "returning").steps, undefined);
  const handlerUpdate = await api("/api/app/Task/object/returning", "PATCH", { $set: { title: "new" } });
  assert.equal(handlerUpdate.status, 200);
  assert.equal(handlerUpdate.body, false);
  const handlerDelete = await api("/api/app/Task/object/returning", "DELETE");
  assert.equal(handlerDelete.status, 200);
  assert.deepEqual(handlerDelete.body, { deleted: "returning" });

  const bulkHandler = await api("/api/app/Task/object", "POST", [
    { _id: "bulk-return", onCreate: { run: { action: 'done("custom")' } } },
    { _id: "bulk-ordinary" },
  ]);
  assert.equal(bulkHandler.status, 201);
  assert.equal(bulkHandler.body[0], "custom");
  assert.equal(bulkHandler.body[1]._id, "bulk-ordinary");
  const bulkHandlerDelete = await api("/api/app/Task/object", "DELETE", ["bulk-return", "bulk-ordinary"]);
  assert.equal(bulkHandlerDelete.status, 200);
  assert.equal(bulkHandlerDelete.body.deleted, 2);

  assert.equal((await api("/api/app/Task/object", "POST", [
    { _id: "delete-return", onDelete: { run: { action: 'done("removed")' } } },
    { _id: "delete-ordinary" },
  ])).status, 201);
  const bulkDeleteReturn = await api("/api/app/Task/object", "DELETE", ["delete-return", "delete-ordinary"]);
  assert.equal(bulkDeleteReturn.status, 200);
  assert.deepEqual(bulkDeleteReturn.body, ["removed", null]);

  for (const [name, objy] of [
    ["Base", {}],
    ["Rule", { affectable: true }],
    ["Flexible", { structure: { color: "blue" }, inheritFamily: "Base" }],
  ]) {
    assert.equal((await api("/api/app/collections", "POST", {
      name, meta: { hooks: { use: ["objy"] }, objy },
    })).status, 201);
  }
  const invalidMeta = await api("/api/app/collections", "POST", {
    name: "Invalid", meta: { hooks: { use: ["objy"] }, objy: { affectable: "yes" } },
  });
  assert.equal(invalidMeta.status, 400);
  assert.equal(node.getCollectionMeta("app", "Invalid"), null);
  assert.equal((await api("/api/app/Base/object", "POST", {
    _id: "shared", inheritedFromBase: true,
  })).status, 201);
  assert.equal((await api("/api/app/Rule/object", "POST", {
    _id: "custom-defaults", affects: { kind: "custom" }, bonus: 10,
  })).status, 201);
  assert.equal((await api("/api/app/Flexible/object", "POST", {
    _id: "configured", kind: "custom", inherits: ["shared"],
  })).status, 201);
  const configured = await api("/api/app/Flexible/object/configured");
  assert.equal(configured.status, 200);
  assert.equal(configured.body.color, "blue");
  assert.equal(configured.body.inheritedFromBase, true);
  assert.equal(configured.body.bonus, 10);

  assert.equal((await api("/api/app/Flexible/meta", "PUT", {
    hooks: { use: ["objy"] }, objy: { structure: { color: "red" }, inheritFamily: "Base" },
  })).status, 200);
  assert.equal((await api("/api/app/Flexible/object", "POST", { _id: "after-meta" })).body.color, "red");
  assert.equal((await api("/api/app/Flexible/object/configured")).body.color, "blue");
  assert.equal((await api("/api/app/Flexible/meta", "PUT", {
    hooks: { use: ["objy"] }, objy: { inheritFamily: 12 },
  })).status, 400);
  assert.equal((await api("/api/app/Flexible/object", "POST", { _id: "after-rejected-meta" })).body.color, "red");
  assert.equal((await api("/api/app/Rule/meta", "PUT", {
    hooks: { use: ["objy"] }, objy: { affectable: false },
  })).status, 200);
  assert.equal((await api("/api/app/Flexible/object/configured")).body.bonus, undefined);

  assert.equal((await api("/api/databases", "POST", { name: "other" })).status, 201);
  assert.equal((await api("/api/other/collections", "POST", {
    name: "Flexible", meta: { hooks: { use: ["objy"] }, objy: { structure: { color: "yellow" } } },
  })).status, 201);
  assert.equal((await api("/api/other/Flexible/object", "POST", { _id: "same-name" })).body.color, "yellow");
  assert.equal((await api("/api/app/Flexible/object", "POST", { _id: "still-red" })).body.color, "red");
});

async function request(base, path, method, body, token) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}
