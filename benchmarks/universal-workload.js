const GROUP_COUNT = 16;
const OWNER_COUNT = 16;
const DELETE_STRIDE = 10;

export const UNIVERSAL_DEFAULTS = Object.freeze({
  objects: 10_000,
  batchSize: 2_000,
  payloadBytes: 192,
  pointReads: 500,
  vectorObjects: 1_000,
});

export async function runUniversalWorkload({
  root,
  label,
  objects = UNIVERSAL_DEFAULTS.objects,
  batchSize = UNIVERSAL_DEFAULTS.batchSize,
  payloadBytes = UNIVERSAL_DEFAULTS.payloadBytes,
  pointReads = UNIVERSAL_DEFAULTS.pointReads,
  vectorObjects = UNIVERSAL_DEFAULTS.vectorObjects,
  mutationCount = Math.max(1, Math.min(objects, Math.floor(objects * 0.05))),
  memory = () => null,
  ready,
  yieldEveryBatches = 4,
} = {}) {
  requireRoot(root);
  const options = normalizeOptions({
    objects,
    batchSize,
    payloadBytes,
    pointReads,
    vectorObjects,
    mutationCount,
  });
  const oracle = buildOracle(options.objects, options.mutationCount);
  const databaseName = "universal";
  const metrics = { batches: {}, queries: {} };
  const beforeMemory = memory();

  await root.createDatabase(databaseName);
  const database = root.database(databaseName);
  await database.createCollection("owners");
  await database.createCollection("objects", {
    indexes: ["status", "group", "tags", "score"],
    columns: ["amount", "score"],
    tiering: {
      mode: "compressedMemory",
      keep: ["status", "group", "tags", "score", "amount", "owner", "_vec"],
      minBytes: 1,
    },
  });

  const owners = database.collection("owners");
  const collection = database.collection("objects");
  await owners.insertMany(ownerRows(), { minimal: true });

  const insert = await runBatches(options.objects, options.batchSize, yieldEveryBatches, async (start, end) => {
    const rows = [];
    for (let index = start; index < end; index++) {
      rows.push(objectAt(index, options.payloadBytes, options.vectorObjects));
    }
    const result = await collection.insertMany(rows, { minimal: true });
    equal(result.inserted, rows.length, `inserted count at ${start}`);
  });
  metrics.insertMs = insert.totalMs;
  metrics.insertOpsPerSecond = rate(options.objects, insert.totalMs);
  metrics.batches.insertMaxMs = insert.maxMs;

  metrics.readyAfterInsertMs = await measure(async () => {
    if (ready) await ready(databaseName, "objects");
    else await collection.ready?.();
  });
  const afterInsertMemory = memory();

  const initial = await verifyInitial(collection, oracle, options, metrics);

  const patch = await runBatches(options.mutationCount, options.batchSize, yieldEveryBatches, async (start, end) => {
    const patches = [];
    for (let index = start; index < end; index++) {
      patches.push({
        _id: objectId(index),
        $set: {
          status: "mutated",
          score: mutatedScore(index),
          amount: mutatedAmount(index),
        },
      });
    }
    const result = await collection.patchMany(patches, { minimal: true });
    equal(result.updated, patches.length, `updated count at ${start}`);
    equal(result.skipped, 0, `update skipped count at ${start}`);
  });
  metrics.patchMs = patch.totalMs;
  metrics.patchOpsPerSecond = rate(options.mutationCount, patch.totalMs);
  metrics.batches.patchMaxMs = patch.maxMs;

  const dirtyMutated = await timedQuery(metrics, "dirtyMutatedCount", () => collection.count({ status: "mutated" }));
  equal(dirtyMutated, options.mutationCount, "dirty field index count");

  const deleteIds = [];
  for (let index = 0; index < options.mutationCount; index += DELETE_STRIDE) {
    deleteIds.push(objectId(index));
  }
  const remove = await runBatches(deleteIds.length, options.batchSize, yieldEveryBatches, async (start, end) => {
    const ids = deleteIds.slice(start, end);
    const result = await collection.removeMany(ids, { minimal: true });
    equal(result.deleted, ids.length, `deleted count at ${start}`);
    equal(result.skipped, 0, `delete skipped count at ${start}`);
  });
  metrics.deleteMs = remove.totalMs;
  metrics.deleteOpsPerSecond = rate(deleteIds.length, remove.totalMs);
  metrics.batches.deleteMaxMs = remove.maxMs;

  const dirtyFinal = await verifyFinal(collection, oracle, metrics, "dirty");
  metrics.readyAfterMutationMs = await measure(async () => {
    if (ready) await ready(databaseName, "objects");
    else await collection.ready?.();
  });
  const settledFinal = await verifyFinal(collection, oracle, metrics, "settled");
  deepEqual(dirtyFinal, settledFinal, "dirty and settled results");

  const runtimeStats = typeof collection.stats === "function" ? collection.stats() : null;
  const afterMutationMemory = memory();
  const signature = {
    initial,
    final: settledFinal,
    vector: oracle.vectorId,
  };

  return {
    label,
    options,
    signature,
    metrics: {
      ...metrics,
      pointReadP50Ms: percentile(metrics.pointReadSamples, 0.5),
      pointReadP95Ms: percentile(metrics.pointReadSamples, 0.95),
      pointReadP99Ms: percentile(metrics.pointReadSamples, 0.99),
      pointReadSamples: undefined,
    },
    memory: {
      before: beforeMemory,
      afterInsert: afterInsertMemory,
      afterMutation: afterMutationMemory,
    },
    runtime: runtimeStats,
  };
}

