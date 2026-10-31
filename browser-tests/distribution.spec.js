import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const coreRoot = new URL("../.release/staging/core/", import.meta.url);
const manifestPath = new URL("../.release/manifest.json", import.meta.url);
let server;
let base;

test.beforeAll(async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const files = new Map();
  for (const file of ["browser.js", "runtime-browser.js", "shared.js"]) {
    files.set(`/core/${file}`, await readFile(new URL(file, coreRoot)));
  }
  const standaloneUrl = new URL(`../.release/artifacts/${manifest.standalone}`, import.meta.url);
  files.set(`/${basename(manifest.standalone)}`, await readFile(standaloneUrl));

  server = createServer((req, res) => {
    if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><title>OBJY DB distribution test</title>");
      return;
    }
    const module = files.get(req.url);
    if (module) {
      res.setHeader("content-type", "text/javascript");
      res.end(module);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("the @objy/db browser export runs with portable compression", async ({ page }) => {
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { createDatabase } = await import("/core/browser.js");
    const database = createDatabase({ storage: { engine: "object" } });
    await database.createDatabase("release");
    await database.database("release").createCollection("assets", {
      indexes: ["status"],
      columns: ["score"],
      tiering: { mode: "compressedMemory", offload: ["payload"], minBytes: 1 },
    });
    const assets = database.database("release").collection("assets");
    await assets.insertMany([
      { _id: "one", status: "active", score: 12, payload: "a".repeat(200) },
      { _id: "two", status: "archived", score: 8, payload: "b".repeat(200) },
    ]);
    await assets.ready();
    const found = await assets.find({ status: "active" });
    const aggregate = await assets.search({
      $aggregate: { fields: { total: { $sum: "score" } } },
    });
    const stats = assets.stats().compression;
    database.close();
    return {
      id: found[0]._id,
      payload: found[0].payload.length,
      total: aggregate[0].total,
      compressed: stats.compressedObjects,
    };
  });
  expect(result).toEqual({ id: "one", payload: 200, total: 20, compressed: 2 });
});

test("the GitHub browser artifact is standalone", async ({ page }) => {
  await page.goto(base);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const result = await page.evaluate(async (standalone) => {
    const { createDatabase } = await import(`/${standalone}`);
    const database = createDatabase();
    await database.createDatabase("release");
    await database.database("release").createCollection("assets", { indexes: ["status"] });
    const assets = database.database("release").collection("assets");
    await assets.insertMany([
      { _id: "one", status: "active" },
      { _id: "two", status: "archived" },
    ]);
    await assets.ready();
    const found = await assets.find({ status: "active" });
    database.close();
    return found[0]._id;
  }, manifest.standalone);
  expect(result).toBe("one");
});
