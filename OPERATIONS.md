# Running OBJY DB

**OBJY DB is a fast, bulk-first object database that lives in memory wherever it runs.** Use it directly inside a Node.js application, inside a browser, or behind an HTTP server that adds durability and distributed operation.

The runtime changes. The database does not.

- Objects stay dynamic and schema-free.
- Databases, collections, metadata, and `_id` mean the same thing everywhere.
- Single writes use the same bulk machinery as large imports.
- Queries, aggregation, indexes, RID columns, references, vectors, and compression share one implementation.
- Complete objects are hydrated at the API boundary.

## One In-Memory Core

The object store is the live database. Field indexes, columns, vector indexes, dictionaries, and compressed tiering organize that state for different workloads, but they do not create a second source of truth.

```text
dynamic objects in memory
        |
        +-- field indexes for filtering, grouping, and sorting
        +-- RID columns for compact scalar values and aggregation
        +-- HNSW indexes for client-provided vectors
        +-- compressed tiering for colder object fields
```

Writes are immediately visible through the local database API. Calling `ready()` waits for configured derived structures to finish catching up, which is useful before benchmarking or requiring vector search.

## Embedded

Install `@objy/db` when the database should live inside a Node.js application or service:

```sh
npm install @objy/db
```

```js
import { createDatabase } from "@objy/db";

const objy = createDatabase();
await objy.createDatabase("app");
await objy.database("app").createCollection("assets", {
  indexes: ["status"],
  columns: ["score"]
});

const assets = objy.database("app").collection("assets");
await assets.insertMany(objects);
const active = await assets.find({ status: "active" });
```

Embedded operation is deliberately simple:

- The application owns the database lifecycle and calls `objy.close()` when finished.
- Data lives in the process heap and disappears with the process.
- There is no HTTP, authentication, S3, sharding, or replication overhead.
- Native Node.js platform adapters are selected automatically.

Use embedded mode for application-local datasets, processing pipelines, tests, caches that need database semantics, and services that already own their network boundary.

## Browser

The same `@objy/db` package runs directly in modern browsers:

```js
import { createDatabase } from "@objy/db";

const objy = createDatabase();
```

Package-aware bundlers select the portable browser adapters automatically. GitHub releases also include a standalone `objy-db-<version>.esm.js` module for applications without npm.

Browser operation keeps the complete local database engine:

- Bulk CRUD, queries, aggregation, indexes, columns, vectors, references, and compression remain available.
- Data lives in the page or worker heap and is released when that JavaScript context ends.
- No server connection is required.
- Authentication, replication, sharding, files, and S3 are server responsibilities.
- Browser persistence is not implemented yet.

Memory limits are controlled by the browser, so applications should bound imported datasets and release databases that are no longer needed. Run representative workloads in every browser family the application supports.

## Server

Install `@objy/server` when multiple clients need shared access or when the database needs durability, authentication, files, or clustering:

```sh
npm install --global @objy/server
objy run --config ./objydb.config.json
```

The server wraps the same in-memory database with:

- REST and the JavaScript client.
- JWT authentication and object permissions.
- File objects backed by S3.
- Object hooks and interface plugins.
- Local-WAL acknowledgements and S3 recovery.
- Object sharding, request routing, and replicas.
- The admin console and cluster status API.

A single server is one in-memory database behind HTTP. A cluster partitions that same model across object shards and optionally keeps replica copies of each shard.

## Server Durability

Memory remains the serving layer. Durability happens around it:

```text
write -> memory -> local WAL -> S3 journal -> snapshot
          |             |
       visible       safe ack
```

| Acknowledgement | Response means |
| --- | --- |
| `ack: "memory"` | The handling node accepted the write in memory. An early process or host failure can lose an unflushed write. |
| `ack: "localWal"` | The write was appended and flushed to the node-local WAL before the response. |

`localWal` is the recommended mode when process-failure durability matters. With `fsync` enabled, it adds storage latency to writes but protects the normal gap before asynchronous S3 upload.

S3 is the recovery source:

- **Journals** contain bounded operation batches after the current snapshot cursor.
- **Snapshots** contain full objects separated by database, collection, and shard.
- **Compaction** removes journals already covered by a successful snapshot.
- **Retention** optionally keeps older snapshots for deliberate point-in-time restore.

