import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as db from "@objy/db";

test("database and UI package identities match the workspace lockfile", async () => {
  const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
  const manifest = await readJson("../package.json");
  const ui = await readJson("../ui/package.json");
  const lock = await readJson("../package-lock.json");

  assert.equal(manifest.name, "@objy/db");
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[""].name, manifest.name);
  assert.equal(ui.name, "@objy/db-ui");
  assert.equal(lock.packages.ui.name, ui.name);
  assert.deepEqual(lock.packages[`node_modules/${ui.name}`], { resolved: "ui", link: true });
});

test("package root exposes the server API", () => {
  assert.equal(typeof db.startServer, "function");
  assert.equal(typeof db.createInterfaceContext, "function");
});

test("database package exposes hooks but not client or embedded variants", async () => {
  const hooks = await import("@objy/db/hooks");
  assert.equal(typeof hooks.createObjectHookRegistry, "function");
  for (const path of ["@objy/db/client", "@objy/db/db", "@objy/db/browser"]) {
    await assert.rejects(import(path), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }
});

test("package internals are not exported", async () => {
  await assert.rejects(import("@objy/db/src/store.js"), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
});
