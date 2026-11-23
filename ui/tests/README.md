# Verification

## HTTP integration tests

Run root `npm test` (builds the UI), or `npm run build:ui` then `npm test --workspace=ui`. Tests use disposable loopback, in-memory servers and the official client, then shut down. Session tests add fake-indexeddb.

Coverage includes CRUD, arbitrary JSON, immutable `_id`, native filters/sorting/aggregation/references, metadata, optimistic edit checks, server isolation, failed connection switches, confirmed and uncertain writes, partial collection creation, token rotation, cross-tab locking, rejected credentials, permission failures, failed storage, cluster telemetry and cancellation.

`query-builder.test.mjs` checks real-server all/any filters, five aggregations, JSON types, repeated fields, round trips, unsupported queries, and validation.

File tests cover binary/empty data, authenticated download, field-preserving replacement, stale/missing objects, unavailable storage, and deletion cleanup. Confirmed context deletion clears catalogs even after failed refresh.

`store-refresh.test.mjs` enforces 40 searches/one count for 2,000 objects and no unrelated reloads after writes. It covers page retries, query resets, offset duplicates, scoped errors, and meta updates without page reloads.

## Browser regression tests

Run root `npm run test:ui:manual` (or `npm run test:browser` in `ui/`), open the printed URL, and click **Run checks**. The interactive runner operates production DOM/forms/keyboard handlers in an iframe. A separate loopback origin and disposable authenticated server isolate existing deployments/logins; external URLs are rejected. Assets/API share one proxy, verifying the hosting-server default.

Coverage: connection/reload, paging/selection, drafts/Undo, query shortcuts/errors, server failure/retry, JSON/ID validation, save/meta, deletion, context/object creation, node details, and keyboard/focus. Native text insertion is also checked manually.

Results appear in-page and in the terminal. The server verifies final objects/meta, then stops. Assertions, state mismatches, or timeouts exit nonzero. `tests/browser/` is test-only, excluded from `dist/`.

The 15 flows include builder filters/grouped counts, reopen/cancel, unsupported JSON/focus, upload validation/replacement/cancel, draft guards, download bytes/name, exact-name deletion/cancel, selection/draft cleanup, and unrelated-data protection. Downloads cross the real authenticated API before interception at browser save; the server verifies bytes and deleted-scope cleanup.

The [QA archive](archive/) records older manual checks, including retired UI/AI behavior. Current source/tests define today's implementation, not those reports.

Root Playwright runs this harness in each configured browser, replacing old selectors/localStorage tests. `connection-storage.test.mjs` covers rotation, invalid sessions, and cross-tab races against the real server/client.

Preview checks cover PNG/SVG decoding, PDF pixels/pages, downloads, misleading HTML filenames, broken-image/PDF fallback, URL/canvas cleanup, and early close. HTTP tests verify client cancellation forwarding.