export function assertUniversalPerformance(report, {
  minInsertOpsPerSecond,
  minPatchOpsPerSecond,
  minDeleteOpsPerSecond,
  maxBatchMs,
  maxPointReadP95Ms,
  maxQueryMs,
} = {}) {
  const failures = [];
  if (minInsertOpsPerSecond && report.metrics.insertOpsPerSecond < minInsertOpsPerSecond) {
    failures.push(`insert throughput ${round(report.metrics.insertOpsPerSecond)} < ${minInsertOpsPerSecond} objects/s`);
  }
  if (minPatchOpsPerSecond && report.metrics.patchOpsPerSecond < minPatchOpsPerSecond) {
    failures.push(`patch throughput ${round(report.metrics.patchOpsPerSecond)} < ${minPatchOpsPerSecond} objects/s`);
  }
  if (minDeleteOpsPerSecond && report.metrics.deleteOpsPerSecond < minDeleteOpsPerSecond) {
    failures.push(`delete throughput ${round(report.metrics.deleteOpsPerSecond)} < ${minDeleteOpsPerSecond} objects/s`);
  }
  const slowestBatch = Math.max(...Object.values(report.metrics.batches));
  if (maxBatchMs && slowestBatch > maxBatchMs) {
    failures.push(`slowest batch ${round(slowestBatch)}ms > ${maxBatchMs}ms`);
  }
  if (maxPointReadP95Ms && report.metrics.pointReadP95Ms > maxPointReadP95Ms) {
    failures.push(`point-read p95 ${round(report.metrics.pointReadP95Ms)}ms > ${maxPointReadP95Ms}ms`);
  }
  const slowestQuery = Math.max(...Object.values(report.metrics.queries));
  if (maxQueryMs && slowestQuery > maxQueryMs) {
    failures.push(`slowest query ${round(slowestQuery)}ms > ${maxQueryMs}ms`);
  }
  if (failures.length) throw new Error(`${report.label} performance budget failed: ${failures.join("; ")}`);
}

export function comparableSignature(report) {
  return JSON.stringify(report.signature);
}

