#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_REMOTE_ROOT = "/opt/spread-db";
const DEFAULT_SERVICE = "spread-db";
const DEFAULT_PORT = 3333;
const DEFAULT_NODE_ID = "hetzner-1";
const DEFAULT_PREFIX = "spread-db";
const DEFAULT_SHARD_MAP_KEY = "cluster/shard-map.json";
const DEFAULT_NODE_MAJOR = 22;
const DEFAULT_SSH_CONTROL_PERSIST = "10m";
const DEFAULT_HEALTH_WAIT_SECONDS = 20 * 60;
const DEFAULT_HEALTH_REQUEST_TIMEOUT_MS = 5000;

const args = parseArgs(process.argv.slice(2));
if (args.help) usage(0);

const cwd = process.cwd();
let config;
let release;
let remoteRelease;
let remoteShared;
let remoteCurrent;
let remoteWalPath;
let remoteConfigPath;
let remoteShardMapPath;
let serviceUnitName;
let serviceUnitPath;
let sshControlDir;
let sshControlPath;
let sshControlOpen = false;

main().catch((err) => {
  console.error(`deploy failed: ${err.message}`);
  process.exit(1);
});

async function main() {
  const deployConfig = loadDeployConfig(args.config);
  config = normalizeDeployConfig(deployConfig, args);
  release = args.release || timestampRelease();
  remoteRelease = `${config.remote.root}/releases/${release}`;
  remoteShared = `${config.remote.root}/shared`;
  remoteCurrent = `${config.remote.root}/current`;
  remoteWalPath = `${config.remote.root}/data/wal`;
  remoteConfigPath = `${remoteShared}/spread-db.config.json`;
  remoteShardMapPath = `${remoteShared}/shard-map.json`;
  serviceUnitName = `${config.remote.service}.service`;
  serviceUnitPath = `/etc/systemd/system/${serviceUnitName}`;

  assertLocalRepo(cwd);
  requireBinary("ssh");
  requireBinary("rsync");

  const runtimeConfig = makeRuntimeConfig(config);
  const shardMap = loadShardMap(args.map, config);
  const temp = mkdtempSync(join(tmpdir(), "spread-db-deploy-"));
  sshControlDir = mkdtempSync("/tmp/spread-db-ssh-");
  sshControlPath = join(sshControlDir, "control");

  try {
    const localRuntimeConfig = join(temp, "spread-db.config.json");
    const localShardMap = join(temp, "shard-map.json");
    writeFileSync(localRuntimeConfig, `${JSON.stringify(runtimeConfig, null, 2)}\n`);
    writeFileSync(localShardMap, `${JSON.stringify(shardMap, null, 2)}\n`);

    log(`deploying release ${release} to ${config.ssh.host}`);
    openSshMultiplex();
    ensureRemoteRuntime();
    remote(`mkdir -p ${q(remoteRelease)} ${q(remoteShared)} ${q(remoteWalPath)}`);
    rsyncProject(remoteRelease);
    rsyncFile(localRuntimeConfig, remoteConfigPath);
    rsyncFile(localShardMap, remoteShardMapPath);

    remote(`cd ${q(remoteRelease)} && npm ci --omit=dev`);
    remote(`cd ${q(remoteRelease)} && node scripts/put-shard-map.js --config ${q(remoteConfigPath)} --map ${q(remoteShardMapPath)}`);
    remote(`ln -sfn ${q(remoteRelease)} ${q(remoteCurrent)}`);
    installSystemdUnit();
    remoteSudo("systemctl daemon-reload");
    remoteSudo(`systemctl enable ${q(serviceUnitName)}`);
    remoteSudo(`systemctl restart ${q(serviceUnitName)}`);
    await smokeCheck();

    log(`done: ${config.node.url}`);
  } finally {
    closeSshMultiplex();
    if (sshControlDir) rmSync(sshControlDir, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const out = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      const value = inline !== undefined ? inline : argv[++i];
      out[toCamel(key)] = value;
    } else {
      positional.push(arg);
    }
  }
  if (!out.config && positional[0]) out.config = positional[0];
  return out;
}

function usage(code) {
  console.log(`
usage:
  node scripts/deploy-hetzner.js --config deploy/hetzner.single.json

optional overrides:
  --host root@123.123.123.123
  --public-url http://123.123.123.123:3333
  --node hetzner-1
  --port 3333
  --map deploy/shard-map.json
  --release 20260812-120000
  --health-wait-seconds 1200

The script uploads the current repo to a timestamped release, writes
spread-db.config.json and shard-map.json, stores the shard map in S3, installs
a systemd service, restarts it, and smoke-checks /health and /api/config.
`);
  process.exit(code);
}

