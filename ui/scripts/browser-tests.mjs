import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";
import { buildSite, root } from "./build.mjs";
import { staticServer } from "./static-server.mjs";
import { testServer } from "../tests/helpers/server.mjs";
import { createServerAdapter } from "../src/data/adapters.js";
import { createFileService } from "../../src/files.js";
import { seedPreviews } from "../tests/helpers/attachment-fixtures.mjs";

if (!process.argv.includes("--skip-build"))
  await buildSite({ serverOutput: true });
const files = createFileService({ mode: "memory" });
const backend = await testServer({
  files,
  auth: { enabled: true },
  environment: { OBJYDB_ADMIN_PASSWORD: "ui-regression-only" },
});
const adapter = createServerAdapter({
  url: backend.url,
  username: "admin",
  password: "ui-regression-only",
});
await adapter.open();
await adapter.createDatabase("ui_regression");
await seedPreviews(adapter, "ui_regression", "previews");
for (const name of ["items", "other"])
  await adapter.createCollection("ui_regression", name);
await adapter.insertMany(
  "ui_regression",
  "items",
  Array.from({ length: 110 }, (_, i) => ({
    _id: `item-${String(i).padStart(3, "0")}`,
    name: `Item ${i}`,
    active: i % 2 === 0,
    value: i,
  })),
);
await adapter.insertMany("ui_regression", "other", [
  { _id: "other", name: "Other collection" },
]);
await adapter.createDatabase("delete_in_ui");
for (const name of ["remove_me", "keep_me"]) {
  await adapter.createCollection("delete_in_ui", name);
  await adapter.insertFile("delete_in_ui", name, { _id: "file", name: "fixture.txt" }, new File(["disposable fixture"], "fixture.txt"));
}
let configRequests = 0;
let failQuery = false,
  finishing = false;
const server = staticServer(join(root, "dist"), {
  route: async (req, res, url) => {
    if (
      url.pathname === "/__qa/" ||
      url.pathname === "/__qa/browser-tests.js"
    ) {
      const file = url.pathname.endsWith(".js")
        ? "browser-tests.js"
        : "index.html";
      res.writeHead(200, {
        "content-type": file.endsWith(".js") ? "text/javascript" : "text/html",
        "cache-control": "no-store",
      });
      res.end(await readFile(join(root, "tests/browser", file)));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/__qa/config-requests") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ count: configRequests }));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/__qa/fail-query") {
      failQuery = true;
      res.writeHead(204).end();
      return true;
    }
    if (req.method === "POST" && url.pathname === "/__qa/result") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 100_000) throw new Error("Report too large");
      }
      const report = JSON.parse(body);
      let verified = false;
      try {
        const rows = await adapter.search("ui_regression", "items", {});
        const meta = await adapter.getMeta("ui_regression", "items");
        const created = await adapter.search("created_in_ui", "entries", {});
        const attachment = created.find((row) => row._id === "attachment");
        const databases = await adapter.listDatabases();
        verified =
          rows.length === 109 &&
          !rows.some((row) => row._id === "item-000") &&
          meta.label === "Edited in browser" &&
          created.some((row) => row.name === "Created in browser" && row._file) &&
          attachment?.nested?.keep === true &&
          attachment?.label === "JSON preserved" &&
          await (await adapter.downloadFile("created_in_ui", "entries", "attachment")).text() === "file version 2" &&
          !databases.includes("delete_in_ui") &&
          (await files.storage.list(files.databasePrefix("delete_in_ui") + "/")).length === 0;
      } catch {
        /* A failed UI run may not have reached creation. */
      }
      const passed = report.failed === 0 && verified;
      console.log(
        JSON.stringify({ ...report, serverStateVerified: verified }, null, 2),
      );
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ passed, serverStateVerified: verified }));
      setTimeout(() => finish(passed ? 0 : 1), 250);
      return true;
    }
    if (url.pathname === "/api/config") configRequests++;
    if (failQuery && url.pathname.endsWith("/search")) {
      failQuery = false;
      res
        .writeHead(503, { "content-type": "application/json" })
        .end('{"error":"Injected query failure"}');
      return true;
    }
    // Exercise the actual server UI routes and assets as well as its API.
    // Only this disposable backend is reachable; there is no arbitrary proxy target.
    const upstream = request(
      new URL(req.url, backend.url),
      { method: req.method, headers: req.headers },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () =>
      res.writeHead(502).end("Test server unavailable"),
    );
    req.pipe(upstream);
    return true;
  },
});
async function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timeout);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await adapter.close();
  await backend.close();
  process.exitCode = code;
}
server.listen(0, "127.0.0.1", () =>
  console.log(
    `Browser regression tests: http://127.0.0.1:${server.address().port}/__qa/`,
  ),
);
const timeout = setTimeout(() => {
  console.error("Browser tests timed out.");
  finish(1);
}, 10 * 60_000);
process.on("SIGINT", () => finish(1));
process.on("SIGTERM", () => finish(1));