async function verifyInitial(collection, oracle, options, metrics) {
  const total = await timedQuery(metrics, "initialTotalCount", () => collection.count());
  const active = await timedQuery(metrics, "initialActiveCount", () => collection.count({ status: "active" }));
  const universal = await timedQuery(metrics, "initialContainsCount", () => collection.count({ tags: { $contains: "universal" } }));
  equal(total, oracle.initial.total, "initial total");
  equal(active, oracle.initial.active, "initial active count");
  equal(universal, oracle.initial.universal, "initial contains count");

  const [aggregate] = await timedQuery(metrics, "initialAggregate", () => collection.search({
    status: "active",
    $aggregate: {
      fields: {
        sum: { $sum: "amount" },
        count: { $count: true },
        average: { $avg: "amount" },
        minimum: { $min: "amount" },
        maximum: { $max: "amount" },
      },
    },
  }));
  verifyMetricRow(aggregate, oracle.initial.aggregate, "initial aggregate");

  const grouped = await timedQuery(metrics, "initialGroupedAggregate", () => collection.search({
    tags: { $contains: "universal" },
    $aggregate: {
      groupBy: "group",
      fields: {
        sum: { $sum: "amount" },
        count: { $count: true },
        minimum: { $min: "amount" },
        maximum: { $max: "amount" },
      },
    },
  }));
  verifyGroups(grouped, oracle.initial.groups);

  const sorted = await timedQuery(metrics, "initialSortedPage", () => collection.find({}, {
    sortBy: "score",
    sort: "desc",
    limit: Math.min(100, options.objects),
    refDepth: 0,
  }));
  for (let index = 1; index < sorted.length; index++) {
    truthy(sorted[index - 1].score >= sorted[index].score, "sorted page order");
  }

  const readSamples = [];
  const reads = Math.min(options.pointReads, options.objects);
  for (let sample = 0; sample < reads; sample++) {
    const index = sampleIndex(sample, options.objects);
    const started = now();
    const row = await collection.get(objectId(index), { refDepth: sample === 0 ? 1 : 0 });
    readSamples.push(now() - started);
    equal(row._id, objectId(index), `point read ${index}`);
    equal(row.payload.length, payloadAt(index, options.payloadBytes).length, `hydrated payload ${index}`);
    if (sample === 0) equal(row.owner.object.region, ownerRegion(index), "reference hydration");
  }
  metrics.pointReadSamples = readSamples;

  const vector = await timedQuery(metrics, "initialVectorSearch", () => collection.search({
    $vector: { vector: [1, 0, 0], limit: 5, ef: options.vectorObjects },
    $refDepth: 0,
  }));
  equal(vector[0]._id, oracle.vectorId, "nearest vector");

  return {
    total,
    active,
    universal,
    aggregate: canonicalMetricRow(aggregate),
    groups: canonicalGroups(grouped),
    sortedScores: sorted.map((row) => row.score),
  };
}

async function verifyFinal(collection, oracle, metrics, phase) {
  const total = await timedQuery(metrics, `${phase}TotalCount`, () => collection.count());
  const mutated = await timedQuery(metrics, `${phase}MutatedCount`, () => collection.count({ status: "mutated" }));
  equal(total, oracle.final.total, `${phase} total`);
  equal(mutated, oracle.final.mutated, `${phase} mutated count`);

  const [aggregate] = await timedQuery(metrics, `${phase}Aggregate`, () => collection.search({
    status: "mutated",
    $aggregate: {
      fields: {
        sum: { $sum: "amount" },
        count: { $count: true },
        average: { $avg: "amount" },
        minimum: { $min: "amount" },
        maximum: { $max: "amount" },
      },
    },
  }));
  verifyMetricRow(aggregate, oracle.final.aggregate, `${phase} aggregate`);

  for (const index of oracle.final.samples) {
    const row = await readMaybe(collection, objectId(index), { refDepth: 0 });
    if (index < oracle.mutationCount && index % DELETE_STRIDE === 0) {
      equal(row, undefined, `${phase} deleted object ${index}`);
    } else {
      equal(row._id, objectId(index), `${phase} object ${index}`);
      if (index < oracle.mutationCount) {
        equal(row.status, "mutated", `${phase} status ${index}`);
        equal(row.amount, mutatedAmount(index), `${phase} amount ${index}`);
      }
    }
  }

  return { total, mutated, aggregate: canonicalMetricRow(aggregate) };
}

