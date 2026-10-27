import { setTimeout as sleep } from "node:timers/promises";
import { createObjectStorage } from "./object-storage.js";
import { DEFAULT_DATA_PREFIX } from "./config.js";
import { finalizeShardMap, isTopologyResharding, normalizeShardMap, publishShardMap } from "./shard-map.js";

const DEFAULT_KEY = "cluster/shard-map.json";

export class ShardMapStore {
  constructor({ storage, prefix = DEFAULT_DATA_PREFIX, key = DEFAULT_KEY, durable = false } = {}) {
    if (!storage) throw new Error("storage is required");
    this.storage = storage;
    this.prefix = normalizePrefix(prefix);
    this.key = key.replace(/^\/+/, "");
    this.durable = durable === true;
  }

  async load() {
    const raw = await this.storage.get(this._key());
    if (!raw) return null;
    const payload = JSON.parse(raw);
    const stored = payload.shardMap || payload;
    const shardMap = normalizeShardMap(stored);
    if (stored.version !== shardMap.version || !stored.topology) await this._write(shardMap);
    return shardMap;
  }

  async save(shardMap) {
    const current = await this.load();
    return this._write(publishShardMap(current, shardMap));
  }

  async finalize(expectedTopologyId) {
    const current = await this.load();
    if (!current) throw new Error("cannot finalize a missing shard map");
    return this._write(finalizeShardMap(current, expectedTopologyId));
  }

  async waitForActive(expectedTopologyId, { pollMs = 1000 } = {}) {
    for (;;) {
      const shardMap = await this.load();
      if (!shardMap) throw new Error("shard map disappeared while waiting for reshard finalization");
      if (shardMap.topology.id !== expectedTopologyId) {
        throw new Error(`topology changed while waiting for ${expectedTopologyId}`);
      }
      if (!isTopologyResharding(shardMap)) return shardMap;
      await sleep(Math.max(50, Number(pollMs) || 1000));
    }
  }

  async _write(shardMap) {
    const payload = {
      version: 2,
      updatedAt: new Date().toISOString(),
      shardMap,
    };
    await this.storage.put(this._key(), JSON.stringify(payload), "application/json");
    return payload;
  }

  _key() {
    return `${this.prefix}/${this.key}`.replace(/^\/+/, "");
  }
}

export function createShardMapStore(config = {}, persistenceConfig = {}) {
  const mode = config.mode || "off";
  if (mode === "off" || mode === false) return null;
  const storage = createObjectStorage({
    mode,
    s3: {
      ...(persistenceConfig.s3 || {}),
      ...(config.s3 || {}),
    },
  });
  return new ShardMapStore({
    storage,
    prefix: config.prefix || persistenceConfig.prefix || DEFAULT_DATA_PREFIX,
    key: config.key || DEFAULT_KEY,
    durable: mode === "s3",
  });
}

function normalizePrefix(prefix) {
  return String(prefix || "").replace(/^\/+|\/+$/g, "");
}
