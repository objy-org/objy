import assert from "node:assert/strict";
import test from "node:test";
import * as core from "objydb";

test("package root exposes the portable core", () => {
  assert.deepEqual(Object.keys(core), ["createDatabase"]);
  assert.equal(typeof core.createDatabase, "function");
});

test("server APIs are isolated behind the server entry", async () => {
  const server = await import("objydb/server");
  assert.equal(typeof server.createClient, "function");
  assert.equal(typeof server.createObjectHookRegistry, "function");
  assert.equal(typeof server.startServer, "function");
});

test("browser database is available through its isolated package entry", async () => {
  const browser = await import("objydb/browser");
  assert.equal(typeof browser.createDatabase, "function");
});

test("package internals are not exported", async () => {
  await assert.rejects(import("objydb/src/store.js"), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
});