function loadDeployConfig(path) {
  if (!path) return {};
  return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
}

function normalizeDeployConfig(raw = {}, overrides = {}) {
  const ssh = {
    host: overrides.host || raw.ssh?.host || raw.host,
    port: positiveInt(overrides.sshPort || raw.ssh?.port, 22),
    opts: arrayOfStrings(raw.ssh?.opts),
    sudo: raw.ssh?.sudo !== false,
    multiplex: raw.ssh?.multiplex !== false,
    controlPersist: raw.ssh?.controlPersist || DEFAULT_SSH_CONTROL_PERSIST,
  };
  if (!ssh.host) throw new Error("ssh.host is required; pass --host or set it in deploy config");

  const port = positiveInt(overrides.port || raw.node?.port || raw.server?.port, DEFAULT_PORT);
  const publicUrl = trimTrailingSlash(overrides.publicUrl || raw.node?.url || raw.publicUrl);
  if (!publicUrl) throw new Error("node.url/publicUrl is required; pass --public-url or set node.url");

  const s3 = normalizeS3Config(raw.s3);

  return {
    ssh,
    remote: {
      root: raw.remote?.root || DEFAULT_REMOTE_ROOT,
      service: raw.remote?.service || DEFAULT_SERVICE,
      installNode: raw.remote?.installNode !== false,
      nodeMajor: positiveInt(raw.remote?.nodeMajor, DEFAULT_NODE_MAJOR),
    },
    node: {
      id: overrides.node || overrides.id || raw.node?.id || DEFAULT_NODE_ID,
      url: publicUrl,
      port,
      retainOps: positiveInt(raw.node?.retainOps, 256),
      syncBatchSize: positiveInt(raw.node?.syncBatchSize, 50_000),
    },
    storage: {
      engine: raw.storage?.engine || "object",
      object: raw.storage?.object || {
        valueDirectory: { enabled: true },
      },
    },
    files: normalizeFilesConfig(raw.files),
    auth: {
      jwtSecret: required(raw.auth?.jwtSecret, "auth.jwtSecret"),
      accessTokenTtlSeconds: positiveInt(raw.auth?.accessTokenTtlSeconds, 900),
      refreshTokenTtlSeconds: positiveInt(raw.auth?.refreshTokenTtlSeconds, 1_209_600),
      users: Array.isArray(raw.auth?.users) ? raw.auth.users : [],
    },
    cluster: {
      syncMs: positiveInt(raw.cluster?.syncMs, 2500),
      forwardTimeoutMs: positiveInt(raw.cluster?.forwardTimeoutMs, 60_000),
      replicationTimeoutMs: positiveInt(raw.cluster?.replicationTimeoutMs, 60_000),
      hints: {
        enabled: raw.cluster?.hints?.enabled !== false,
        debounceMs: positiveInt(raw.cluster?.hints?.debounceMs, 25),
        maxScopesPerHint: positiveInt(raw.cluster?.hints?.maxScopesPerHint, 128),
      },
      secret: raw.cluster?.secret || raw.auth?.jwtSecret,
      shardMapPrefix: raw.cluster?.shardMapPrefix || raw.persistence?.prefix || DEFAULT_PREFIX,
      shardMapKey: raw.cluster?.shardMapKey || DEFAULT_SHARD_MAP_KEY,
      shardName: raw.cluster?.shardName || "shard-0",
    },
    persistence: {
      prefix: raw.persistence?.prefix || DEFAULT_PREFIX,
      flushMs: positiveInt(raw.persistence?.flushMs, 1000),
      opBatchSize: positiveInt(raw.persistence?.opBatchSize, 10_000),
      snapshotMs: positiveInt(raw.persistence?.snapshotMs, 3_600_000),
      snapshotRole: raw.persistence?.snapshotRole || "primary",
      segmentBytes: positiveInt(raw.persistence?.segmentBytes, 16 * 1024 * 1024),
      compactJournals: raw.persistence?.compactJournals !== false,
      snapshotRetention: raw.persistence?.snapshotRetention || {},
      journalRetention: raw.persistence?.journalRetention || {},
      restoreMode: raw.persistence?.restoreMode || "reshard",
      restoreSnapshotId: raw.persistence?.restoreSnapshotId || null,
      localWalFsync: raw.persistence?.localWal?.fsync !== false,
      localWalFlushMs: positiveInt(raw.persistence?.localWal?.flushMs, 1000),
      s3,
    },
    health: {
      waitSeconds: positiveInt(
        overrides.healthWaitSeconds || raw.health?.waitSeconds || raw.deploy?.healthWaitSeconds,
        DEFAULT_HEALTH_WAIT_SECONDS,
      ),
      requestTimeoutMs: positiveInt(
        overrides.healthRequestTimeoutMs || raw.health?.requestTimeoutMs || raw.deploy?.healthRequestTimeoutMs,
        DEFAULT_HEALTH_REQUEST_TIMEOUT_MS,
      ),
    },
  };
}

