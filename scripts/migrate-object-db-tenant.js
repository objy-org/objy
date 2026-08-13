#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
if (args.help) usage(0);

const config = {
  sourceBase: trimSlash(args.source || env("SOURCE_BASE_URL", "https://spoo.io")),
  sourceTenant: args.sourceTenant || env("SOURCE_TENANT", "meier"),
  sourceAuthTenant: args.sourceAuthTenant || env("SOURCE_AUTH_TENANT", "_objectdb"),
  sourceAuthCollection: args.sourceAuthCollection || env("SOURCE_AUTH_COLLECTION", "users"),
  sourceUsername: args.sourceUsername || env("SOURCE_USERNAME", "admin"),
  sourcePassword: args.sourcePassword || env("SOURCE_PASSWORD", ""),
  targetBase: trimSlash(args.target || env("TARGET_BASE_URL", "http://178.105.99.197:8080")),
  targetDatabase: args.targetDatabase || env("TARGET_DATABASE", "meier"),
  targetAuthDatabase: args.targetAuthDatabase || env("TARGET_AUTH_DATABASE", "_global"),
  targetAuthCollection: args.targetAuthCollection || env("TARGET_AUTH_COLLECTION", "users"),
  targetUsername: args.targetUsername || env("TARGET_USERNAME", "admin"),
  targetPassword: args.targetPassword || env("TARGET_PASSWORD", ""),
  checkpointPath: resolve(process.cwd(), args.checkpoint || env("CHECKPOINT", ".spread-db/migrations/object-db-meier.json")),
  batchSize: positiveInt(args.batchSize || env("BATCH_SIZE"), 1000),
  retries: positiveInt(args.retries || env("RETRIES"), 4),
  timeoutMs: positiveInt(args.timeoutMs || env("TIMEOUT_MS"), 60_000),
  collectionFilter: csv(args.collections || env("COLLECTIONS", "")),
  dryRun: booleanArg(args.dryRun || env("DRY_RUN", "")),
  resetCheckpoint: booleanArg(args.resetCheckpoint || env("RESET_CHECKPOINT", "")),
  minimalReturn: args.minimalReturn !== "false",
  compatReferences: args.compatReferences !== "false",
};

const authState = {
  sourceToken: null,
  targetToken: null,
};

main().catch((err) => {
  console.error(`migration failed: ${err.stack || err.message}`);
  process.exit(1);
});

async function main() {
  assertConfig();
  const checkpoint = config.resetCheckpoint ? freshCheckpoint() : loadCheckpoint();

  log(`source ${config.sourceBase}/api/tenant/${config.sourceTenant}`);
  log(`target ${config.targetBase}/api/${config.targetDatabase}`);
  log(`checkpoint ${config.checkpointPath}`);

  authState.sourceToken = (await login({
    base: config.sourceBase,
    database: config.sourceAuthTenant,
    collection: config.sourceAuthCollection,
    username: config.sourceUsername,
    password: config.sourcePassword,
    oldApi: true,
  })).accessToken;
  authState.targetToken = (await login({
    base: config.targetBase,
    database: config.targetAuthDatabase,
    collection: config.targetAuthCollection,
    username: config.targetUsername,
    password: config.targetPassword,
    oldApi: false,
  })).accessToken;

  const collections = await listSourceCollections();
  const selected = config.collectionFilter.length
    ? collections.filter((name) => config.collectionFilter.includes(name))
    : collections;
  if (config.collectionFilter.length) {
    for (const wanted of config.collectionFilter) {
      if (!collections.includes(wanted)) throw new Error(`source collection not found: ${wanted}`);
    }
  }

  log(`source collections: ${collections.length}; selected: ${selected.length}`);
  const sourceCounts = await countSourceCollections(selected);
  const totalObjects = sum(Object.values(sourceCounts));
  log(`source object count: ${totalObjects}`);

  if (!config.dryRun) {
    await ensureTargetDatabase();
    for (const collection of selected) await ensureTargetCollection(collection);
  }

  checkpoint.startedAt ||= new Date().toISOString();
  checkpoint.source = { base: config.sourceBase, tenant: config.sourceTenant };
  checkpoint.target = { base: config.targetBase, database: config.targetDatabase };
  checkpoint.batchSize = config.batchSize;
  checkpoint.sourceCounts = sourceCounts;
  saveCheckpoint(checkpoint);

  for (const collection of selected) {
    await migrateCollection({ checkpoint, collection, expectedCount: sourceCounts[collection] });
  }

  if (!config.dryRun) {
    log("verifying target counts");
    const verification = {};
    for (const collection of selected) {
      const targetCount = await countTargetCollection(collection);
      verification[collection] = { source: sourceCounts[collection], target: targetCount };
      if (targetCount !== sourceCounts[collection]) {
        throw new Error(`count mismatch for ${collection}: source ${sourceCounts[collection]}, target ${targetCount}`);
      }
    }
    checkpoint.verification = verification;
  }

  checkpoint.completedAt = new Date().toISOString();
  saveCheckpoint(checkpoint);
  log(`migration complete: ${selected.length} collections, ${totalObjects} objects`);
  if (checkpoint.warnings?.length) {
    log(`warnings: ${checkpoint.warnings.length}; see checkpoint for details`);
  }
}

