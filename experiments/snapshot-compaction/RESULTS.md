# Snapshot Compaction Comparison

2026-11-17. Isolated experiment against production commit `e5f37106e2c323683b126dd59002167accf141f2`; production source, defaults and installed databases unchanged.

## Workload

- Two million approximately 4.2-KB objects plus 1024 repeatedly replaced objects. Three field indexes, a typed `score` column and compressed object bodies; full objects in S3.
- A fresh serving process restored the fixture and warmed indexes, columns and lazy ID ordering before measurement. No replicas or retained in-memory operation history in either mode.
- Point reads target 20/s, lists of 50 objects target 5/s, NDJSON replacements target 250 objects/s in 100-object requests, with one write request in flight. Acknowledgements follow fsynced local WAL writes. S3 journals flush every five seconds.
- Both modes use 16-MiB JSONL snapshot segments. Order: baseline, compactor, compactor, baseline. The benchmark alone promotes candidates in its disposable bucket; the candidate implementation never publishes a live pointer or deletes inputs.
- The baseline pauses S3 journal flushing during snapshots; the candidate allows it to continue. Results measure both CPU isolation and the reduced journal backlog, not an isolated codec comparison. Achieved write rates were about 235 and 247 objects/s against the same 250/s target, not maximum-throughput measurements.
- Shared 32-GiB macOS host, Node 22.17.1, serving heap limit 8 GiB, child heap limit 512 MiB. Local S3-compatible storage in a disposable container limited to 1 GiB and two CPUs. These are not dedicated-host or remote-S3 timings.

## Measured Results

Values are averages of two per-run measurements, including percentiles; they are **not pooled percentiles**. Peak RSS is sampled, and combined RSS includes the compactor child but excludes the S3 container and load generator.

| Metric | Live-heap baseline | S3 compactor |
| --- | ---: | ---: |
| Point-read median | 13.90 ms | 0.93 ms |
| Point-read p95 | 332.06 ms | 8.54 ms |
| Point-read p99 | 775.84 ms | 321.95 ms |
| 50-object list p95 | 332.80 ms | 15.57 ms |
| 100-object replacement p95 | 321.03 ms | 56.11 ms |
| 100-object replacement p99 | 1001.99 ms | 67.46 ms |
| Serving peak JS heap | 4.50 GiB | 2.84 GiB |
| Combined peak RSS | 5.74 GiB | 4.67 GiB |
| Peak pending journals | 145.26 MiB | 3.71 MiB |
| Snapshot job duration | 149.75 s | 203.87 s |
| Node CPU including API and child | 132.32 CPU-s | 202.42 CPU-s |

The child used 120-123 MiB sampled peak JS heap and 415-460 MiB maximum RSS. Temporary-file peak was about **12 GiB**, with **24.4 GiB of encoded temporary-file writes** per compaction. Those are file bytes, not a measurement of physical SSD writes. Compaction also downloads the previous full snapshot from S3.

### Tail Latency

| Run | Mode | Point p95 | Point p99 | Maximum point latency |
| --- | --- | ---: | ---: | ---: |
| 1 | Baseline | 437.40 ms | 1105.41 ms | 1784.14 ms |
| 2 | Compactor | 7.49 ms | 64.88 ms | 1095.24 ms |
| 3 | Compactor | 9.60 ms | 579.01 ms | 1732.32 ms |
| 4 | Baseline | 226.72 ms | 446.27 ms | 658.16 ms |

The p95 improvement repeats; rare long pauses remain. The host was under memory pressure and using swap. These measurements do not isolate the remaining pauses between GC, paging and other work, and do not justify calling the candidate pause-free.

## Verification Status

- Complete: four timed cases, no request errors; forced child kill after an S3 segment upload, published snapshot unchanged.
- Complete: baseline snapshot plus journals restored through the ordinary reader; all full bodies, field-index counts and grouped/total sums and counts matched the independent fixture.
- Complete: equivalent candidate-plus-journal restore and a fresh candidate snapshot-only restore at revision 88,700. Together the three oracles checked **6,009,072 full object bodies**, plus field-index counts and grouped/total sums and counts.
- Normal restore including index/column warmup took 167.02 s from the baseline and 172.26 s from the candidate in one restore pair. Correctness-oracle work is excluded from those times.
- Focused component tests cover conflicts, stale writes, duplicate operations, deletions, vectors, compressed bodies, columns, multiple scopes, malformed/missing inputs, scratch write failures and large completion messages.
- Final `npm test`: **450/450 passed**, including 23 experiment tests. Package validation passed; no experimental or test files are included in the server package. Disposable processes, containers, volumes, scratch runs and WAL data were removed; reports remain outside the repository.

An **independent existing baseline recovery oracle fails**: received peer operations can be skipped using the receiving node's journal sequence rather than their origin. See `restore-oracle.js` and the README. Single-writer benchmark success does not certify multi-writer recovery.

## Decision

Keep this isolated. It substantially improves common interactive latency and reduces measured peak memory, at the cost of more CPU, longer snapshot jobs, S3 reads and temporary disk work. It does not eliminate all long pauses.

Production adoption still requires the journal-origin recovery fix, durable input ownership/pinning, fenced publication, lifecycle and reshard coordination, retention and disk-exhaustion handling. No new production mode has been enabled.

Two earlier large attempts are excluded: one had incorrect lazy-ordering warmup; another completed output but lost the large IPC completion payload. The harness warmup and completion protocol were fixed, regression-tested and rerun. Only the final four-case run contributes the table above.