function makeRuntimeConfig(config) {
  return {
    node: {
      id: config.node.id,
      url: config.node.url,
      retainOps: config.node.retainOps,
      syncBatchSize: config.node.syncBatchSize,
    },
    server: {
      port: config.node.port,
    },
    storage: config.storage,
    files: config.files,
    cluster: {
      syncMs: config.cluster.syncMs,
      forwardTimeoutMs: config.cluster.forwardTimeoutMs,
      replicationTimeoutMs: config.cluster.replicationTimeoutMs,
      hints: config.cluster.hints,
      secret: config.cluster.secret,
      shardMapStore: {
        mode: "s3",
        prefix: config.cluster.shardMapPrefix,
        key: config.cluster.shardMapKey,
      },
    },
    auth: config.auth,
    persistence: {
      mode: "s3",
      prefix: config.persistence.prefix,
      flushMs: config.persistence.flushMs,
      opBatchSize: config.persistence.opBatchSize,
      snapshotMs: config.persistence.snapshotMs,
      snapshotDirtyOnly: true,
      snapshotRole: config.persistence.snapshotRole,
      segmentBytes: config.persistence.segmentBytes,
      compactJournals: config.persistence.compactJournals,
      snapshotRetention: config.persistence.snapshotRetention,
      journalRetention: config.persistence.journalRetention,
      restoreMode: config.persistence.restoreMode,
      ...(config.persistence.restoreSnapshotId ? { restoreSnapshotId: config.persistence.restoreSnapshotId } : {}),
      ack: "localWal",
      localWal: {
        mode: "on",
        dir: remoteWalPath,
        fsync: config.persistence.localWalFsync,
        flushMs: config.persistence.localWalFlushMs,
      },
      s3: config.persistence.s3,
    },
  };
}

function normalizeFilesConfig(raw = {}) {
  if (raw === false) return { mode: "off" };
  const mode = raw.mode || "s3";
  if (!["off", "s3"].includes(mode)) throw new Error("files.mode must be one of: off, s3");
  return {
    mode,
    ...(raw.prefix ? { prefix: raw.prefix } : {}),
    ...(raw.maxUploadBytes ? { maxUploadBytes: positiveInt(raw.maxUploadBytes, 256 * 1024 * 1024) } : {}),
    ...(raw.s3 ? { s3: normalizeS3Config(raw.s3) } : {}),
  };
}

function loadShardMap(path, config) {
  if (path) {
    const parsed = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
    return parsed.shardMap || parsed;
  }
  return {
    shards: {
      [config.cluster.shardName]: {
        peers: [{ url: config.node.url }],
      },
    },
  };
}

