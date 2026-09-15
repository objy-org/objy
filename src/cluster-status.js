import { freemem, totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { DEFAULT_SHARD, peerKey } from "./shard-map.js";
import { CLUSTER_SECRET_HEADER } from "./interfaces/cluster.js";
import { summarizeCompression } from "./compression-stats.js";

export const CLUSTER_STATUS_PATH = "/cluster/status";

export function localClusterStatus(node, memoryGuard = null, replicationScheduler = null, restoreStatus = null) {
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
    memoryGuard: memoryGuard?.status?.() || null,
    ownedShards: shards.filter((shard) => shard.owned).map((shard) => shard.name),
    shards,
    peers,
    replication: {
      seq: node.seq,
      logLength: node.log.length,
      trimmed: node.trimmed,
      retainOps: node.retainOps,
      syncBatchSize: node.syncBatchSize,
      scheduler: replicationScheduler?.status?.() || null,
    },
    indexes: node.indexReadiness(),
    vectors: node.vectorStats(),
    compression: node.compressionStats?.() || emptyCompressionStats(),
    restore: restoreSnapshot(restoreStatus),
    process: {
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
    },
  };
}

export async function collectClusterStatus(node, { timeoutMs = 1500, memoryGuard = null, replicationScheduler = null, restoreStatus = null } = {}) {
  const local = { ...localClusterStatus(node, memoryGuard, replicationScheduler, restoreStatus), local: true, reachable: true };
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
    rss: rssSummary(nodes, shardMap),
    heap: heapSummary(nodes, shardMap),
    compression: compressionSummary(nodes, shardMap),
    nodes,
  };
}

function restoreSnapshot(restoreStatus) {
  if (!restoreStatus) return null;
  return typeof restoreStatus.snapshot === "function" ? restoreStatus.snapshot() : restoreStatus;
}

