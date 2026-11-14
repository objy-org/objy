import test from "node:test";
import assert from "node:assert/strict";
import { createFileService } from "../../src/files.js";
import { ObjyStore, createServerAdapter } from "../src/data/objy-store.js";
import { testServer } from "./helpers/server.mjs";

async function setup(t, files = createFileService({ mode: "memory" })) {
  const server = await testServer({
    files,
    auth: { enabled: true },
    environment: { OBJYDB_ADMIN_PASSWORD: "file-tests-only" },
  });
  t.after(() => server.close());
  const adapter = createServerAdapter({ url: server.url, username: "admin", password: "file-tests-only" });
  const store = await new ObjyStore(adapter).open();
  t.after(() => store.close());
  await store.createDatabase("attachments");
  await store.createCollections("attachments", ["docs", "keep"]);
  return { store, adapter, files, server };
}

test("files: official client uploads and downloads exact bytes, preserves JSON, and cleans up on deletion", async (t) => {
  const { store, files } = await setup(t);
  const bytes = new Uint8Array([0, 1, 127, 128, 255, 13, 10]);
  const original = await store.insertFile("attachments", "docs", { _id: "binary", name: "bytes.bin", nested: { keep: true } }, new File([bytes], "bytes.bin"));
  assert.deepEqual(new Uint8Array(await (await store.downloadFile("attachments", "docs", "binary")).arrayBuffer()), bytes);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.downloadFile("attachments", "docs", "binary", { signal: controller.signal }), { code: "ABORTED" });
  await store.loadCollection("attachments", "docs");
  const edited = { ...original, label: "Edited JSON" };
  await store.replaceObject("attachments", "docs", "binary", edited, { expected: original });
  assert.deepEqual(new Uint8Array(await (await store.downloadFile("attachments", "docs", "binary")).arrayBuffer()), bytes);
  const replaced = await store.replaceFile("attachments", "docs", "binary", new File(["replacement"], "new.txt", { type: "text/plain" }), { expected: edited });
  assert.equal(replaced.label, "Edited JSON");
  assert.deepEqual(replaced.nested, { keep: true });
  assert.notEqual(replaced._file.key, original._file.key);
  assert.equal(await files.storage.getBlob(original._file.key), null);
  assert.equal(await (await store.downloadFile("attachments", "docs", "binary")).text(), "replacement");
  assert.equal(store.assertCollection("attachments", "docs").objects[0]._file.key, replaced._file.key);
  await store.removeObjects("attachments", "docs", ["binary"]);
  assert.equal(await files.storage.getBlob(replaced._file.key), null);
  await assert.rejects(store.downloadFile("attachments", "docs", "binary"), { status: 404 });
});

test("files: attaching to an existing object preserves fields; stale and missing replacements do not write", async (t) => {
  const { store, adapter } = await setup(t);
  const original = { _id: "plain", name: "Existing", nested: { value: 4 } };
  await store.insertObjects("attachments", "docs", [original]);
  const attached = await store.replaceFile("attachments", "docs", "plain", new File([], "empty.txt", { type: "text/plain" }), { expected: original });
  assert.deepEqual(attached.nested, original.nested);
  assert.equal((await store.downloadFile("attachments", "docs", "plain")).size, 0);
  await adapter.patch("attachments", "docs", "plain", { $set: { name: "Changed elsewhere" } });
  await assert.rejects(store.replaceFile("attachments", "docs", "plain", new File(["wrong"], "wrong.txt"), { expected: attached }), /changed on the server/);
  const current = await adapter.get("attachments", "docs", "plain");
  assert.equal(current.name, "Changed elsewhere");
  assert.equal(current._file.key, attached._file.key);
  await assert.rejects(store.replaceFile("attachments", "docs", "missing", new File(["no"], "no.txt")), /not found/);
  assert.equal(await adapter.get("attachments", "docs", "missing"), undefined);
});

test("scope deletion removes only its objects and blobs, even when the following refresh fails", async (t) => {
  const { store, adapter, files } = await setup(t);
  const deleted = await store.insertFile("attachments", "docs", { _id: "deleted" }, new File(["delete"], "delete.txt"));
  const kept = await store.insertFile("attachments", "keep", { _id: "kept" }, new File(["keep"], "keep.txt"));
  await store.createDatabase("unrelated");
  await store.loadCollection("attachments", "docs");
  const listCollections = adapter.listCollections;
  adapter.listCollections = async () => { throw new Error("Refresh offline"); };
  await store.dropCollection("attachments", "docs");
  assert.deepEqual(store.assertDatabase("attachments").collections.map((c) => c.name), ["keep"]);
  assert.match(store.refreshError.message, /Refresh offline/);
  assert.equal(await files.storage.getBlob(deleted._file.key), null);
  assert.ok(await files.storage.getBlob(kept._file.key));
  adapter.listCollections = listCollections;
  adapter.listDatabases = async () => { throw new Error("Refresh offline"); };
  await store.dropDatabase("attachments");
  assert.ok(!store.databases.some((db) => db.name === "attachments"));
  assert.ok(store.databases.some((db) => db.name === "unrelated"));
  assert.equal(await files.storage.getBlob(kept._file.key), null);
});

test("unavailable file storage and denied deletions leave existing data intact", async (t) => {
  const { store } = await setup(t, null);
  await store.insertObjects("attachments", "docs", [{ _id: "original", name: "Keep" }]);
  await assert.rejects(store.insertFile("attachments", "docs", { _id: "new" }, new File(["x"], "x.txt")), /file storage/i);
  await assert.rejects(store.replaceFile("attachments", "docs", "original", new File(["x"], "x.txt")), /file storage/i);
  assert.deepEqual(await store.query("attachments", "docs"), [{ _id: "original", name: "Keep" }]);
  await assert.rejects(store.dropDatabase("_global"));
  assert.ok(store.databases.some((db) => db.name === "_global"));
});
