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

## Extended Load and Failure Tests

A subsequent test-only pass kept runtime code unchanged at `0ca2ce8`.
Five additional focused regressions passed: lost ingest acknowledgements,
coordinator/source restarts after copying with replica-origin writes and
tombstones, concurrent topology submissions, and mixed column types across
repeated live changes. The complete suite passed **582 tests**.

The extended process harness keeps the seeded dataset immutable and continuously
checks exact indexed equality, array membership, column-range/sort queries,
grouped count/sum/avg/min/max, and (in the later runs) offset and aggregation
paging. Two writers create, replace, patch and delete separate objects in the
same collection, using NDJSON batches of 20. Fixed-result oracles therefore stay
valid while indexes and columns receive mutations; no snapshot isolation is
assumed for aggregates over changing rows.

`--profile=indexed` allows one large query at a time, plus independent point and
vector readers and two writers. The default mixed profile runs the large-query
readers concurrently and also includes a cold-field grouping scan. Writers use
one entry node unless `--writer-routing=round-robin` is selected; routing can
still fail over to another physical replica. Transient errors are counted, not
silently counted as successful requests. The harness can retry a failed map
submission twice, recording those retries.

### Completed Runs

| Dataset and disturbance | Grow | All-process crash restore | Shrink | Result |
| --- | ---: | ---: | ---: | --- |
| 100,000 objects, six processes, coordinator killed during copy | 27.98 s | 10.90 s | 9.23 s | Passed |
| 100,000 objects, six processes, S3 paused for 3 s during copy; index/column meta changed under load; snapshots every 5 s | 17.30 s | 8.99 s | 9.33 s | Passed |
| 100,000 objects with approximately 4 KiB cold payloads, three processes, no replicas, source killed after partial copy | 19.24 s | 8.43 s | 10.13 s | Passed |

All completed runs matched the fixed query/aggregation oracles and final mutable
state. The storage-pause and large-object/no-replica runs additionally compared
**every surviving mutable object and every deleted mutable ID**, in bounded
batches through every node, after growth, crash recovery, and shrink. They
finished with 6,850 and 6,360 surviving mutable objects respectively, and the same
number of deleted IDs. The coordinator run used sampled full mutable-object
reads plus complete mutable group/count/sum/min/max/avg checks.

Successful responses during active copying in the storage-pause/rebuild run
measured point-read p95 30.5 ms, grouped-aggregation p95 95.7 ms, aggregation-page
p95 38.6 ms, and offset-page p95 73.6 ms. Planner headers confirmed `index-full`,
`index-partial`, `aggregate-group-forward-index`, `aggregate-group-index`, and
`vector-index` paths across the completed workloads. Correct results also
survived temporary scan fallbacks. These small-run timings do not predict
million-object performance.

### Failed Runs and Open Findings

**Sustained million-object workload: not a pass.** With six processes, one large
query at a time and continuous NDJSON CRUD, migration exceeded the harness's
15-minute deadline while still catching up. Base delivery took approximately
639 seconds and sent 1,380,584 replica-copy records, including mutable rows.
Catch-up had run for another 261 seconds when the test stopped. All six processes
were alive and there were no fixed-data oracle mismatches before timeout, but
ownership had not committed. Post-commit crash recovery and shrink were therefore
**not executed in this run**.

| Successful response p95 | Before migration, with workload | During base copying |
| --- | ---: | ---: |
| Point read | 566 ms | 757 ms |
| Indexed equality/list | 99 ms | 218 ms |
| Column range/sort | 579 ms | 724 ms |
| Grouped aggregation | 775 ms | 1,141 ms |
| Filtered grouped aggregation | 1,308 ms | 2,437 ms |
| Insert, 20-object batch | 1,019 ms | 1,173 ms |

The grouped paths were genuinely `aggregate-group-forward-index` and
`aggregate-group-index`; the slow results cannot simply be dismissed as an
unindexed workload. During copying, point-read median was 3.86 ms but p99 was
1,535 ms, demonstrating long latency tails. Sampled aggregate peaks were about
6.4 GiB RSS, 7.3 GiB heap used and 651% OS-reported CPU. The pre-migration window
lasted only ten seconds, so its sparsely sampled query percentiles are descriptive,
not statistically strong before/after estimates.

