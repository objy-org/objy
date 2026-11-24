import { randomUUID } from "./runtime.js";

export const GLOBAL_DATABASE = "*";
export const GLOBAL_COLLECTION = "*";
export const DEFAULT_SHARD = "default";
export const SHARD_MAP_VERSION = 2;
export const SHARD_PARTITIONER = "fnv1a32-mod-v1";
export const JUMP_PARTITIONER = "fnv1a32-jump-v1";
export const TOPOLOGY_ACTIVE = "active";
export const TOPOLOGY_RESHARDING = "resharding";

export class ShardMap {
  constructor(map) {
    this.shards = new Map();
    this.version = SHARD_MAP_VERSION;
    this.topology = null;
    this.ownershipEpoch = 0;
    this.names = [];
    this.migration = null;
    this.originSequences = {};
    if (map) this.replace(map);
  }

  replace(map) {
    const normalized = normalizeShardMap(map);
    this.shards.clear();
    this.names = [];
    this.version = normalized.version;
    this.topology = normalized.topology;
    this.ownershipEpoch = normalized.ownershipEpoch || 0;
    this.migration = normalized.migration || null;
    this.originSequences = normalized.originSequences || {};
    for (const [shard, shardConfig] of Object.entries(normalized.shards)) {
      this._ensureShard(shard);
      for (const peer of shardConfig.peers || []) this.addPeer(shard, peer);
    }
  }

  addPeer(shard, peer) {
    const shardEntry = this._ensureShard(shard);
    const key = peerKey(peer);
    const existing = shardEntry.peers.get(key);
    if (existing) return existing;
    shardEntry.peers.set(key, peer);
    return peer;
  }

  removePeer(shard, peer) {
    const shardEntry = this._getShard(shard);
    if (!shardEntry) return false;
    return shardEntry.peers.delete(peerKey(peer));
  }

  peersFor(shard = DEFAULT_SHARD) {
    return uniquePeers([
      ...this._peersFor(DEFAULT_SHARD),
      ...this._peersFor(shard),
    ]);
  }

  shardForObject(database, collection, objectId) {
    const shards = this.names;
    if (!shards.length) return DEFAULT_SHARD;
    const hash = hashString(String(objectId));
    return shards[this.topology?.partitioner === JUMP_PARTITIONER ? jumpHash(hash, shards.length) : hash % shards.length];
  }

  shardsForCollection(database, collection) {
    return [...this.names];
  }

  syncTargets() {
    return [...this.shards.entries()].map(([shardName, shard]) => ({
      database: GLOBAL_DATABASE,
      collection: GLOBAL_COLLECTION,
      shard: shardName,
      peers: [...shard.peers.values()],
    }));
  }

  allPeers() {
    const peers = [];
    for (const shard of this.shards.values()) peers.push(...shard.peers.values());
    return uniquePeers(peers);
  }

  snapshot() {
    const shards = {};
    for (const [shardName, shard] of this.shards) {
      shards[shardName] = {
        peers: [...shard.peers.values()].map(describePeer),
      };
    }
    return {
      version: this.version,
      ...(this.ownershipEpoch ? { ownershipEpoch: this.ownershipEpoch } : {}),
      topology: cloneTopology(this.topology),
      shards,
      ...(Object.keys(this.originSequences).length ? { originSequences: { ...this.originSequences } } : {}),
      ...(this.migration ? { migration: structuredClone(this.migration) } : {}),
    };
  }

  _ensureShard(shard) {
    let shardEntry = this.shards.get(shard);
    if (!shardEntry) {
      shardEntry = { peers: new Map() };
      this.shards.set(shard, shardEntry);
      this.names = [...this.shards.keys()].sort();
    }
    return shardEntry;
  }

  _getShard(shard) {
    return this.shards.get(shard);
  }

  _peersFor(shard) {
    return [...(this._getShard(shard)?.peers.values() || [])];
  }
}

