import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertUniversalPerformance,
  comparableSignature,
  runUniversalWorkload,
  UNIVERSAL_DEFAULTS,
} from "./universal-workload.js";

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
    const line = child.stdout.split("\n").find((entry) => entry.startsWith("UNIVERSAL_RESULT "));
    if (!line) throw new Error(`${variant} did not produce a universal test result`);
    const result = JSON.parse(line.slice("UNIVERSAL_RESULT ".length));
    results.push(result);
    console.log(formatResult(result));
  }

  assertSignatures(results);
  assertRelativePerformance(results, "source-node", "package-node");
  assertRelativePerformance(results, "source-server", "package-server");
  await writeReport(settings.reportDir, "node.json", { options: settings, results });
}

async function runChild(settings) {
  const runtime = await openVariant(settings.variant);
  let report;
  try {
    report = await runUniversalWorkload({
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
    assertUniversalPerformance(report, settings.variant.includes("server") ? {
      minInsertOpsPerSecond: 100,
      minPatchOpsPerSecond: 50,
      minDeleteOpsPerSecond: 50,
      maxBatchMs: 15_000,
      maxPointReadP95Ms: 1_000,
      maxQueryMs: 60_000,
    } : {
      minInsertOpsPerSecond: 250,
      minPatchOpsPerSecond: 100,
      minDeleteOpsPerSecond: 100,
      maxBatchMs: 10_000,
      maxPointReadP95Ms: 500,
      maxQueryMs: 60_000,
    });
    console.log(`UNIVERSAL_RESULT ${JSON.stringify(report)}`);
  } finally {
    await runtime.close();
  }
}

async function openVariant(variant) {
  if (variant === "source-node" || variant === "package-node") {
    const entry = variant === "source-node"
      ? new URL("../src/core.js", import.meta.url)
      : new URL("../.release/staging/db/node.js", import.meta.url);
    const { createDatabase } = await import(entry);
    const database = createDatabase({ storage: { engine: "object" } });
    return {
      root: database,
      close: async () => database.close(),
    };
  }

  if (variant === "source-server" || variant === "package-server") {
    const entry = variant === "source-server"
      ? new URL("../src/api.js", import.meta.url)
      : new URL("../.release/staging/server/src/api.js", import.meta.url);
    const { createClient, startServer } = await import(entry);
    const runtime = await startServer({
      port: 0,
      auth: {
        jwtSecret: "universal-test-secret",
        users: [{
          _id: "universal-admin",
          username: "admin",
          password: "universal-password",
          role: "admin",
          admin: true,
        }],
      },
      bootstrapLogger: () => {},
      maxJsonBytes: 64 * 1024 * 1024,
    });
    const client = createClient({
      url: `http://127.0.0.1:${runtime.port}`,
      timeoutMs: 10 * 60_000,
    });
    await client.login({ username: "admin", password: "universal-password" });
    return {
      root: client,
      ready: (database, collection) => runtime.node.awaitIndexes(database, collection),
      close: async () => {
        runtime.replication?.stop?.();
        await new Promise((resolvePromise) => runtime.server.close(resolvePromise));
        runtime.node.db.dispose();
      },
    };
  }

  throw new Error(`unknown universal Node variant: ${variant}`);
}

function parseOptions(argv, environment) {
  const values = new Map();
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    values.set(key, value);
  }
  return {
    variant: values.get("variant") || null,
    variants: values.get("variants") || environment.UNIVERSAL_NODE_VARIANTS || "source-node,package-node,source-server,package-server",
    objects: numberOption(values.get("objects") || environment.UNIVERSAL_OBJECTS, UNIVERSAL_DEFAULTS.objects),
    batchSize: numberOption(values.get("batch-size") || environment.UNIVERSAL_BATCH_SIZE, UNIVERSAL_DEFAULTS.batchSize),
    payloadBytes: numberOption(values.get("payload-bytes") || environment.UNIVERSAL_PAYLOAD_BYTES, UNIVERSAL_DEFAULTS.payloadBytes),
    pointReads: numberOption(values.get("point-reads") || environment.UNIVERSAL_POINT_READS, UNIVERSAL_DEFAULTS.pointReads),
    vectorObjects: numberOption(values.get("vector-objects") || environment.UNIVERSAL_VECTOR_OBJECTS, UNIVERSAL_DEFAULTS.vectorObjects),
    reportDir: resolve(root, environment.UNIVERSAL_REPORT_DIR || ".performance-results"),
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
