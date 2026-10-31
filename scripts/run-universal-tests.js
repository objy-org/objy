import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const options = parseOptions(process.argv.slice(2));
const reportDirectory = resolve(root, ".performance-results");

await rm(reportDirectory, { recursive: true, force: true });
await mkdir(reportDirectory, { recursive: true });

run(process.execPath, ["scripts/build-release-variants.js"]);
run(process.execPath, [
  "--expose-gc",
  "benchmarks/universal-node.js",
  `--objects=${options.objects}`,
  `--batch-size=${options.batchSize}`,
  `--payload-bytes=${options.payloadBytes}`,
  `--point-reads=${options.pointReads}`,
  `--vector-objects=${options.vectorObjects}`,
  `--variants=${options.nodeVariants}`,
]);

if (options.browsers !== "none") {
  const playwright = ["playwright", "test", "browser-tests/universal.spec.js", "--workers=1"];
  if (options.browsers !== "all") playwright.push(`--project=${options.browsers}`);
  run("npx", playwright, {
    UNIVERSAL_RUN: "1",
    UNIVERSAL_OBJECTS: String(options.objects),
    UNIVERSAL_BATCH_SIZE: String(options.batchSize),
    UNIVERSAL_PAYLOAD_BYTES: String(options.payloadBytes),
    UNIVERSAL_POINT_READS: String(options.pointReads),
    UNIVERSAL_VECTOR_OBJECTS: String(options.vectorObjects),
    UNIVERSAL_BROWSER_VARIANTS: options.browserVariants,
    UNIVERSAL_REPORT_DIR: reportDirectory,
  });
}

const reports = await loadReports(reportDirectory);
assertUniversalSignatures(reports);
console.log(`universal suite passed across ${reports.length} runtime variants`);
console.log(`performance reports: ${reportDirectory}`);

function run(command, args, extraEnvironment = {}) {
  const child = spawnSync(command, args, {
    cwd: root,
    env: {
      ...process.env,
      ...extraEnvironment,
      UNIVERSAL_REPORT_DIR: reportDirectory,
    },
    encoding: "utf8",
    stdio: "inherit",
  });
  if (child.status !== 0) process.exit(child.status || 1);
}

async function loadReports(directory) {
  const reports = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const document = JSON.parse(await readFile(resolve(directory, name), "utf8"));
    reports.push(...document.results);
  }
  if (!reports.length) throw new Error("universal suite produced no reports");
  return reports;
}

function assertUniversalSignatures(reports) {
  const expected = JSON.stringify(reports[0].signature);
  for (const report of reports.slice(1)) {
    if (JSON.stringify(report.signature) !== expected) {
      throw new Error(`${report.label} differs from the cross-platform consistency oracle`);
    }
  }
}

function parseOptions(argv) {
  const values = new Map();
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    values.set(key, value);
  }
  return {
    objects: positiveInteger(values.get("objects"), 10_000),
    batchSize: positiveInteger(values.get("batch-size"), 2_000),
    payloadBytes: positiveInteger(values.get("payload-bytes"), 192),
    pointReads: positiveInteger(values.get("point-reads"), 500),
    vectorObjects: positiveInteger(values.get("vector-objects"), 1_000),
    browsers: values.get("browsers") || "all",
    nodeVariants: values.get("node-variants") || "source-node,package-node,source-server,package-server",
    browserVariants: values.get("browser-variants") || "source,package,standalone",
  };
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`invalid positive integer: ${value}`);
  return number;
}