export function normalizeShardMap(map) {
  if (!map?.shards || typeof map.shards !== "object" || Array.isArray(map.shards)) {
    throw new Error("shard map must define top-level shards");
  }
  if (map.version !== undefined && ![1, SHARD_MAP_VERSION].includes(Number(map.version))) {
    throw new Error(`unsupported shard map version: ${map.version}`);
  }
  const shards = cloneShards(map.shards);
  const shardNames = Object.keys(shards).sort();
  const topology = normalizeTopology(map.topology, shardNames);
  validateTopology(topology, shardNames);
  const ownershipEpoch = Number(map.ownershipEpoch || 0);
  if (!Number.isSafeInteger(ownershipEpoch) || ownershipEpoch < 0) throw new Error("invalid shard ownership epoch");
  return {
    version: SHARD_MAP_VERSION,
    ...(ownershipEpoch ? { ownershipEpoch } : {}),
    topology,
    shards,
    ...(map.originSequences ? { originSequences: normalizeSequences(map.originSequences) } : {}),
    ...(map.migration ? { migration: normalizeMigration(map.migration) } : {}),
  };
}

function normalizeMigration(migration) {
  if (!["copying", "sealing", "committed"].includes(migration.phase) || !migration.id ||
      migration.source?.migration || migration.target?.migration) throw new Error("invalid live migration state");
  const source = normalizeShardMap(migration.source);
  const target = normalizeShardMap(migration.target);
  if (isTopologyResharding(source) || isTopologyResharding(target) || target.topology.id !== migration.id) throw new Error("invalid live migration topology");
  return { id: String(migration.id), phase: migration.phase, source, target,
    startedAt: migration.startedAt, ...(migration.frontiers ? { frontiers: { ...migration.frontiers } } : {}) };
}

function normalizeSequences(sequences) {
  if (!sequences || typeof sequences !== "object" || Array.isArray(sequences) ||
      Object.values(sequences).some((seq) => !Number.isSafeInteger(seq) || seq < 0)) throw new Error("invalid origin sequence watermarks");
  return { ...sequences };
}

export function planLiveShardMap(currentMap, desiredMap) {
  const current = normalizeShardMap(currentMap);
  if (current.migration || isTopologyResharding(current)) throw new Error("a topology change is already pending");
  const desired = normalizeDesiredShardMap({ ...desiredMap, topology: { ...desiredMap.topology, partitioner: JUMP_PARTITIONER } });
  return finalizeShardMap(transitionMap(current, desired, liveShardOrder(current, desired)));
}

export function liveShardOrder(current, desired) {
  const previous = Object.keys(current.shards).sort();
  const retained = previous.filter((name) => Object.hasOwn(desired.shards, name));
  if (!retained.length) return Object.keys(desired.shards).sort();
  if (retained.some((name, index) => name !== previous[index])) throw new Error("remove logical shards from the end, not from the middle");
  return [...retained, ...Object.keys(desired.shards).filter((name) => !Object.hasOwn(current.shards, name)).sort()];
}

export function publishShardMap(currentMap, desiredMap) {
  if (!currentMap || !Object.keys(currentMap.shards || {}).length) return normalizeShardMap(desiredMap);
  const current = normalizeShardMap(currentMap);
  if (current.migration) throw new Error("cannot replace the shard map during live resharding");
  const desired = normalizeDesiredShardMap(desiredMap, current.topology.partitioner);
  const currentSignature = partitionSignature(current);
  const desiredSignature = partitionSignature(desired);

  if (current.topology.state === TOPOLOGY_RESHARDING && currentSignature !== desiredSignature) {
    throw new Error("cannot start another topology change while resharding is unfinished");
  }

  if (currentSignature === desiredSignature) {
    const shards = assignPeerLayout(Object.keys(current.shards), desired.shards);
    const changed = Object.keys(shards).some((name) => peerKey(shards[name].peers[0] || {}) !== peerKey(current.shards[name].peers[0] || {}));
    return {
      ...current,
      ...(changed ? { ownershipEpoch: (current.ownershipEpoch || 0) + 1 } : {}),
      shards,
    };
  }

  return transitionMap(current, desired);
}