async function migrateCollection({ checkpoint, collection, expectedCount }) {
  const state = checkpoint.collections[collection] || {
    imported: 0,
    cursor: null,
    complete: false,
    startedAt: new Date().toISOString(),
    batches: 0,
    idConflicts: 0,
    referenceCompatAdds: 0,
  };
  checkpoint.collections[collection] = state;

  if (state.complete && state.imported === expectedCount) {
    log(`skip ${collection}: already complete (${state.imported})`);
    return;
  }

  log(`migrate ${collection}: ${state.imported}/${expectedCount}`);
  while (true) {
    const { rows, nextCursor } = await fetchSourceBatch(collection, state.cursor);
    if (rows.length === 0) break;

    const stats = { idConflicts: 0, referenceCompatAdds: 0 };
    const prepared = rows.map((row) => prepareObject(row, stats));
    state.idConflicts += stats.idConflicts;
    state.referenceCompatAdds += stats.referenceCompatAdds;

    if (!config.dryRun) await writeTargetBatch(collection, prepared);

    state.imported += rows.length;
    state.cursor = nextCursor;
    state.batches += 1;
    state.updatedAt = new Date().toISOString();
    saveCheckpoint(checkpoint);

    if (state.batches === 1 || state.batches % 10 === 0 || !nextCursor) {
      log(`${collection}: ${state.imported}/${expectedCount}${nextCursor ? "" : " done"}`);
    }
    if (!nextCursor) break;
  }

  state.complete = true;
  state.completedAt = new Date().toISOString();
  saveCheckpoint(checkpoint);
}

function prepareObject(row, stats) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("source row is not an object");
  }
  const id = row._id ?? row.id;
  if (id === undefined || id === null || String(id).length === 0) {
    throw new Error(`source object has no _id/id: ${JSON.stringify(row).slice(0, 300)}`);
  }
  const prepared = deepClone(row);
  prepared._id = String(id);
  if (config.compatReferences) addCollectionToOldReferences(prepared, stats);
  return prepared;
}

