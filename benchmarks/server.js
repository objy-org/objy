import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertServerPerformance,
  comparableSignature,
  runServerWorkload,
  SERVER_DEFAULTS,
} from "./server-workload.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const options = parseOptions(process.argv.slice(2), process.env);

if (options.variant) await runChild(options);
else await runParent(options);

async function runParent(settings) {
  const variants = settings.variants.split(",").map((value) => value.trim()).filter(Boolean);
  const results = [];
  for (const variant of variants) {
    const child = spawnSync(process.execPath, [
      "--expose-gc",
      fileURLToPath(import.meta.url),
      `--variant=${variant}`,
      `--objects=${settings.objects}`,
      `--batch-size=${settings.batchSize}`,
      `--payload-bytes=${settings.payloadBytes}`,
      `--point-reads=${settings.pointReads}`,
      `--vector-objects=${settings.vectorObjects}`,
    ], {
      cwd: root,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (child.status !== 0) {
      process.stderr.write(child.stdout || "");
      process.stderr.write(child.stderr || "");
      process.exit(child.status || 1);
    }
    const line = child.stdout.split("\n").find((entry) => entry.startsWith("SERVER_RESULT "));
    if (!line) throw new Error(`${variant} did not produce a server benchmark result`);
    const result = JSON.parse(line.slice("SERVER_RESULT ".length));
    results.push(result);
    console.log(formatResult(result));
  }

  assertSignatures(results);
  assertRelativePerformance(results, "source-server", "package-server");
  await writeReport(settings.reportDir, "server.json", { options: settings, results });
}

async function runChild(settings) {
  const runtime = await openVariant(settings.variant);
  try {
    const report = await runServerWorkload({
      root: runtime.root,
      label: settings.variant,
      objects: settings.objects,
      batchSize: settings.batchSize,
      payloadBytes: settings.payloadBytes,
      pointReads: settings.pointReads,
      vectorObjects: settings.vectorObjects,
      memory: nodeMemory,
      ready: runtime.ready,
    });
    assertServerPerformance(report, {
      minInsertOpsPerSecond: 100,
      minPatchOpsPerSecond: 50,
      minDeleteOpsPerSecond: 50,
      maxBatchMs: 15_000,
      maxPointReadP95Ms: 1_000,
      maxQueryMs: 60_000,
    });
    console.log(`SERVER_RESULT ${JSON.stringify(report)}`);
  } finally {
    await runtime.close();
  }
}

async function openVariant(variant) {
  if (variant !== "source-server" && variant !== "package-server") {
    throw new Error(`unknown server variant: ${variant}`);
  }
  const entry = variant === "source-server"
    ? new URL("../src/api.js", import.meta.url)
    : new URL("../.release/staging/server/src/api.js", import.meta.url);
  const { startServer } = await import(entry);
  const { createClient } = await import("@objy/client");
  const server = await startServer({
    port: 0,
    auth: {
      jwtSecret: "server-benchmark-secret",
      users: [{
        _id: "server-benchmark-admin",
        username: "admin",
        password: "server-benchmark-password",
        role: "admin",
        admin: true,
      }],
    },
    bootstrapLogger: () => {},
    maxJsonBytes: 64 * 1024 * 1024,
  });
  const client = createClient({
    url: `http://127.0.0.1:${server.port}`,
    timeoutMs: 10 * 60_000,
  });
  await client.login({ username: "admin", password: "server-benchmark-password" });
  return {
    root: client,
    ready: (database, collection) => server.node.awaitIndexes(database, collection),
    close: async () => {
      server.replication?.stop?.();
      await new Promise((resolvePromise) => server.server.close(resolvePromise));
      server.node.db.dispose();
    },
  };
}

function parseOptions(argv, environment) {
  const values = new Map();
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    values.set(key, value);
  }
  return {
    variant: values.get("variant") || null,
    variants: values.get("variants") || environment.SERVER_VARIANTS || "source-server,package-server",
    objects: numberOption(values.get("objects") || environment.SERVER_OBJECTS, SERVER_DEFAULTS.objects),
    batchSize: numberOption(values.get("batch-size") || environment.SERVER_BATCH_SIZE, SERVER_DEFAULTS.batchSize),
    payloadBytes: numberOption(values.get("payload-bytes") || environment.SERVER_PAYLOAD_BYTES, SERVER_DEFAULTS.payloadBytes),
    pointReads: numberOption(values.get("point-reads") || environment.SERVER_POINT_READS, SERVER_DEFAULTS.pointReads),
    vectorObjects: numberOption(values.get("vector-objects") || environment.SERVER_VECTOR_OBJECTS, SERVER_DEFAULTS.vectorObjects),
    reportDir: resolve(root, environment.SERVER_REPORT_DIR || ".performance-results"),
  };
}

function numberOption(value, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`invalid positive integer: ${value}`);
  return number;
}

function nodeMemory() {
  global.gc?.();
  const value = process.memoryUsage();
  return {
    rss: value.rss,
    heapUsed: value.heapUsed,
    heapTotal: value.heapTotal,
    external: value.external,
  };
}

function assertSignatures(results) {
  const expected = comparableSignature(results[0]);
  for (const result of results.slice(1)) {
    if (comparableSignature(result) !== expected) {
      throw new Error(`${result.label} produced a different consistency signature`);
    }
  }
}

function assertRelativePerformance(results, sourceLabel, packageLabel) {
  const source = results.find((result) => result.label === sourceLabel);
  const packaged = results.find((result) => result.label === packageLabel);
  if (!source || !packaged) return;
  const ratio = packaged.metrics.insertOpsPerSecond / source.metrics.insertOpsPerSecond;
  if (ratio < 0.5) {
    throw new Error(`${packageLabel} insert throughput regressed to ${round(ratio * 100)}% of ${sourceLabel}`);
  }
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

async function writeReport(directory, name, value) {
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`);
}

function round(value) {
  return Math.round(value * 10) / 10;
}