An earlier, more concurrent million-object saturation run also failed before
commit: a catalog control request returned `fetch failed`. Queries launched
before migration already exhibited multi-second delays. Its connection failure
was not conclusively diagnosed; do not label it an OOM or a provider problem.

**Replicated source-failure final-state oracle: failed.** In a 100,000-object,
two-copies-per-shard run, the source was killed after the new destination had
received 525 physical rows. Growth completed in 25.06 seconds. Fixed-data query
oracles remained correct, but the settled mutable aggregate had 19 groups rather
than the client's expected ten. A diagnostic query observed ten objects still
in the original create-state group range. The immutable-data checks do not turn
this mutable-state mismatch into a pass. The failed run did not proceed to
whole-cluster restart or shrink.

The source-failure case was repeated with complete physical-object comparisons
before aggregation. It failed again: a direct-read object contained replacement
values where the oracle expected its subsequent patch. Additional direct GETs
confirmed original create values for other IDs, including IDs expected to be
deleted. This is not merely stale group-index output.

Target S3 journals contained the following distinct operations for one such
object, `traffic-274-13` (duplicate persisted copies omitted):

| Origin | CRDT version | Stored operation value: kind / score |
| --- | --- | --- |
| `stress-2` | `{ c: 54545, n: "stress-2" }` | replacement: `130 / -574` |
| `stress-2` | `{ c: 54565, n: "stress-2" }` | patch: `130 / -567` |
| `stress-3` | `{ c: 56585, n: "stress-3" }` | original create-shaped value: `113 / 287` |

Direct GET returned `113 / 287`. The replacement and patch were not missing from
durable journals: the create-shaped operation originated on the fallback replica
with a larger version and won under LWW. The forwarding/retry and version-ordering
trace still needs isolation to explain exactly how that later-version create
was produced. No runtime fix was made or claimed.

Separately, the existing cross-replica LWW policy was reproduced on both this
branch and unchanged `main`, without migration: advance node A's clock with
unrelated writes, create an object on A, replace it on an unsynchronized B, then
synchronize. The earlier A value wins if its CRDT timestamp is larger. Sequential
client requests across replicas do not establish causal/session ordering. This
is consistent with the version-ordering concern above, but is not proof of that
run's exact HTTP retry/forwarding sequence.
The round-robin writer variant also failed its final-state oracle; a stable entry
node avoids that baseline variant but does not prevent physical replica failover.

**ANN recall is not exact correctness.** On the deliberately isolated-vector
dataset, one run retrieved the exact nearest vector in only 4/20 pre-migration
queries, and another post-restart phase retrieved it in 0/4. A different million
run retrieved it in all 955 successful queries. These differences precede or span
random HNSW rebuilds and are not evidence that stored embeddings changed. Returned
IDs, scores and ranking passed their strict checks; recall variability remains a
quality concern. The harness records recall separately rather than assuming an
approximate index always returns the exact nearest neighbour.

### Reproduce

```sh
# Sustained million-object workload: completion-budget failure described above
node stress/live-resharding.js --objects=1000000 --replicas=2 --mixed=true --profile=indexed --failure=false

# Coordinator crash with live traffic
node stress/live-resharding.js --objects=100000 --replicas=2 --mixed=true --profile=indexed --fault=coordinator

# Source crash with replicas: final-state mismatch described above
node stress/live-resharding.js --objects=100000 --replicas=2 --mixed=true --profile=indexed --fault=source

# Storage outage plus metadata rebuild and periodic snapshots
node stress/live-resharding.js --objects=100000 --replicas=2 --mixed=true --profile=indexed --fault=storage --rebuild=true --snapshot-ms=5000

# Larger objects, source crash, no replicas
node stress/live-resharding.js --objects=100000 --replicas=1 --payload=4096 --mixed=true --profile=indexed --fault=source
```

These results support the tested index/aggregation arithmetic and several recovery
flows, but are **not an all-clear for live resharding under sustained million-object
load or client-order preservation across replica failover**. No runtime fixes were
made during this pass. Disposable processes, S3 containers and WAL files were
removed; measurement reports and process logs remain in the harness's temporary
report directories.
