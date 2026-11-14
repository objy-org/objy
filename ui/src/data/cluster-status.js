const nonnegative = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const positive = (value) => nonnegative(value) && value > 0;
const count = (value) => nonnegative(value) && Number.isInteger(value);

function indexReadiness(indexes) {
  if (
    !indexes ||
    ![indexes.ready, indexes.building, indexes.error].every(count)
  )
    return null;
  const { ready, building, error } = indexes;
  const total = ready + building + error;
  return {
    ready,
    building,
    error,
    total,
    percent: total ? (ready / total) * 100 : null,
  };
}

function activeWorkers(workers) {
  if (!workers || typeof workers !== "object" || Array.isArray(workers))
    return null;
  const labels = {
    fieldIndex: "Field",
    columns: "Column",
    vectorIndex: "Vector",
  };
  const groups = Object.entries(workers).map(([key, worker]) => ({
    label: labels[key] || key,
    active: count(worker?.active) ? worker.active : null,
    type: worker?.type,
  }));
  if (!groups.length) return null;
  return {
    active: groups.every((group) => group.active !== null)
      ? groups.reduce((sum, group) => sum + group.active, 0)
      : null,
    groups,
  };
}

function compressionForNode(config, node) {
  // Detailed config puts compression in a separate per-node list, not nodes[].
  const entries = config.compression?.nodes;
  if (!Array.isArray(entries)) return null;
  const entry = entries.find((entry) =>
    node.id ? entry.nodeId === node.id : node.url && entry.url === node.url,
  );
  if (!entry || entry.reachable === false) return null;
  return {
    savedBytes: Number.isFinite(entry.savedBytes) ? entry.savedBytes : null,
    savedPercent: Number.isFinite(entry.savedPercent)
      ? entry.savedPercent
      : null,
    compressedObjects: count(entry.compressedObjects)
      ? entry.compressedObjects
      : null,
  };
}

// /api/config reports process RSS, plus a guard limit that accounts for containers.
// Never interpret missing telemetry as zero usage or use heap allocation as RAM capacity.
export function clusterNodes(config) {
  if (!Array.isArray(config?.nodes))
    throw new Error("The config endpoint did not return cluster nodes.");
  return config.nodes.map((entry, index) => {
    const node = entry?.node || {},
      memory = entry?.memory || {},
      guard = entry?.memoryGuard || {};
    const label =
      (typeof node.id === "string" && node.id) ||
      (typeof node.url === "string" && node.url) ||
      `Node ${index + 1}`;
    const reachable = entry?.reachable !== false && entry?.ok !== false;
    const used = nonnegative(memory.rss)
      ? memory.rss
      : nonnegative(guard.rss)
        ? guard.rss
        : null;
    const limit = positive(guard.limitBytes)
      ? guard.limitBytes
      : positive(memory.systemTotal)
        ? memory.systemTotal
        : null;
    const percent =
      reachable && used !== null && limit !== null
        ? (used / limit) * 100
        : null;
    return {
      key: JSON.stringify([node.id || label, node.url || ""]),
      label,
      url: typeof node.url === "string" ? node.url : "",
      reachable,
      used: reachable ? used : null,
      limit: reachable ? limit : null,
      percent: Number.isFinite(percent) ? percent : null,
      limitKind: positive(guard.limitBytes) ? "node limit" : "host memory",
      indexes: reachable ? indexReadiness(entry.indexes) : null,
      workers: reachable ? activeWorkers(entry.indexes?.workers) : null,
      compression: reachable ? compressionForNode(config, node) : null,
      uptimeMs:
        reachable && nonnegative(entry.process?.uptimeMs)
          ? entry.process.uptimeMs
          : null,
      shardCount:
        reachable && Array.isArray(entry.ownedShards)
          ? entry.ownedShards.length
          : null,
      replication:
        !reachable || typeof entry.replication?.healthy !== "boolean"
          ? null
          : entry.replication.healthy
            ? "In sync"
            : entry.replication.error
              ? "Needs attention"
              : "Syncing",
      acceptingWrites:
        reachable && typeof guard.acceptingWrites === "boolean"
          ? guard.acceptingWrites
          : null,
      restoring: reachable && entry.restoring === true,
    };
  });
}

// Transient telemetry only. Switching servers invalidates in-flight responses;
// fetch once on connection, then only on explicit refresh. No polling or retries.
export class ClusterMonitor {
  constructor({ onChange = () => {} } = {}) {
    this.onChange = onChange;
    this.source = null;
    this.version = 0;
    this.state = { status: "idle", nodes: [], error: "" };
  }
  publish(state) {
    this.state = state;
    this.onChange(state);
  }
  cancel() {
    this.version++;
    this.controller?.abort();
    this.pending = null;
  }
  setSource(source) {
    if (source === this.source) return;
    this.cancel();
    this.source = source;
    this.publish({ status: source ? "loading" : "idle", nodes: [], error: "" });
    return this.refresh();
  }
  refresh() {
    if (!this.source) return;
    if (this.pending) return this.pending;
    const source = this.source,
      version = this.version,
      controller = new AbortController();
    this.controller = controller;
    this.pending = (async () => {
      try {
        const config = await Promise.resolve().then(() =>
          source.getClusterStatus({
            details: true,
            signal: controller.signal,
            timeoutMs: 8_000,
          }),
        );
        if (version !== this.version) return;
        this.publish({
          status: "ready",
          nodes: clusterNodes(config),
          error: "",
          updatedAt: Date.now(),
        });
      } catch (error) {
        if (version !== this.version) return;
        const message =
          error.status === 403
            ? "Cluster status requires a global administrator account."
            : error.message;
        this.publish({ status: "error", nodes: [], error: message });
      } finally {
        if (version === this.version) {
          this.pending = null;
        }
      }
    })();
    this.publish({ ...this.state, refreshing: true });
    return this.pending;
  }
  close() {
    this.cancel();
    this.source = null;
    this.publish({ status: "idle", nodes: [], error: "" });
  }
}
