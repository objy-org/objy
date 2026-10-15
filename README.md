# OBJY DB

An in-memory, sharded, replicated object database for large dynamic object sets.

OBJY DB is built for plain JavaScript-style objects, fast local reads, bulk-first writes, object sharding, pull-based replication, S3 persistence, and a small admin console. Its core stays lightweight: the OBJY runtime is optional, with no schema-first object model or hidden application context in the database itself.

Public REST API usage is documented in `API.md`. This guide is for developing, running, and operating the database itself.

The [JavaScript client](client/README.md) is available at `/client.js` for browser imports and `spread-db/client` for Node and bundlers. It includes CRUD, queries, files, bulk imports and automatic token renewal.

## Why This Exists

OBJY DB keeps the database model simple:

- Objects are dynamic and identified by `_id`.
- Collections own metadata such as index definitions.
- Databases are top-level namespaces.
- Shards distribute objects globally across all databases and collections.
- Replicas converge through the replication log.
- Persistence is journals plus compacted snapshots on S3.

The goal is a system that stays understandable while still handling very large object counts.

## Quick Start

Install dependencies:

```sh
npm ci
```

Start a node:

```sh
node src/index.js --config spread-db.config.json --node node-a --url http://localhost:8080 --port 8080
```

Open the console:

```text
http://localhost:8080/
```

Default local login from the sample config:

```text
admin / 123
```

## The Mental Model

```text
database
  collection
    meta
    object _id=...
    object _id=...
```

Objects live under `database/collection/object`. A collection can contain fully dynamic objects, and collection meta carries optional indexes and vector settings.

Sharding is object-based. For any `{ database, collection, _id }`, the shard map decides the owner shard. Any node can receive a request; if it does not own the shard, it forwards the operation to a peer that does.

## Runtime Pieces

| Piece | Responsibility |
| --- | --- |
| Store | Keeps objects in memory. `object` is the current high-throughput path; `shape` remains available. |
| CRDT node | Applies whole-object writes, deletes, clocks, tombstones, and convergence rules. |
| Shard router | Finds object owners and fans reads/writes across shards when needed. |
| Replication scheduler | Uses hinted pull plus periodic anti-entropy sync. |
| Persistence manager | Flushes journals, writes snapshots, restores data on boot. |
| Index layer | Maintains field, column, and vector index readiness. |
| Interfaces | Mount public, cluster, and optional plugin routes. |

## Pluggable Components

OBJY DB is built around small replaceable layers. The core database owns object clocks, shard routing, replication, persistence coordination, and index readiness. Everything around that should stay swappable.

The two most important extension points are:

| Component | What can be changed |
| --- | --- |
| Storage engine | Replace how objects are represented in memory while keeping the same database/collection/object behavior. |
| Interfaces | Add, remove, or replace HTTP-facing route modules without changing the storage or replication layers. |

Storage engines should expose the same object-level behavior: bulk insert, replace, update, delete, reads, scans, metadata access, and index maintenance hooks. Single-object operations are treated as bulks of one, so custom storage should be designed bulk-first.

Interface plugins should stay thin. They translate transport concerns into database operations, but should not own storage, replication, sharding, or permission logic. The default setup uses separate public and cluster interfaces; custom interfaces can be added for specialized protocols, admin tooling, import flows, or private operational routes.

### Object Hooks

Object hooks are named, code-registered middleware for public create, read, update, and delete operations. They run once on the node that accepts the request, before shard fan-out, and never during replication or restore. Bulk requests invoke each hook once for the whole bulk; NDJSON streams invoke them once per bounded batch.

```js
import { createObjectHookRegistry } from "spread-db/hooks";
import { startServer } from "spread-db/server";

const hooks = createObjectHookRegistry();

hooks.register("timestamps", {
  operations: ["create", "update"],
  handler: async (context, next) => {
    const now = new Date().toISOString();
    for (const object of context.input.objects || []) object._updated = now;
    await next();
  },
});

await startServer({ objectHooks: hooks });
```

The CLI can load hook modules from files listed in `spread-db.config.json`. Paths are relative to that config file. Each module exports `register({ objectHooks, node, options })`; registration finishes before the HTTP server starts.

