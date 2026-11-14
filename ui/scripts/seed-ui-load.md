# Local UI load dataset

`seed-ui-load.mjs` is bound to the existing local CLI test deployment at `http://127.0.0.1:8179`. It reads that deployment's admin password in memory and uses the official `@objy/client`; credentials are never included in the progress output or dataset manifest.

The target is 100 databases named `ui_load_20261110_001` through `ui_load_20261110_100`, each containing 20 named collections and 2,000 objects: 2,000 collections and 4,000,000 objects total. Existing databases outside that prefix are not modified. Records contain deterministic IDs, names, sequence numbers, status, boolean and numeric fields. Every tenth object includes nested details and tags, allowing JSON editing, filtering and aggregation tests.

Run from the repository root. The test deployment and manifest remain in the original workspace; set its location explicitly:

```sh
export OBJY_TEST_WORKSPACE="/Users/marco/Documents/Codex/2026-11-06/i-am-thinking-about-building-a"
node scripts/seed-ui-load.mjs
node scripts/seed-ui-load.mjs --verify
```

The `$OBJY_TEST_WORKSPACE/outputs/objy-ui-load.json` manifest records ownership, completed databases and server-count verification. An interrupted write is reconciled by existing IDs before resuming; there is no blind write replay. Batches contain at most 1,000 objects. The loader stops at 78% of the server memory guard limit and leaves completed data intact. `--through=10` limits a run or verification to the first ten databases.

For this dataset the existing test deployment was increased from 2 GiB to an 8 GiB heap/memory-guard limit, retaining its original write-rejection thresholds. Original configuration is backed up under `$OBJY_TEST_WORKSPACE/work/objy-test-server/odb-98c29b0766b8/before-ui-load-capacity`. The CLI manages the same server, port and existing local storage. Do not restore the smaller limit while the larger dataset is still loaded.

Example collection queries:

```json
{"status":"active","active":true}
```

```json
{"value":{"$gte":500},"$sort":{"value":-1}}
```

```json
{"$aggregate":{"fields":{"count":{"$count":true},"sum":{"$sum":"value"}}}}
```