function normalizeS3Config(raw = {}) {
  const endpoint = required(raw.endpoint, "s3.endpoint");
  const endpointLocation = hetznerLocationFromEndpoint(endpoint);
  const configuredRegion = typeof raw.region === "string" && raw.region.trim()
    ? raw.region.trim()
    : null;
  const region = normalizeS3Region(configuredRegion, endpointLocation);

  if (endpointLocation && region !== endpointLocation) {
    throw new Error(`s3.region must be ${endpointLocation} for endpoint ${endpoint}`);
  }

  return {
    bucket: required(raw.bucket, "s3.bucket"),
    endpoint,
    region,
    accessKeyId: required(raw.accessKeyId, "s3.accessKeyId"),
    secretAccessKey: required(raw.secretAccessKey, "s3.secretAccessKey"),
    forcePathStyle: raw.forcePathStyle === undefined ? true : raw.forcePathStyle === true,
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

function rsyncProject(remoteRelease) {
  log(`uploading source to ${remoteRelease}`);
  const target = `${sshTarget()}:${remoteRelease}/`;
  run("rsync", [
    "-az",
    "--delete",
    "--exclude", ".git/",
    "--exclude", "node_modules/",
    "--exclude", ".spread-db/",
    "--exclude", ".npm-cache/",
    "--exclude", "*.log",
    "--exclude", ".DS_Store",
    "--exclude", "deploy/*.json",
    ...rsyncSshArgs(),
    "./",
    target,
  ], { cwd });
}

function rsyncFile(localPath, remotePath) {
  run("rsync", ["-az", ...rsyncSshArgs(), localPath, `${sshTarget()}:${remotePath}`], { cwd });
}

function rsyncSshArgs() {
  const flags = sshFlags();
  return flags.length ? ["-e", ["ssh", ...flags].map(q).join(" ")] : [];
}

function remote(command) {
  return run("ssh", [...sshFlags(), sshTarget(), command], { cwd });
}

function remoteOk(command) {
  logCommand("ssh", [...sshFlags(), sshTarget(), command]);
  const result = spawnSync("ssh", [...sshFlags(), sshTarget(), command], {
    cwd,
    stdio: "inherit",
    shell: false,
  });
  return result.status === 0;
}

function remoteSudo(command) {
  const prefix = sudo();
  return remote(prefix ? `${prefix} ${command}` : command);
}

function ensureRemoteRuntime() {
  log("checking remote Node.js runtime");
  if (remoteOk(remoteNodeCheckCommand())) {
    log("remote Node.js runtime is ready");
    return;
  }
  if (!config.remote.installNode) {
    throw new Error("remote Node.js/npm is missing; install Node.js >=18.17 or enable remote.installNode");
  }

  log(`installing Node.js ${config.remote.nodeMajor}.x on remote`);
  const installScript = `
set -e
if ! command -v apt-get >/dev/null 2>&1; then
  echo "automatic Node.js install only supports apt-get based servers" >&2
  exit 1
fi
${rootCommand("apt-get update")}
${rootCommand("apt-get install -y ca-certificates curl gnupg")}
curl -fsSL https://deb.nodesource.com/setup_${config.remote.nodeMajor}.x | ${rootCommand("bash -")}
${rootCommand("apt-get install -y nodejs")}
node -v
npm -v
`;
  remote(`sh -lc ${q(installScript)}`);

  if (!remoteOk(remoteNodeCheckCommand())) {
    throw new Error("remote Node.js/npm install completed, but the runtime still does not satisfy Node.js >=18.17");
  }
}

function remoteNodeCheckCommand() {
  const check = `
const [major, minor] = process.versions.node.split(".").map(Number);
process.exit(major > 18 || (major === 18 && minor >= 17) ? 0 : 1);
`;
  return `command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && node -e ${q(check)}`;
}

function rootCommand(command) {
  const prefix = sudo();
  return prefix ? `${prefix} ${command}` : command;
}

function openSshMultiplex() {
  if (!config.ssh.multiplex) return;
  log("opening reusable SSH connection");
  run("ssh", [
    ...sshBaseFlags(),
    "-M",
    "-N",
    "-f",
    "-S", sshControlPath,
    "-o", "ControlMaster=yes",
    "-o", `ControlPersist=${config.ssh.controlPersist}`,
    sshTarget(),
  ], {
    cwd,
    logLabel: `ssh [open control connection ${sshTarget()}]`,
  });
  sshControlOpen = true;
}

function closeSshMultiplex() {
  if (!sshControlOpen || !sshControlPath) return;
  logCommand("ssh", [
    ...sshBaseFlags(),
    "-S", sshControlPath,
    "-O", "exit",
    sshTarget(),
  ], `ssh [close control connection ${sshTarget()}]`);
  spawnSync("ssh", [
    ...sshBaseFlags(),
    "-S", sshControlPath,
    "-O", "exit",
    sshTarget(),
  ], {
    cwd,
    stdio: "ignore",
    shell: false,
  });
  sshControlOpen = false;
}

function installSystemdUnit() {
  const unit = `[Unit]
Description=spread-db
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${remoteCurrent}
ExecStart=/usr/bin/env node ${remoteCurrent}/src/index.js --config ${remoteConfigPath} --node ${config.node.id} --url ${config.node.url} --port ${config.node.port}
Restart=always
RestartSec=3
LimitNOFILE=1048576
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;
  const encoded = Buffer.from(unit, "utf8").toString("base64");
  remoteSudo(`sh -c ${q(`printf %s ${q(encoded)} | base64 -d | tee ${q(serviceUnitPath)} >/dev/null`)}`);
}

async function smokeCheck() {
  log(`waiting up to ${config.health.waitSeconds}s for service health`);
  const base = config.node.url;
  let last = null;
  let attempt = 0;
  const deadline = Date.now() + config.health.waitSeconds * 1000;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const health = await fetchWithTimeout(`${base}/health`);
      last = health.status;
      if (health.ok) {
        const login = await fetchWithTimeout(`${base}/api/_global/users/auth`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "admin", password: "123" }),
        });
        const session = await login.json().catch(() => null);
        if (!login.ok) throw new Error(`admin login failed ${login.status}`);
        const status = await fetchWithTimeout(`${base}/api/config`, {
          headers: { authorization: `Bearer ${session.accessToken}` },
        });
        const statusPayload = await status.json().catch(() => null);
        if (!status.ok) throw new Error(`config failed ${status.status}`);
        console.log(JSON.stringify({
          health: health.status,
          config: status.status,
          nodeCount: statusPayload.nodes?.length,
          shardCount: statusPayload.shards?.length,
        }));
        return;
      }
    } catch (err) {
      last = cleanFetchError(err);
    }
    if (attempt === 1 || attempt % 10 === 0) {
      log(`waiting for ${base}/health: ${last}`);
    }
    await sleep(1000);
  }
  throw new Error(
    `service did not become healthy at ${base}: ${last}. ` +
    `On the server, check: systemctl status ${serviceUnitName} --no-pager -l; ` +
    `journalctl -u ${serviceUnitName} -n 100 --no-pager; and whether TCP ${config.node.port} is open.`,
  );
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.health.requestTimeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function cleanFetchError(err) {
  if (err.name === "AbortError") return "request timed out";
  return err.message;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertLocalRepo(path) {
  for (const file of ["package.json", "src/index.js", "scripts/put-shard-map.js"]) {
    try {
      readFileSync(resolve(path, file));
    } catch {
      throw new Error(`run this script from the spread-db repo root; missing ${file}`);
    }
  }
}

function requireBinary(name) {
  const result = spawnSync("sh", ["-lc", `command -v ${q(name)}`], { stdio: "ignore" });
  if (result.status !== 0) throw new Error(`${name} is required on the local machine`);
}

function run(command, argv, options = {}) {
  const { logLabel, ...spawnOptions } = options;
  logCommand(command, argv, logLabel);
  const result = spawnSync(command, argv, {
    stdio: "inherit",
    shell: false,
    ...spawnOptions,
  });
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

function sshTarget() {
  return config.ssh.host;
}

function sshFlags() {
  const flags = sshBaseFlags();
  if (config.ssh.multiplex && sshControlPath) {
    flags.push(
      "-S", sshControlPath,
      "-o", "ControlMaster=auto",
      "-o", `ControlPersist=${config.ssh.controlPersist}`,
    );
  }
  return flags;
}

function sshBaseFlags() {
  return [
    ...(config.ssh.port === 22 ? [] : ["-p", String(config.ssh.port)]),
    ...config.ssh.opts,
  ];
}

function sudo() {
  return config.ssh.sudo ? "sudo -n" : "";
}

function q(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function required(value, name) {
  const text = typeof value === "string" ? value.trim() : "";
  if (
    !text ||
    text.includes("<") ||
    text === "replace-me" ||
    text.startsWith("replace-with-")
  ) {
    throw new Error(`${name} is required in deploy config`);
  }
  return text;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
}

function trimTrailingSlash(value) {
  return typeof value === "string" && value.length > 0 ? value.replace(/\/+$/, "") : "";
}

function timestampRelease() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function log(message) {
  console.log(`deploy: ${message}`);
}

function logCommand(command, argv, label = null) {
  if (label) {
    console.log(`$ ${label}`);
    return;
  }
  const printable = [command, ...argv].map((part) => {
    const text = String(part);
    if (/secretAccessKey|jwtSecret|cluster\.secret|clusterSecret/i.test(text)) return "[redacted]";
    if (text.includes("\n")) return "[inline-script]";
    if (text.length > 180) return `${text.slice(0, 160)}...`;
    return text;
  });
  console.log(`$ ${printable.join(" ")}`);
}
