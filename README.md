# spread-db

An in-memory database for dynamic, stateless JavaScript objects.

- **Dynamic objects** – no schema. Any JSON object, any shape, stored as-is.
- **Shape store internals** – objects are never kept as raw blobs. Every object is
  classified by its *shape* (ordered field-name layout) and its values are stored
  in generic column arrays shared by all objects of the same field set. Value
  types stay fully dynamic and do not participate in shape identity.
- **Namespaced** – databases contain collections; object ids live in a flat
  `db / collection / id` namespace, so the same id can exist independently in
  different databases and collections.
- **Multi-leader replication** – every node accepts writes. A conflict-free
  (CRDT) merge, based on whole-object last-write-wins with Lamport timestamps,
  keeps all nodes convergent. Any node can be written to, and the cluster
  heals to a consistent state.
- **REST API** – plain HTTP/JSON, zero runtime dependencies.
- **Console UI** – a zero-dependency web console at `GET /` for poking at the
  API by hand: insert, get, list, patch, replace, delete, and inspect the
  internal shape store.

## Quick start

```sh
npm test          # run the test suite (node:test, no deps needed)
npm start         # start a node on PORT (default 8080)
```

Open http://localhost:8080/ for the console UI.

```sh
# node A
PORT=8080 PEERS=http://localhost:8081 npm start

# node B
PORT=8081 PEERS=http://localhost:8080 npm start
```

`PEERS` is shorthand for adding URLs to the global default shard. For explicit
shard placement, start with `SHARD_MAP`:

```sh
SHARD_MAP='{
  "databases": {
    "app": {
      "collections": {
        "users": {
          "shards": {
            "users-0": {
              "peers": [{ "url": "http://localhost:8081" }]
            }
          }
        }
      }
    }
  }
}' npm start
```

## REST API

Objects are stored as `db/coll/{id}`. The `id` is returned on insert; you can
also supply your own `id` in the body. `id` is reserved and not part of the
stored shape.

| Method | Path                               | Body      | Result                          |
| ------ | ---------------------------------- | --------- | ------------------------------- |
| POST   | `/db/:db/coll/:coll`               | object    | `201 { id }`                    |
| GET    | `/db/:db/coll/:coll`               | –         | `{ db, coll, count, objects }`  |
| GET    | `/db/:db/coll/:coll/:id`           | –         | `200 object` / `404`            |
| PUT    | `/db/:db/coll/:coll/:id`           | object    | full replace (upsert)           |
| PATCH  | `/db/:db/coll/:coll/:id`           | object    | partial merge (upsert)          |
| DELETE | `/db/:db/coll/:coll/:id`           | –         | `204` / `404`                   |
| GET    | `/db/:db/coll/:coll/shapes`        | –         | shape-store layout + stats      |
| GET    | `/health`                          | –         | node liveness + node id         |
| GET    | `/cluster/shards`                  | –         | current shard map               |
| PUT    | `/cluster/shards`                  | shard map | replace shard map               |
| POST   | `/cluster/peers`                   | peer spec | add peer to a shard             |

Examples:

```sh
curl -X POST localhost:8080/db/app/coll/users -d '{"name":"ada","age":36}'
# {"id":"<uuid>"}

curl localhost:8080/db/app/coll/users/<uuid>
# {"id":"<uuid>","name":"ada","age":36}

curl -X PATCH localhost:8080/db/app/coll/users/<uuid> -d '{"age":37}'
curl -X DELETE localhost:8080/db/app/coll/users/<uuid>
```

Dynamic peer add:

```sh
curl -X POST localhost:8080/cluster/peers \
  -d '{
    "database": "app",
    "collection": "users",
    "shard": "users-0",
    "url": "http://localhost:8081"
  }'
```

## Query, Index, Aggregate

Programmatic collections and `CRDTNode` support the old `object-db` query shape:

```js
node.createIndex("app", "users", "email");

const admins = node.find(
  "app",
  "users",
  {
    tags: { $contains: "admin" },
    "profile.city": "London",
  },
  { sortBy: "age", sort: "desc", limit: 50 },
);
```

Supported operators:

- `$eq`
- `$ne`
- `$gt`
- `$gte`
- `$lt`
- `$lte`
- `$in`
- `$contains`
- `$exists`
- `$regex`

Indexes are equality indexes over a field path. A direct equality query such as
`{ email: "ada@example.com" }` uses the index when one exists; richer operators
still use the same matcher and scan candidate objects.

Aggregation uses the same query matcher first, then computes metrics:

```js
node.aggregate("app", "orders", { status: "paid" }, {
  groupBy: "region",
  sum: "total",
  avg: "total",
  max: "total",
});
```

Metric fields can be a string or an array. Supported metrics are `sum`, `avg`,
`min`, and `max`; every aggregate result includes `count`.

## How it works

### Shape store (`src/shape.js`)

When an object is written, its live fields are reduced to a layout:
`[{name}]` sorted by name. The layout is hashed into a `shapeId`. Each shape
owns one generic value column per field. Columns store row value codes plus a
small dictionary of distinct values, so repeated values are shared within the
column, but the values themselves remain dynamically typed.

