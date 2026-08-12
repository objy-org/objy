import { DEFAULT_SHARD, peerKey } from "./shard-map.js";

export const CLUSTER_STATUS_PATH = "/cluster/status";

export function localClusterStatus(node) {
  const memory = memorySnapshot();
  const shardMap = node.shardMapSnapshot();
  const peers = peerSummaries(node, shardMap);
  const shards = shardSummaries(node, shardMap);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    node: {
      id: node.id,
      url: node.url || null,
    },
    memory,
    ownedShards: shards.filter((shard) => shard.owned).map((shard) => shard.name),
    shards,
    peers,
    replication: {
      seq: node.seq,
      logLength: node.log.length,
      trimmed: node.trimmed,
      retainOps: node.retainOps,
      syncBatchSize: node.syncBatchSize,
    },
    indexes: node.indexReadiness(),
    vectors: node.vectorStats(),
    process: {
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
    },
  };
}

export async function collectClusterStatus(node, { timeoutMs = 1500 } = {}) {
  const local = { ...localClusterStatus(node), local: true, reachable: true };
  const remotes = await Promise.all(remoteStatusPeers(node).map((peer) => fetchPeerStatus(peer, timeoutMs)));
  const nodes = uniqueNodes([local, ...remotes]);
  const shardMap = node.shardMapSnapshot();

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    node: local.node,
    shardMap,
    shards: shardSummaries(node, shardMap, nodes),
    peers: peerSummaries(node, shardMap, nodes),
    nodes,
  };
}

async function fetchPeerStatus(peer, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${peer.url}${CLUSTER_STATUS_PATH}`, { signal: controller.signal });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) {
      return unreachablePeer(peer, `status ${response.status}`, response.status);
    }
    return {
      ...body,
      ok: body.ok !== false,
      local: false,
      reachable: true,
      sourcePeer: describePeer(peer),
      status: response.status,
    };
  } catch (err) {
    const message = err.name === "AbortError" ? `timeout after ${timeoutMs}ms` : err.message;
    return unreachablePeer(peer, message);
  } finally {
    clearTimeout(timer);
  }
}

function unreachablePeer(peer, error, status = 0) {
  return {
    ok: false,
    local: false,
    reachable: false,
    status,
    generatedAt: new Date().toISOString(),
    node: {
      id: peer.nodeId || null,
      url: peer.url || null,
    },
    memory: null,
    ownedShards: [],
    shards: [],
    peers: [],
    sourcePeer: describePeer(peer),
    error,
  };
}

function remoteStatusPeers(node) {
  return node.shardMap.allPeers().filter((peer) => peer.url && !node._isSelfPeer(peer));
}

function uniqueNodes(nodes) {
  const out = new Map();
  for (const status of nodes) {
    const key = status.node?.id || status.node?.url || status.sourcePeer?.url || status.sourcePeer?.key;
    if (!key || out.has(key)) continue;
    out.set(key, status);
  }
  return [...out.values()].sort((left, right) => {
    if (left.local) return -1;
    if (right.local) return 1;
    return nodeLabel(left).localeCompare(nodeLabel(right));
  });
}

function shardSummaries(node, shardMap = node.shardMapSnapshot(), nodes = []) {
  return shardEntries(shardMap).map(([name, config]) => {
    const peers = (config.peers || []).map((peer) => enrichedPeer(node, peer, nodes));
    return {
      name,
      owned: node.ownsShard(name),
      peerCount: peers.length,
      peers,
    };
  });
}

function peerSummaries(node, shardMap = node.shardMapSnapshot(), nodes = []) {
  const peers = new Map();
  for (const [shard, config] of shardEntries(shardMap)) {
    for (const peer of config.peers || []) {
      const key = peerKey(peer);
      const entry = peers.get(key) || {
        ...enrichedPeer(node, peer, nodes),
        shards: [],
      };
      if (!entry.shards.includes(shard)) entry.shards.push(shard);
      peers.set(key, entry);
    }
  }
  return [...peers.values()].sort((left, right) => {
    if (left.self) return -1;
    if (right.self) return 1;
    return peerLabel(left).localeCompare(peerLabel(right));
  });
}

function shardEntries(shardMap) {
  const entries = Object.entries(shardMap.shards || {});
  if (!entries.length) return [[DEFAULT_SHARD, { peers: [] }]];
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

function enrichedPeer(node, peer, nodes) {
  const status = nodes.find((candidate) => peerMatchesStatus(peer, candidate));
  return {
    ...describePeer(peer),
    self: node._isSelfPeer(peer),
    online: node._isSelfPeer(peer) || status?.reachable === true,
    nodeId: status?.node?.id || peer.nodeId || null,
    rss: status?.memory?.rss ?? null,
    rssMb: status?.memory?.rssMb ?? null,
    error: status?.reachable === false ? status.error : undefined,
  };
}

function peerMatchesStatus(peer, status) {
  if (!status) return false;
  return (
    (peer.url && (status.node?.url === peer.url || status.sourcePeer?.url === peer.url)) ||
    (peer.nodeId && status.node?.id === peer.nodeId) ||
    (peer.key && (status.node?.id === peer.key || status.sourcePeer?.key === peer.key))
  );
}

function describePeer(peer = {}) {
  return {
    key: peerKey(peer),
    url: peer.url || null,
    nodeId: peer.nodeId || null,
  };
}

function memorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    rssMb: mib(usage.rss),
    heapUsed: usage.heapUsed,
    heapUsedMb: mib(usage.heapUsed),
    heapTotal: usage.heapTotal,
    heapTotalMb: mib(usage.heapTotal),
    external: usage.external,
    externalMb: mib(usage.external),
    arrayBuffers: usage.arrayBuffers,
    arrayBuffersMb: mib(usage.arrayBuffers),
  };
}

function mib(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function nodeLabel(status) {
  return status.node?.id || status.node?.url || status.sourcePeer?.url || "";
}

function peerLabel(peer) {
  return peer.nodeId || peer.url || peer.key || "";
}
