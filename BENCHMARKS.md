# Benchmarks

OBJY DB publishes reproducible server measurements, not cross-product claims. Results describe one machine, one commit, and one workload. Repeat them with the hardware, object shapes, S3 provider, and network topology that matter to your deployment.

## Server Workload

The server workload inserts dynamic objects in bounded batches, then verifies point reads, indexed filters, array containment, sorting, numeric and grouped aggregation, references, vector search, patches, deletes, dirty derived-state fallbacks, and final correctness. It runs against both the source server and the packed npm artifact and requires identical results.

```sh
npm ci
npm run test:scale -- --objects=100000
```

Measured on 2026-10-31 with an Apple M2 Pro, 32 GiB memory, macOS 15.7.7, and Node.js 22.17.1:

| Runtime | Inserts/s | Patches/s | Deletes/s | Point read p95 | Aggregate | Grouped aggregate | Sorted page | Final heap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Source `@objy/server` | 28,313 | 8,689 | 35,087 | 0.397 ms | 12.6 ms | 22.5 ms | 8.2 ms | 236.9 MiB |
| Packed `@objy/server` | 29,529 | 8,469 | 35,888 | 0.384 ms | 12.6 ms | 21.0 ms | 7.6 ms | 236.8 MiB |

The two variants produced the same correctness signature before and after mutation. `Final heap` includes objects, indexes, columns, vectors, compression state, the HTTP runtime, and temporary work. It is not a per-object storage estimate.

Machine-readable reports are written to `.performance-results/`.

## Heavy Correctness Runs

The same development machine completed these million-object checks:

| Scenario | Workload | Measured stages | Result |
| --- | --- | --- | --- |
| Sharding and replication | 1,000,000 objects, 8 shards, 100,000 mutations | Insert 3.84 s; initial replica sync 1.96 s; mutation catch-up 0.47 s | Exact object values and all shard counts matched |
| Persistence and restore | 1,000,000 objects, 1 scope, 5 snapshot segments | Journal writes 7.86 s; snapshot and compaction 1.13 s; restore 2.98 s | Restored count and sampled objects matched |
| Sharded persistence | 1,000,000 objects, 4 shards, 2 replicas per shard | Insert 4.51 s; replica sync 5.04 s; primary checkpoints 1.30 s; fresh replica restore 2.65 s | Every replica contained only its shard and all four counts were exactly 250,000 |
| Restart reshard | 1,000,000 objects, 4 source shards to 6 target shards | Source snapshot 2.35 s; repartitioning restore 16.97 s; finalized-shard replica restore 3.23 s | All objects, target counts, field indexes, and columns matched |

These are deterministic protocol tests using local peers and memory-backed object storage. They include no external S3 or network latency and are correctness and algorithm baselines, not deployment throughput claims.

## Commands

```sh
# Source and packed server with the default workload
npm run test:scale

# One million objects
npm run test:scale:million

# Custom workload
npm run test:scale -- \
  --objects=250000 \
  --batch-size=5000 \
  --point-reads=2000
```

| Command | Exercises |
| --- | --- |
| `npm run test:stress:million` | Million-object sharding, replication, mutations, node failure, recovery, and convergence |
| `npm run test:stress:persistence` | Million-object snapshot, journal, and restore correctness |
| `npm run test:stress:sharded` | Multi-shard, multi-replica durable restore and consistency |
| `npm run test:stress:reshard` | Restart-based topology generation and object redistribution |
| `npm run benchmark:storage` | Object and shape storage-engine comparison |
| `npm run benchmark:tiering` | Full-object versus compressed-memory tiering tradeoffs |

## Reading Results

- Compare identical commits, Node.js versions, configs, object shapes, and warmup state.
- Record p50, p95, and p99 latency; throughput alone hides stalls.
- Measure restore time and post-boot derived-state warmup separately.
- Include replica count when reporting physical memory or write amplification.
- Repeat restore and failure tests against the chosen S3 provider and region.
- Do not extrapolate 100,000-object timings linearly to millions of objects.
