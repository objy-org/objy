# Verification

## HTTP integration tests

Run `npm test` at the repository root (includes the UI build), or `npm test --workspace=ui` after `npm run build:ui`. These tests use disposable loopback instances of this repository’s server source and the official `@objy/client` over HTTP. Objects stay in memory; each server shuts down after its tests. Saved-session tests use fake-indexeddb with the real server and client.

Coverage includes CRUD, arbitrary JSON, immutable `_id`, native filters/sorting/aggregation/references, metadata, optimistic edit checks, server isolation, failed connection switches, confirmed and uncertain writes, partial collection creation, token rotation, cross-tab locking, rejected credentials, permission failures, failed storage, cluster telemetry and cancellation.

`query-builder.test.mjs` runs generated all/any filters and all five aggregation functions through the real server and official client. It also checks JSON types, repeated fields, round trips, unsupported-query preservation and invalid values.

File tests check binary and empty attachments, authenticated SDK download, replacement preserving object fields, stale/missing object protection, unavailable blob storage, and blob cleanup after object/collection/database deletion. Confirmed scope deletion removes local catalog entries even when refresh fails.

`store-refresh.test.mjs` enforces request budgets: 2,000 objects require 40 searches and one count; a write does not reload unrelated collections or catalog lists. It also checks failed-page retries, changed query resets, duplicate IDs under concurrent offset changes, scoped refresh errors and metadata updates without object reloads.

## Browser regression tests

Run root `npm run test:ui:manual` (or `npm run test:browser` from `ui/`), open the printed localhost URL and click **Run checks**. The runner loads the actual production build in an iframe and operates its DOM controls, forms and keyboard handlers. It uses a new, authenticated disposable in-memory server and a separate loopback origin, so it cannot access the existing CLI deployment or its saved browser connection. The proxy forwards both built assets and API calls to that one server; the suite verifies the default hosting-server URL. No external server URL is accepted. This is an interactive browser runner, not a headless CLI test.

The suite covers connection, incremental paging, object selection, drafts across collection switches, Undo, multiline query shortcuts, malformed queries, injected server failure and retry, JSON/ID validation, save, metadata, delete confirmation, database/collection/object creation, node details, keyboard focus return and connection restoration after reload. Keyboard events exercise the handlers; native text insertion is also checked manually in the local UI.

Results appear in the page and terminal. The server independently verifies the resulting objects and metadata, then shuts down. The process exits nonzero on a failed assertion, mismatched server state or timeout. The HTML/JS runner lives in `tests/browser/` and is served only by this test command; it is not included in `dist/`.

The 15 browser flows also cover the query builder's filter rows, grouped counts, reopening, cancellation, unsupported JSON and focus return; upload validation, attachment replacement/cancellation, dirty-editor guards, download bytes and filename, exact-name scope deletion confirmation/cancellation, selection cleanup, draft cleanup and protection of unrelated data. The file download is captured at the browser save boundary; its contents still come from the real authenticated client/server. The server independently checks resulting file bytes and deleted-scope blob cleanup.

The earlier `*-qa.md` files record manual checks of previous versions; some describe retired UI or AI behavior. Current source and these executable tests define the current implementation.

The root Playwright suite runs this same harness in each configured browser for CI; the old console selectors and localStorage-session tests have been replaced. Token rotation, invalid sessions and cross-tab races remain covered by `connection-storage.test.mjs` against the real server and official client.

Preview coverage checks PNG/SVG decoding, actual PDF canvas pixels and multipage navigation, explicit downloads, unsupported HTML with a misleading image filename, broken-image/PDF fallback, object URL and canvas cleanup and closing before the request completes. The HTTP tests also verify cancellation is forwarded through the official client.