function buildOracle(objects, mutationCount) {
  const initialAggregate = metricAccumulator();
  const groups = new Map();
  let active = 0;
  let universal = 0;
  for (let index = 0; index < objects; index++) {
    const amount = amountAt(index);
    if (isActive(index)) {
      active++;
      addMetric(initialAggregate, amount);
    }
    if (hasUniversalTag(index)) {
      universal++;
      const group = groupAt(index);
      const metric = groups.get(group) || metricAccumulator();
      addMetric(metric, amount);
      groups.set(group, metric);
    }
  }

  const finalAggregate = metricAccumulator();
  let deleted = 0;
  for (let index = 0; index < mutationCount; index++) {
    if (index % DELETE_STRIDE === 0) deleted++;
    else addMetric(finalAggregate, mutatedAmount(index));
  }

  return {
    mutationCount,
    vectorId: objectId(0),
    initial: {
      total: objects,
      active,
      universal,
      aggregate: finishMetric(initialAggregate),
      groups: Object.fromEntries([...groups].map(([key, value]) => [key, finishMetric(value)])),
    },
    final: {
      total: objects - deleted,
      mutated: mutationCount - deleted,
      aggregate: finishMetric(finalAggregate),
      samples: sampleIndexes(objects, mutationCount),
    },
  };
}

function objectAt(index, payloadBytes, vectorObjects) {
  return {
    _id: objectId(index),
    status: isActive(index) ? "active" : "archived",
    group: groupAt(index),
    score: scoreAt(index),
    amount: amountAt(index),
    tags: hasUniversalTag(index) ? ["universal", "secondary"] : ["secondary"],
    owner: { type: "reference", collection: "owners", value: ownerId(index) },
    payload: payloadAt(index, payloadBytes),
    ...(index % 11 === 0 ? { optional: { enabled: index % 22 === 0, bucket: index % 101 } } : {}),
    ...(index < vectorObjects ? { _vec: index === 0 ? [1, 0, 0] : [0, 1, index / vectorObjects] } : {}),
  };
}

function ownerRows() {
  return Array.from({ length: OWNER_COUNT }, (_, index) => ({
    _id: `owner-${index}`,
    name: `Owner ${index}`,
    region: `region-${index % 4}`,
  }));
}

function objectId(index) {
  return `object-${index}`;
}

function ownerId(index) {
  return `owner-${index % OWNER_COUNT}`;
}

function ownerRegion(index) {
  return `region-${(index % OWNER_COUNT) % 4}`;
}

function isActive(index) {
  return index % 4 !== 0;
}

function hasUniversalTag(index) {
  return index % 3 !== 0;
}

function groupAt(index) {
  return `group-${index % GROUP_COUNT}`;
}

function scoreAt(index) {
  return (index * 17) % 10_000;
}

function amountAt(index) {
  return (index * 37) % 1_000;
}

function mutatedScore(index) {
  return 20_000 + index;
}

function mutatedAmount(index) {
  return 5_000 + (index % 100);
}

function payloadAt(index, bytes) {
  const prefix = `object=${index};`;
  return prefix + String(index % 10).repeat(Math.max(0, bytes - prefix.length));
}

function metricAccumulator() {
  return { sum: 0, count: 0, minimum: Infinity, maximum: -Infinity };
}

function addMetric(metric, value) {
  metric.sum += value;
  metric.count++;
  metric.minimum = Math.min(metric.minimum, value);
  metric.maximum = Math.max(metric.maximum, value);
}

function finishMetric(metric) {
  return {
    sum: metric.sum,
    count: metric.count,
    average: metric.count ? metric.sum / metric.count : 0,
    minimum: metric.count ? metric.minimum : null,
    maximum: metric.count ? metric.maximum : null,
  };
}

