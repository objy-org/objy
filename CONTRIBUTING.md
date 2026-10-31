# Contributing

Thanks for helping improve OBJY DB. Focused fixes, tests, documentation, and carefully scoped performance work are welcome.

## Before You Start

- Search existing issues before opening a new one.
- Open an issue before substantial architecture or public API work so the direction can be agreed first.
- Keep changes focused, bulk-first, and compatible with dynamic objects.
- Preserve the separation between storage, queries, routing, replication, persistence, and interfaces.
- Do not add compatibility branches or abstractions without a current use.

## Development

OBJY DB requires Node.js 20 or newer.

```sh
npm ci
npm test
```

Add focused tests beside the behavior being changed. The broader suites are selected by impact:

| Change | Required command |
| --- | --- |
| Any runtime behavior | `npm test` |
| Browser runtime, client, or console | `npm run test:browser` |
| Storage, queries, aggregation, indexes, columns, or compression | `npm run test:universal` |
| Exports, package files, release scripts, or metadata | `npm run check:package` |
| Replication, restore, or resharding | Relevant `test:stress:*` command from `package.json` |

Performance changes should include a before/after command and workload. Do not present a single warm run as a general benchmark; see [BENCHMARKS.md](BENCHMARKS.md) for the repository format.

## Pull Requests

- Explain the user-visible behavior and the reason for the change.
- Keep unrelated formatting, generated files, and refactors out of the diff.
- Preserve single-operation-as-bulk-of-one behavior.
- Cover failure paths when changing distributed or durable state.
- Update the relevant public documentation when behavior or configuration changes.
- Confirm that no credentials, local WAL data, S3 data, customer data, or generated caches are included.

Report security issues privately as described in [SECURITY.md](SECURITY.md). By submitting a contribution, you agree that it is licensed under the repository's [MIT License](LICENSE).
