# Cluster node overview — November 10, 2026

Verified locally at http://127.0.0.1:4317/ against the existing authenticated CLI server at http://127.0.0.1:8179/. No server settings or existing objects were changed.

- The official client's detailed config response supplies the overview. RSS uses the current `memory.rss`, with the memory guard's configured 8 GiB capacity. The dialog shows actual bytes prominently; there is no heap section.
- The existing server reported two indexed collections ready, zero active field/column/vector tasks, and zero compression savings (no compressed objects). Compression is matched to the selected node, not the cluster total.
- The dialog fits at 400 × 516 px within a 1280 × 720 viewport. RSS and index readiness have progress indicators; worker counts and compression stay compact. Screenshot: `outputs/objy-node-rss-overview.png` at the workspace root.
- Refresh updates the snapshot and timestamp while preserving keyboard focus. Escape returns focus to the node pill. Browser console reported no errors.
- `npm test`: 52 passing tests. Coverage includes real authenticated detailed config reads, per-node compression identity, zero/missing/offline metrics, active worker counts, index readiness, stale-response cancellation, concurrent refresh coalescing, permission failures, and explicit recovery.
- Mock-clock tests advance an hour after success and failure without issuing automatic requests.
- `npm run test:browser`: 11 passing flows against an isolated in-memory server, including independent verification of resulting test data. The node check waits 16 seconds and dispatches visibility/page lifecycle events: neither triggers a request or changes the snapshot. Explicit Refresh adds exactly one request. The first run exposed focus loss when disabling the refresh button; it now uses `aria-disabled` with a guarded handler, and the repeated suite passes.
- Production build and whitespace checks passed. Multiple/offline nodes and nonzero compression/worker readings are tested with deterministic endpoint-shaped inputs; the visible local server was a single idle node.

Telemetry is fetched once on activation and afterward only on explicit refresh. There is no polling, auto-retry, or tab-visibility refresh.
