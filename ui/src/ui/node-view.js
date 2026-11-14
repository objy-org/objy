import { escapeHTML as esc } from "./markup.js";

function memorySize(bytes) {
  if (bytes === null) return "Unavailable";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let index = 0;
  while (Math.abs(bytes) >= 1024 && index < units.length - 1) {
    bytes /= 1024;
    index++;
  }
  return `${bytes.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[index]}`;
}
function uptimeLabel(milliseconds) {
  if (milliseconds === null) return "—";
  const minutes = Math.floor(milliseconds / 60_000),
    hours = Math.floor(minutes / 60),
    days = Math.floor(hours / 24);
  if (days) return `${days}d ${hours % 24}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return minutes ? `${minutes}m` : "< 1m";
}
function nodeMetric(label, value, caption, percent, role = "meter") {
  const measured = percent !== null;
  const fill = measured ? Math.min(100, Math.max(0, percent)) : 0;
  return `<div class="node-usage">
   <div class="node-usage-heading"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>
   <div class="node-usage-track ${measured ? "" : "unavailable"}" ${measured ? `role="${role}" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${fill}" aria-valuetext="${esc(caption)}"` : 'aria-hidden="true"'}>
    <span style="width:${fill}%"></span>
   </div><p class="node-usage-caption">${esc(caption)}</p>
  </div>`;
}
export function nodePills(nodes) {
  return nodes
    .map((node) => {
      const measured = node.percent !== null;
      const value = !node.reachable
        ? "Offline"
        : measured
          ? `${node.percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
          : "—";
      const detail = !node.reachable
        ? "Node unreachable"
        : measured
          ? `Memory (RSS): ${memorySize(node.used)} / ${memorySize(node.limit)} (${node.limitKind}) · ${value}`
          : "Memory usage unavailable";
      const description = `${node.label} · ${detail}`;
      const fill = measured ? Math.min(100, Math.max(0, node.percent)) : 0;
      return `<button type="button" class="node-pill ${!node.reachable ? "offline" : measured && node.percent >= 85 ? "high-memory" : ""}"
   data-action="node-details" data-node-key="${esc(node.key)}" aria-haspopup="dialog" aria-label="${esc("View node " + node.label)}"
   title="${esc(description + (node.url ? "\n" + node.url : ""))}"><span class="node-memory-fill" style="width:${fill}%" aria-hidden="true"></span>
   <span class="node-name">${esc(node.label)}</span><span class="node-memory-value">${esc(value)}</span></button>`;
    })
    .join("");
}

export function nodeDetails(node) {
  const status = !node.reachable
    ? "Offline"
    : node.restoring
      ? "Restoring"
      : "Online";
  const stat = (label, value, warning = false, detail = "") =>
    `<div><dt>${label}</dt><dd${warning ? ' class="node-warning"' : ""}>${esc(value ?? "Unavailable")}${detail ? `<small>${esc(detail)}</small>` : ""}</dd></div>`;
  const indexes = node.indexes;
  const indexState = !indexes
    ? "Unavailable"
    : !indexes.total
      ? "Not configured"
      : indexes.error
        ? "Needs attention"
        : indexes.building
          ? "Building"
          : "Ready";
  const indexCaption = !indexes
    ? "Not reported by this server"
    : !indexes.total
      ? "No indexed collections"
      : `${indexes.ready.toLocaleString()} / ${indexes.total.toLocaleString()} indexed collections ready${indexes.building ? ` · ${indexes.building} building` : ""}${indexes.error ? ` · ${indexes.error} failed` : ""}`;
  const rssCaption =
    node.percent === null
      ? "Capacity not reported"
      : `${node.percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}% of ${memorySize(node.limit)} ${node.limitKind}`;
  const workerDetail = node.workers?.groups
    .map((group) => `${group.label} ${group.active ?? "—"}`)
    .join(" · ");
  const compression = node.compression;
  const compressionDetail =
    compression?.compressedObjects === 0
      ? "No compressed objects"
      : compression?.savedPercent != null
        ? `${compression.savedPercent.toLocaleString(undefined, { maximumFractionDigits: 1 })}% of object payload`
        : "";
  return `<div class="node-identity"><span class="node-health ${!node.reachable || node.restoring ? "node-warning" : ""}">${status}</span>${node.url ? `<span class="node-address" title="${esc(node.url)}">${esc(node.url)}</span>` : ""}</div>
  ${
    node.reachable
      ? `
   <div class="node-metrics">
    ${nodeMetric("Memory · RSS", memorySize(node.used), node.used === null ? "Not reported by this server" : rssCaption, node.percent)}
    ${nodeMetric("Index readiness", indexState, indexCaption, indexes?.percent ?? null, "progressbar")}
   </div>
   <dl class="node-stats">
    ${stat("Active workers", node.workers?.active?.toLocaleString(), false, workerDetail)}
    ${stat("Compression saved", memorySize(compression?.savedBytes ?? null), false, compressionDetail)}
    ${stat("Uptime", uptimeLabel(node.uptimeMs))}
    ${stat("Shards", node.shardCount?.toLocaleString())}
    ${stat("Replication", node.replication, node.replication === "Needs attention")}
    ${stat("Writes", node.acceptingWrites === null ? null : node.acceptingWrites ? "Accepting" : "Paused", node.acceptingWrites === false)}
   </dl>`
      : '<p class="node-unavailable">Statistics are unavailable while this node is unreachable.</p>'
  }
  `;
}
