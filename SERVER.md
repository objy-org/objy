# OBJY DB Server

**Turn the same in-memory object database into a shared, durable, distributed service.**

`@objy/server` wraps `@objy/db` with HTTP, authentication, files, persistence, routing, replicas, and administration. The object model and query language stay the same.

[Overview](README.md) · [Database guide](DB.md) · [HTTP API](API.md) · [JavaScript client](https://github.com/objy-org/objy-client)

## Deploy

The recommended path is the deployment CLI:

```sh
npm install --global @objy/cli
objy deploy local --name dev --size tiny
```

The CLI downloads and verifies the latest published server release, provisions the runtime, and prints the server URL and initial administrator credentials. It pins that release to the deployment, so later starts do not upgrade silently.

```sh
objy status dev
objy logs dev --follow
objy restart dev
objy stop dev
```

Applications connect through [`@objy/client`](https://github.com/objy-org/objy-client) or the [HTTP API](API.md).

<details>
<summary><strong>Embed the server in another Node.js process</strong></summary>

```sh
npm install @objy/server
```

```js
import { startServer } from "@objy/server";

const runtime = await startServer({ port: 8080 });
console.log(`OBJY DB listening on http://127.0.0.1:${runtime.port}`);
```

The server package intentionally contains no command-line executable. Process management and infrastructure provisioning belong to `@objy/cli`.

</details>

## What the Server Adds

| Layer | Responsibility |
| --- | --- |
| Public interface | REST, admin console, files, and plugins |
| Security | JWT sessions, database users, permissions, and cluster-route secrets |
| Routing | Accept work on any node and forward it to object-shard owners |
| Replication | Hinted pull for fast delivery and anti-entropy for repair |
| Durability | Local WAL acknowledgements, S3 journals, snapshots, and restore |

Single and multi-object writes enter the same storage path. Hooks run once on the accepting node and never during replication or restore.

## Durability

Memory serves reads and writes. The local WAL protects acknowledged operations, while S3 stores journals and complete-object snapshots for cluster recovery.

```text
client -> auth and routing -> owner memory -> local WAL
                                  |              |
                                  |              +-- durable acknowledgement
                                  +-- replicas pull
                                  +-- S3 journal -> snapshot
```

A compact durable configuration:

```json
{
  "node": {
    "id": "node-a",
    "url": "https://node-a.example.com"
  },
  "server": {
    "port": 8080
  },
  "memoryGuard": {
    "enabled": true
  },
  "persistence": {
    "mode": "s3",
    "prefix": "objydb-production",
    "ack": "localWal",
    "localWal": {
      "mode": "on",
      "dir": "/var/lib/objydb/wal",
      "fsync": true
    },
    "s3": {
      "bucket": "objydb-production",
      "endpoint": "https://s3.example.com",
      "region": "us-east-1",
      "accessKeyId": { "fromEnvironment": "OBJYDB_S3_ACCESS_KEY_ID" },
      "secretAccessKey": { "fromEnvironment": "OBJYDB_S3_SECRET_ACCESS_KEY" }
    }
  }
}
```

Use a unique S3 prefix for every installation and place the WAL on durable node-local storage.

### Acknowledgement Modes

| Mode | A successful response means |
| --- | --- |
| `ack: "memory"` | The owner accepted the write in memory. A process or host failure can lose an unflushed write. |
| `ack: "localWal"` | The owner appended and flushed the operation to its local WAL. |

With `fsync` enabled, `localWal` pays local storage latency for process-failure protection. It does not wait for every replica or for S3.

<details>
<summary><strong>Journals, snapshots, and retention</strong></summary>

- Journals receive bounded operation batches asynchronously, every five seconds by default.
- Dirty primary scopes produce full-object snapshots every 60 seconds by default.
- A successful snapshot removes journals already covered by its cursors.
- Snapshot retention is opt-in through `snapshotRetention.keepLatest` or `keepForMs`.
- `restoreSnapshotId` is only for an intentional restore to a retained snapshot.
- Indexes, columns, and vector indexes are derived in memory and are not stored in snapshots.

</details>

## Readiness

A durable node starts in phases:

1. Load configuration, shared secrets, and the active shard map.
2. Expose `/health` while restoring owned metadata, snapshot segments, newer journals, and the local WAL.
3. Open the public API after all owned objects are readable.
4. Start replication and persistence schedules.
5. Warm field indexes, columns, and vectors in bounded cooperative tasks.

Data routes return `503` during object restore. After the API opens, ordinary queries use correct scan fallbacks while derived structures warm. Vector search returns `503` until its index is ready.

## Clustering

Sharding is global. The tuple `{ database, collection, _id }` selects an object shard, and the shard map assigns peers to it. Every peer holds the same map and stores only the shards it owns.

Replicas improve availability and failure tolerance. They do not increase logical capacity because every replica stores another physical copy of its shard.

Managed deployments create and distribute the topology through `@objy/cli`.

<details>
<summary><strong>Configure a cluster manually</strong></summary>

```json
{
  "cluster": {
    "shardMap": {
      "shards": {
        "shard-0": {
          "peers": [
            { "url": "http://node-a:8080" },
            { "url": "http://node-b:8080" }
          ]
        },
        "shard-1": {
          "peers": [
            { "url": "http://node-c:8080" },
            { "url": "http://node-d:8080" }
          ]
        }
      }
    },
    "shardMapStore": {
      "mode": "off"
    }
  }
}
```

This topology has two logical shards and two physical replicas per shard.

For a durable cluster, store the shard map in the same S3 service and publish it before starting peers. From a source checkout:

```sh
node scripts/put-shard-map.js --config objydb.config.json --map shard-map.json
```

Packaged deployments can publish the same map through their provisioning tooling. Peers may share one config while overriding local identity:

```sh
node src/index.js --config objydb.config.json --node node-a --url http://node-a:8080 --port 8080
```

</details>

### Routing and Replication

Any public node can receive a request. It handles owned objects locally, forwards other object work to an owner, and fans queries or aggregations across required shards in parallel.

Replication is asynchronous and pull-based:

1. A write records an operation and hints the shard's peers.
2. Replicas pull missing bounded batches.
3. Periodic anti-entropy closes gaps after lost hints or temporary outages.
4. Whole-object last-write-wins ordering resolves concurrent versions.

OBJY DB has no multi-object transactions or linearizable cross-shard read snapshots. A local-WAL acknowledgement protects the handling node's operation; replication converges afterward.

## Operations

### Pressure and Failure

| Situation | Server behavior |
| --- | --- |
| Non-owner receives a request | It forwards to an owner with a bounded timeout. |
| Replica is temporarily offline | Available owners continue; the replica catches up after returning. |
| S3 is unavailable | Memory and the local WAL continue until persistence pressure reaches its configured limit. |
| Memory threshold is crossed | New writes receive `507` and `Retry-After`; reads remain available. |
| Index is warming | Correct scan paths remain available; vector search waits with `503`. |
| Process exits after WAL acknowledgement | The WAL is replayed before the node becomes ready. |

Treat long replica outages as durable restore events rather than relying only on the short retained in-memory operation log.

### Memory

One copy of every shard represents logical capacity. Each replica adds another physical copy, including indexes, columns, vectors, and temporary build state.

Set the Node.js heap below the VM or container limit, leave room for native allocations and V8 reserve, and enable the memory guard in bounded environments. Use NDJSON and bounded client batches for large HTTP imports.

### Observe

```text
GET /health
GET /api/config
GET /api/config?details=1
```

`/health` is lightweight and unauthenticated. `/api/config` requires a global administrator and returns compact topology, memory, restore, replication, and readiness information. Load `?details=1` for diagnosis rather than high-frequency polling.

Watch for missing shard owners, memory near the guard threshold, derived structures that never become ready, growing persistence or replication lag, and repeated pull or S3 failures. A transient pull error alone does not prove data loss.

### Stop and Upgrade

`objy stop` sends `SIGTERM`. `SIGINT` and `SIGTERM` trigger graceful shutdown: stop replication, close HTTP intake, flush the local WAL and pending S3 journals, then exit. Avoid `SIGKILL` during normal operation or topology changes.

Upgrade redundant clusters one replica at a time. Verify health, object counts, catch-up, and representative queries before continuing.

### Change the Topology

Replica membership changes retain the partition topology. A shard-count change performs a coordinated restart-based reshard:

1. Gracefully stop every peer and flush durable writes.
2. Publish the desired shard map.
3. Start target peers against the same S3 namespace.
4. Restore the source generation and repartition objects into target shards.
5. Write a durable checkpoint for every target shard.
6. Activate the new topology only after every target shard is ready.

Resharding requires S3 persistence, an S3 shard-map store, temporary space for both generations, and enough memory for every target shard. Live resharding is not implemented yet.
