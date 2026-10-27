![OBJY DB](https://raw.githubusercontent.com/spoo-technologies/objy-db/main/public/branding/objy-db-header-deep-field.png)

# OBJY DB

<p align="center"><strong>Dynamic objects in memory. Sharded across nodes. Durable in S3.</strong></p>

OBJY DB is a bulk-first database for large, dynamic JavaScript object sets. It combines fast in-memory access with object sharding, replication, indexed queries, and S3-backed recovery.

[Quick start](#quick-start) | [API](API.md) | [JavaScript client](client/README.md) | [Contributing](CONTRIBUTING.md) | [Security](SECURITY.md)

## Quick Start

Install dependencies and start one node:

```sh
npm ci
node src/index.js --config spread-db.config.json --node node-a --url http://localhost:8080 --port 8080
```

Open the admin console at:

```text
http://localhost:8080/
```

On first boot, OBJY DB creates the global `admin` user and prints a generated password once. For unattended first boot, provide it explicitly:

```sh
OBJYDB_ADMIN_PASSWORD="your-initial-password" node src/index.js \
  --config spread-db.config.json \
  --node node-a
```

## What You Get

| Capability | What it means |
| --- | --- |
| Dynamic objects | Collections accept different object shapes and value types without a schema. |
| Bulk-first writes | Storage, routing, replication, persistence, and hooks operate on bounded batches. |
| Object sharding | Objects from every database and collection are distributed by `_id`. |
| Replication | Hinted pull handles the fast path; anti-entropy closes missed gaps. |
| S3 durability | Journals capture changes and snapshots compact durable state. |
| Fast query paths | Field indexes, RID columns, and HNSW vector indexes accelerate different workloads. |
| Memory control | Value dictionaries, typed columns, and compressed-memory tiering reduce resident data. |
| Complete object model | References, files, authentication, permissions, hooks, and aggregation are built in. |
| Simple access | Use the REST API, the browser-ready JavaScript client, or the admin console. |

OBJY DB uses whole-object last-write-wins convergence. Updates replace the replicated object value rather than merging individual fields.

## How It Works

```text
                         +----------------------+
Client ----> any node -->| auth, hooks, routing |
                         +----------+-----------+
                                    |
                          owning object shard
                                    |
                 +------------------+------------------+
                 |                                     |
          in-memory objects                    replica hint
       indexes / columns / vectors                  |
                 |                              peer pulls
                 |
          WAL -> S3 journals -> snapshots
```

Any public node can accept a request. The shard router handles it locally when possible and otherwise forwards it to an owner. Replicas pull acknowledged operations from one another and converge independently.

S3 is the durable source for cluster recovery. A local WAL can protect acknowledged writes before the next asynchronous S3 journal flush.

## Data Model

```text
database
  collection
    meta
    object _id=...
    object _id=...
```

- A **database** is the top-level namespace.
- A **collection** owns objects and a small metadata document.
- An **object** is a dynamic JSON-style record identified by `_id`.

Collection metadata activates derived structures and optional behavior:

```json
{
  "indexes": ["status", "ownerId"],
  "columns": ["score"],
  "tiering": {
    "mode": "compressedMemory",
    "keep": ["name", "status", "ownerId"],
    "minBytes": 4096
  },
  "hooks": {
    "use": ["timestamps"]
  }
}
```

Sharding is global, not configured per database or collection. The tuple `{ database, collection, _id }` deterministically selects an object shard.

## Runtime Architecture

| Layer | Responsibility |
| --- | --- |
| Store | Keeps objects in memory. `object` is the recommended high-throughput engine; `shape` remains available. |
| CRDT node | Applies whole-object writes, clocks, tombstones, and convergence rules. |
| Shard router | Locates object owners and fans operations across shards. |
| Replication scheduler | Coordinates hinted pull and periodic anti-entropy. |
| Persistence manager | Flushes journals, writes snapshots, and restores owned data. |
| Derived structures | Maintains field indexes, RID columns, and vector indexes. |
| Interfaces | Exposes public, cluster, UI, and plugin routes. |

Single-object operations are bulks of one. This keeps the write model consistent from the HTTP boundary down to storage and replication.

## Run a Cluster

Every peer loads the same global shard map and determines ownership from its node id or URL.

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

One peer means one copy of a shard. Multiple peers are replicas of that shard. Any replica can accept writes; the first reachable peer is preferred for routed requests.

When the shard map lives in S3, publish it before starting peers:

```sh
node scripts/put-shard-map.js --config spread-db.config.json --map shard-map.json
```

Then start peers from the same config with individual identities:

```sh
node src/index.js --config spread-db.config.json --node node-a --url http://localhost:8080 --port 8080
node src/index.js --config spread-db.config.json --node node-b --url http://localhost:8081 --port 8081
node src/index.js --config spread-db.config.json --node node-c --url http://localhost:8082 --port 8082
node src/index.js --config spread-db.config.json --node node-d --url http://localhost:8083 --port 8083
```

If no shard-map store is enabled, place the map under `cluster.shardMap` in the config. A node stores and replicates only its owned shards. Replicas improve availability but also consume another full physical copy; logical capacity counts one replica per shard.

Planned shard-count changes use `restoreMode: "reshard"` for the redistribution boot. Return to `scoped` after the new topology is established.

## Durability

S3 persistence uses append-friendly journal segments and periodic snapshots under one configured prefix.

```json
{
  "persistence": {
    "mode": "s3",
    "prefix": "objydb",
    "ack": "localWal",
    "localWal": {
      "mode": "on",
      "dir": ".spread-db/wal",
      "fsync": true
    },
    "s3": {
      "bucket": "objydb",
      "endpoint": "https://s3.example.com",
      "region": "us-east-1",
      "accessKeyId": "replace-me",
      "secretAccessKey": "replace-me",
      "forcePathStyle": false
    }
  }
}
```

| Setting | Behavior |
| --- | --- |
| `ack: "memory"` | Acknowledge after in-memory acceptance. Fastest, but process failure can lose an unflushed write. |
| `ack: "localWal"` | Acknowledge after the local WAL flush. Protects the gap before S3 journal upload. |
| `restoreMode: "scoped"` | Restore only scopes owned by the current shard map. |
| `restoreMode: "reshard"` | Read old shard scopes and redistribute them through a new map. |

On boot, a peer loads shared secrets and the shard map, restores metadata, streams owned snapshot segments, replays newer journals and the optional WAL, then opens the full public server. Objects are readable while derived structures continue warming.

At runtime, dirty scopes produce snapshots and covered journals are compacted according to retention settings. `restoreSnapshotId` is normally omitted and should be set only for an intentional restore from a retained snapshot.

## Query Speed

Collection metadata chooses which derived structure supports a workload:

| Structure | Best for |
| --- | --- |
| Field index | Equality filters, candidate narrowing, grouped values, and indexed sorting. |
| RID column | Compact field storage and `$sum`, `$avg`, `$min`, `$max`, and `$count`. |
| Vector index | HNSW search over client-provided `_vec` embeddings. |

Index and column builds are cooperative same-thread tasks. They yield between bounded batches so the API remains available, but they are not separate worker processes. Queries fall back to correct scan paths while required structures are warming; vector search returns `503` until its index is ready.

The `x-spread-db-query-path` response header shows which path served a query or aggregation.

## Extend OBJY DB

The database keeps core ownership clear:

- **Storage engines** decide how objects live in memory.
- **Interfaces** translate transports into database operations.
- **Object hooks** add application behavior around public CRUD.

Custom storage engines must preserve bulk CRUD, reads, scans, metadata, and derived-state integration. Interfaces should remain thin and leave authentication, permissions, routing, replication, and durability in the database.

### Object Hooks

Hooks are named middleware for create, read, update, and delete. They run once on the accepting node, never during replication or restore. Bulk requests invoke a hook once for the full bulk; NDJSON streams invoke it once per bounded batch.

```js
import { createObjectHookRegistry } from "objydb/hooks";
import { startServer } from "objydb/server";

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

The CLI loads hook modules listed under `plugins`. Paths are relative to the config file, and every public cluster node must register the same hook names.

```json
{
  "plugins": [
    { "file": "./plugins/example.js", "options": {} }
  ]
}
```

Hooks may transform `context.input`, inspect `context.result`, provide a successful `responseOverride`, and validate their collection metadata. OBJY DB revalidates transformed writes before storage.

## Configuration

The default config path is `spread-db.config.json`. Use `--config` to select another file, and override peer-local identity with `--node`, `--url`, and `--port`.

A shared cluster config can stay compact because omitted settings use runtime defaults:

```json
{
  "node": {
    "id": "node-a",
    "url": "http://localhost:8080"
  },
  "server": {
    "port": 8080
  },
  "storage": {
    "engine": "object"
  },
  "memoryGuard": {
    "enabled": true
  },
  "cluster": {
    "syncMs": 2500,
    "forwardTimeoutMs": 60000,
    "replicationTimeoutMs": 60000,
    "shardMapStore": {
      "mode": "off"
    }
  },
  "auth": {
    "enabled": true
  },
  "persistence": {
    "mode": "off"
  }
}
```

| Section | Controls |
| --- | --- |
| `node` | Peer identity, URL, retained operations, and replication batch size. |
| `server` | HTTP port, JSON-body limit, and optional CORS origins. |
| `imports` | Bulk object count, object size, request size, persistence pressure, and retry delay. |
| `storage` | `object` or `shape` in-memory representation and value-directory tuning. |
| `files` | Object-backed blob mode, upload limit, prefix, and optional S3 override. |
| `vector` | Embedding field and HNSW construction/search tuning. |
| `memoryGuard` | Write rejection and recovery thresholds. |
| `cluster` | Forwarding, replication, hints, shared secret, and shard-map storage. |
| `auth` | JWT enablement and access/refresh token lifetimes. |
| `persistence` | S3, WAL, journals, snapshots, retention, acknowledgements, and restore. |
| `plugins` | Code modules loaded before the public server starts. |

OBJY DB generates JWT and cluster secrets and persists them beside durable state. Explicit secrets remain supported and must be identical across peers. The initial global admin password can come from `OBJYDB_ADMIN_PASSWORD`; subsequent boots use the stored user.

The shipped [spread-db.config.json](spread-db.config.json) is a local development baseline. Keep credentials and deployment-specific addresses outside source control.

## Console and Status

Every running node serves the admin console at its root URL. It provides:

- Database, collection, and object management.
- Collection metadata editing.
- Query and aggregation tools.
- Peer and shard topology.
- Logical and physical RSS and heap usage.
- Index, vector, compression, and replication readiness.

The lightweight unauthenticated health route is:

```text
GET /health
```

The authenticated `GET /api/config` route provides compact cluster status, with deeper diagnostics available through `?details=1`.

## Develop

The repository follows the runtime layers:

| Path | Contains |
| --- | --- |
| `src/` | Storage, queries, routing, replication, persistence, auth, and interfaces. |
| `client/` | The browser and Node JavaScript client. |
| `scripts/` | Cluster, shard-map, migration, and operational utilities. |
| `test/` | Unit, integration, sharding, persistence, and failure coverage. |
| `public/` | Admin console and branding assets. |

Keep changes bulk-first and preserve the layer boundaries above. Public HTTP behavior belongs in interfaces; storage engines should not absorb routing or authentication; replication and restore must never execute public object hooks.

## Operating Principles

- Prefer `storage.engine: "object"` for the current high-throughput path.
- Use local-WAL acknowledgements when process-failure durability matters.
- Keep forwarding timeouts realistic for heavily loaded shard owners.
- Let hints handle normal replication and anti-entropy handle recovery.
- Avoid repeated metadata rebuilds during large imports.
- Watch logical memory for capacity and physical memory for replica cost.
- Publish the shard map before peers start, and restart the cluster for a planned reshard.

## Documentation

- [Public REST API](API.md)
- [JavaScript client](client/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [License](LICENSE)
