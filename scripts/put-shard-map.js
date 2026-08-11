import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { createShardMapStore } from "../src/shard-map-store.js";

const args = process.argv.slice(2);
const mapPath = valueAfter(args, "--map") || positional(args)[0];
if (!mapPath) {
  console.error("usage: node scripts/put-shard-map.js --config spread-db.minio.config.json --map shard-map.json");
  process.exit(1);
}

const config = loadConfig(configArgs(args), process.cwd(), { requireNode: false });
const store = createShardMapStore(config.cluster.shardMapStore, config.persistence);
if (!store) {
  console.error("cluster.shardMapStore must be configured with mode memory or s3");
  process.exit(1);
}

const shardMap = JSON.parse(readFileSync(resolve(process.cwd(), mapPath), "utf8"));
await store.save(shardMap.shardMap || shardMap);
console.log(`shard map saved to ${config.cluster.shardMapStore.prefix}/${config.cluster.shardMapStore.key}`);

function valueAfter(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return null;
}

function positional(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config" || arg === "-c" || arg === "--map") {
      i++;
      continue;
    }
    if (!arg.startsWith("-")) out.push(arg);
  }
  return out;
}

function configArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--map") {
      i++;
      continue;
    }
    if (arg.startsWith("--map=")) continue;
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
    if (!arg.startsWith("-")) continue;
    out.push(arg);
    if ((arg === "--config" || arg === "-c") && argv[i + 1]) out.push(argv[++i]);
  }
  return out;
}
