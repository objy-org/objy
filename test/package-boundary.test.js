import assert from "node:assert/strict";
import test from "node:test";
import * as database from "@objy/db";

test("package root exposes the universal database", () => {
  assert.deepEqual(Object.keys(database), ["createDatabase"]);
  assert.equal(typeof database.createDatabase, "function");
});

test("server and client APIs are not exported by the database package", async () => {
  for (const path of ["@objy/db/server", "@objy/db/client", "@objy/db/hooks"]) {
    await assert.rejects(import(path), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }
});

test("package internals are not exported", async () => {
  await assert.rejects(import("@objy/db/src/store.js"), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
});
