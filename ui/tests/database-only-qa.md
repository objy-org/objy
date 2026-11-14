# Database-only verification — 2026-11-07

Historical report: the outer sidebar, Data/Chat screens, manual table editor, query/settings screens and Open actions described here were removed on 2026-11-08. See `canvas-qa.md` for the current interface.

## Scope

Removed HTML app creation/editing, source repository and IndexedDB adapter, sandbox runtime, generated-app sidebar/views/layouts, app tools and routing operations, their bundles and obsolete tests/documentation. The browser now exposes only database navigation, Data/Chat, the Data Explorer, object JSON editing, native queries and collection settings. Old saved app records are not accessed or erased. OBJY data remains in memory.

## Deterministic checks

`npm test`: **40/40 passed** using real @objy/db and scripted/native SDK providers. `npm run build:ai`, JavaScript syntax and Git whitespace checks passed. Retired app capabilities are absent from the source registry and built product. The downloadable archive contains neither app-runtime assets nor the local evaluation harness.

## Manual browser checks

Local browser UI: create database and collection; insert two arbitrary JSON objects; inspect JSON; patch nested fields while preserving unrelated values; query a numeric filter; fully replace an object without changing `_id`; delete that object while retaining the other; save/reopen collection metadata; expand the Data Explorer to native object JSON; drop the collection and database. Database session/sidebar state followed deletion correctly. Dark theme and shared sidebar background retained. A request submitted through the actual home composer created inventory/bikes and inserted the requested name/gears/electric object; the chat receipts and Open button led to the correct data table.

## Actual local model

Qwen3 4B, real WebLLM + AI SDK + @objy/db, isolated in-memory evaluation: **8/9 passed on the final run**.

Passed database/collection creation, follow-up bike insertion, correction without duplicate insertion, native read, full replacement, rejecting HTML-app work, targeted deletion and a fresh empty engine.

**Remaining limitation:** the natural-language partial-update scenario did not complete. The model queried no matching objects and repeated the read; the runtime stopped without writing. The native patch method and manual patch UI both passed. This is a model interpretation failure, so the assistant is not claimed to be fully reliable.

Earlier evaluation exposed duplicate correction handling and a count verification incorrectly substituting for a replacement. Routing/execution instructions now preserve the current request and receipts. Object update/delete tasks must query first, can target only returned identities, and cannot finish via a count check. These constraints limit execution; they do not guarantee correct intent interpretation.

The local harness source remains in `tests/browser-eval.js`, built by `scripts/browser-eval.mjs`. Its generated output is excluded from deployment.
