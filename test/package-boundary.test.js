import assert from "node:assert/strict";
import test from "node:test";
import * as server from "@objy/server";

test("package root exposes the server API", () => {
  assert.equal(typeof server.startServer, "function");
  assert.equal(typeof server.createInterfaceContext, "function");
});

test("server package exposes hooks but not client or database variants", async () => {
  const hooks = await import("@objy/server/hooks");
  assert.equal(typeof hooks.createObjectHookRegistry, "function");
  for (const path of ["@objy/server/client", "@objy/server/db", "@objy/server/browser"]) {
    await assert.rejects(import(path), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }
});

test("package internals are not exported", async () => {
  await assert.rejects(import("@objy/server/src/store.js"), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
});
