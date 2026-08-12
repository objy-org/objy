import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeAuthConfig } from "./auth.js";
import { normalizeVectorConfig } from "./vector.js";

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
    storage: normalizeStorageConfig(config.storage),
    vector: normalizeVectorConfig(config.vector),
    cluster: {
      syncMs: positiveInt(config.cluster?.syncMs, 1000),
      shardMap: config.cluster?.shardMap,
      shardMapStore: normalizeShardMapStoreConfig(config.cluster?.shardMapStore, config.persistence),
    },
    auth: normalizeAuthConfig(config.auth),
    persistence: normalizePersistenceConfig(config.persistence),
  };
}

function normalizeStorageConfig(config = {}) {
  const engine = config.engine || "shape";
  if (!["shape", "object"].includes(engine)) {
    throw new Error("storage.engine must be one of: shape, object");
  }
  return {
    engine,
    object: normalizeObjectStorageConfig(config.object),
  };
}

function normalizeObjectStorageConfig(config = {}) {
  return {
    valueDirectory: normalizeValueDirectoryConfig(config.valueDirectory),
  };
}

function normalizeValueDirectoryConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    minRefs: positiveInt(config.minRefs, 2),
    maxEntries: positiveInt(config.maxEntries, 100_000),
    maxCandidates: positiveInt(config.maxCandidates, 4_096),
    maxCandidatesPerPath: positiveInt(config.maxCandidatesPerPath, 256),
    maxPaths: positiveInt(config.maxPaths, 1_024),
    maxStringLength: positiveInt(config.maxStringLength, 256),
    maxKeyBytes: positiveInt(config.maxKeyBytes, 512),
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
  const ack = ackMode(config.ack);

  return {
    mode,
    prefix: config.prefix || "spread-db",
    flushMs: positiveInt(config.flushMs, 1000),
    opBatchSize: positiveInt(config.opBatchSize, 1000),
    snapshotMs: positiveInt(config.snapshotMs, 60_000),
    segmentBytes: positiveInt(config.segmentBytes, 16 * 1024 * 1024),
    compactJournals: config.compactJournals !== false,
    snapshotDirtyOnly: config.snapshotDirtyOnly !== false,
    snapshotRole: snapshotRole(config.snapshotRole),
    restoreMode: config.restoreMode || "scoped",
    restoreScopes: Array.isArray(config.restoreScopes) ? config.restoreScopes : undefined,
    ack,
    localWal: normalizeLocalWalConfig(config.localWal, ack),
    s3: normalizeS3Config(config.s3),
  };
}

function normalizeS3Config(config = {}) {
  const endpoint = config.endpoint;
  const endpointLocation = typeof endpoint === "string" ? hetznerLocationFromEndpoint(endpoint) : null;
  const configuredRegion = typeof config.region === "string" && config.region.trim()
    ? config.region.trim()
    : null;
  const region = normalizeS3Region(configuredRegion, endpointLocation);
  if (endpointLocation && region !== endpointLocation) {
    throw new Error(`persistence.s3.region must be ${endpointLocation} for endpoint ${endpoint}`);
  }
  return {
    bucket: config.bucket || "spread-db",
    endpoint,
    region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: config.forcePathStyle,
  };
}

function normalizeS3Region(region, endpointLocation) {
  if (!endpointLocation) return region || "us-east-1";
  if (!region || region === "us-east-1" || region === "US") return endpointLocation;
  return region;
}

function hetznerLocationFromEndpoint(endpoint) {
  const host = endpoint.replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
  const match = host.match(/^(fsn1|nbg1|hel1)\.your-objectstorage\.com$/);
  return match?.[1] || null;
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

function snapshotRole(value) {
  const role = value || "primary";
  if (role === "primary" || role === "all" || role === "none") return role;
  throw new Error("persistence.snapshotRole must be one of: primary, all, none");
}

function ackMode(value) {
  const mode = value || "memory";
  if (mode === "memory") return "memory";
  if (mode === "localWal" || mode === "local-wal" || mode === "wal") return "localWal";
  throw new Error("persistence.ack must be one of: memory, localWal");
}

function normalizeLocalWalConfig(config = {}, ack = "memory") {
  const rawMode = config.mode ?? (ack === "localWal" ? "on" : "off");
  const mode = rawMode === true ? "on" : rawMode === false ? "off" : rawMode;
  if (mode !== "off" && mode !== "on") throw new Error("persistence.localWal.mode must be one of: off, on");
  if (ack === "localWal" && mode === "off") {
    throw new Error("persistence.ack localWal requires persistence.localWal.mode on");
  }
  return {
    mode,
    dir: config.dir || ".spread-db/wal",
    fsync: config.fsync !== false,
    flushMs: positiveInt(config.flushMs, 0),
  };
}