function transitionMap(current, desired, order = Object.keys(desired.shards).sort()) {
  const topologyId = transitionTopologyId(current.topology.id, partitionSignature(desired));
  const targetShardNames = order.map((_, index) => topologyShardName(topologyId, index));
  return {
    version: SHARD_MAP_VERSION,
    ownershipEpoch: (current.ownershipEpoch || 0) + 1,
    ...(current.originSequences ? { originSequences: { ...current.originSequences } } : {}),
    topology: {
      id: topologyId,
      state: TOPOLOGY_RESHARDING,
      partitioner: desired.topology.partitioner,
      source: {
        id: current.topology.id,
        shards: Object.keys(current.shards).sort(),
      },
    },
    shards: Object.fromEntries(targetShardNames.map((name, index) => [name, cloneShard(desired.shards[order[index]])])),
  };
}

export function finalizeShardMap(map, expectedTopologyId = null) {
  const normalized = normalizeShardMap(map);
  if (expectedTopologyId && normalized.topology.id !== expectedTopologyId) {
    throw new Error(`topology changed while finalizing ${expectedTopologyId}`);
  }
  if (normalized.topology.state !== TOPOLOGY_RESHARDING) return normalized;
  return {
    ...normalized,
    topology: {
      id: normalized.topology.id,
      state: TOPOLOGY_ACTIVE,
      partitioner: normalized.topology.partitioner,
    },
  };
}

export function partitionSignature(map) {
  const normalized = map?.topology && map?.shards ? map : normalizeShardMap(map);
  return `${normalized.topology.partitioner}:${Object.keys(normalized.shards).length}`;
}

export function isTopologyResharding(map) {
  return map?.topology?.state === TOPOLOGY_RESHARDING;
}

export function topologySourceShards(map) {
  return isTopologyResharding(map) ? [...map.topology.source.shards] : [];
}

export function peerKey(peer) {
  return peer.url || peer.nodeId || peer.key;
}

function uniquePeers(peers) {
  const out = new Map();
  for (const peer of peers) out.set(peerKey(peer), peer);
  return [...out.values()];
}

function describePeer(peer) {
  return {
    ...(peer.url ? { url: peer.url } : {}),
    ...(peer.nodeId ? { nodeId: peer.nodeId } : {}),
    ...(peer.key && !peer.url ? { key: peer.key } : {}),
  };
}

function normalizeDesiredShardMap(map, fallbackPartitioner) {
  if (!map?.shards || typeof map.shards !== "object" || Array.isArray(map.shards)) {
    throw new Error("shard map must define top-level shards");
  }
  const shards = cloneShards(map.shards);
  const partitioner = map.topology?.partitioner || fallbackPartitioner || SHARD_PARTITIONER;
  if (![SHARD_PARTITIONER, JUMP_PARTITIONER].includes(partitioner)) throw new Error(`unsupported shard partitioner: ${partitioner}`);
  return {
    version: SHARD_MAP_VERSION,
    topology: {
      id: map.topology?.id || "desired",
      state: TOPOLOGY_ACTIVE,
      partitioner,
    },
    shards,
  };
}

function normalizeTopology(topology, shardNames) {
  const partitioner = topology?.partitioner || SHARD_PARTITIONER;
  const id = topology?.id || initialTopologyId(shardNames, partitioner);
  const state = topology?.state || TOPOLOGY_ACTIVE;
  return {
    id: String(id),
    state,
    partitioner,
    ...(topology?.source
      ? {
          source: {
            id: String(topology.source.id || ""),
            shards: [...new Set((topology.source.shards || []).map(String))].sort(),
          },
        }
      : {}),
  };
}

