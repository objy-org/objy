import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeAuthConfig } from "./auth.js";
import { normalizeVectorConfig } from "./vector.js";

export const DEFAULT_CONFIG_PATH = "objydb.config.json";
export const DEFAULT_DATA_PREFIX = "objydb";
export const DEFAULT_FILE_PREFIX = `${DEFAULT_DATA_PREFIX}/files`;
export const DEFAULT_LOCAL_WAL_DIR = ".objydb/wal";
export const DEFAULT_S3_BUCKET = "objydb";
export const DEFAULT_MAX_JSON_BYTES = 64 * 1024 * 1024;
export const DEFAULT_IMPORT_CONFIG = {
  maxBulkObjects: 10_000,
  maxBulkBytes: DEFAULT_MAX_JSON_BYTES,
  maxObjectBytes: 8 * 1024 * 1024,
  maxPendingPersistenceBytes: 256 * 1024 * 1024,
  retryAfterMs: 1000,
};

export function loadConfig(argv = process.argv.slice(2), cwd = process.cwd(), options = {}) {
  const configPath = resolve(cwd, configPathFromArgs(argv) || DEFAULT_CONFIG_PATH);
  const environment = options.environment || process.env;
  const document = existsSync(configPath) ? readJsonFile(configPath) : {};
  const fileConfig = resolveEnvironmentReferences(document, environment);
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
      maxJsonBytes: positiveInt(serverConfig.maxJsonBytes, DEFAULT_MAX_JSON_BYTES),
      cors: serverConfig.cors ?? false,
    },
    imports: normalizeImportConfig(config.imports),
    plugins: config.plugins ?? [],
    storage: normalizeStorageConfig(config.storage),
    files: normalizeFilesConfig(config.files, config.persistence),
    vector: normalizeVectorConfig(config.vector),
    memoryGuard: normalizeMemoryGuardConfig(config.memoryGuard),
    cluster: {
      syncMs: positiveInt(config.cluster?.syncMs, 2500),
      forwardTimeoutMs: positiveInt(config.cluster?.forwardTimeoutMs, 60_000),
      replicationTimeoutMs: positiveInt(config.cluster?.replicationTimeoutMs, 60_000),
      hints: normalizeReplicationHintsConfig(config.cluster?.hints),
      secret: clusterSecret(config.cluster),
      shardMap: config.cluster?.shardMap,
      shardMapStore: normalizeShardMapStoreConfig(config.cluster?.shardMapStore, config.persistence),
    },
    auth: normalizeAuthConfig(config.auth),
    persistence: normalizePersistenceConfig(config.persistence),
  };
}

function normalizeFilesConfig(config = {}, persistenceConfig = {}) {
  const mode = config.mode || "off";
  if (!["off", "memory", "s3"].includes(mode)) {
    throw new Error(`unsupported files mode: ${mode}`);
  }
  const s3Config = mode === "s3"
    ? {
        ...(persistenceConfig?.s3 || {}),
        ...(config.s3 || {}),
      }
    : (config.s3 || {});
  return {
    mode,
    prefix: config.prefix || DEFAULT_FILE_PREFIX,
    maxUploadBytes: positiveInt(config.maxUploadBytes, 256 * 1024 * 1024),
    s3: normalizeS3Config(s3Config, "files.s3"),
  };
}

function normalizeStorageConfig(config = {}) {
  const engine = config.engine || "object";
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
    poolStructuredValues: config.poolStructuredValues === true,
    maxNestedContainerEntries: positiveInt(config.maxNestedContainerEntries, 64),
  };
}

function normalizeMemoryGuardConfig(config = {}) {
  const enabled = config.enabled === true;
  const rejectWritesPercent = percent(config.rejectWritesPercent ?? config.maxRssPercent, 85);
  const resumeWritesPercent = percent(config.resumeWritesPercent, Math.min(78, rejectWritesPercent));
  if (resumeWritesPercent > rejectWritesPercent) {
    throw new Error("memoryGuard.resumeWritesPercent must be <= memoryGuard.rejectWritesPercent");
  }
  return {
    enabled,
    limitMb: positiveNumber(config.limitMb, null),
    rejectWritesPercent,
    resumeWritesPercent,
    checkMs: positiveInt(config.checkMs, 1000),
  };
}

function normalizeReplicationHintsConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    debounceMs: positiveInt(config.debounceMs, 25),
    maxScopesPerHint: positiveInt(config.maxScopesPerHint, 128),
  };
}

function normalizeShardMapStoreConfig(config = {}, persistenceConfig = {}) {
  const mode = config.mode || "off";
  if (!["off", "memory", "s3"].includes(mode)) {
    throw new Error(`unsupported shard map store mode: ${mode}`);
  }
  return {
    mode,
    prefix: config.prefix || persistenceConfig?.prefix || DEFAULT_DATA_PREFIX,
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
    prefix: config.prefix || DEFAULT_DATA_PREFIX,
    flushMs: positiveInt(config.flushMs, 5000),
    opBatchSize: positiveInt(config.opBatchSize, 1000),
    journalMaxBytes: positiveInt(config.journalMaxBytes, 4 * 1024 * 1024),
    snapshotMs: positiveInt(config.snapshotMs, 60_000),
    segmentBytes: positiveInt(config.segmentBytes, 16 * 1024 * 1024),
    compactJournals: config.compactJournals !== false,
    snapshotRetention: normalizeRetentionConfig(config.snapshotRetention),
    journalRetention: normalizeRetentionConfig(config.journalRetention),
    snapshotDirtyOnly: config.snapshotDirtyOnly !== false,
    snapshotRole: snapshotRole(config.snapshotRole),
    restoreSnapshotId: optionalString(config.restoreSnapshotId),
    restoreScopes: Array.isArray(config.restoreScopes) ? config.restoreScopes : undefined,
    ack,
    localWal: normalizeLocalWalConfig(config.localWal, ack),
    s3: normalizeS3Config(config.s3),
  };
}

function normalizeS3Config(config = {}, label = "persistence.s3") {
  const endpoint = config.endpoint;
  const endpointLocation = typeof endpoint === "string" ? hetznerLocationFromEndpoint(endpoint) : null;
  const configuredRegion = typeof config.region === "string" && config.region.trim()
    ? config.region.trim()
    : null;
  const region = normalizeS3Region(configuredRegion, endpointLocation);
  if (endpointLocation && region !== endpointLocation) {
    throw new Error(`${label}.region must be ${endpointLocation} for endpoint ${endpoint}`);
  }
  return {
    bucket: config.bucket || DEFAULT_S3_BUCKET,
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

function resolveEnvironmentReferences(value, environment) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvironmentReferences(item, environment));
  }
  if (!value || typeof value !== "object") return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "fromEnvironment") {
    const name = value.fromEnvironment;
    const resolved = environment[name];
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw new Error(`required environment variable is missing: ${name}`);
    }
    return resolved;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    resolveEnvironmentReferences(item, environment),
  ]));
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function percent(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
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
    dir: config.dir || DEFAULT_LOCAL_WAL_DIR,
    fsync: config.fsync !== false,
    flushMs: positiveInt(config.flushMs, 0),
    maxRecordBytes: positiveInt(config.maxRecordBytes, 4 * 1024 * 1024),
    maxOpsPerRecord: positiveInt(config.maxOpsPerRecord, 1000),
  };
}

function normalizeImportConfig(config = {}) {
  return {
    maxBulkObjects: positiveInt(config.maxBulkObjects, DEFAULT_IMPORT_CONFIG.maxBulkObjects),
    maxBulkBytes: positiveInt(config.maxBulkBytes, DEFAULT_IMPORT_CONFIG.maxBulkBytes),
    maxObjectBytes: positiveInt(config.maxObjectBytes, DEFAULT_IMPORT_CONFIG.maxObjectBytes),
    maxPendingPersistenceBytes: positiveInt(config.maxPendingPersistenceBytes, DEFAULT_IMPORT_CONFIG.maxPendingPersistenceBytes),
    retryAfterMs: positiveInt(config.retryAfterMs, DEFAULT_IMPORT_CONFIG.retryAfterMs),
  };
}

function normalizeRetentionConfig(config = {}) {
  return {
    keepLatest: positiveInt(config.keepLatest, 0),
    keepForMs: positiveInt(config.keepForMs, 0),
  };
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function clusterSecret(cluster = {}) {
  return optionalString(cluster?.secret) || optionalString(cluster?.clusterSecret);
}
