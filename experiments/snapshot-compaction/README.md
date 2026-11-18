# S3 Snapshot Compaction Experiment

An isolated comparison against the existing live-heap snapshot writer. No production runtime imports this directory. No default configuration, API or acknowledgement behavior changes.

```sh
# Focused correctness and injected-failure tests
node --test test/snapshot-compaction.test.js

# Small real-S3 smoke test
node experiments/snapshot-compaction/benchmark.js --objects=20000 --order=baseline,compactor

# Repeated large comparison, in ABBA order
node experiments/snapshot-compaction/benchmark.js --objects=2000000
```

The benchmark requires Docker. It creates and removes its own S3-compatible container and volume, uses random loopback ports, and never opens an existing installation. Reports and process logs remain in the printed temporary directory. The fixture has three field indexes, a typed column, compressed object bodies, concurrent public reads/lists and NDJSON replacements with fsynced local-WAL acknowledgements.

## Candidate

1. Capture a durable journal cut using the existing persistence flush path.
2. Read the previous snapshot and selected journal operations from S3, in another process.
3. Sort bounded runs on private temporary disk and merge them with bounded fan-in.
4. Resolve bounded batches through the existing store, with indexes, columns, compression and vectors disabled. Vector values remain ordinary persisted fields.
5. Write full-object JSONL segments and a staged manifest using the existing snapshot format.

One ID's history is never split across independent reducers. Long histories are applied incrementally rather than held in memory. Default encoded-data limits are 16 MiB per sort run, 16 MiB per output segment and 8 MiB per input record. These are not exact RSS caps: parsed objects, stream buffers and the runtime also use memory. The child process has a separate 512-MiB V8 heap limit. Temporary disk use grows with input size.

## Safety And Limits

The candidate **never updates `latest.json`, deletes S3 inputs or runs automatic retention**. It rejects changed snapshot/catalog guards and active resharding. Guard checks are conservative staging checks, not a production publication lock; they do not provide atomic protection against deletion/recreation or topology races.

The benchmark alone promotes results inside its disposable bucket to exercise the unmodified restore reader. It also kills a compactor after a segment upload, then verifies recovery from the unchanged published snapshot and journals. Source snapshots and journals are retained throughout all benchmark rounds.

Before production adoption, input pinning, fenced publication, lifecycle/reshard coordination, retention and disk-space exhaustion policy still require integration and failure testing. JSONL inputs only; this experiment does not migrate legacy JSON arrays. It is not an alternative persistence mode available to users.

### Existing Recovery Blocker

`node experiments/snapshot-compaction/restore-oracle.js` currently fails on the unmodified production implementation: a received peer operation is journaled under the receiver's name, and restore can incorrectly skip it using the receiver's snapshot sequence. This is independent of the compactor and must be fixed before claiming multi-writer recovery safety. The large comparison is a single-writer experiment, not a certification of distributed recovery.

Remove this directory and `test/snapshot-compaction.test.js` to remove the experiment completely.
