import { freemem, totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { DEFAULT_SHARD, peerKey } from "./shard-map.js";
import { CLUSTER_SECRET_HEADER } from "./interfaces/cluster.js";
import { summarizeCompression } from "./compression-stats.js";

export const CLUSTER_STATUS_PATH = "/cluster/status";
export const DEFAULT_CLUSTER_STATUS_CACHE_MS = 1_000;

const clusterStatusCache = new WeakMap();

export function localClusterStatus(node, memoryGuard = null, replicationScheduler = null, restoreStatus = null, { details = false } = {}) {
  const memory = memorySnapshot();
  const shardMap = node.shardMapSnapshot();
  const ownedShards = shardEntries(shardMap).filter(([shard]) => node.ownsShard(shard)).map(([shard]) => shard);
  const indexSummary = node.indexSummary();
  const vectorSummary = node.vectorSummary();
  const restore = restoreSnapshot(restoreStatus);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    node: {
      id: node.id,
      url: node.url || null,
    },
    memory,
    memoryGuard: memoryGuard?.status?.() || null,
    ownedShards,
    replication: details ? {
      ...compactReplicationStatus(replicationScheduler),
      seq: node.seq,
      logLength: node.log.length,
      trimmed: node.trimmed,
      retainOps: node.retainOps,
      syncBatchSize: node.syncBatchSize,
      scheduler: replicationScheduler?.status?.() || null,
    } : compactReplicationStatus(replicationScheduler),
    indexes: details ? { ...node.indexReadiness(), ...indexSummary } : indexSummary,
    vectors: details ? { ...vectorSummary, collections: node.vectorStats() } : vectorSummary,
    compression: details
      ? node.compressionStats?.() || emptyCompressionStats()
      : node.compressionSummary?.() || emptyCompressionSummary(),
    restoring: restore?.status === "restoring",
    ...(restore?.status === "restoring" ? { restore } : {}),
    process: {
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
    },
  };
}

export async function collectClusterStatus(node, options = {}) {
  const cacheMs = Math.max(0, Number(options.cacheMs ?? DEFAULT_CLUSTER_STATUS_CACHE_MS) || 0);
  if (!cacheMs) return buildClusterStatus(node, options);
  const key = options.details ? "details" : "compact";
  let cache = clusterStatusCache.get(node);
  if (!cache) {
    cache = new Map();
    clusterStatusCache.set(node, cache);
  }
  const cached = cache.get(key);
  if (cached?.value && cached.expiresAt > Date.now()) return cached.value;
  if (cached?.promise) return cached.promise;

  const entry = {};
  entry.promise = buildClusterStatus(node, options).then((value) => {
    entry.value = value;
    entry.expiresAt = Date.now() + cacheMs;
    entry.promise = null;
    return value;
  }, (err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, entry);
  return entry.promise;
}

async function buildClusterStatus(node, {
  timeoutMs = 1500,
  memoryGuard = null,
  replicationScheduler = null,
  restoreStatus = null,
  details = false,
} = {}) {
  const local = {
    ...localClusterStatus(node, memoryGuard, replicationScheduler, restoreStatus, { details }),
    local: true,
    reachable: true,
  };
  const remotes = await Promise.all(remoteStatusPeers(node).map((peer) => fetchPeerStatus(peer, timeoutMs, details)));
  const nodes = uniqueNodes([local, ...remotes]);
  const shardMap = node.shardMapSnapshot();
  const compression = compressionSummary(nodes, shardMap, { details });

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    node: local.node,
    shards: shardSummaries(node, shardMap, nodes),
    rss: rssSummary(nodes, shardMap, { details }),
    heap: heapSummary(nodes, shardMap, { details }),
    compression: details ? compression : compression.logical,
    indexes: aggregateIndexSummary(nodes),
    vectors: aggregateVectorSummary(nodes),
    nodes: nodes.map((status) => nodeStatusResponse(status, details)),
  };
}

function restoreSnapshot(restoreStatus) {
  if (!restoreStatus) return null;
  return typeof restoreStatus.snapshot === "function" ? restoreStatus.snapshot() : restoreStatus;
}

