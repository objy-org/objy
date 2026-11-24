# Live Resharding Validation

Local results for the `live-resharding` branch, compared with
`main` at `29054537316f2c00a0ae569aea4194ff5fe5df99`.
Node.js 22.17.1, macOS arm64, 32 GiB RAM. These are reproducible development
measurements, not deployment guarantees or cloud-S3 throughput claims.

## Real Processes and S3

```sh
npm run build:ui
npm run test:stress:live -- --objects=1000000 --replicas=2
```

The harness creates its own disposable MinIO container, bucket, ephemeral ports,
and WAL directories. It does not use an existing database. Here `--replicas=2`
means two total copies per shard: one primary and one replica.

Workload: one million dynamic objects, roughly 512 bytes of cold payload plus
other fields, two field indexes, one numeric column, compressed-memory tiering,
and cross-collection references. Inserts use NDJSON batches of 2,000 and local-WAL
acknowledgement; S3 journals flush every five seconds. Automatic snapshots are
disabled to isolate migration's own checkpoints. Each node has a 2 GiB JS heap
limit; the memory guard is disabled for this stress test.

| Phase | Final run |
| --- | ---: |
| Initial six-process startup | 1.37 s |
| Insert 1,000,000 indexed objects | 98.53 s |
| Grow from two to three shards, including failed destination and retry | 97.26 s |
| SIGKILL and restore all six processes | 60.68 s |
| Shrink from three to two shards | 61.78 s |

During growth a destination is killed, commit must remain blocked, and the same
map is retried after restarting it. Another client updates 2,000 objects during
copying. After insertion, growth, whole-cluster crash recovery, and shrink,
grouped count/sum/min/max are compared with an independent oracle through every
node. Each verification also reads 100 sampled full objects and references.
All checks passed. A previous complete million-object run also passed.

The growth probe reads `object-42` every 20 ms through one node; it is not a
random-query throughput benchmark. Of 3,536 requests, 104 were temporarily
unavailable. Successful responses measured p50 3.29 ms, p95 14.26 ms,
p99 51.72 ms, and maximum 408.06 ms. Error responses are excluded from these
latency percentiles, not from the unavailable count.

One-second resource sampling across all six processes recorded approximately
5.3 GiB RSS and 5.8 GiB heap used at their respective sampled peaks. Summed
OS-reported CPU reached 514% (roughly five cores). These are not retained-data
sizes or hard upper bounds. macOS memory compression, GC timing, indexes, copies
in flight, and sampling affect the numbers; RSS and heap used are not additive.
After shrink, removed processes were still running for the routing checks.

Without replicas, the same failure/grow/crash/shrink scenario also passed with
100,000 objects and three processes (`--replicas=1`): insert 12.01 s,
growth 6.10 s, crash restore 4.02 s, shrink 3.51 s.

## Normal CRUD Cost

Run on an otherwise idle test workload, alternating unchanged and modified code
three times each:

```sh
node benchmarks/server.js --variants=source-server \
  --objects=100000 --point-reads=500 --payload-bytes=512
```

The existing server benchmark verifies field indexes, columns, compression,
references, vectors, mutation results, and dirty versus settled query results.

| Median of three runs | Before | After |
| --- | ---: | ---: |
| Insert throughput | 24,615 objects/s | 24,072 objects/s |
| Point-read p95 | 0.409 ms | 0.405 ms |
| Point-read p99 | 0.973 ms | 1.156 ms |
| Heap after mutations | 269.14 MiB | 269.22 MiB |

Median insert throughput was 2.2% lower, with effectively unchanged measured
heap. Insert throughput ranged from 24,446-24,639 objects/s before and
21,864-24,771 after; three local runs cannot establish a universal overhead.
These measurements concern normal CRUD, not migration under load.

## Correctness and Limits

Focused tests cover exact object placement and full-object restore; writes and
deletes from replicas during copying; stale topology rejection; transfer,
checkpoint, publication and acknowledgement failures; coordinator/destination
restarts around commit; replica bootstrap; post-migration snapshots; and streamed
CRUD spanning handover. References, vectors, attachments, hooks, structure,
password hashes, JWT renewal, and permissions are exercised without special
migration transformations.

The source map remains authoritative until durable commit. Copying reuses the
object store and bounded bulk LWW merge, not a second local storage engine.
Target snapshots and journal tails must be durable before ownership switches.

- Handover temporarily rejects API requests; there is no zero-downtime promise.
- All source and target participants must acknowledge. One unavailable node can
  stop completion. The administrative primary must remain the same.
- One migration is allowed at a time. Retry the same desired map after failure;
  there is no automatic primary election or migration cancellation.
- Context creation, deletion and metadata changes wait during migration.
- The first live change converts modulo routing to Jump Consistent Hashing;
  it may move substantially more data than subsequent append/tail changes.
- Hashing balances key counts, not bytes. Memory-aware balancing is not included.
- Each topology generation writes complete target checkpoints. Old S3 generations
  remain retained; moving only a fraction of keys does not mean only that fraction
  of snapshot bytes is written.
- Incoming copies and journal tails need headroom. Retired object payloads are
  removed, but reusable ID/RID slots remain until restart.

These tests do not prove correctness under every possible failure. Repeat them
against the intended S3 provider, object sizes, network, and sustained workload
before enabling live changes in a customer cluster.

Final regression checks passed: all 577 tests in `npm test`, nine UI browser
tests, package checks and isolated installation, the 100,000-object source/packed
server benchmark, and the existing 100,000-object stopped-cluster 4-to-6-shard
restore/index/column regression.
