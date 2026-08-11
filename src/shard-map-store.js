import { createObjectStorage } from "./object-storage.js";

const DEFAULT_KEY = "cluster/shard-map.json";

export class ShardMapStore {
  constructor({ storage, prefix = "spread-db", key = DEFAULT_KEY } = {}) {
    if (!storage) throw new Error("storage is required");
    this.storage = storage;
    this.prefix = normalizePrefix(prefix);
    this.key = key.replace(/^\/+/, "");
  }

  async load() {
    const raw = await this.storage.get(this._key());
    if (!raw) return null;
    const payload = JSON.parse(raw);
    return payload.shardMap || payload;
  }

  async save(shardMap) {
    const payload = {
      version: 1,
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
    prefix: config.prefix || persistenceConfig.prefix || "spread-db",
    key: config.key || DEFAULT_KEY,
  });
}

function normalizePrefix(prefix) {
  return String(prefix || "").replace(/^\/+|\/+$/g, "");
}
