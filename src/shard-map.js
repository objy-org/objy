export const GLOBAL_DATABASE = "*";
export const GLOBAL_COLLECTION = "*";
export const DEFAULT_SHARD = "default";

export class ShardMap {
  constructor(map) {
    this.shards = new Map();
    if (map) this.replace(map);
  }

  replace(map) {
    this.shards.clear();
    if (!map.shards) throw new Error("shard map must define top-level shards");
    for (const [shard, shardConfig] of Object.entries(map.shards)) {
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
    return { shards };
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

function hashString(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