function validateTopology(topology, shardNames) {
  if (!topology.id) throw new Error("shard map topology.id is required");
  if (![SHARD_PARTITIONER, JUMP_PARTITIONER].includes(topology.partitioner)) {
    throw new Error(`unsupported shard partitioner: ${topology.partitioner}`);
  }
  if (![TOPOLOGY_ACTIVE, TOPOLOGY_RESHARDING].includes(topology.state)) {
    throw new Error(`unsupported shard topology state: ${topology.state}`);
  }
  if (topology.state === TOPOLOGY_ACTIVE && topology.source) {
    throw new Error("active shard topology must not define a source");
  }
  if (topology.state !== TOPOLOGY_RESHARDING) return;
  if (!topology.source?.id || !topology.source.shards.length) {
    throw new Error("resharding topology must define its source id and shards");
  }
  const target = new Set(shardNames);
  for (const shard of topology.source.shards) {
    if (target.has(shard)) throw new Error(`source and target shard names overlap: ${shard}`);
  }
}

function initialTopologyId(shardNames, partitioner) {
  return `t-${shortHash(`initial|${partitioner}|${shardNames.join("|")}`)}`;
}

function transitionTopologyId(sourceId, signature) {
  const entropy = randomUUID().replaceAll("-", "").slice(0, 12);
  return `t-${shortHash(`${sourceId}|${signature}`).slice(0, 8)}-${entropy}`;
}

function topologyShardName(topologyId, index) {
  return `${topologyId}-s${String(index).padStart(4, "0")}`;
}

function assignPeerLayout(targetNames, desiredShards) {
  const desiredEntries = Object.entries(desiredShards).sort(([a], [b]) => a.localeCompare(b));
  const exact = targetNames.length === desiredEntries.length
    && targetNames.every((name) => Object.hasOwn(desiredShards, name));
  return Object.fromEntries([...targetNames].sort().map((name, index) => [
    name,
    cloneShard(exact ? desiredShards[name] : desiredEntries[index]?.[1]),
  ]));
}

function cloneShards(shards) {
  return Object.fromEntries(Object.entries(shards).map(([name, config]) => [String(name), cloneShard(config)]));
}

function cloneShard(config = {}) {
  return {
    peers: [...(config?.peers || [])].map((peer) => peer.url ? { ...peer, url: String(peer.url).replace(/\/+$/, "") } : peer),
  };
}

function cloneTopology(topology) {
  if (!topology) return null;
  return {
    id: topology.id,
    state: topology.state,
    partitioner: topology.partitioner,
    ...(topology.source
      ? { source: { id: topology.source.id, shards: [...topology.source.shards] } }
      : {}),
  };
}

function shortHash(value) {
  const forward = hashString(value).toString(16).padStart(8, "0");
  const reverse = hashString([...value].reverse().join("")).toString(16).padStart(8, "0");
  return `${forward}${reverse}`;
}

function hashString(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Lamping/Veach Jump Consistent Hash, with exact 64-bit multiplication in two
// 32-bit words. Avoid BigInt allocations on the per-object routing path.
export function jumpHash(key, buckets) {
  if (!Number.isSafeInteger(buckets) || buckets < 1) throw new RangeError("invalid jump hash bucket count");
  let lo = key >>> 0, hi = 0, previous = -1, next = 0;
  while (next < buckets) {
    previous = next;
    const low = lo & 65535, high = lo >>> 16;
    const middle = high * 0xb0fd + low * 0x87b0 + ((low * 0xb0fd) >>> 16);
    const upper = (high * 0x87b0 + Math.floor(middle / 65536)) >>> 0;
    hi = (Math.imul(hi, 0x87b0b0fd) + Math.imul(lo, 0x27bb2ee6) + upper) >>> 0;
    lo = (Math.imul(lo, 0x87b0b0fd) + 1) >>> 0;
    if (!lo) hi = (hi + 1) >>> 0;
    next = Math.floor((previous + 1) * 2147483648 / ((hi >>> 1) + 1));
  }
  return previous;
}