function compactReplicationStatus(replicationScheduler) {
  const status = replicationScheduler?.status?.() || {};
  const error = status.lastError || null;
  const pendingHints = Number(status.pendingHintScopes) || 0;
  const inflightPulls = (Number(status.queuedPulls) || 0) + (Number(status.inflightPulls) || 0);
  return {
    healthy:
      !error
      && (!Array.isArray(status.lastSyncFailures) || status.lastSyncFailures.length === 0)
      && pendingHints === 0
      && inflightPulls === 0
      && status.syncingAll !== true,
    lastSuccessfulSyncAt: status.lastSyncAt || null,
    pendingHints,
    inflightPulls,
    error,
  };
}

function aggregateIndexSummary(nodes) {
  const summary = { ready: 0, building: 0, error: 0, activeTasks: 0 };
  for (const status of nodes) {
    const indexes = status.indexes || {};
    summary.ready += Number(indexes.ready) || 0;
    summary.building += Number(indexes.building) || 0;
    summary.error += Number(indexes.error) || 0;
    summary.activeTasks += Number(indexes.activeTasks) || 0;
  }
  return summary;
}

function aggregateVectorSummary(nodes) {
  const summary = { storedVectors: 0, activeIndexes: 0, warmingIndexes: 0, errors: 0 };
  for (const status of nodes) {
    const vectors = status.vectors || {};
    summary.storedVectors += Number(vectors.storedVectors) || 0;
    summary.activeIndexes += Number(vectors.activeIndexes) || 0;
    summary.warmingIndexes += Number(vectors.warmingIndexes) || 0;
    summary.errors += Number(vectors.errors) || 0;
  }
  return summary;
}

function nodeStatusResponse(status, details) {
  if (details) {
    const { compression, ...response } = status;
    return response;
  }
  return {
    ok: status.ok !== false,
    generatedAt: status.generatedAt,
    local: status.local === true,
    reachable: status.reachable !== false,
    ...(status.status ? { status: status.status } : {}),
    ...(status.error ? { error: status.error } : {}),
    node: status.node,
    memory: status.memory || null,
    memoryGuard: status.memoryGuard || null,
    ownedShards: status.ownedShards || [],
    replication: status.replication || null,
    restoring: status.restoring === true,
    ...(status.restore ? { restore: status.restore } : {}),
    process: status.process || null,
  };
}

async function fetchPeerStatus(peer, timeoutMs, details = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${peer.url}${CLUSTER_STATUS_PATH}${details ? "?details=1" : ""}`, {
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
    restoring: false,
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

function rssSummary(nodes, shardMap, { details = false } = {}) {
  const perNode = nodes.map(nodeMemoryEntry);
  const physical = memoryTotals(perNode);
  const logical = logicalMemoryTotals(nodes, perNode, shardMap, memoryTotals, { details });
  return {
    cluster: logical,
    logical,
    physical,
  };
}

function heapSummary(nodes, shardMap, { details = false } = {}) {
  const perNode = nodes.map(nodeHeapEntry);
  const physical = heapTotals(perNode);
  const logical = logicalMemoryTotals(nodes, perNode, shardMap, heapTotals, { details });
  return {
    cluster: logical,
    logical,
    physical,
  };
}

function compressionSummary(nodes, shardMap, { details = false } = {}) {
  const perNode = nodes.map(nodeCompressionEntry);
  const physical = compressionTotals(perNode);
  const logical = logicalMemoryTotals(nodes, perNode, shardMap, compressionTotals, { details });
  return {
    cluster: logical,
    logical,
    physical,
    ...(details ? { nodes: perNode } : {}),
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

function logicalMemoryTotals(nodes, perNode, shardMap, totals = memoryTotals, { details = false } = {}) {
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
      ...(details ? { missingShards: [], selectedReplicas: [] } : {}),
      mode: "physical-fallback",
    });
  }

  return totals([...selected.values()], {
    shardCount: shards.length,
    coveredShardCount: selectedReplicas.length,
    missingShardCount: missingShards.length,
    ...(details ? { missingShards, selectedReplicas } : {}),
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
    ...emptyCompressionSummary(),
    collections: [],
  };
}

function emptyCompressionSummary() {
  return summarizeCompression([]);
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