Indexes, columns, and vector indexes are derived in memory and rebuild after restore. They are never required to recover the objects themselves.

## Server Startup

A durable node becomes available in two stages:

1. Load configuration, shared secrets, and the active shard map.
2. Open `/health` while restoring owned metadata, snapshots, journals, and the local WAL.
3. Open the public API after all owned objects are readable.
4. Start replication, journal flushing, and snapshot scheduling.
5. Warm indexes, columns, and vectors in bounded same-thread tasks.

Data routes return `503` during object restore. After the public API opens, ordinary queries use correct scan fallbacks while derived structures warm. Vector search returns `503` until its vector index is ready.

## Replication and Consistency

Replication is asynchronous and pull-based:

1. The owner accepts an object operation and hints its shard peers.
2. Replicas pull missing bounded batches.
3. Periodic anti-entropy repairs missed hints and temporary outages.
4. Whole-object last-write-wins ordering resolves concurrent versions.

Any server node may receive a public request. The router forwards object work to an owner and fans queries or aggregations across the required shards in parallel.

Replicas improve availability but do not add logical memory capacity. A successful WAL acknowledgement means the handling node can recover the operation; it does not mean every replica has already applied it.

## Capacity and Pressure

Plan physical memory from stored copies:

- One copy of every shard represents logical cluster capacity.
- Each additional replica consumes another physical copy of its shard and derived structures.
- Heap contains objects, IDs, indexes, columns, vectors, and temporary build/import state.
- RSS also includes V8 reserve, native allocations, and compressed buffers.

Set the Node.js heap below the VM or container memory limit and leave room for non-heap RSS. The optional memory guard rejects new writes with `507` above its configured threshold and resumes below the recovery threshold. Reads stay available.

Large HTTP imports should use NDJSON and bounded client batches. Back off when the server responds with `503`, `507`, or `Retry-After`.

## Observe

```text
GET /health
GET /api/config
GET /api/config?details=1
```

`/health` is lightweight and unauthenticated. `/api/config` requires a global administrator and reports compact peer, shard, memory, restore, replication, and readiness state. Load `?details=1` for diagnosis rather than frequent polling.

Watch these signals:

- Every shard has a reachable owner and the expected replicas.
- Heap and RSS remain below the memory-guard threshold.
- Restore, field-index, column, and vector readiness reaches a stable state.
- Persistence backlog and replication lag do not keep growing.
- Repeated pull, journal, snapshot, or S3 failures are investigated.

One transient pull error does not prove data loss. A persistent unavailable replica or growing cursor gap does require action.

## Stop and Upgrade

Use `objy stop`, `SIGINT`, or `SIGTERM`. Graceful shutdown stops replication, closes HTTP intake, flushes the local WAL and pending S3 journals, then exits.

```sh
objy status
objy logs --follow
objy restart
objy stop
```

Upgrade redundant clusters one replica at a time. Verify health, restored object counts, replica catch-up, and representative queries before continuing to the next peer. Avoid `SIGKILL` and do not combine an untested version upgrade with a shard-count change.

## Change Cluster Size

Adding or removing a replica keeps the partition topology. Changing the number of shards performs a coordinated restart-based reshard:

1. Gracefully stop every peer and flush durable writes.
2. Publish the desired shard map.
3. Start the target peers against the same S3 namespace.
4. Peers restore the source generation and repartition objects into target shards.
5. Each target shard writes a durable checkpoint.
6. The topology becomes active only after every target shard is ready.

Resharding requires shared S3 persistence, an S3 shard-map store, temporary space for both generations, and enough memory for every target shard. Live resharding is not implemented yet.

## Current Boundaries

- Embedded and browser databases are memory-only.
- The server has no multi-object transactions.
- Cross-shard reads are not linearizable snapshots.
- Replicas converge asynchronously with whole-object last-write-wins semantics.
- Shard-count changes require a coordinated restart.
- APIs and configuration may still evolve before `1.0`.

Pin an exact alpha version and test restore, load, failure, and upgrade behavior with representative data before production use. See [BENCHMARKS.md](BENCHMARKS.md) for reproducible workloads and [API.md](API.md) for the public server interface.
