import { chromium, expect, firefox, test, webkit } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const repository = new URL("..", import.meta.url).pathname;
const enabled = process.env.UNIVERSAL_RUN === "1";
const objects = positiveInteger(process.env.UNIVERSAL_OBJECTS, 10_000);
const batchSize = positiveInteger(process.env.UNIVERSAL_BATCH_SIZE, 2_000);
const payloadBytes = positiveInteger(process.env.UNIVERSAL_PAYLOAD_BYTES, 192);
const pointReads = positiveInteger(process.env.UNIVERSAL_POINT_READS, 500);
const vectorObjects = positiveInteger(process.env.UNIVERSAL_VECTOR_OBJECTS, 1_000);
const variants = (process.env.UNIVERSAL_BROWSER_VARIANTS || "source,package,standalone")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const reportDirectory = resolve(repository, process.env.UNIVERSAL_REPORT_DIR || ".performance-results");
let server;
let base;
let standalone;

test.skip(!enabled, "run through npm run test:universal");
test.setTimeout(Math.max(120_000, objects * 20));

test.beforeAll(async () => {
  const manifest = JSON.parse(await readFile(join(repository, ".release/manifest.json"), "utf8"));
  standalone = manifest.standalone;
  server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/") {
      response.setHeader("content-type", "text/html");
      response.end('<!doctype html><script type="importmap">{"imports":{"fflate":"/vendor/fflate.js"}}</script>');
      return;
    }
    const path = filePath(url.pathname);
    if (!path) {
      response.statusCode = 404;
      response.end();
      return;
    }
    try {
      const file = await readFile(path);
      response.setHeader("content-type", extname(path) === ".js" ? "text/javascript" : "application/octet-stream");
      response.end(file);
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolvePromise) => server.close(resolvePromise));
});

test("universal consistency and performance workload", async ({ browserName }, testInfo) => {
  const reports = [];
  for (const variant of variants) {
    const browser = await browserTypes[browserName].launch(browserName === "chromium"
      ? { args: ["--enable-precise-memory-info"] }
      : {});
    try {
      const page = await browser.newPage();
      await page.goto(base);
      const report = await page.evaluate(async ({ entry, label, options }) => {
        const [{ createDatabase }, workload] = await Promise.all([
          import(entry),
          import("/workload.js"),
        ]);
        const database = createDatabase({ storage: { engine: "object" } });
        try {
          const result = await workload.runUniversalWorkload({
            root: database,
            label,
            ...options,
            memory: () => {
              const value = performance.memory;
              return value ? {
                heapUsed: value.usedJSHeapSize,
                heapTotal: value.totalJSHeapSize,
                heapLimit: value.jsHeapSizeLimit,
              } : null;
            },
          });
          workload.assertUniversalPerformance(result, {
            minInsertOpsPerSecond: 100,
            minPatchOpsPerSecond: 50,
            minDeleteOpsPerSecond: 50,
            maxBatchMs: 15_000,
            maxPointReadP95Ms: 1_000,
            maxQueryMs: 60_000,
          });
          return result;
        } finally {
          database.close();
        }
      }, {
        entry: entryFor(variant),
        label: `${testInfo.project.name}-${variant}`,
        options: { objects, batchSize, payloadBytes, pointReads, vectorObjects },
      });
      reports.push(report);
      console.log(formatResult(report));
    } finally {
      await browser.close();
    }
  }

  const signatures = new Set(reports.map((report) => JSON.stringify(report.signature)));
  expect(signatures.size, "all browser variants must produce the same consistency signature").toBe(1);
  assertRelativePerformance(reports, `${testInfo.project.name}-source`, `${testInfo.project.name}-package`);
  assertRelativePerformance(reports, `${testInfo.project.name}-source`, `${testInfo.project.name}-standalone`);

  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    join(reportDirectory, `browser-${testInfo.project.name}.json`),
    `${JSON.stringify({ objects, batchSize, payloadBytes, results: reports }, null, 2)}\n`,
  );
});

const browserTypes = { chromium, firefox, webkit };

function entryFor(variant) {
  if (variant === "source") return "/src/browser.js";
  if (variant === "package") return "/package/browser.js";
  if (variant === "standalone") return `/${standalone}`;
  throw new Error(`unknown universal browser variant: ${variant}`);
}

function filePath(pathname) {
  if (pathname === "/vendor/fflate.js") return join(repository, "node_modules/fflate/esm/browser.js");
  if (pathname === "/workload.js") return join(repository, "benchmarks/universal-workload.js");
  if (pathname === `/${standalone}`) return join(repository, ".release/artifacts", standalone);
  if (pathname.startsWith("/src/")) return inside(repository, pathname);
  if (pathname.startsWith("/package/")) {
    return inside(join(repository, ".release/staging/db"), pathname.slice("/package".length));
  }
  return null;
}

function inside(root, pathname) {
  const relative = normalize(pathname).replace(/^\/+/, "");
  const path = resolve(root, relative);
  return path.startsWith(`${resolve(root)}/`) ? path : null;
}

function assertRelativePerformance(reports, sourceLabel, candidateLabel) {
  const source = reports.find((report) => report.label === sourceLabel);
  const candidate = reports.find((report) => report.label === candidateLabel);
  if (!source || !candidate) return;
  const ratio = candidate.metrics.insertOpsPerSecond / source.metrics.insertOpsPerSecond;
  expect(ratio, `${candidateLabel} must retain at least 40% of source insert throughput`).toBeGreaterThanOrEqual(0.4);
}

function formatResult(report) {
  const heap = report.memory.afterMutation?.heapUsed;
  return [
    report.label,
    `${report.options.objects.toLocaleString()} objects`,
    `${round(report.metrics.insertOpsPerSecond).toLocaleString()} inserts/s`,
    `read p95 ${round(report.metrics.pointReadP95Ms)}ms`,
    `slowest query ${round(Math.max(...Object.values(report.metrics.queries)))}ms`,
    heap ? `heap ${round(heap / 1024 / 1024)} MiB` : null,
  ].filter(Boolean).join(" | ");
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`invalid positive integer: ${value}`);
  return number;
}

function round(value) {
  return Math.round(value * 10) / 10;
}
