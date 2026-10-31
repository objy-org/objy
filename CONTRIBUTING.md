# Contributing

Thanks for helping improve OBJY DB.

1. Open an issue before substantial architectural work so the direction can be agreed first.
2. Keep changes focused, bulk-first, and compatible with dynamic objects.
3. Preserve the separation between storage, querying, replication, persistence, and HTTP interfaces.
4. Add focused tests for behavior changes and run `npm test`.
5. Run `npm run test:browser` for browser runtime, client, or admin-console changes.
6. Run `npm run test:universal` when changing storage, queries, aggregation, indexes, or other shared database behavior.
7. Run `npm run check:package` when changing exports, runtime files, or package metadata.

Do not commit credentials, generated caches, local persistence data, or customer data. By submitting a contribution, you agree that it is licensed under the repository's MIT License.
