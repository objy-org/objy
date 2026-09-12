import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";

const DEFAULTS = Object.freeze({
  objects: 100_000,
  batch: 5_000,
  reads: 10_000,
});

const MODES = {
  full: {
    meta: {
      indexes: ["status", "applications", "department"],
      columns: ["cost"],
    },
  },
  compressed: {
    meta: {
      indexes: ["status", "applications", "department"],
      columns: ["cost"],
      tiering: {
        mode: "compressedMemory",
        keep: ["name", "status", "applications", "department"],
        minBytes: 1,
      },
    },
  },
};

const args = parseArgs(process.argv.slice(2));

if (!args.mode) runParent(args);
else await runChild(args);

function runParent(options) {
  const script = fileURLToPath(import.meta.url);
  const nodeArgs = process.execArgv.includes("--expose-gc")
    ? process.execArgv
    : [...process.execArgv, "--expose-gc"];
  const results = [];

  for (const mode of Object.keys(MODES)) {
    const child = spawnSync(process.execPath, [
      ...nodeArgs,
      script,
      `--mode=${mode}`,
      `--objects=${options.objects}`,
      `--batch=${options.batch}`,
      `--reads=${options.reads}`,
      "--json",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.status !== 0) {
      process.stderr.write(child.stderr || child.stdout);
      process.exit(child.status || 1);
    }
    const line = child.stdout.trim().split("\n").find((entry) => entry.startsWith("RESULT "));
    if (!line) {
      process.stderr.write(child.stderr || child.stdout);
      process.exit(1);
    }
    results.push(JSON.parse(line.slice("RESULT ".length)));
  }

  printSummary(results);
}

async function runChild(options) {
  const mode = MODES[options.mode];
  if (!mode) throw new Error(`unknown benchmark mode: ${options.mode}`);

  forceGc();
  const before = memory();
  const store = new Store({
    engine: "object",
    object: {
      valueDirectory: {
        enabled: true,
        minRefs: 2,
        maxStringLength: 256,
      },
    },
  });
  store.createCollection("bench", "assets", mode.meta);
  const collection = store.collection("bench", "assets");

  const expected = expectedAggregate(options.objects);
  const insert = time(() => loadRows(store, options));
  await store.awaitIndexes("bench", "assets");
  forceGc();
  const afterLoad = memory();

  const sampleIds = sampleObjectIds(options.objects, options.reads);
  const randomFullReads = time(() => {
    let checksum = 0;
    for (const id of sampleIds) checksum += collection.read(id)?.history?.events?.length || 0;
    return checksum;
  });

  const indexedRead = time(() => {
    return collection.find({ applications: { $contains: "assetmanagement" } }, { limit: 50 }).length;
  });

  const aggregate = time(() => {
    return collection.aggregate({ applications: { $contains: "assetmanagement" } }, {
      groupBy: "department",
      fields: {
        total: { $sum: "cost" },
        n: { $count: true },
      },
    });
  });

  assertGroupedAggregate(aggregate.value, expected);
  const stats = collection.shapeStats()[0];
  const result = {
    mode: options.mode,
    objects: options.objects,
    memory: diffMemory(before, afterLoad),
    insertMs: round(insert.ms),
    randomFullReadMs: round(randomFullReads.ms),
    indexedReadMs: round(indexedRead.ms),
    aggregateMs: round(aggregate.ms),
    readPath: collection.readPath({ applications: { $contains: "assetmanagement" } }),
    aggregatePath: collection.aggregatePath({ applications: { $contains: "assetmanagement" } }, {
      groupBy: "department",
      fields: {
        total: { $sum: "cost" },
        n: { $count: true },
      },
    }),
    tiering: stats.tiering,
  };

  if (options.json) console.log(`RESULT ${JSON.stringify(result)}`);
  else console.log(JSON.stringify(result, null, 2));
}

function loadRows(store, options) {
  for (let start = 0; start < options.objects; start += options.batch) {
    const end = Math.min(start + options.batch, options.objects);
    const ops = [];
    for (let i = start; i < end; i++) {
      ops.push({
        kind: "putObj",
        db: "bench",
        coll: "assets",
        id: objectId(i),
        value: assetObject(i),
        ts: { c: i + 1, n: "bench" },
      });
    }
    store.applyOps(ops);
  }
}

function assetObject(i) {
  const departments = ["it", "hr", "finance", "sales", "ops", "legal", "support", "field"];
  const statuses = ["active", "active", "active", "archived"];
  const department = departments[i % departments.length];
  const cost = 50 + ((i * 37) % 10_000);
  const activeApp = i % 3 !== 0;
  return {
    name: `Asset ${i}`,
    status: statuses[i % statuses.length],
    applications: activeApp ? ["assetmanagement", "objy-agent"] : ["objy-agent"],
    department,
    cost,
    history: {
      summary: coldText(i),
      events: Array.from({ length: 8 }, (_, step) => ({
        step,
        at: `2026-08-${String((step % 28) + 1).padStart(2, "0")}`,
        note: `asset ${i} lifecycle event ${step} ${"checked ".repeat(12)}`,
      })),
    },
    raw: {
      source: "benchmark",
      payload: coldText(i + 17),
    },
  };
}

function coldText(i) {
  return Array.from({ length: 24 }, (_, line) => {
    return `asset=${i} line=${line} status payload repeated audit trail ${"value ".repeat(24)}`;
  }).join("\n");
}

function expectedAggregate(count) {
  const groups = new Map();
  for (let i = 0; i < count; i++) {
    const object = assetObject(i);
    if (!object.applications.includes("assetmanagement")) continue;
    const group = groups.get(object.department) || { total: 0, n: 0 };
    group.total += object.cost;
    group.n++;
    groups.set(object.department, group);
  }
  return groups;
}

function assertGroupedAggregate(rows, expected) {
  const seen = new Map((rows || []).map((row) => [row.department, row]));
  if (seen.size !== expected.size) throw new Error(`group count mismatch: ${seen.size} expected ${expected.size}`);
  for (const [department, expectedRow] of expected) {
    const row = seen.get(department);
    if (!row || row.total !== expectedRow.total || row.n !== expectedRow.n) {
      throw new Error(`aggregate mismatch for ${department}: ${JSON.stringify(row)} expected ${JSON.stringify(expectedRow)}`);
    }
  }
}

function sampleObjectIds(count, reads) {
  const ids = [];
  let seed = 0x9e3779b1;
  for (let i = 0; i < reads; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    ids.push(objectId(seed % count));
  }
  return ids;
}

function objectId(i) {
  return `asset-${i}`;
}

function time(fn) {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

function parseArgs(argv) {
  const parsed = { ...DEFAULTS };
  for (const arg of argv) {
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "mode") parsed.mode = value;
    if (key === "objects" || key === "n") parsed.objects = positiveInt(value, DEFAULTS.objects);
    if (key === "batch") parsed.batch = positiveInt(value, DEFAULTS.batch);
    if (key === "reads") parsed.reads = positiveInt(value, DEFAULTS.reads);
  }
  return parsed;
}

function printSummary(results) {
  console.table(results.map((result) => ({
    mode: result.mode,
    objects: result.objects,
    "heap MB": result.memory.heapUsedMb,
    "rss MB": result.memory.rssMb,
    "external MB": result.memory.externalMb,
    "insert ms": result.insertMs,
    "full reads ms": result.randomFullReadMs,
    "indexed read ms": result.indexedReadMs,
    "aggregate ms": result.aggregateMs,
    "aggregate path": result.aggregatePath,
    "tier objects": result.tiering.objects,
    "cold raw MB": mb(result.tiering.rawBytes),
    "cold compressed MB": mb(result.tiering.compressedBytes),
  })));
}

function memory() {
  return process.memoryUsage();
}

function diffMemory(before, after) {
  return {
    heapUsedMb: mb(after.heapUsed - before.heapUsed),
    rssMb: mb(after.rss - before.rss),
    externalMb: mb(after.external - before.external),
  };
}

function forceGc() {
  global.gc?.();
}

function mb(bytes) {
  return round(bytes / 1024 / 1024);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