```json
{
  "plugins": [
    { "file": "./plugins/example.js", "options": {} }
  ]
}
```

Collections enable registered hooks through meta. `use` applies a hook to the operations declared by its code registration; operation arrays are optional additions. Setting `enabled` to `false` preserves the configuration but bypasses the whole chain.

```json
{
  "hooks": {
    "enabled": true,
    "use": ["timestamps", "audit"],
    "create": ["assets.validate"]
  }
}
```

Hooks may modify `context.input` before `next()` and inspect `context.result` afterward. A hook may set `context.result.responseOverride` after a successful write to replace that write's JSON response. A hook definition may also provide `validateMeta(meta)` to reject invalid collection settings when metadata is saved. OBJY DB revalidates transformed writes and still owns authentication, permissions, routing, and durability. Every public cluster node must register the same names.

The optional `plugins/objy.js` module registers an `objy` hook. It loads `new-objy` only when configured and uses OBJY DB's existing writes instead of an OBJY storage mapper. For adjacent source checkouts, configure it like this on every API node:

```json
{
  "plugins": [{
    "file": "./plugins/objy.js",
    "options": { "runtime": "../new-objy/index.js" }
  }]
}
```

Enable the hook and configure its family in collection metadata:

```json
{
  "hooks": { "use": ["objy"] },
  "objy": {
    "structure": { "status": "new" },
    "inheritFamily": "Base",
    "affectable": false
  }
}
```

These settings are scoped to that database and collection. Omitted settings use OBJY defaults; the `Affectable` collection is always affectable. Metadata changes take effect on the next object operation. Any family with `"affectable": true` can supply live defaults to objects in the same database.

OBJY handlers run in local QuickJS workers. Handlers run in OBJY's order; when one calls `done(value)` with a non-null value, the last such value replaces the ordinary JSON write response. Bulk writes return an array in input order, using the ordinary object for items without a handler value. A single delete with a handler value returns HTTP 200 and that value instead of an empty HTTP 204. NDJSON streams still return their minimal count summaries. Without a handler return value, changes to `afterObj` appear in the response only. The plugin stores event definitions but does not yet run a scheduler; that needs a separate event source and consumer.

## Configuration

The default config path is:

```text
spread-db.config.json
```

Use another file with `--config`. The same config can be shared by every peer; peer identity is usually supplied at startup:

```sh
node src/index.js --config spread-db.config.json --node node-a --url http://localhost:8080 --port 8080
```

This sample shows the runtime defaults explicitly. Values like node identity and secrets should be replaced for real deployments.

