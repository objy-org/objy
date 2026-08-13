# spread-db

An in-memory, sharded, replicated object database for large dynamic object sets.

spread-db is built for plain JavaScript-style objects, fast local reads, bulk-first writes, object sharding, pull-based replication, S3 persistence, and a small admin console. It is intentionally lightweight: no OBJY, no schema-first object model, no hidden application context.

Public REST API usage is documented in `API.md`. This guide is for developing, running, and operating the database itself.

## Why This Exists

spread-db keeps the database model simple:

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
    "accessTokenTtlSeconds": 900,
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
    "flushMs": 1000,
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
