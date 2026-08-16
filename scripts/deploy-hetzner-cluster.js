#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ARG_KEYS = new Set(["config", "only", "release", "dryRun", "help"]);
const args = parseArgs(process.argv.slice(2));
if (args.help) usage(0);

const cwd = process.cwd();

main().catch((err) => {
  console.error(`cluster deploy failed: ${err.message}`);
  process.exit(1);
});

async function main() {
  if (!args.config) usage(1);
  const configPath = resolve(cwd, args.config);
  const cluster = readJson(configPath);
  const nodes = normalizeNodes(cluster.nodes);
  const selected = args.only ? nodes.filter((node) => node.id === args.only || node.name === args.only) : nodes;
  if (!selected.length) throw new Error(`no nodes selected${args.only ? ` by --only ${args.only}` : ""}`);

  const shardMap = cluster.shardMap || buildShardMap(nodes, cluster);
  const release = args.release || timestampRelease();
  const temp = mkdtempSync(join(tmpdir(), "spread-db-cluster-deploy-"));

  try {
    const shardMapPath = join(temp, "shard-map.json");
    writeFileSync(shardMapPath, `${JSON.stringify(shardMap, null, 2)}\n`);

    log(`release ${release}`);
    log(`shards ${Object.entries(shardMap.shards).map(([name, shard]) => `${name}:${shard.peers.map((peer) => peer.url).join(",")}`).join(" ")}`);

    for (const node of selected) {
      const nodeConfig = makeNodeConfig(cluster, node);
      const nodeConfigPath = join(temp, `${node.id}.json`);
      writeFileSync(nodeConfigPath, `${JSON.stringify(nodeConfig, null, 2)}\n`);

      const command = [
        "node",
        "scripts/deploy-hetzner.js",
        "--config", nodeConfigPath,
        "--map", shardMapPath,
        "--release", release,
      ];

      if (args.dryRun) {
        log(`[dry-run] ${node.id} ${nodeConfig.node.url} via ${nodeConfig.ssh.host}`);
        continue;
      }

      log(`deploying ${node.id} ${nodeConfig.node.url} via ${nodeConfig.ssh.host}`);
      run(command[0], command.slice(1));
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function makeNodeConfig(cluster, node) {
  const base = deployBaseConfig(cluster);
  const port = positiveInt(node.port || node.node?.port || cluster.node?.port || cluster.server?.port, 8080);
  const host = node.host || node.ip;
  const url = trimTrailingSlash(node.url || node.node?.url || (host ? `http://${host}:${port}` : ""));
  const shard = node.shard || node.shards?.[0] || cluster.cluster?.shardName || base.cluster?.shardName || "shard-0";
  const sshHost = node.ssh?.host || node.sshHost || node.host || node.ip;
  if (!url) throw new Error(`node ${node.id} needs url or host`);
  if (!sshHost) throw new Error(`node ${node.id} needs ssh.host or host`);
  const files = mergeOptionalConfig(cluster.files, node.files);

  return deepMerge(base, {
    ssh: deepMerge(cluster.ssh || {}, {
      ...node.ssh,
      host: sshHost,
    }),
    remote: deepMerge(cluster.remote || {}, node.remote || {}),
    health: deepMerge(cluster.health || {}, node.health || {}),
    node: deepMerge(cluster.node || {}, {
      ...node.node,
      id: node.id,
      url,
      port,
    }),
    cluster: deepMerge(cluster.cluster || {}, {
      shardName: shard,
    }),
    ...(files !== undefined ? { files } : {}),
  });
}

function deployBaseConfig(cluster) {
  const { nodes: _nodes, shardMap: _shardMap, ...base } = cluster;
  return base;
}

function buildShardMap(nodes, cluster = {}) {
  const shards = {};
  for (const node of nodes) {
    const shard = node.shard || node.shards?.[0];
    if (!shard) throw new Error(`node ${node.id} needs shard for generated shard map`);
    const port = positiveInt(node.port || node.node?.port || cluster.node?.port || cluster.server?.port, 8080);
    const host = node.host || node.ip;
    const url = trimTrailingSlash(node.url || node.node?.url || (host ? `http://${host}:${port}` : ""));
    if (!url) throw new Error(`node ${node.id} needs url or host`);
    const entry = shards[shard] || { peers: [] };
    entry.peers.push({ url });
    shards[shard] = entry;
  }
  return { shards };
}

function normalizeNodes(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) throw new Error("cluster config requires a non-empty nodes array");
  return nodes.map((node, index) => {
    const id = node.id || node.name || `hetzner-${index + 1}`;
    return { ...node, id };
  });
}

function deepMerge(...items) {
  const out = {};
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    for (const [key, value] of Object.entries(item)) {
      out[key] = isPlainObject(value) && isPlainObject(out[key])
        ? deepMerge(out[key], value)
        : value;
    }
  }
  return out;
}

function mergeOptionalConfig(base, override) {
  if (override !== undefined) {
    return isPlainObject(base) && isPlainObject(override) ? deepMerge(base, override) : override;
  }
  return base;
}

function parseArgs(argv) {
  const out = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      const normalized = toCamel(key);
      if (!ARG_KEYS.has(normalized)) throw new Error(`unknown option: --${key}`);
      out[normalized] = inline !== undefined ? inline : argv[++i];
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
  node scripts/deploy-hetzner-cluster.js --config deploy/hetzner.cluster.json

optional:
  --only hetzner-2
  --release 20260813T120000Z
  --dry-run

The cluster config contains shared deploy/runtime settings and lists each peer
with its own SSH host, public URL, and shard.
`);
  process.exit(code);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function run(command, argv) {
  const result = spawnSync(command, argv, {
    cwd,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
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
  console.log(`deploy-cluster: ${message}`);
}
