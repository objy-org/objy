# OBJY DB

The database guide: run OBJY DB, work with dynamic objects, choose how they use memory, and operate one node or a distributed cluster.

`@objy/db` runs the HTTP server and database engine. It owns storage, queries, authentication, persistence, sharding, replication, and the Data Explorer. Applications connect using [`@objy/client`](https://github.com/objy-org/objy-client) or the [REST API](API.md). The client is a separate package; it does not start the database.

[Run](#run-the-server) · [Configure](#configuration) · [Objects](#object-model) · [Queries](#queries-and-aggregation) · [Meta](#collection-meta) · [Persistence](#persistence-and-recovery) · [Clusters](#shards-and-replicas) · [Operations](#operating-the-database)

## Run the Server

### Run a Node

Install the database with Node.js 20 or newer:

```sh
npm install --global @objy/db
```

Create `objydb.config.json`. A temporary, single-node setup needs only:

```json
{
  "node": { "id": "node-a", "url": "http://127.0.0.1:8080" },
  "server": { "port": 8080 }
}
```

```sh
objy
objy --config /path/to/objydb.config.json
```

The command runs one node in the foreground: it loads configuration, establishes system credentials, restores configured durable data, starts replication, and serves the HTTP API and Data Explorer. Stop it gracefully with Ctrl+C or SIGTERM. Open the printed URL and use the initial administrator password printed in the logs.

Without `--config`, it looks for `objydb.config.json` in the working directory. `--node`, `--url`, and `--port` override the local identity and listener, so peers can share one configuration file. `objy --help` lists these options; `objy --version` prints the installed database version. The command does not install infrastructure or manage background processes.

For a project-local installation, use `npm install @objy/db` followed by `npm exec -- objy --config objydb.config.json`. Direct startup with `node node_modules/@objy/db/src/index.js` remains available. For running a source checkout, see [Contributing](https://github.com/objy-org/objy/blob/main/CONTRIBUTING.md).

### From a Node.js Application

Use Node.js 20 or newer and an ES module, for example `server.mjs`:

```sh
npm install @objy/db
```

```js
import { startServer } from "@objy/db";

const runtime = await startServer({ port: 8080 });
console.log(`OBJY DB listening on http://127.0.0.1:${runtime.port}`);
```

**This is a memory-only HTTP server.** `startServer()` takes runtime options; it does not read the JSON configuration or perform S3/WAL recovery. Its generated credentials and data are not durable across process exits. The application owns its lifecycle. Use `objy` for the complete configured node bootstrap.

## Configuration

This is a durable S3-backed example, not a list of defaults. Create the bucket first and give each independent cluster its own prefix.

```json
{
  "node": {
    "id": "node-a",
    "url": "http://127.0.0.1:8080",
    "retainOps": 256,
    "syncBatchSize": 50000
  },
  "server": { "port": 8080, "cors": false },
  "storage": { "engine": "object" },
  "files": { "mode": "s3", "prefix": "objydb/files" },
  "memoryGuard": {
    "enabled": true,
    "limitMb": 4096,
    "rejectWritesPercent": 85,
    "resumeWritesPercent": 78
  },
  "cluster": {
    "syncMs": 2500,
    "forwardTimeoutMs": 60000,
    "replicationTimeoutMs": 60000,
    "shardMapStore": {
      "mode": "s3",
      "prefix": "objydb",
      "key": "cluster/shard-map.json"
    }
  },
  "auth": {
    "accessTokenTtlSeconds": 3600,
    "refreshTokenTtlSeconds": 1209600
  },
  "persistence": {
    "mode": "s3",
    "prefix": "objydb",
    "ack": "localWal",
    "flushMs": 5000,
    "snapshotMs": 60000,
    "compactJournals": true,
    "snapshotRetention": { "keepLatest": 5 },
    "localWal": { "mode": "on", "dir": ".objydb/wal", "fsync": true },
    "s3": {
      "bucket": "objydb",
      "endpoint": "https://s3.example.com",
      "region": "us-east-1",
      "accessKeyId": { "fromEnvironment": "OBJYDB_S3_ACCESS_KEY_ID" },
      "secretAccessKey": { "fromEnvironment": "OBJYDB_S3_SECRET_ACCESS_KEY" }
    }
  }
}
```

| Section | What it controls |
| --- | --- |
| `node` | Unique local `id` and reachable `url`. `retainOps` bounds the in-memory replication log (default 256); `syncBatchSize` bounds a pull batch (default 1024). |
| `server` | HTTP `port` (default 8080), `cors`, and JSON request limits. |
| `storage` | In-memory object storage with bounded, automatic value dictionaries. `engine` defaults to `object`, the only built-in engine. |
| `files` | Optional private file storage. Default `mode` is `off`; `s3` inherits connection settings from `persistence.s3`, with optional `files.s3` overrides. |
| `memoryGuard` | Optional RSS-based write admission. `limitMb` is a per-process budget; otherwise the guard uses detected container or host memory. Disabled by default. |
| `cluster` | Replication timing, hints, forwarding timeouts, and shared shard-map storage. `syncMs` defaults to 2500; both timeouts default to 60000. |
| `auth` | JWT authentication, token lifetimes, and initial-user options. Authentication is enabled by default. Missing system secrets are generated. |
| `persistence` | Durability, namespace, acknowledgement, journal flushes, snapshots, retention, and S3 connection. Default `mode` is `off` and default `ack` is `memory`. |
| `imports` | Bounded write admission: `maxBulkObjects`, `maxBulkBytes`, `maxObjectBytes`, `maxPendingPersistenceBytes`, `persistenceWaitMs`, and `retryAfterMs`. |
| `plugins`, `vector` | Code-registered extensions and vector-index settings. |

`fromEnvironment` references are optional: a setting can contain the literal string instead. A missing referenced environment variable fails startup. Keep credentials out of source control and restrict configuration-file access.

For a separate browser application, allow its origin explicitly:

```json
{ "server": { "port": 8080, "cors": { "origins": ["https://app.example.com"] } } }
```

Configured startup stores generated system secrets in the shared S3 namespace when available, or locally otherwise. Preserve that state and the node's WAL directory. Peers must share authentication and cluster secrets, but have distinct identities and local WAL storage.

Persistence pressure pauses a write batch before it changes data. The owning node waits for existing journal/WAL flushes, without polling; routing and replication use the same admission gate. `imports.maxPendingPersistenceBytes` defaults to 256 MiB and includes queued and in-flight journal/WAL bytes. It is a backpressure threshold, not a hard process-memory cap: an admitted batch can cross it. Waiting requests are bounded too.

`imports.persistenceWaitMs` defaults to `60000` per pressured batch (`0` rejects immediately). The deadline does not reset on progress. A storage failure, cancellation, exhausted waiting capacity, or deadline ends the wait with an error; pressure responses use `503` and `Retry-After`. Client and forwarding timeouts can end a request sooner. Set a suitable client timeout for long imports. A successful write still follows the configured `persistence.ack` policy, not a new S3 or replica acknowledgement.

## Object Model

```text
database
  collection + meta
    objects
```

A **database** is a namespace. A **collection** holds objects and one small metadata document. An **object** is dynamic JSON with an `_id`: fields, nested structures, and value types can differ between objects in the same collection. No schema migration is required to add a field.

### Object Anatomy

```json
{
  "_id": "asset-1",
  "name": "Laptop",
  "type": "asset",
  "status": "active",
  "kind": "device",
  "score": 42,
  "tags": ["inventory"],
  "owner": { "type": "reference", "collection": "users", "value": "user-1" },
  "_vec": [0.2, 0.8, 0.4]
}
```

- `_id` is unique inside its collection. Omit it to generate a compact, random 16-character URL-safe id. IDs are not chronological; an ordinary field such as `createdAt` can express creation order.
- References are links, not embedded copies. Reads can expand them as `.object`, and queries can follow those paths.
- `_vec` supplies an embedding. Vectors are stored separately from ordinary object fields and hidden from normal reads.
- `_file` is a server-managed descriptor connecting an object to private S3 file content.

Reads return ordinary JSON, including transparently hydrated columns and compressed fields. Reference expansion and structure defaults are read views, not extra copies persisted into each object.

## Working with Objects

Install `@objy/client`. These examples use one fresh database throughout:

```js
import { createClient } from "@objy/client";

const client = createClient({ url: "http://127.0.0.1:8080" });
await client.login({ username: "admin", password: "<printed-password>" });

await client.createDatabase("app");
const app = client.database("app");
await app.createCollection("users", { indexes: ["username"] });
await app.createCollection("assets", { indexes: ["status", "kind"], columns: ["score"] });
const users = app.collection("users");
const assets = app.collection("assets");
```

### Single and Bulk Operations

```js
await assets.insert({ _id: "asset-1", name: "Laptop", status: "new" });
await assets.get("asset-1");
await assets.replace("asset-1", {
  name: "Laptop Pro", type: "asset", kind: "device", status: "active", score: 75
});
await assets.patch("asset-1", { $set: { score: 80 }, $unset: ["legacyFlag"] });

await assets.insertMany([
  { _id: "asset-2", type: "asset", kind: "device", status: "active", score: 20 },
  { _id: "asset-3", type: "asset", kind: "vehicle", status: "archived", score: 40 }
], { minimal: true });
await assets.replaceMany([{ _id: "asset-2", type: "asset", kind: "device", score: 25 }]);
await assets.patchMany([{ _id: "asset-3", $set: { score: 50 } }]);
```

`insert` creates new objects; duplicate IDs conflict, including duplicates within one bulk. `replace` is a full-object upsert: omitted fields disappear. `patch` changes only the paths in `$set` and `$unset`, including nested paths. Single operations use the same bulk-first storage and replication mechanisms as batches.

Reads and normal writes return objects or arrays. For large writes, `{ minimal: true }` returns counts without hydrating every written object. Auto-generated IDs are not included in that minimal response; supply IDs when you need to track imported objects.

Delete one with `await assets.remove("asset-1")`, or many with `await assets.removeMany(["asset-2", "asset-3"])`. Deleting a collection removes its objects and metadata; deleting a database removes its collections. There are no multi-object ACID transactions or retained read snapshots spanning requests.

### Streamed Imports

Streaming uses NDJSON at the HTTP boundary and bounded bulk batches inside the database:

```js
async function* source() {
  for (let n = 0; n < 100000; n++) {
    yield { _id: `import-${n}`, type: "asset", kind: "device", score: n };
  }
}

await assets.import(source, { operation: "insert" });
await assets.import([
  { _id: "import-2", $set: { score: 99 } }
], { operation: "patch" });
```

`import` also supports `replace` and `remove`. Replacements contain full objects, patches contain `_id` and update operators, and deletions identify objects by `_id`. This avoids a single giant JSON array; it does not remove per-object validation, indexing, WAL, or replication work.

A stream can commit earlier batches before a later batch fails. Keep stable IDs and inspect the error's committed counts rather than blindly replaying an insert stream. Passing a source factory, as above, lets the client recreate a stream if safe authentication renewal is required. For wire formats, limits, and partial-failure responses, see [streaming operations](API.md#streamed-bulk-writes) and the [client guide](https://github.com/objy-org/objy-client).

## Queries and Aggregation

```js
await assets.find({ status: "active" }, { limit: 50, sortBy: "_id" });

await assets.search({
  score: { $gte: 20 },
  $sort: { score: -1 },
  $page: 1,
  $pageSize: 50
});

await assets.count({ kind: "device" });

await assets.search({
  $aggregate: {
    groupBy: "kind",
    fields: {
      totalScore: { $sum: "score" },
      averageScore: { $avg: "score" },
      count: { $count: true }
    },
    $sort: { totalScore: -1 }
  }
});
```

The query language supports comparisons, array membership such as `$contains`, logical combinations, nested paths, sorting, paging, and aggregation. `search` accepts normal queries as well as vector search. Aggregation includes grouping, `$sum`, `$avg`, `$min`, `$max`, and `$count`; numeric sum/average inputs must be finite numbers, not numeric strings. The [REST reference](API.md) lists the complete operators and response formats.

The planner combines field-index candidates, columns, and scans as appropriate. Grouping on an indexed field and summing a column can avoid full-object hydration, but still involves work proportional to the relevant values. An index does not make every aggregate constant-time. HTTP responses expose the selected path in `x-objydb-query-path`, for example `index-full`, `scan`, or an `aggregate-*` path; distributed requests can report multiple paths.

### Sorting and Paging

Default order is `_id` ascending. Explicit sorts use `_id` ascending as the tie-breaker, so equal field values have a deterministic order across shards. This is stable ordering of the current data, not chronological ID order or a transaction snapshot.

Paging is offset/page-based, with a maximum page size of 250. Concurrent writes, deletes, sort-field changes, or replica lag can shift records between requests. Deep offsets and unindexed sorts cost more than small first-page reads.

```js
for await (const asset of assets.iterate({ kind: "device" }, { pageSize: 100 })) {
  console.log(asset._id);
}
```

The client iterator walks ordinary object pages; it is not a stable server-side cursor and does not iterate aggregate or vector results.

## Collection Meta

Every collection has one small metadata object, kept in memory and persisted separately from its objects when S3 persistence is configured. It can contain custom application information as well as database settings:

```js
await assets.setMeta({
  indexes: ["status", "kind"],
  columns: ["score"],
  tiering: {
    mode: "compressedMemory",
    keep: ["name", "type", "status", "kind"],
    minBytes: 4096
  },
  structure: [
    { condition: { type: "asset" }, apply: { lifecycle: { managed: true } } }
  ]
});

const meta = await assets.getMeta();
```

`setMeta` replaces the metadata document. Read and merge it first if you want to preserve unrelated settings.

### Field Indexes

`indexes: ["status", "owner.value"]` maintains lookups from values to matching internal object IDs. Equality, array membership, grouping, and supported sort paths can use them instead of scanning every object. Nested paths are supported. `_id` already has a direct lookup; adding an ordinary field index for it is unnecessary.

Index fields that real queries use. Every index consumes memory and adds maintenance to writes. A low-selectivity field can still be useful for grouping, but matching most objects naturally requires more work than matching a few.

### Columns

`columns: ["score"]` moves selected physical values into collection-scoped, RID-addressed storage. Numeric and boolean values use compact typed storage; strings can use dictionaries, while mixed types have an overflow representation. Objects remain fully dynamic.

Values move out of the ordinary object body rather than being duplicated beside it. Reads hydrate the same JSON shape. Aggregates and field-only readers can access columns without rebuilding unrelated object fields. Removing a column returns its values to ordinary object storage.

Columns are not a replacement for field indexes: columns make values compact and directly accessible, while field indexes find matching objects. Snapshots still contain complete logical objects, not a separate persisted column-index format.

### Compressed Memory

```json
{
  "tiering": {
    "mode": "compressedMemory",
    "offload": ["history", "rawPayload"],
    "minBytes": 4096
  }
}
```

Use either `keep` to name hot fields or `offload` to name compressible fields, not both. Payloads below `minBytes` stay uncompressed. The object engine uses fast DEFLATE compression in memory, not a disk tier. Indexed and column fields remain directly available automatically; arrays preserve their contents and shape.

Applications see normal full objects, without a `_warm` marker. Selected results are hydrated as needed, so small pages avoid hydrating an entire collection where the query path allows it. A scan over compressed, unindexed fields still has to decompress them. Compression trades CPU and read latency for memory savings; it is most useful for large, repetitive payloads that are not frequently scanned.

Changing the setting retieres existing objects cooperatively. `{ "tiering": { "mode": "off" } }` restores ordinary in-memory fields. Compression statistics compare only the tiered payload's original and compressed bytes, not total database heap or RSS.

The object engine also interns eligible repeated values automatically through bounded value dictionaries. That is a separate optimization, controlled by `storage.object.valueDirectory`, not another collection meta index.

### Conditional Structure

```json
{
  "structure": [
    { "condition": {}, "apply": { "source": "inventory" } },
    { "condition": { "type": "asset" }, "apply": { "status": "managed" } }
  ]
}
```

Structure supplies virtual read defaults without storing them on every object. Conditions inspect physical fields. Entries apply in order: later matching entries override earlier virtual values, and explicit object values always win. Unsetting a physical override reveals its fallback on the next read. Identity, authentication, file, and vector fields cannot be supplied virtually.

**Virtual fields are not queryable.** Filters, sorting, paging membership, aggregation, indexes, and columns use physical fields only. Structure values are not written into WAL, replication, journals, or snapshots. Changing structure affects subsequent reads without rewriting objects or rebuilding indexes.

### When Meta Changes

Affected index builds, column migrations, and compression jobs run in bounded, cooperatively scheduled work. Accepting a meta update does not mean all work has finished. Reads and writes remain correct through fallback paths, which can be slower until the job completes. These jobs share the main process; background scheduling is not CPU isolation. The config view reports readiness.

## Live References

```js
await users.insert({ _id: "user-1", username: "alice" });
await assets.insert({
  _id: "owned-asset",
  name: "Shared laptop",
  owner: { type: "reference", collection: "users", value: "user-1" }
});

await assets.get("owned-asset"); // owner.object contains the current referenced object
await assets.get("owned-asset", { refDepth: 0 }); // descriptor only
await assets.search({ "owner.object.username": "alice", $refDepth: 0 });
```

References default to the same database; add `database` to cross database boundaries. Default expansion depth is one. `.object` is resolved on reads, including remote-shard lookups, not stored as a permanent embedded copy. Permissions still apply to referenced data. `$refDepth: 0` controls output expansion, not whether a reference predicate is evaluated.

Vector search cannot be combined with reference-`.object` predicates. See [Live References](API.md#live-references) for the complete descriptor and depth behavior.

## Vector Search

Clients supply embeddings, so no embedding provider is required:

```js
await assets.insert({ _id: "vector-asset", name: "Laptop", _vec: [0.2, 0.8, 0.4] });
```

Once its vector index is ready, search it:

```js
const matches = await assets.search({ $vector: { vector: [0.21, 0.79, 0.4], limit: 10, ef: 64 } });
```

Search uses HNSW and cosine similarity. Embeddings must contain finite numbers and compatible dimensions; use the same embedding model for stored and query vectors. Ordinary filters and permissions restrict results. Vector data is durable object data, but the derived HNSW index is not included in snapshots.

Global configuration controls `vector.enabled`, `vector.field` (default `_vec`), and `vector.hnsw` settings such as `M`, `efConstruction`, and `efSearch`. After boot or a rebuild, including immediately after a vector write, search can return `503` with `error: "vector index warming"` until the index is ready. Retry the search after warmup, not the insert; ordinary object reads remain available.

## Files

Enable `files.mode: "s3"` first. Each file is represented by an ordinary object, with one private blob attached:

```js
await assets.insertFile(
  { _id: "manual", title: "Notes" },
  new Blob(["Hello"], { type: "text/plain" }),
  { filename: "notes.txt" }
);
await assets.replaceFile(
  "manual",
  { title: "Updated notes" },
  new Blob(["Updated"], { type: "text/plain" }),
  { filename: "notes.txt" }
);
const response = await assets.download("manual");
const content = await response.blob();
await assets.remove("manual");
```

The managed `_file` descriptor contains `storage`, `key`, and `mimeType`. The wrapping object's permissions also govern blob reads; clients never need S3 credentials. CRUD controls the object and file together, not a separate mutable file record. File uploads use single-object multipart requests, not bulk/NDJSON uploads.

A content replacement stages a new blob, commits the object's new pointer, then cleans up the old blob. Failed cleanup is possible; old blobs are not a supported file-version history. Database snapshots retain descriptors, not independent copies of file contents. See [File Handling](API.md#file-handling) for upload and download endpoints.

## Authentication and Permissions

Configured startup ensures `_global/users` contains the initial administrator. When it must create that user, it generates a password and prints it once in the creating node's logs. `OBJYDB_ADMIN_PASSWORD` can supply the initial password instead; set it before the first boot if you need a chosen credential. It does not reset an existing user. Protect those logs and bootstrap state.

Any collection can contain authenticatable objects with a username and password. Passwords are hashed and excluded from public reads. Login targets `/api/{database}/{collection}/auth`, and token renewal uses the sibling `/renew` endpoint. Default access-token lifetime is one hour; refresh tokens last 14 days. Login to `_global/users` for global administration.

Password hashing uses Node's built-in asynchronous PBKDF2-HMAC-SHA256, without an external cryptography package: 600,000 iterations, a random 16-byte salt, and a 32-byte hash. Password inputs are plaintext and limited to 1024 UTF-8 bytes. Hash work is bounded to two active jobs and 32 waiting jobs per process; overload returns `503` with `Retry-After`. Existing weaker hashes remain usable and are upgraded on successful login through the ordinary durable write path. Replication and restore preserve stored hashes without hashing again.

Access tokens are deliberately stateless: changing permissions or deleting an account does not invalidate an already issued token before expiry. Renewal reads the current account and permissions and checks its `tokenVersion`; there is no per-request account lookup or immediate access-token revocation.

A database can be created with its own administrator:

```js
await client.createDatabase("team", {
  adminUser: { username: "owner", password: "<chosen-password>" }
});
```

This creates its `users` collection and an object with `admin: true`. Database admins administer their own database; global admins can administer other databases. `_global` is publicly read-only, even for global admins, including metadata and database/collection changes.

Non-admin users have no access unless granted permissions. Object-level rules live directly in the user object:

```json
{
  "username": "alice",
  "permissions": [
    {
      "name": "own objects",
      "query": { "ownerId": "alice" },
      "perm": "crud"
    }
  ]
}
```

`perm` combines `c` (create), `r` (read), `u` (update), and `d` (delete). Read constraints are merged into queries; writes validate their operation and applicable object constraints, including both stored and resulting update values. `collectionPermissions`, for example `{ "read": ["assets"], "write": ["assets"] }`, grants collection-wide access; write does not imply read. Collection/schema and database operations have their own administrative requirements. Renew or log in again after user permissions change. See [Permissions](API.md#permissions) for the exact rule formats and endpoint policy.

Collection-write access does not grant account administration. Only a database/global admin may change an authenticatable object's `admin`, `role`, `permissions`, `collectionPermissions`, or `tokenVersion`, or activate an object carrying such grants. Users may change their own credentials or delete their own account only with the corresponding ordinary write permission; other accounts require an admin for those operations. Identity includes database, collection, and `_id`. Business objects without credentials can still use the same field names. The policy covers all public write formats and runs after hooks, without changing replication or restore.

These checks read current fields without storing another authorization index. For non-admin writes, checking an existing compressed object can require decompression if its credentials could be cold; admin writes skip this check.

## Persistence and Recovery

Persistence is optional. Without it, memory is volatile; replication alone is not a backup.

```text
write -> in-memory objects -> local WAL -> acknowledgement (ack: localWal)
                  |
                  +-> asynchronous replica catch-up
                  +-> batched S3 journals -> periodic full-object snapshots
```

| State | Purpose |
| --- | --- |
| In-memory operation log | Bounded recent operations for fast replication pulls. Not durable by itself. |
| Local WAL | Local recovery and acknowledgement after flush when `ack: "localWal"` is selected. Keep `localWal.fsync: true` for durable flushes. |
| S3 journals | Asynchronous batches of changes since checkpoints. `flushMs` defaults to 5000, not one S3 request per object. |
| S3 snapshots | Full logical objects, scoped by database, collection, and shard. Automatic snapshot interval defaults to 60000 ms for dirty scopes. |

`ack: "memory"` does not wait for disk durability. `ack: "localWal"` waits for the local WAL, not a remote replica or S3 quorum. A process crash can recover from that WAL; loss of its disk before replication or S3 catches up can still lose recent writes. There is no synchronous cross-node commit guarantee.

S3 stores whole objects, including values held in columns or compressed memory and supplied vectors. It does not store the derived field/vector indexes. This keeps S3 independent of the in-memory representation.

On boot, a node restores its owned scopes from snapshots and later journals, then replays eligible local WAL operations. Loading is streamed in bounded batches. Object data is available when restore finishes; derived indexes and memory optimizations can continue warming afterward. Replicas catch up through operation pulls and durable journals when recent operations have been trimmed, not by transferring another peer's full heap snapshot.

### Snapshots and Retention

A checkpoint is published only after its data is safely written. Journals are compacted only when covered by durable checkpoints, so a failed snapshot must not discard uncovered changes. Snapshot writing normally belongs to each shard's configured primary; `snapshotRole: "none"` disables automatic snapshots on that node.

Set `snapshotRetention.keepLatest` to retain a bounded number of published snapshots per scope, for example five. `keepForMs` can additionally preserve snapshots by age. Defaults do not automatically prune old snapshots. Journals and unpublished leftovers are not a second user-facing backup/version system.

Leave `restoreSnapshotId` unset for normal latest-checkpoint recovery plus journals and local WAL. An explicit ID is a snapshot-only recovery choice: normal journal/WAL replay is skipped. Test recovery in an isolated namespace and select a snapshot that exists for the relevant scopes. A database snapshot does not preserve old versions of replaced or deleted file blobs.

The shared-state protocol uses ordinary S3 GET, PUT, LIST, and DELETE operations, not conditional ETag writes. Use a service with strongly consistent object reads and listings. Preserve the node's publication state and do not run two processes with the same node identity.

## Shards and Replicas

![OBJY DB server architecture](https://raw.githubusercontent.com/objy-org/objy/main/public/branding/objy-server-architecture.svg)

One global shard map applies to all databases and collections. Object `_id` hashes determine shard membership, not database names or object byte size. Distribution is approximately balanced by object count, not guaranteed memory usage.

A shard is a partition of data. Replicas are copies of that shard: two shards with two replicas each means four node processes when each process owns one copy. Requests can enter any node. CRUD is routed to an available owner; distributed queries read one replica per shard, fan out in parallel with timeouts, then merge and page globally.

Replication is asynchronous, using change hints to trigger pulls and periodic anti-entropy to catch missed hints. `cluster.syncMs` controls that safety interval, not write acknowledgement. Hint defaults debounce for 25 ms and include at most 128 scopes per hint. Reading another replica immediately after a write may observe lag.

### A Local Cluster

For four nodes with two shards and two copies per shard, use a shared S3-backed configuration like the earlier example and a map such as `shard-map.json`:

```json
{
  "shards": {
    "shard-a": {
      "peers": [
        { "nodeId": "a1", "url": "http://127.0.0.1:8080" },
        { "nodeId": "a2", "url": "http://127.0.0.1:8081" }
      ]
    },
    "shard-b": {
      "peers": [
        { "nodeId": "b1", "url": "http://127.0.0.1:8082" },
        { "nodeId": "b2", "url": "http://127.0.0.1:8083" }
      ]
    }
  }
}
```

In a source checkout, publish the map before starting the cluster:

```sh
node scripts/put-shard-map.js --config objydb.config.json --map shard-map.json
```

Then run each installed node in its own terminal or process manager. Start `a1` first so it can establish shared bootstrap state:

```sh
objy --config objydb.config.json --node a1 --url http://127.0.0.1:8080 --port 8080
objy --config objydb.config.json --node a2 --url http://127.0.0.1:8081 --port 8081
objy --config objydb.config.json --node b1 --url http://127.0.0.1:8082 --port 8082
objy --config objydb.config.json --node b2 --url http://127.0.0.1:8083 --port 8083
```

The persisted map takes precedence over an inline `cluster.shardMap`. Inline maps with shard-map storage off can describe a temporary memory-only cluster, but durable resharding and safe clustered context deletion require shared persistence. The first peer of each shard is its configured primary; there is no automatic primary election.

### Availability and Resharding

Ordinary object operations can use a surviving replica. Administrative operations are different: database/collection creation and metadata changes use their assigned fixed primary; topology and deletion coordination also have a fixed primary. If it is unavailable, those operations can fail rather than electing a competing writer. Snapshot publication pauses for an unavailable shard primary.

To change shard count, gracefully stop the old topology before publishing the new map. Publication records a new topology and its previous sources. Target nodes scan those sources in bounded batches, retain objects belonging to their new shard, and checkpoint their targets. The transition is finalized after all required targets are ready; old source state remains available during handoff.

Restore mode follows this map state automatically: ordinary boot is scoped to owned shards; a pending repartition uses reshard restore. Do not configure `restoreMode` or mix live old and new topologies. This is restart-based resharding, not live online resharding. Adding a replica also needs a deliberate map update and catch-up; simply starting another process does not assign it data.

## Operating the Database

### Data Explorer

The server serves its UI at `/`, `/ui`, and `/ui/`. Public database operations live under `/api`, not at the root URL. The connection form defaults to the server hosting the UI; cross-origin servers need suitable CORS settings.

Use the explorer to:

- Browse, locally filter, and collapse the database/collection tree; create or delete contexts.
- Page through objects, edit JSON, insert one object or an array, and edit collection meta.
- Write native query JSON or use the graphical filter/aggregation builder. It supports nested conditions, sorting, grouping, and aggregate fields while preserving advanced JSON when switching views.
- Upload files and preview browser-displayable attachments such as images or PDFs; other types can download.
- Inspect node memory, readiness, compression, replication, and write-admission status. Refresh explicitly rather than relying on automatic polling.

Database and collection rows show their delete control on hover or keyboard focus. Deletion requires typing the exact name and includes the scope's objects and attachments; `_global` is protected. Add objects accepts an optional file only with a single JSON object. Save or undo a dirty object draft before replacing its attachment. Image/PDF previews include a Download option and use authenticated API reads, never direct S3 access.

The sliders button opens the query builder. Combine filters with AND/OR, choose a sort, or use Count, Sum, Average, Minimum, or Maximum with an optional group field. Suggestions come from loaded objects; you can also type dotted paths. Values accept text or JSON: quote numeric strings, and use arrays for "one of". Apply query fills the JSON input; Run or Cmd/Ctrl+Enter executes it. Queries beyond the graphical controls remain editable in JSON and are never partially overwritten.

Saved connections and tokens stay in the browser; database objects and passwords do not. Forgetting a saved connection is not server-side token revocation. Derived aggregate/vector rows and expanded reference content are not editable as stored object bodies. Editor preflight checks do not provide atomic compare-and-swap updates.

### Health and Readiness

`GET /health` is unauthenticated and reports process health, including during restore. Public data operations can still return `503` while restore or a required vector index is warming. An HTTP listener being up is not proof that all data and indexes are ready.

`GET /api/config` requires global administration and returns compact cluster status; `?details=1` requests detailed diagnostics. It reports physical node memory separately from logical capacity, which counts only one replica per shard. `heapUsed` includes objects and indexes; RSS also includes native allocations and other process memory. Compression ratios describe tiered payloads, not whole-process savings.

A recent replication error can be historical, and a successful pull is not a full consistency checksum. Inspect reachability, progress, pending work, and repeated errors together.

### Memory and Background Work

Set a heap budget per process with Node.js, not as a cluster-wide allocation:

```sh
node --max-old-space-size=4096 node_modules/@objy/db/src/index.js --config objydb.config.json
```

Heap is not total RSS: typed arrays, buffers, compression, HTTP bodies, and temporary copies need headroom. On a machine with several nodes, allocate each a realistic fraction of total memory. The optional memory guard returns `507` under pressure and resumes below its lower threshold. It is write admission, not a hard RSS cap or a guarantee against OOM during restore or maintenance.

Indexing, column migration, compression, snapshot preparation, and other maintenance use cooperative scheduling. They still consume CPU and temporary memory. Prefer bounded NDJSON imports, minimal write responses, sensible indexes, and small read pages. Measure representative overlapping workloads rather than treating local benchmark numbers as universal limits; see [Benchmarks](https://github.com/objy-org/objy/blob/main/BENCHMARKS.md).

### Deleting Databases and Collections

Deletion first marks the context as deleting, blocking writes, metadata changes, and recreation under that name while peers drain work and durable state is removed. A database deletion also covers its collections. Clustered deletion requires shared S3 persistence; a standalone memory-only node can delete locally.

Success means cleanup is complete. If a required peer is offline, deletion can return `503` and remain pending. Bring the peer back and retry the same DELETE on any node; it resumes the pending deletion. A timeout does not silently reopen the context. After successful deletion and recreation, another DELETE is a new operation against the new context.

### Stop and Upgrade

The configured entry point handles `SIGINT` and `SIGTERM`: it stops replication scheduling, drains HTTP work, and flushes persistence before exit. Allow enough shutdown time in the process manager. Forced termination is not graceful shutdown. Applications using `startServer()` directly own their own shutdown handling.

Preserve node identities, local WAL/publication state, generated secrets, and S3 namespaces across upgrades. Take a recoverable backup before changing storage or topology. Older binaries and map publishers may not understand newer coordination formats; do not assume mixed-version rolling upgrades are safe. Place public access behind HTTPS and restrict internal cluster connectivity; the shared cluster secret is not a substitute for network protection.

## Extensions

Storage, persistence, interfaces, and code plugins have separate responsibilities. The built-in object engine combines dynamic objects, value dictionaries, RID-based columns, and optional compressed memory. A different engine would require implementing the storage contract and integrating it in code, not merely naming an arbitrary module in JSON. The default HTTP interface provides auth, public CRUD, cluster routes, and the UI. A custom interface must explicitly implement its access controls rather than assuming the default REST protections apply automatically.

### Object Hooks

Trusted server plugins can register middleware around public object operations. Configure a plugin file relative to the configuration file:

```json
{ "plugins": [{ "file": "./plugins/audit.mjs", "options": {} }] }
```

```js
export function register({ objectHooks }) {
  objectHooks.register("audit", async (context, next) => {
    const result = await next();
    console.log(context.operation, context.database, context.collection, context.count);
    return result;
  });
}
```

Enable it in collection meta with `{ "hooks": { "enabled": true, "use": ["audit"] } }`. Operation-specific selections are optional; `enabled: false` disables all hooks for the collection.

Hooks must call and await `next()` exactly once. They run on the handling node once per operation batch, including bounded streamed batches, never during replication or restore. Authentication, permissions, routing, and durability remain database responsibilities. Load consistent plugin code on all possible handling nodes. Plugins are trusted code, not a sandbox; a failure after `next()` may occur after a write has committed, and hooks are not distributed transactions or a foreign-data index adapter.

Programmatic registration is also available from `@objy/db/hooks`. For source contracts and development, see [Contributing](https://github.com/objy-org/objy/blob/main/CONTRIBUTING.md); for every public request format, use the [REST API](API.md).
