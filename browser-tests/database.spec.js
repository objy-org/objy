import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("..", import.meta.url).pathname;
let server;
let base;

test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><script type="importmap">{"imports":{"fflate":"/vendor/fflate.js"}}</script>`);
      return;
    }
    const relative = url.pathname === "/vendor/fflate.js"
      ? "node_modules/fflate/esm/browser.js"
      : normalize(url.pathname).replace(/^\/+/, "");
    if (!relative.startsWith("src/") && !relative.startsWith("node_modules/fflate/")) {
      res.statusCode = 404;
      res.end();
      return;
    }
    try {
      const file = await readFile(join(root, relative));
      res.setHeader("content-type", extname(relative) === ".js" ? "text/javascript" : "application/octet-stream");
      res.end(file);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("the database runs entirely inside a real browser", async ({ page }) => {
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { createDatabase } = await import("/src/browser.js");
    const database = createDatabase({ storage: { engine: "object" } });
    await database.createDatabase("browser");
    const db = database.database("browser");
    await db.createCollection("people");
    await db.createCollection("assets", {
      indexes: ["status"],
      columns: ["cost"],
      tiering: { mode: "compressedMemory", keep: ["status", "owner", "cost"], minBytes: 1 },
    });
    await db.collection("people").insert({ _id: "ada", name: "Ada" });
    const assets = db.collection("assets");
    await assets.insertMany([
      {
        _id: "one",
        status: "active",
        cost: 12,
        payload: "compress résumé 🚀 ".repeat(100),
        owner: { type: "reference", collection: "people", value: "ada" },
        _vec: [1, 0],
      },
      { _id: "two", status: "archived", cost: 8, payload: "compress ".repeat(100), _vec: [0, 1] },
    ]);
    await assets.ready();
    const found = await assets.find({ status: "active" });
    const aggregate = await assets.search({ $aggregate: { fields: { total: { $sum: "cost" } } } });
    const vector = await assets.search({ $vector: { vector: [1, 0], limit: 1 }, $refDepth: 0 });
    const stats = assets.stats();
    return {
      found: found[0]._id,
      owner: found[0].owner.object.name,
      total: aggregate[0].total,
      vector: vector[0]._id,
      compressed: stats.compression.compressedObjects,
    };
  });
  expect(result).toEqual({ found: "one", owner: "Ada", total: 20, vector: "one", compressed: 2 });
});
