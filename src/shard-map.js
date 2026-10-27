import { randomUUID } from "node:crypto";

export const GLOBAL_DATABASE = "*";
export const GLOBAL_COLLECTION = "*";
export const DEFAULT_SHARD = "default";
export const SHARD_MAP_VERSION = 2;
export const SHARD_PARTITIONER = "fnv1a32-mod-v1";
export const TOPOLOGY_ACTIVE = "active";
export const TOPOLOGY_RESHARDING = "resharding";

export class ShardMap {
  constructor(map) {
    this.shards = new Map();
    this.version = SHARD_MAP_VERSION;
    this.topology = null;
    if (map) this.replace(map);
  }

  replace(map) {
    const normalized = normalizeShardMap(map);
    this.shards.clear();
    this.version = normalized.version;
    this.topology = normalized.topology;
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
    const shards = this.shardsForCollection(database, collection);
    if (!shards.length) return DEFAULT_SHARD;
    return shards[hashString(String(objectId)) % shards.length];
  }

  shardsForCollection(database, collection) {
    return [...this.shards.keys()].sort();
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
      topology: cloneTopology(this.topology),
      shards,
    };
  }

  _ensureShard(shard) {
    let shardEntry = this.shards.get(shard);
    if (!shardEntry) {
      shardEntry = { peers: new Map() };
      this.shards.set(shard, shardEntry);
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
  return {
    version: SHARD_MAP_VERSION,
    topology,
    shards,
  };
}

export function publishShardMap(currentMap, desiredMap) {
  if (!currentMap || !Object.keys(currentMap.shards || {}).length) return normalizeShardMap(desiredMap);
  const current = normalizeShardMap(currentMap);
  const desired = normalizeDesiredShardMap(desiredMap, current.topology.partitioner);
  const currentSignature = partitionSignature(current);
  const desiredSignature = partitionSignature(desired);

  if (current.topology.state === TOPOLOGY_RESHARDING) {
    if (currentSignature !== desiredSignature) {
      throw new Error("cannot start another topology change while resharding is unfinished");
    }
    return {
      ...current,
      shards: assignPeerLayout(Object.keys(current.shards), desired.shards),
    };
  }

  if (currentSignature === desiredSignature) {
    return {
      ...current,
      shards: assignPeerLayout(Object.keys(current.shards), desired.shards),
    };
  }

  const topologyId = transitionTopologyId(current.topology.id, desiredSignature);
  const targetShardNames = Object.keys(desired.shards)
    .sort()
    .map((_, index) => topologyShardName(topologyId, index));
  return {
    version: SHARD_MAP_VERSION,
    topology: {
      id: topologyId,
      state: TOPOLOGY_RESHARDING,
      partitioner: desired.topology.partitioner,
      source: {
        id: current.topology.id,
        shards: Object.keys(current.shards).sort(),
      },
    },
    shards: assignPeerLayout(targetShardNames, desired.shards),
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
  if (partitioner !== SHARD_PARTITIONER) throw new Error(`unsupported shard partitioner: ${partitioner}`);
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
  if (topology.partitioner !== SHARD_PARTITIONER) {
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
    peers: [...(config?.peers || [])],
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
