import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeAuthConfig } from "./auth.js";

export const DEFAULT_CONFIG_PATH = "spread-db.config.json";

export function loadConfig(argv = process.argv.slice(2), cwd = process.cwd(), options = {}) {
  const configPath = resolve(cwd, configPathFromArgs(argv) || DEFAULT_CONFIG_PATH);
  const fileConfig = existsSync(configPath) ? readJsonFile(configPath) : {};
  return normalizeConfig(fileConfig, configPath, cliOverridesFromArgs(argv), options);
}

export function normalizeConfig(config = {}, configPath = null, overrides = {}, options = {}) {
  const requireNode = options.requireNode !== false;
  const nodeConfig = config.node || {};
  const serverConfig = config.server || {};
  const nodeId = overrides.nodeId || nodeConfig.id;
  const port = positiveInt(overrides.port ?? serverConfig.port ?? nodeConfig.port, 8080);

  if (requireNode && !nodeId) {
    throw new Error("node id is required; pass --node <id>");
  }

  return {
    configPath,
    node: {
      id: nodeId,
      url: overrides.url || nodeConfig.url || `http://localhost:${port}`,
      retainOps: positiveInt(nodeConfig.retainOps, 256),
      syncBatchSize: positiveInt(nodeConfig.syncBatchSize, 1024),
    },
    server: {
      port,
    },
    cluster: {
      syncMs: positiveInt(config.cluster?.syncMs, 1000),
      shardMap: config.cluster?.shardMap,
      shardMapStore: normalizeShardMapStoreConfig(config.cluster?.shardMapStore, config.persistence),
    },
    auth: normalizeAuthConfig(config.auth),
    persistence: normalizePersistenceConfig(config.persistence),
  };
}

function normalizeShardMapStoreConfig(config = {}, persistenceConfig = {}) {
  const mode = config.mode || "off";
  if (!["off", "memory", "s3"].includes(mode)) {
    throw new Error(`unsupported shard map store mode: ${mode}`);
  }
  return {
    mode,
    prefix: config.prefix || persistenceConfig?.prefix || "spread-db",
    key: config.key || "cluster/shard-map.json",
    s3: {
      ...(persistenceConfig?.s3 || {}),
      ...(config.s3 || {}),
    },
  };
}

function normalizePersistenceConfig(config = {}) {
  const mode = config.mode || "off";
  if (!["off", "memory", "s3"].includes(mode)) {
    throw new Error(`unsupported persistence mode: ${mode}`);
  }

  return {
    mode,
    prefix: config.prefix || "spread-db",
    flushMs: positiveInt(config.flushMs, 1000),
    opBatchSize: positiveInt(config.opBatchSize, 1000),
    snapshotMs: positiveInt(config.snapshotMs, 60_000),
    segmentBytes: positiveInt(config.segmentBytes, 16 * 1024 * 1024),
    compactJournals: config.compactJournals !== false,
    restoreMode: config.restoreMode || "scoped",
    restoreScopes: Array.isArray(config.restoreScopes) ? config.restoreScopes : undefined,
    s3: {
      bucket: config.s3?.bucket || "spread-db",
      endpoint: config.s3?.endpoint,
      region: config.s3?.region || "us-east-1",
      accessKeyId: config.s3?.accessKeyId,
      secretAccessKey: config.s3?.secretAccessKey,
      forcePathStyle: config.s3?.forcePathStyle,
    },
  };
}

function configPathFromArgs(argv) {
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config" || arg === "-c") return argv[i + 1];
    if (arg.startsWith("--config=")) return arg.slice("--config=".length);
    if (arg === "--node" || arg === "-n" || arg === "--id" || arg === "--url" || arg === "--port" || arg === "-p") {
      i++;
      continue;
    }
    if (
      arg.startsWith("--node=") ||
      arg.startsWith("--id=") ||
      arg.startsWith("--url=") ||
      arg.startsWith("--port=") ||
      arg.startsWith("-p=")
    ) continue;
    if (!arg.startsWith("-")) positional.push(arg);
  }
  return positional[0];
}

function cliOverridesFromArgs(argv) {
  return {
    nodeId: valueFromArgs(argv, ["--node", "-n", "--id"]),
    url: valueFromArgs(argv, ["--url"]),
    port: valueFromArgs(argv, ["--port", "-p"]),
  };
}

function valueFromArgs(argv, names) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (names.includes(arg)) return argv[i + 1];
    for (const name of names) {
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`failed to read config ${path}: ${err.message}`);
  }
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
