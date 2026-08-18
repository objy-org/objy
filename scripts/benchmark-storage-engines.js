import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";

const ENGINES = {
  shape: {
    engine: "shape",
  },
  object: {
    engine: "object",
    object: {
      valueDirectory: {
        enabled: true,
        minRefs: 2,
        maxStringLength: 256,
      },
    },
  },
};

const DEFAULTS = Object.freeze({
  objects: 100_000,
  batch: 5_000,
  reads: 25_000,
});

const args = parseArgs(process.argv.slice(2));

if (!args.engine) runParent(args);
else await runChild(args);

function runParent(options) {
  const script = fileURLToPath(import.meta.url);
  const nodeArgs = process.execArgv.includes("--expose-gc")
    ? process.execArgv
    : [...process.execArgv, "--expose-gc"];
  const results = [];

  for (const engine of Object.keys(ENGINES)) {
    const child = spawnSync(process.execPath, [
      ...nodeArgs,
      script,
      `--engine=${engine}`,
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
  const storage = ENGINES[options.engine];
  if (!storage) throw new Error(`unknown benchmark engine: ${options.engine}`);

  forceGc();
  const beforeHeap = heapUsed();
  const store = new Store(storage);
  store.createCollection("bench", "assets", {
    indexes: ["status", "applications", "properties.department.value"],
    columnIndexes: ["cost", "properties.cost.value", "status", "properties.department.value"],
  });
  const collection = store.collection("bench", "assets");

  const expected = expectedAggregate(options.objects);
  const insert = time(() => loadRows(store, options));
  await store.awaitIndexes("bench", "assets");
  forceGc();
  const afterLoadHeap = heapUsed();

  const sampleIds = sampleObjectIds(options.objects, options.reads);
  const randomReads = time(() => {
    let checksum = 0;
    for (const id of sampleIds) checksum += collection.read(id)?.cost || 0;
    return checksum;
  });

  const indexedRead = time(() => {
    return collection.find({ applications: { $contains: "assetmanagement" } }, { limit: 50 }).length;
  });

  const flatAggregate = time(() => {
    return collection.aggregate({ applications: { $contains: "assetmanagement" } }, {
      fields: {
        total: { $sum: "cost" },
        n: { $count: true },
      },
    });
  });

  const groupedAggregate = time(() => {
    return collection.aggregate({ applications: { $contains: "assetmanagement" } }, {
      groupBy: "properties.department.value",
      fields: {
        total: { $sum: "properties.cost.value" },
        n: { $count: true },
      },
    });
  });

  assertAggregate(flatAggregate.value, expected);
  assertGroupedAggregate(groupedAggregate.value, expected);

  const result = {
    engine: options.engine,
    objects: options.objects,
    heapMb: mb(afterLoadHeap - beforeHeap),
    heapUsedMb: mb(afterLoadHeap),
    insertMs: round(insert.ms),
    randomReadMs: round(randomReads.ms),
    indexedReadMs: round(indexedRead.ms),
    flatAggregateMs: round(flatAggregate.ms),
    groupedAggregateMs: round(groupedAggregate.ms),
    readPath: collection.readPath({ applications: { $contains: "assetmanagement" } }),
    aggregatePath: collection.aggregatePath({ applications: { $contains: "assetmanagement" } }, {
      groupBy: "properties.department.value",
      fields: {
        total: { $sum: "properties.cost.value" },
        n: { $count: true },
      },
    }),
    stats: collection.shapeStats()[0],
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
  const companies = ["acme", "initech", "globex", "umbrella"];
  const department = departments[i % departments.length];
  const cost = 50 + ((i * 37) % 10_000);
  const activeApp = i % 3 !== 0;
  const object = {
    status: statuses[i % statuses.length],
    applications: activeApp ? ["assetmanagement", "objy-agent"] : ["objy-agent"],
    role: "asset",
    name: `Asset ${i}`,
    display_name: `Asset ${i}`,
    asset_tag: `AST-${String(i).padStart(8, "0")}`,
    company: companies[i % companies.length],
    cost,
    properties: {
      department: { value: department },
      company: { value: companies[i % companies.length] },
      cost: { value: cost },
    },
    lifecycle: {
      state: statuses[i % statuses.length],
      bucket: `bucket-${i % 32}`,
    },
  };
  if (i % 11 === 0) object.serial_number = `SNR-${i}-${i * 17}`;
  if (i % 17 === 0) object.custom = { flag: i % 2 === 0, score: i % 101 };
  return object;
}

function expectedAggregate(count) {
  const groups = new Map();
  let total = 0;
  let n = 0;
  for (let i = 0; i < count; i++) {
    const object = assetObject(i);
    if (!object.applications.includes("assetmanagement")) continue;
    total += object.cost;
    n++;
    const key = object.properties.department.value;
    const group = groups.get(key) || { total: 0, n: 0 };
    group.total += object.properties.cost.value;
    group.n++;
    groups.set(key, group);
  }
  return { total, n, groups };
}

function assertAggregate(rows, expected) {
  const row = rows?.[0];
  if (!row || row.total !== expected.total || row.n !== expected.n) {
    throw new Error(`flat aggregate mismatch: ${JSON.stringify(rows)} expected ${JSON.stringify({
      total: expected.total,
      n: expected.n,
    })}`);
  }
}

function assertGroupedAggregate(rows, expected) {
  const seen = new Map((rows || []).map((row) => [row["properties.department.value"], row]));
  if (seen.size !== expected.groups.size) throw new Error(`group count mismatch: ${seen.size} expected ${expected.groups.size}`);
  for (const [key, expectedRow] of expected.groups) {
    const row = seen.get(key);
    if (!row || row.total !== expectedRow.total || row.n !== expectedRow.n) {
      throw new Error(`group aggregate mismatch for ${key}: ${JSON.stringify(row)} expected ${JSON.stringify(expectedRow)}`);
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
    if (key === "engine") parsed.engine = value;
    if (key === "objects" || key === "n") parsed.objects = positiveInt(value, DEFAULTS.objects);
    if (key === "batch") parsed.batch = positiveInt(value, DEFAULTS.batch);
    if (key === "reads") parsed.reads = positiveInt(value, DEFAULTS.reads);
  }
  return parsed;
}

function printSummary(results) {
  const rows = results.map((result) => ({
    engine: result.engine,
    objects: result.objects,
    "heap delta MB": result.heapMb,
    "insert ms": result.insertMs,
    "random reads ms": result.randomReadMs,
    "indexed read ms": result.indexedReadMs,
    "flat agg ms": result.flatAggregateMs,
    "group agg ms": result.groupedAggregateMs,
    "read path": result.readPath,
    "aggregate path": result.aggregatePath,
    columns: result.stats.columns || 0,
  }));
  console.table(rows);
  for (const result of results) {
    console.log(`${result.engine} stats: ${JSON.stringify(compactStats(result.stats))}`);
  }
}

function compactStats(stats) {
  return {
    engine: stats.engine,
    rows: stats.rows,
    bytes: stats.bytes,
    ridTable: stats.ridTable,
    valueDirectory: stats.valueDirectory,
    columns: stats.columns,
    columnStats: stats.columnStats?.slice(0, 12),
  };
}

function forceGc() {
  global.gc?.();
}

function heapUsed() {
  return process.memoryUsage().heapUsed;
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
