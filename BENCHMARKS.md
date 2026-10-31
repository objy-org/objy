# Benchmarks

OBJY DB publishes reproducible measurements, not cross-product claims. Results here describe one machine, one commit, and one workload. Use the same commands on the hardware and data shapes that matter to your deployment.

## Current Baseline

Measured on 2026-10-31 from commit `7aef7487d4b5` for `0.2.0-alpha.0` (plus documentation-only working-tree changes).

| System | Value |
| --- | --- |
| CPU | Apple M2 Pro, 12 logical CPUs |
| Memory | 32 GiB |
| Architecture | arm64 |
| Operating system | macOS 15.7.7 |
| Node.js | 22.17.1 |
| Browser | Chromium via Playwright |

Command:

```sh
npm ci
npm run test:universal -- --objects=100000 --browsers=chromium
```

The workload inserts 100,000 dynamic objects in batches of 2,000, then verifies point reads, indexed filters, array containment, sorting, numeric and grouped aggregation, references, vector search, patches, deletes, dirty derived-state fallbacks, and final correctness. It configures field indexes, RID columns, a 1,000-vector HNSW index, value dictionaries, and compressed-memory tiering.

## Results

| Runtime | Inserts/s | Patches/s | Deletes/s | Point read p95 | Aggregate | Grouped aggregate | Sorted page | Final heap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Source `@objy/db`, Node.js | 34,354 | 10,369 | 55,765 | 0.017 ms | 14.4 ms | 23.4 ms | 4.6 ms | 177.1 MiB |
| Packed `@objy/db`, Node.js | 33,310 | 9,905 | 46,686 | 0.017 ms | 14.2 ms | 22.7 ms | 4.5 ms | 176.7 MiB |
| Source `@objy/server`, HTTP | 28,313 | 8,689 | 35,087 | 0.397 ms | 12.6 ms | 22.5 ms | 8.2 ms | 236.9 MiB |
| Packed `@objy/server`, HTTP | 29,529 | 8,469 | 35,888 | 0.384 ms | 12.6 ms | 21.0 ms | 7.6 ms | 236.8 MiB |
| Source `@objy/db`, Chromium | 30,272 | 8,418 | 30,303 | 0.100 ms | 9.7 ms | 15.8 ms | 15.4 ms | 239.4 MiB |
| Packed `@objy/db`, Chromium | 30,741 | 8,050 | 27,174 | 0.100 ms | 9.5 ms | 15.6 ms | 10.1 ms | 230.4 MiB |
| Standalone ESM, Chromium | 30,666 | 8,402 | 32,051 | 0.100 ms | 10.0 ms | 17.2 ms | 10.0 ms | 226.9 MiB |

All seven variants produced the same correctness signature before and after mutation. The compressed portion reported roughly 80% byte savings for this deliberately repetitive payload. That percentage is not a whole-process memory reduction and will vary with object shape and tiering policy.

`Final heap` is the runtime heap sample after 5,000 patches and 500 deletes. It includes objects and derived state and is not a per-object storage estimate. Browser heap values come from Chromium's exposed heap metrics; Node.js server figures include HTTP and server-runtime overhead. Sub-millisecond values are sensitive to timer resolution.

## Heavy Correctness Runs

The same machine also completed these million-object checks on 2026-10-31:

| Scenario | Workload | Measured stages | Result |
| --- | --- | --- | --- |
| Sharding and replication | 1,000,000 objects, 8 shards, 100,000 mutations | Insert 3.84 s; initial replica sync 1.96 s; mutation catch-up 0.47 s | Exact object values and all shard counts matched |
| Persistence and restore | 1,000,000 objects, 1 scope, 5 snapshot segments | Journal writes 7.86 s; snapshot and compaction 1.13 s; restore 2.98 s | Restored count and sampled objects matched |
| Sharded persistence | 1,000,000 objects, 4 shards, 2 replicas per shard | Insert 4.51 s; replica sync 5.04 s; primary checkpoints 1.30 s; fresh replica restore 2.65 s | Every replica contained only its shard and all four counts were exactly 250,000 |
| Restart reshard | 1,000,000 objects, 4 source shards to 6 target shards | Source snapshot 2.35 s; repartitioning restore 16.97 s; finalized-shard replica restore 3.23 s | All objects, target counts, field indexes, and columns matched |

These are deterministic, in-process protocol tests using local peers and memory-backed object storage. They include no network or external S3 latency and should be read as correctness and algorithm baselines, not deployment throughput.

## Reproduce and Scale

Run all supported source and package variants:

```sh
npm run test:universal
```

Run the million-object universal workload:

```sh
npm run test:universal:million
```

Select variants or tune the workload without editing source:

```sh
npm run test:universal -- \
  --objects=250000 \
  --batch-size=5000 \
  --point-reads=2000 \
  --browsers=chromium
```

Machine-readable reports are written to `.performance-results/`. The directory is ignored by Git so each report describes the local run that produced it.

## Stress Suites

The stress programs focus on correctness and failure behavior at large object counts. Their defaults are intentionally heavy.

| Command | Exercises |
| --- | --- |
| `npm run test:stress:million` | Million-object sharding, replication, mutations, node failure, recovery, and convergence |
| `npm run test:stress:persistence` | Million-object snapshot, journal, and restore correctness |
| `npm run test:stress:sharded` | Multi-shard, multi-replica durable restore and consistency |
| `npm run test:stress:reshard` | Restart-based topology generation and object redistribution |
| `npm run benchmark:storage` | Object and shape storage-engine comparison |
| `npm run benchmark:tiering` | Full-object versus compressed-memory tiering tradeoffs |

The persistence stress suites use deterministic in-process object-storage adapters unless a script explicitly configures an external service. They validate the persistence protocol without claiming real S3 network throughput. Production evaluation should repeat restore and failure tests against the chosen S3 provider, region, object count, and latency profile.

## Reading Results

- Compare identical commits, Node.js versions, configs, object shapes, and warmup state.
- Record p50, p95, and p99 latency for service workloads; throughput alone hides stalls.
- Measure restore time and post-boot derived-state warmup separately.
- Include replica count when reporting physical memory or write amplification.
- Treat browser and HTTP results as separate environments, even when they share the same database core.
- Do not extrapolate 100,000-object timings linearly to millions of objects without running the larger workload.

Benchmark changes are welcome when they stay deterministic, verify correctness, and produce machine-readable output.
