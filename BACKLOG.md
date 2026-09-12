# Later

- Internal cluster transport: use streamed NDJSON for every shard-forwarded bulk write, including operations that return hydrated objects. Keep request transport independent from response policy: minimal requests return counts, while hydrated requests may return full JSON objects. Queries, aggregations, and small cluster-control messages can remain JSON unless streaming provides a measurable benefit.

- Reference query planner: optimize predicates like `owner.object.name` by querying the referenced collection first, converting matching referenced IDs into base reference-value filters such as `owner.value: { "$in": [...] }`, and then using the normal field indexes on the owning collection. This should work generally for nested references where each hop can be resolved through indexed reference fields.

- Local warm-tier storage for large object parts:
  - Treat tiering as an internal storage optimization only. Public reads must return normal hydrated objects with no `_warm`, `_cold`, or storage hints.
  - Keep hot data in memory and move configured warm payloads to local disk, not S3. S3 remains the durable snapshot/journal/restore layer.
  - Derive warm payload locations from `database/collection/objectId`; do not store per-field storage pointers in user objects.
  - Make the warm layer bulk-first: `putMany`, `getMany`, and `deleteMany`. Lists should narrow/page from hot memory/indexes first, then hydrate only the returned batch. Snapshots should hydrate in bounded batches and write full logical objects into the existing snapshot format.
  - Collection meta uses `tiering` directly. It can be a single policy such as `{ "keep": [...] }` or `{ "offload": [...] }`, or an ordered array of policies such as `{ "when": { "status": "archived" }, "keep": [...] }`. Do not use a nested `rules` key. `keep` and `offload` are mutually exclusive per policy, and `_id` is always kept.
  - Tiering policies may use simple query predicates in `when`; evaluate them on insert, replace, patch, restore, and future background retiering after meta changes. Do not add read/query-time tiering evaluation.
  - Indexed warm fields remain queryable because indexes are built from the full incoming object before splitting. Fields used for indexes, column indexes, permissions, references, routing, and common sorting must remain available to the relevant hot/index structures. Non-indexed warm-field queries should be a visible slow path or a later explicit policy decision.
  - Meta changes that require retiering large datasets should be background work later; the meta update itself should not synchronously rewrite millions of objects.