function verifyMetricRow(actual, expected, label) {
  equal(actual.sum, expected.sum, `${label} sum`);
  equal(actual.count, expected.count, `${label} count`);
  closeTo(actual.average, expected.average, `${label} average`);
  equal(actual.minimum, expected.minimum, `${label} minimum`);
  equal(actual.maximum, expected.maximum, `${label} maximum`);
}

function verifyGroups(actual, expected) {
  const rows = new Map(actual.map((row) => [row.group, row]));
  equal(rows.size, Object.keys(expected).length, "group count");
  for (const [group, metric] of Object.entries(expected)) {
    verifyMetricRow({ ...rows.get(group), average: metric.average }, metric, `group ${group}`);
  }
}

function canonicalMetricRow(row) {
  return {
    sum: row.sum,
    count: row.count,
    average: round(row.average),
    minimum: row.minimum,
    maximum: row.maximum,
  };
}

function canonicalGroups(rows) {
  return [...rows]
    .sort((left, right) => left.group.localeCompare(right.group))
    .map((row) => ({
      group: row.group,
      sum: row.sum,
      count: row.count,
      minimum: row.minimum,
      maximum: row.maximum,
    }));
}

function sampleIndexes(objects, mutationCount) {
  return [
    0,
    1,
    Math.min(mutationCount - 1, 42),
    Math.floor(objects / 2),
    objects - 1,
  ].filter((value, index, all) => value >= 0 && value < objects && all.indexOf(value) === index);
}

function sampleIndex(sample, objects) {
  return (sample * 7_919) % objects;
}

async function readMaybe(collection, id, options) {
  try {
    return await collection.get(id, options);
  } catch (error) {
    if (error?.status === 404) return undefined;
    throw error;
  }
}

async function runBatches(total, batchSize, yieldEvery, operation) {
  const started = now();
  let maxMs = 0;
  let batch = 0;
  for (let start = 0; start < total; start += batchSize) {
    const batchStarted = now();
    await operation(start, Math.min(start + batchSize, total));
    maxMs = Math.max(maxMs, now() - batchStarted);
    batch++;
    if (yieldEvery > 0 && batch % yieldEvery === 0) await yieldControl();
  }
  return { totalMs: now() - started, maxMs };
}

async function timedQuery(metrics, name, operation) {
  const started = now();
  const result = await operation();
  metrics.queries[name] = now() - started;
  return result;
}

async function measure(operation) {
  const started = now();
  await operation();
  return now() - started;
}

function normalizeOptions(options) {
  return {
    objects: positiveInteger(options.objects, "objects"),
    batchSize: positiveInteger(options.batchSize, "batchSize"),
    payloadBytes: positiveInteger(options.payloadBytes, "payloadBytes"),
    pointReads: positiveInteger(options.pointReads, "pointReads"),
    vectorObjects: Math.min(positiveInteger(options.vectorObjects, "vectorObjects"), options.objects),
    mutationCount: Math.min(positiveInteger(options.mutationCount, "mutationCount"), options.objects),
  };
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`${label} must be a positive integer`);
  return number;
}

function requireRoot(root) {
  if (!root || typeof root.createDatabase !== "function" || typeof root.database !== "function") {
    throw new TypeError("root must provide the OBJY DB database API");
  }
}

function rate(count, milliseconds) {
  return milliseconds > 0 ? count / (milliseconds / 1_000) : Infinity;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function now() {
  return globalThis.performance.now();
}

function yieldControl() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function equal(actual, expected, label) {
  if (!Object.is(actual, expected)) throw new Error(`${label}: ${String(actual)} !== ${String(expected)}`);
}

function closeTo(actual, expected, label) {
  if (Math.abs(actual - expected) > 1e-9) throw new Error(`${label}: ${actual} != ${expected}`);
}

function truthy(value, label) {
  if (!value) throw new Error(label);
}

function deepEqual(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${label}: ${left} !== ${right}`);
}