Objects are rows in their shape; object-id -> `(shapeId, row)` is the only
per-object pointer. Changing a field's value type stays in place; only adding or
removing fields moves the row into a different shape. Empty shapes are
garbage-collected. Removed rows release interned values, and reused rows
overwrite only column cells instead of recreating full objects. `GET /.../shapes`
exposes the internal columnar layout, dictionary sizes, capacity, and byte
estimates so you can see the deduplication in action.

### CRDT (`src/crdt.js`, `src/store.js`)

Writes are turned into append-only ops, each stamped with a Lamport timestamp
`{c, n}` (counter + origin node id):

- `touch`   – ensure an (empty) object exists
- `putObj`  – replace one whole object value
- `delObj`  – tombstone an object

Merge rules are commutative, associative, and idempotent:

- Per object: the op with the higher timestamp wins (LWW register).
- Object delete: applied only if its timestamp is newer than the object's
  current last write; a later `putObj` resurrects the object, an earlier one
  doesn't.
- Re-applying the same ops changes nothing.

Each node keeps an append-only op log of *its own* writes. Peers are polled;
the response returns only the ops the peer hasn't seen yet (`after` seq), so
gossip is incremental. Pulls are bounded by `syncBatchSize` (default `1024`) and
repeat until the peer catches up, which keeps large log transfers from becoming
one giant response. Because every node pulls from every peer, writes made
anywhere eventually reach everywhere. No leader, no lock, no ordering service.

### HTTP replication

Internal endpoints (not part of the public CRUD surface):

- `GET /replicate?after=<seq>&limit=<n>` -> `{ node, lastSeq, ops }` (or `410`
  if the log was truncated past `<seq>`)
- `GET /replicate/snapshot`      -> full CRDT state, for peers too far behind
- `POST /replicate/ack`          -> `{ node, after }` acknowledges how much of
  our log the peer has applied

### Shard Map

Peer membership is organized as `database -> collection -> shard -> peers`.
Object sharding is active at the collection level: every op is tagged with
`shard = hash(objectId) % collectionShardCount`, using the sorted shard names for
that `database/collection`. Database-level sharding is not implemented.

```json
{
  "databases": {
    "app": {
      "collections": {
        "users": {
          "shards": {
            "users-0": {
              "peers": [
                { "url": "http://localhost:8081" }
              ]
            }
          }
        }
      }
    }
  }
}
```

The special `* / * / default` shard is the global fallback used by `PEERS` and
by `node.addPeer(peer)`. `node.addPeerToShard(...)` and `/cluster/peers` add
peers dynamically to a specific database/collection/shard without restarting the
process.

Replication is shard-scoped. A peer assigned to `app/users/users-0` pulls only
ops for objects routed to `users-0`; if the peer is too far behind, snapshot
recovery is filtered to that same shard. This keeps shard replicas from receiving
objects owned by sibling shards.

Current limits:

- Writes are routed locally by the writer's shard map; write forwarding and
  ownership rejection are not implemented yet.
- Collection queries still run against whatever shard data is local to the node.
  Cross-shard query fan-out/merge is a later layer.

### Op-log retention

The op log is pruned based on peer acknowledgements. Each pull includes the
requester's node id; after applying ops, the requester acks how far it got. A
node drops its own log entries once *every* peer has acked past them, keeping a
configurable buffer of recent ops on top:

- `RETAIN_OPS` (default `256`) — ops to keep beyond the lowest ack watermark.
  Set `0` to prune immediately on ack.

Two safety nets:

- **Min-ack watermark** — if a peer acked up to seq 10 and then went down, its
  old ack keeps ops 11+ retained, so it catches up incrementally when it returns.
- **Snapshot fallback** — a peer that pulls `after` a point we've already
  pruned gets `410` and transparently switches to `GET /replicate/snapshot`,
  applying the full state with LWW merge. So a brand-new or data-lost node still
  converges even after aggressive pruning. Object tombstones are part of the
  snapshot and the merge, so deletes survive recovery. Snapshots also advance
  the receiver's Lamport clock before new writes, and carry object timestamps so
  empty objects survive recovery.

## Project layout

```
src/
  shape.js    shape store: layouts, dynamic value columns
  store.js    Store/Database/Collection: CRDT metadata + shape-store glue
  clock.js    Lamport timestamps and comparisons
  crdt.js     CRDTNode: local ops, op log, merge, peer sync
  server.js   HTTP server: REST + replication endpoints
  index.js    entrypoint (env-driven)
test/
  shape.test.js  shape-store behaviour
  crud.test.js   CRUD + namespacing
  crdt.test.js   convergence, LWW, delete/update races, idempotency
  server.test.js REST + HTTP replication
```

## Semantics & trade-offs

- **Eventual consistency, LWW.** Concurrent writes to the same object converge
  to the higher timestamp; ties are broken by node id. Whole objects replace,
  so independent concurrent field changes are not merged. There is no
  read-your-writes guarantee across nodes until a sync completes.
- **In-memory only.** Data lives in shape columns and JS maps; nothing is
  persisted to disk.
- **Multi-writer.** Safe to write the same object on many nodes at once; the
  merge is deterministic and convergent.
- **Retention keeps memory bounded.** Logs are pruned once all peers ack;
  deleted objects keep a lightweight tombstone so deletes win correctly when
  replayed. Op logs grow with local write volume; the snapshot fallback means a
  node that missed pruned ops still converges.
