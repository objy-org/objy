import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const modulePath = new URL("../.release/staging/browser/index.js", import.meta.url);
let server;
let base;

test.beforeAll(async () => {
  const module = await readFile(modulePath);
  server = createServer((req, res) => {
    if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><script type=module src=/objydb.js></script>");
      return;
    }
    if (req.url === "/objydb.js") {
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

test("the packaged browser distribution is standalone", async ({ page }) => {
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { createDatabase } = await import("/objydb.js");
    const database = createDatabase({ storage: { engine: "object" } });
    await database.createDatabase("release");
    await database.database("release").createCollection("assets", {
      indexes: ["status"],
      columns: ["score"],
    });
    const assets = database.database("release").collection("assets");
    await assets.insertMany([
      { _id: "one", status: "active", score: 12 },
      { _id: "two", status: "archived", score: 8 },
    ]);
    await assets.ready();
    const found = await assets.find({ status: "active" });
    const aggregate = await assets.search({
      $aggregate: { fields: { total: { $sum: "score" } } },
    });
    database.close();
    return { id: found[0]._id, total: aggregate[0].total };
  });
  expect(result).toEqual({ id: "one", total: 20 });
});
