# Server-only OBJY access

```
Data Explorer
          |
      ObjyStore (validation, serialized operations, catalog, loaded pages)
          |
    server adapter
          |
    @objy/client → OBJY DB server
```

All operations use `@objy/client` (pinned at 0.1.0), without an embedded engine or fallback. The build rejects server/engine code in browser bundles; integration tests use isolated loopback servers from this repository.

`new ObjyStore(adapter)` requires an explicit adapter; SDK handles stay private. `adapters.js` defines async `ADAPTER_METHODS`: `open`, `close`, database/collection listing/creation/deletion, `search`, `count`, `get`, `insertMany`, `insertFile`, `replaceFile`, `downloadFile`, `patch`, `replace`, `removeMany`, `getMeta`, `setMeta`, `getClusterStatus`. Native results/errors pass through; missing objects become `undefined`. File responses become Blobs inside the session/error wrapper.

## Connections

`Connections` restores saved servers and the selected login; first visits start disconnected. New URLs default to the page's HTTP(S) origin/port and remain editable; saved logins retain their URL. Auth defaults to `_global/users`. The client handles HTTP/tokens/renewal. Servers must be browser-reachable with suitable CORS and HTTPS compatibility; there is no proxy.

Each connection isolates its store, drafts, and selection. Failed login/switch preserves the active connection. Forgetting it disconnects without choosing another; the explorer hides and requests stop. Forget removes local credentials/view state, never server data. Closing the page preserves saved logins.

## Cluster Telemetry

Node pills use `getClusterStatus` → client `status({ details: true })` → `GET /api/config?details=1`. Their modal shows RSS, indexes, tasks, compression, uptime, shards, replication, and write admission, not heap.

| Metric | Interpretation |
| --- | --- |
| Memory | Fresh `memory.rss`, falling back to the guard reading; denominator is `memoryGuard.limitBytes`, then `memory.systemTotal`. Hover shows bytes/budget. Fill caps at 100%; displayed percentage does not. |
| Index readiness | `indexes.ready/building/error` counts indexed collections, not definitions. |
| Workers | `indexes.workers` describes cooperative field/column/vector tasks, not OS threads. |
| Compression | Join `compression.nodes` by node identity; savings cover payloads, not process RAM. |
| Missing/offline | Remain distinct from zero; missing memory has no percentage. |

`ClusterMonitor` fetches on activation and manual refresh only: no polling, focus refresh, or automatic retry. Concurrent refreshes coalesce; timeout is 8 seconds. Switch/forget discards late responses; failures clear stale telemetry. The modal shows the last successful fetch. Reads share session locking/renewal/persistence; global-admin denial affects only pills. Telemetry is never persisted.

## Saved Connections and Tokens

`connection-storage.js` saves whitelisted, versioned records in IndexedDB (`objy-studio-connections`): connection ID/generation, canonical URL, username, auth scope, login requirement, and access/refresh tokens. Selection ID is separate. Passwords, profiles, objects, explorer selections, and drafts are excluded.

Tokens are bound to the exact URL/scope; editing either requires login. The client uses authorization headers, omits cookies, and rejects redirects. Use HTTPS remotely; HTTP supports loopback tests.

- Only the client's explicit safe-to-replay expiry response permits renewal and one retry. The UI does not parse JWT expiry or add renewal loops.
- Web Locks serialize requests, renewal, and persistence across tabs. Requests load current tokens first; renewed tokens save after completion.
- Network/permission errors keep login. Rejected authentication/renewal clears tokens but retains server details.
- Failed token persistence does not undo a confirmed write: report it, retain newer tokens in memory, and retry saving before the next request. A crash during rotation can require login.
- Forget uses the request lock so renewal cannot resurrect credentials. BroadcastChannel disconnects tabs; storage checks catch missed notifications. Re-login invalidates the prior generation. Neither action revokes server tokens or undoes received requests.

IndexedDB is origin-scoped, not an encrypted vault or HttpOnly storage: same-origin scripts can read tokens. Clearing site data/private browsing may remove logins; `localhost:4317` and `127.0.0.1:4317` differ. Without IndexedDB/Web Locks, the UI warns that connections are page-only. Secrets never enter URLs, localStorage, bundles, or logs.

## Queries, Paging, and Refresh

Catalog reads list contexts without downloading unloaded collections. Selection loads 50 objects in server order and a count; **Load more** appends the next 50. Requests cap at 250. Deduplicate offset drift, but advance by received rows, not unique displayed IDs. This is live offset paging, not a snapshot; unknown counts are `null`.

`loadCollection(..., { query })` commits query/results together after success. Ordinary filters preserve paging/sorting; explicit windows, aggregates, and vectors pass through without URL overrides. Empty queries restore browsing. Queries survive refresh/writes in page memory. `resultCount` describes matches/returned rows; `count` is the collection total. Aggregate/vector/reference-expanded results are read-only; ordinary filtered objects remain editable.

| Change | Refresh scope |
| --- | --- |
| Object write | Affected collection window. |
| Collection change | That database's collection list. |
| Database change | Database names and newly discovered databases. |
| Metadata write | No object-page reload. |
| Manual refresh | Loaded windows, reconciling deleted targets. |

Counts invalidate on queries, relevant writes, or manual refresh. Scoped failures remain visible until that scope or a full refresh succeeds. The standalone explorer receives projections/emits events without an SDK dependency; rows show IDs/JSON previews. The host edits through this store, keeping drafts per connection in page memory.

## Writes and Failures

Writes serialize per connection and capture the connection/selection at submission. Editor/dialog writes prevent switching. Optional `expected` snapshots preflight replacements, deletes, and meta writes against fresh reads; this is not atomic compare-and-swap.

Confirmed writes retain receipts and expose `refreshError` if refresh fails. `writeMayHaveSucceeded` disables resubmission pending inspection. Multi-call creation reports completed steps; there is no client rollback. Native query/reference/meta/`_id` semantics remain intact. Business `id` is ordinary data; patches use `$set`/`$unset`, replacements/deletes explicit IDs.

## Deletion and Attachments

The host confirms exact context names before SDK `drop()`. Acknowledged deletion immediately clears local catalog entries, selection, queries, and drafts, even if refresh fails.

Use client `insertFile`, `replaceFile`, and `download`; the server owns `_file` and blob storage. Replacements preflight the latest object, preserve its fields, and strip the old descriptor from multipart data. Save/undo dirty or uncertain drafts first. Derived results have no file controls.

| Preview | Behavior |
| --- | --- |
| Image | `<img>` with a temporary Blob URL. |
| PDF | Require MIME type and PDF header; lazy PDF.js renders pages with local worker/fonts/decoders. No scripting or remote viewer. |
| HTML/unsupported | Download, never embed. |

Downloads stay authenticated; tokens never enter URLs. Previews offer Download, abort requests on close, and release Blob URLs/workers/canvases on close or connection change. File storage must be configured on the server; the UI adds no backend. Tests use disposable memory blobs.

## Local Development

See [setup](../../../CONTRIBUTING.md#development), [module map](../../README.md), and [verification](../../tests/README.md). Edit `src/ui/` and `src/index.html`, not `dist/`. Builds reject embedded engines, copy the client license, fingerprint assets, and replace generated output only after success.