```json
{
  "node": {
    "id": "node-a",
    "url": "http://localhost:8080",
    "retainOps": 256,
    "syncBatchSize": 1024
  },
  "server": {
    "port": 8080
  },
  "storage": {
    "engine": "shape",
    "object": {
      "valueDirectory": {
        "enabled": true,
        "minRefs": 2,
        "maxEntries": 100000,
        "maxCandidates": 4096,
        "maxCandidatesPerPath": 256,
        "maxPaths": 1024,
        "maxStringLength": 256,
        "maxKeyBytes": 512
      }
    }
  },
  "files": {
    "mode": "off",
    "prefix": "spread-db/files",
    "maxUploadBytes": 268435456,
    "s3": {
      "bucket": "spread-db",
      "endpoint": null,
      "region": "us-east-1",
      "accessKeyId": null,
      "secretAccessKey": null,
      "forcePathStyle": null
    }
  },
  "vector": {
    "enabled": true,
    "field": "_vec",
    "hnsw": {
      "M": 16,
      "efConstruction": 200,
      "efSearch": 0
    }
  },
  "memoryGuard": {
    "enabled": false,
    "limitMb": null,
    "rejectWritesPercent": 85,
    "resumeWritesPercent": 78,
    "checkMs": 1000
  },
  "cluster": {
    "syncMs": 2500,
    "forwardTimeoutMs": 60000,
    "replicationTimeoutMs": 60000,
    "secret": "change-me",
    "hints": {
      "enabled": true,
      "debounceMs": 25,
      "maxScopesPerHint": 128
    },
    "shardMapStore": {
      "mode": "off",
      "prefix": "spread-db",
      "key": "cluster/shard-map.json",
      "s3": {
        "bucket": "spread-db",
        "endpoint": null,
        "region": "us-east-1",
        "accessKeyId": null,
        "secretAccessKey": null,
        "forcePathStyle": null
      }
    }
  },
  "auth": {
    "enabled": true,
    "jwtSecret": "change-me",
    "accessTokenTtlSeconds": 3600,
    "refreshTokenTtlSeconds": 1209600,
    "clockToleranceSeconds": 0,
    "users": [
      {
        "_id": "admin",
        "username": "admin",
        "password": "123",
        "role": "admin",
        "admin": true
      }
    ]
  },
  "persistence": {
    "mode": "off",
    "prefix": "spread-db",
    "flushMs": 5000,
    "opBatchSize": 1000,
    "snapshotMs": 60000,
    "segmentBytes": 16777216,
    "compactJournals": true,
    "snapshotRetention": {
      "keepLatest": 0,
      "keepForMs": 0
    },
    "journalRetention": {
      "keepLatest": 0,
      "keepForMs": 0
    },
    "snapshotDirtyOnly": true,
    "snapshotRole": "primary",
    "restoreMode": "scoped",
    "restoreSnapshotId": null,
    "ack": "memory",
    "localWal": {
      "mode": "off",
      "dir": ".spread-db/wal",
      "fsync": true,
      "flushMs": 0
    },
    "s3": {
      "bucket": "spread-db",
      "endpoint": null,
      "region": "us-east-1",
      "accessKeyId": null,
      "secretAccessKey": null,
      "forcePathStyle": null
    }
  }
}
```

### Config Parts

`node` identifies the peer. `id` must be unique in the cluster, and `url` must be reachable by other peers. CLI flags can override `id`, `url`, and `port`, which lets all peers use one shared config.

`server` controls the local HTTP listener.

`storage` selects the in-memory engine. The runtime default is `shape`. For the current object-store path, set `storage.engine` to `object`; the value directory then pools repeated small values to reduce object memory pressure.

`files` enables object-backed blobs. When set to `s3`, file bytes live in S3 under server-derived per-write keys, while the database stores only a small `_file` metadata object on the wrapping object. If `files.s3` is omitted, the file layer can reuse the persistence S3 settings.

`vector` controls the `_vec` field and HNSW tuning used by vector search.

`memoryGuard` can stop accepting local public writes when RSS crosses the reject threshold, then resume after RSS falls below the resume threshold.

`cluster` controls peer behavior: request forwarding, replication timeouts, anti-entropy sync, hinted pull replication, cluster route authentication, and where the shard map is loaded from.

`auth` enables JWT login and bootstraps the global admin user. Keep `jwtSecret` private.

`persistence` controls S3 journals, snapshots, restore behavior, and optional local WAL acknowledgements.

## S3 Persistence

Persistence is designed around S3. The database writes append-friendly journal segments and periodic snapshots under the configured `prefix`.

At startup, a peer:

1. Loads the shard map.
2. Restores snapshots for owned scopes.
3. Replays journals newer than the restored snapshot.
4. Restores metadata.
5. Rebuilds or warms indexes.
6. Starts persistence, replication, and HTTP interfaces.

At runtime, a peer:

1. Applies writes in memory.
2. Records local WAL entries first when `ack` is `localWal`.
3. Flushes journal segments to S3 asynchronously.
4. Writes snapshots for dirty scopes.
5. Compacts journal history covered by retained snapshots.

Minimal S3 persistence shape:

```json
{
  "persistence": {
    "mode": "s3",
    "prefix": "spread-db",
    "ack": "localWal",
    "localWal": {
      "mode": "on",
      "dir": ".spread-db/wal",
      "fsync": true,
      "flushMs": 0
    },
    "s3": {
      "bucket": "spread-db",
      "endpoint": "https://s3.example.com",
      "region": "us-east-1",
      "accessKeyId": "replace-me",
      "secretAccessKey": "replace-me",
      "forcePathStyle": false
    }
  }
}
```