function addCollectionToOldReferences(value, stats) {
  if (Array.isArray(value)) {
    for (const item of value) addCollectionToOldReferences(item, stats);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (
    value.type === "reference" &&
    typeof value.family === "string" &&
    value.family.length > 0 &&
    value.collection === undefined
  ) {
    value.collection = value.family;
    stats.referenceCompatAdds += 1;
  }
  if (
    value.type === "reference" &&
    typeof value.tenant === "string" &&
    value.tenant.length > 0 &&
    value.database === undefined
  ) {
    value.database = value.tenant;
    stats.referenceCompatAdds += 1;
  }
  for (const item of Object.values(value)) addCollectionToOldReferences(item, stats);
}

async function login({ base, database, collection, username, password, oldApi }) {
  const path = oldApi
    ? `/api/tenant/${enc(database)}/${enc(collection)}/auth`
    : `/api/${enc(database)}/${enc(collection)}/auth`;
  const res = await requestJson("POST", `${base}${path}`, {
    username,
    password,
  });
  if (!res.ok || !res.body?.accessToken) {
    throw new Error(`login failed at ${base}${path}: ${res.status} ${jsonShort(res.body)}`);
  }
  return res.body;
}

async function listSourceCollections() {
  const res = await sourceRequestJson("GET", `${config.sourceBase}/api/tenant/${enc(config.sourceTenant)}/collections`);
  if (!res.ok || !Array.isArray(res.body)) {
    throw new Error(`source collection list failed: ${res.status} ${jsonShort(res.body)}`);
  }
  return res.body;
}

async function countSourceCollections(collections) {
  const counts = {};
  for (let i = 0; i < collections.length; i++) {
    const collection = collections[i];
    const count = await countSourceCollection(collection);
    counts[collection] = count;
    if ((i + 1) % 25 === 0 || i + 1 === collections.length) {
      log(`counted ${i + 1}/${collections.length} collections`);
    }
  }
  return counts;
}

async function countSourceCollection(collection) {
  const res = await sourceRequestJson(
    "GET",
    `${config.sourceBase}/api/tenant/${enc(config.sourceTenant)}/${enc(collection)}/count`,
  );
  if (!res.ok || typeof res.body?.result !== "number") {
    throw new Error(`source count failed for ${collection}: ${res.status} ${jsonShort(res.body)}`);
  }
  return res.body.result;
}

async function fetchSourceBatch(collection, cursor) {
  const q = {
    $cursor: cursor || null,
    $pageSize: config.batchSize,
    $refDepth: 0,
  };
  const res = await sourceRequestJson(
    "GET",
    `${config.sourceBase}/api/tenant/${enc(config.sourceTenant)}/${enc(collection)}?q=${encodeURIComponent(JSON.stringify(q))}`,
  );
  if (!res.ok || !Array.isArray(res.body)) {
    throw new Error(`source batch failed for ${collection}: ${res.status} ${jsonShort(res.body)}`);
  }
  return {
    rows: res.body,
    nextCursor: res.headers.get("x-objectdb-next-cursor") || null,
  };
}

async function ensureTargetDatabase() {
  const res = await targetRequestJson("POST", `${config.targetBase}/api/databases`, {
    name: config.targetDatabase,
    meta: {},
  });
  if (!res.ok) throw new Error(`target database create failed: ${res.status} ${jsonShort(res.body)}`);
  log(`target database ${config.targetDatabase}: ${res.body?.created ? "created" : "exists"}`);
}

async function ensureTargetCollection(collection) {
  const res = await targetRequestJson("POST", `${config.targetBase}/api/${enc(config.targetDatabase)}/collections`, {
    name: collection,
    meta: {},
  });
  if (!res.ok) throw new Error(`target collection create failed for ${collection}: ${res.status} ${jsonShort(res.body)}`);
}

async function writeTargetBatch(collection, objects) {
  const url = `${config.targetBase}/api/${enc(config.targetDatabase)}/${enc(collection)}/object`;
  const headers = config.minimalReturn ? { prefer: "return=minimal" } : {};
  let res = await targetRequestJson("POST", url, objects, headers);
  if (!res.ok && res.status === 409) {
    log(`${collection}: insert collided with existing ids; replacing this batch`);
    res = await targetRequestJson("PUT", url, objects, headers);
  }
  if (!res.ok) throw new Error(`target write failed for ${collection}: ${res.status} ${jsonShort(res.body)}`);
  const written = res.body?.inserted ?? res.body?.replaced ?? objects.length;
  if (written !== objects.length) {
    throw new Error(`target write count mismatch for ${collection}: wrote ${written}, expected ${objects.length}`);
  }
}

async function countTargetCollection(collection) {
  const res = await targetRequestJson(
    "POST",
    `${config.targetBase}/api/${enc(config.targetDatabase)}/${enc(collection)}/search`,
    { $aggregate: { fields: { n: { $count: true } } } },
  );
  if (!res.ok || !Array.isArray(res.body)) {
    throw new Error(`target count failed for ${collection}: ${res.status} ${jsonShort(res.body)}`);
  }
  return Number(res.body[0]?.n || res.body[0]?.count || 0);
}

async function sourceRequestJson(method, url, body = null, headers = {}) {
  let res = await requestJson(method, url, body, authState.sourceToken, headers);
  if (res.status !== 401) return res;

  log("source token expired; logging in again");
  authState.sourceToken = (await login({
    base: config.sourceBase,
    database: config.sourceAuthTenant,
    collection: config.sourceAuthCollection,
    username: config.sourceUsername,
    password: config.sourcePassword,
    oldApi: true,
  })).accessToken;
  return requestJson(method, url, body, authState.sourceToken, headers);
}

async function targetRequestJson(method, url, body = null, headers = {}) {
  let res = await requestJson(method, url, body, authState.targetToken, headers);
  if (res.status !== 401) return res;

  log("target token expired; logging in again");
  authState.targetToken = (await login({
    base: config.targetBase,
    database: config.targetAuthDatabase,
    collection: config.targetAuthCollection,
    username: config.targetUsername,
    password: config.targetPassword,
    oldApi: false,
  })).accessToken;
  return requestJson(method, url, body, authState.targetToken, headers);
}

async function requestJson(method, url, body = null, token = null, headers = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= config.retries + 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          ...(body !== null ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body !== null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const parsed = await parseResponseBody(res);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${method} ${url} -> ${res.status} ${jsonShort(parsed)}`);
        if (attempt <= config.retries) {
          await sleep(retryDelay(attempt));
          continue;
        }
      }
      return { ok: res.ok, status: res.status, body: parsed, headers: res.headers };
    } catch (err) {
      lastErr = err;
      if (attempt <= config.retries) {
        await sleep(retryDelay(attempt));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function parseResponseBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function retryDelay(attempt) {
  return Math.min(10_000, 250 * 2 ** (attempt - 1));
}

function loadCheckpoint() {
  if (!existsSync(config.checkpointPath)) return freshCheckpoint();
  return JSON.parse(readFileSync(config.checkpointPath, "utf8"));
}

function freshCheckpoint() {
  return {
    version: 1,
    collections: {},
    warnings: [
      "Source public API redacts password and _vec fields; those fields cannot be migrated without a raw/cluster export source.",
      "Source object identity is written to _id; other source fields are preserved as regular data fields.",
      "Old reference descriptors with family/tenant get additional collection/database fields for spread-db live-reference compatibility.",
    ],
  };
}

function saveCheckpoint(checkpoint) {
  mkdirSync(dirname(config.checkpointPath), { recursive: true });
  writeFileSync(config.checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

function assertConfig() {
  for (const [name, value] of [
    ["SOURCE_PASSWORD", config.sourcePassword],
    ["TARGET_PASSWORD", config.targetPassword],
  ]) {
    if (!value) throw new Error(`${name} is required`);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      out[toCamel(key)] = inline !== undefined ? inline : argv[++i];
    }
  }
  return out;
}

function usage(code) {
  console.log(`
usage:
  SOURCE_PASSWORD=... TARGET_PASSWORD=... \\
    node scripts/migrate-object-db-tenant.js \\
      --source https://spoo.io \\
      --source-tenant meier \\
      --target http://178.105.99.197:8080 \\
      --target-database meier

options:
  --batch-size 1000
  --collections users,orders
  --checkpoint .spread-db/migrations/object-db-meier.json
  --dry-run true
  --reset-checkpoint true
  --compat-references false
`);
  process.exit(code);
}

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function booleanArg(value) {
  return value === true || value === "true" || value === "1" || value === "yes";
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function enc(value) {
  return encodeURIComponent(String(value));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function jsonShort(value) {
  return JSON.stringify(value).slice(0, 1000);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  console.log(`[migration] ${message}`);
}
