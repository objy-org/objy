import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";
import { createObjectStorage } from "./object-storage.js";
import { DEFAULT_DATA_PREFIX } from "./config.js";
import { finalizeShardMap, isTopologyResharding, normalizeShardMap, publishShardMap } from "./shard-map.js";
import { PrimaryStateStore, requirePrimary } from "./primary-state.js";

const DEFAULT_KEY = "cluster/shard-map.json";

export class ShardMapStore {
  constructor({ storage, prefix = DEFAULT_DATA_PREFIX, key = DEFAULT_KEY, durable = false, clockPath, node } = {}) {
    if (!storage) throw new Error("storage is required");
    this.storage = storage;
    this.prefix = normalizePrefix(prefix);
    this.key = key.replace(/^\/+/, "");
    this.durable = durable === true;
    this.node = node;
    this.epoch = 0;
    this.states = new PrimaryStateStore({ storage, clockPath, epoch: () => this.epoch });
    this.pending = Promise.resolve();
  }

  async load() {
    const raw = (await this.states.read(this._key())).body;
    if (!raw) return null;
    const payload = JSON.parse(raw);
    this.deployment = payload.deployment;
    const stored = payload.shardMap || payload;
    const shardMap = normalizeShardMap(stored);
    return shardMap;
  }

  async save(shardMap) {
    return this.update(() => shardMap);
  }

  publishState(shardMap) {
    return this._serialize(() => this._write(normalizeShardMap(shardMap)));
  }

  update(change) {
    return this._serialize(async () => {
      const current = await this.load();
      return this._write(publishShardMap(current, await change(current && structuredClone(current))));
    });
  }

  async finalize(expectedTopologyId) {
    return this._serialize(async () => {
      const current = await this.load();
      if (!current) throw new Error("cannot finalize a missing shard map");
      return this._write(finalizeShardMap(current, expectedTopologyId));
    });
  }

  _serialize(action) {
    const pending = this.pending.catch(() => {}).then(() => {
      if (this.node) requirePrimary(this.node);
      return action();
    });
    this.pending = pending;
    return pending;
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
      ...(this.deployment ? { deployment: this.deployment } : {}),
      updatedAt: new Date().toISOString(),
      shardMap,
    };
    this.epoch = shardMap.ownershipEpoch || 0;
    await this.states.publish(this._key(), payload);
    await this.states.prune(this._key());
    return payload;
  }

  _key() {
    return `${this.prefix}/${this.key}`.replace(/^\/+/, "");
  }
}

export function createShardMapStore(config = {}, persistenceConfig = {}, node) {
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
    node,
    ...(mode === "s3" && persistenceConfig.localWal?.dir ? {
      clockPath: resolve(persistenceConfig.localWal.dir, encodeURIComponent(node?.id || "topology"), "publication-clock.json"),
    } : {}),
  });
}

function normalizePrefix(prefix) {
  return String(prefix || "").replace(/^\/+|\/+$/g, "");
}
