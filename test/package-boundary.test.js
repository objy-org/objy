import assert from "node:assert/strict";
import test from "node:test";
import * as api from "objydb";

test("package root exposes APIs without starting a server", () => {
  assert.equal(typeof api.createClient, "function");
  assert.equal(typeof api.createObjectHookRegistry, "function");
  assert.equal(typeof api.startServer, "function");
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