`ack: "memory"` is fastest but only acknowledges in-memory acceptance. `ack: "localWal"` acknowledges after the local write-ahead log has flushed, which is safer during process failure before the next S3 journal flush.

Restore modes:

| Mode | Behavior |
| --- | --- |
| `scoped` | Restore scopes owned by the current shard map. |
| `reshard` | Scan old persisted shard scopes and redistribute objects through the current shard map. |

`restoreSnapshotId` is normally omitted. Set it only for an intentional restore from a retained snapshot.

## Shards and Replication

The shard map is global. It is not defined per database or per collection.

Each shard has one or more peers. When a shard has one peer, that peer is the only owner for objects assigned to the shard. When a shard has multiple peers, those peers are replicas of the same shard. Any one replica can accept the shard's writes, and the replication scheduler brings the other replicas into convergence.

Replication is scoped by shard. A node only stores and replicates the shards it owns, so adding replicas increases availability and read/write placement options, but it also increases physical memory usage. Logical capacity should count one replica per shard; physical capacity includes every running replica process.

The first reachable peer in a shard is treated as the preferred owner for routed operations. If a request reaches a node that does not own the target object shard, the shard router forwards it to an owning peer. Hinted pull replication then wakes shard replicas quickly after writes, while periodic anti-entropy sync remains as the safety net.

```json
{
  "shards": {
    "shard-0": {
      "peers": [
        { "id": "node-a", "url": "http://localhost:8080" },
        { "id": "node-b", "url": "http://localhost:8081" }
      ]
    },
    "shard-1": {
      "peers": [
        { "id": "node-c", "url": "http://localhost:8082" },
        { "id": "node-d", "url": "http://localhost:8083" }
      ]
    }
  }
}
```

If `cluster.shardMapStore.mode` is `s3`, write the map before starting or restarting peers:

```sh
node scripts/put-shard-map.js --config spread-db.config.json --map shard-map.json
```

If no shard map store is enabled, embed the map under `cluster.shardMap`.

## Cluster Startup

Start multiple peers from the same config and override the local identity:

```sh
node src/index.js --config spread-db.config.json --node node-a --url http://localhost:8080 --port 8080
node src/index.js --config spread-db.config.json --node node-b --url http://localhost:8081 --port 8081
node src/index.js --config spread-db.config.json --node node-c --url http://localhost:8082 --port 8082
node src/index.js --config spread-db.config.json --node node-d --url http://localhost:8083 --port 8083
```

Each peer loads the same global shard map and determines ownership from its node id or URL.

## Indexes

Collection meta controls indexes.

| Index | Used for |
| --- | --- |
| Field index | Equality-style filters, old query planner paths, selected sorted paging. |
| Column index | Numeric aggregate paths such as `$sum`, `$avg`, and count-style summaries. |
| Vector index | `_vec` search using stored client-provided embeddings. |

Index readiness is visible in the admin console cluster status popup.

## Console and Status

The admin console is served by the running node:

```text
http://localhost:8080/
```

It shows:

- Database and collection tree.
- Object list and JSON viewer.
- Collection meta editor.
- Cluster peers and shard state.
- Logical and physical RSS memory.
- Index and vector readiness.
- Replication scheduler state.

The lightweight health check is:

```sh
curl http://localhost:8080/health
```

## Practical Notes

- Prefer `storage.engine: "object"` for the current fast path.
- Use `localWal` acknowledgements when acknowledged writes must survive process failure before S3 journal flush.
- Keep `cluster.secret` identical across peers.
- Keep `forwardTimeoutMs` realistic for heavy shard owners.
- Keep `syncMs` high enough that anti-entropy does not waste work, but low enough to recover from missed hints.
- Upload or embed the shard map before starting peers.
- Restart the whole cluster after planned resharding.
- Avoid repeated meta/index changes during large imports unless rebuild cost is acceptable.
- Watch logical memory for capacity planning; watch physical memory for replica and process pressure.