async function fetchPeerStatus(peer, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${peer.url}${CLUSTER_STATUS_PATH}`, {
      signal: controller.signal,
      headers: peer.secret ? { [CLUSTER_SECRET_HEADER]: peer.secret } : {},
    });
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
    memoryGuard: null,
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

function rssSummary(nodes, shardMap) {
  const perNode = nodes.map(nodeMemoryEntry);
  const physical = memoryTotals(perNode);
  const logical = logicalMemoryTotals(nodes, perNode, shardMap);
  return {
    cluster: logical,
    logical,
    physical,
    nodes: perNode,
  };
}

function heapSummary(nodes, shardMap) {
  const perNode = nodes.map(nodeHeapEntry);
  const physical = heapTotals(perNode);
  const logical = logicalMemoryTotals(nodes, perNode, shardMap, heapTotals);
  return {
    cluster: logical,
    logical,
    physical,
    nodes: perNode,
  };
}

function compressionSummary(nodes, shardMap) {
  const perNode = nodes.map(nodeCompressionEntry);
  const physical = compressionTotals(perNode);
  const logical = logicalMemoryTotals(nodes, perNode, shardMap, compressionTotals);
  return {
    cluster: logical,
    logical,
    physical,
    nodes: perNode,
  };
}

function nodeMemoryEntry(status) {
  const rss = status.memory?.rss ?? null;
  const totalMemory = status.memory?.systemTotal ?? null;
  const freeMemory = status.memory?.systemFree ?? null;
  return {
    key: nodeStatusKey(status),
    nodeId: status.node?.id || null,
    url: status.node?.url || status.sourcePeer?.url || null,
    local: status.local === true,
    reachable: status.reachable !== false,
    rss,
    rssMb: rss === null ? null : mib(rss),
    totalMemory,
    totalMemoryMb: totalMemory === null ? null : mib(totalMemory),
    freeMemory,
    freeMemoryMb: freeMemory === null ? null : mib(freeMemory),
    rssPercent: percent(rss, totalMemory),
    error: status.reachable === false ? status.error : undefined,
  };
}

function nodeHeapEntry(status) {
  const heapUsed = status.memory?.heapUsed ?? null;
  const heapTotal = status.memory?.heapTotal ?? null;
  const heapLimit = status.memory?.heapLimit ?? heapTotal;
  return {
    key: nodeStatusKey(status),
    nodeId: status.node?.id || null,
    url: status.node?.url || status.sourcePeer?.url || null,
    local: status.local === true,
    reachable: status.reachable !== false,
    used: heapUsed,
    usedMb: heapUsed === null ? null : mib(heapUsed),
    total: heapLimit,
    totalMb: heapLimit === null ? null : mib(heapLimit),
    committed: heapTotal,
    committedMb: heapTotal === null ? null : mib(heapTotal),
    heapUsed,
    heapUsedMb: heapUsed === null ? null : mib(heapUsed),
    heapTotal,
    heapTotalMb: heapTotal === null ? null : mib(heapTotal),
    heapLimit,
    heapLimitMb: heapLimit === null ? null : mib(heapLimit),
    percent: percent(heapUsed, heapLimit),
    error: status.reachable === false ? status.error : undefined,
  };
}

function nodeCompressionEntry(status) {
  const compression = status.compression || emptyCompressionStats();
  return {
    key: nodeStatusKey(status),
    nodeId: status.node?.id || null,
    url: status.node?.url || status.sourcePeer?.url || null,
    local: status.local === true,
    reachable: status.reachable !== false,
    collectionCount: Number(compression.collectionCount) || 0,
    liveObjects: Number(compression.liveObjects) || 0,
    compressedObjects: Number(compression.compressedObjects) || 0,
    coveragePercent: Number(compression.coveragePercent) || 0,
    uncompressedBytes: Number(compression.uncompressedBytes) || 0,
    compressedBytes: Number(compression.compressedBytes) || 0,
    savedBytes: Number(compression.savedBytes) || 0,
    savedPercent: Number(compression.savedPercent) || 0,
    collections: Array.isArray(compression.collections) ? compression.collections : [],
    error: status.reachable === false ? status.error : undefined,
  };
}

function memoryTotals(entries, extra = {}) {
  const total = sumField(entries, "rss");
  const totalMemory = sumField(entries, "totalMemory");
  const freeMemory = sumField(entries, "freeMemory");
  const online = entries.filter((entry) => entry.reachable).length;
  return {
    rss: total,
    rssMb: mib(total),
    totalMemory,
    totalMemoryMb: mib(totalMemory),
    freeMemory,
    freeMemoryMb: mib(freeMemory),
    rssPercent: percent(total, totalMemory),
    nodeCount: entries.length,
    onlineNodeCount: online,
    offlineNodeCount: entries.length - online,
    ...extra,
  };
}

function heapTotals(entries, extra = {}) {
  const used = sumField(entries, "used");
  const total = sumField(entries, "total");
  const committed = sumField(entries, "committed");
  const online = entries.filter((entry) => entry.reachable).length;
  return {
    used,
    usedMb: mib(used),
    total,
    totalMb: mib(total),
    committed,
    committedMb: mib(committed),
    heapUsed: used,
    heapUsedMb: mib(used),
    heapLimit: total,
    heapLimitMb: mib(total),
    heapTotal: committed,
    heapTotalMb: mib(committed),
    percent: percent(used, total),
    nodeCount: entries.length,
    onlineNodeCount: online,
    offlineNodeCount: entries.length - online,
    ...extra,
  };
}

function compressionTotals(entries, extra = {}) {
  const summary = summarizeCompression(entries);
  const online = entries.filter((entry) => entry.reachable).length;
  return {
    ...summary,
    nodeCount: entries.length,
    onlineNodeCount: online,
    offlineNodeCount: entries.length - online,
    ...extra,
  };
}

function logicalMemoryTotals(nodes, perNode, shardMap, totals = memoryTotals) {
  const byKey = new Map(perNode.map((entry) => [entry.key, entry]));
  const selected = new Map();
  const selectedReplicas = [];
  const missingShards = [];
  let sawConfiguredPeer = false;
  const shards = shardEntries(shardMap);

  for (const [shard, config] of shards) {
    const peers = config.peers || [];
    if (peers.length) sawConfiguredPeer = true;
    const status = peers
      .map((peer) => nodes.find((candidate) => peerMatchesStatus(peer, candidate)))
      .find((candidate) => candidate && candidate.reachable !== false);

    if (!status) {
      missingShards.push(shard);
      continue;
    }

    const key = nodeStatusKey(status);
    const entry = byKey.get(key);
    if (entry && !selected.has(key)) selected.set(key, entry);
    selectedReplicas.push({
      shard,
      nodeId: status.node?.id || null,
      url: status.node?.url || status.sourcePeer?.url || null,
    });
  }

  if (!sawConfiguredPeer) {
    return totals(perNode, {
      shardCount: shards.length,
      coveredShardCount: perNode.some((entry) => entry.reachable) ? shards.length : 0,
      missingShardCount: 0,
      missingShards: [],
      selectedReplicas: [],
      mode: "physical-fallback",
    });
  }

  return totals([...selected.values()], {
    shardCount: shards.length,
    coveredShardCount: selectedReplicas.length,
    missingShardCount: missingShards.length,
    missingShards,
    selectedReplicas,
    mode: "one-replica-per-shard",
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
  const rss = status?.memory?.rss ?? null;
  const totalMemory = status?.memory?.systemTotal ?? null;
  const freeMemory = status?.memory?.systemFree ?? null;
  return {
    ...describePeer(peer),
    self: node._isSelfPeer(peer),
    online: node._isSelfPeer(peer) || status?.reachable === true,
    nodeId: status?.node?.id || peer.nodeId || null,
    rss,
    rssMb: rss === null ? null : mib(rss),
    totalMemory,
    totalMemoryMb: totalMemory === null ? null : mib(totalMemory),
    freeMemory,
    freeMemoryMb: freeMemory === null ? null : mib(freeMemory),
    rssPercent: percent(rss, totalMemory),
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
  const heap = getHeapStatistics();
  const systemTotal = totalmem();
  const systemFree = freemem();
  return {
    rss: usage.rss,
    rssMb: mib(usage.rss),
    systemTotal,
    systemTotalMb: mib(systemTotal),
    systemFree,
    systemFreeMb: mib(systemFree),
    rssSystemPercent: percent(usage.rss, systemTotal),
    heapUsed: usage.heapUsed,
    heapUsedMb: mib(usage.heapUsed),
    heapTotal: usage.heapTotal,
    heapTotalMb: mib(usage.heapTotal),
    heapLimit: heap.heap_size_limit,
    heapLimitMb: mib(heap.heap_size_limit),
    external: usage.external,
    externalMb: mib(usage.external),
    arrayBuffers: usage.arrayBuffers,
    arrayBuffersMb: mib(usage.arrayBuffers),
  };
}

function sumField(entries, field) {
  return entries.reduce((sum, entry) => sum + (Number(entry[field]) || 0), 0);
}

function emptyCompressionStats() {
  return {
    ...summarizeCompression([]),
    collections: [],
  };
}

function percent(value, total) {
  const numerator = Number(value);
  const denominator = Number(total);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function mib(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function nodeLabel(status) {
  return nodeStatusKey(status);
}

function nodeStatusKey(status) {
  return status.node?.id || status.node?.url || status.sourcePeer?.url || status.sourcePeer?.key || "";
}

function peerLabel(peer) {
  return peer.nodeId || peer.url || peer.key || "";
}
