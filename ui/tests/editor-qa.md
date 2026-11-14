# Object and metadata editing — 2026-11-10

## Checks

- `npm test`: **68/68 passing**. New real-HTTP integration cases verify full JSON replacement by immutable ID, key-order-independent snapshot checks, rejection of stale saves/deletes, deletion of exactly one selected ID, and native metadata round-trips/conflicts.
- Browser build, JavaScript syntax checks and `git diff --check` passed.
- Actual local browser testing used the official OBJY client against a separate, disposable in-memory server. No objects were modified on the user's CLI test server.

## Browser results

1. Object rows show `bike-001`, `bike-002`, etc. as titles and compact escaped JSON underneath. The preview excludes the repeated `_id` and truncates visually with an ellipsis.
2. The selected object opens in an editable JSON textarea. Save and Undo enable when edited.
3. Invalid JSON and changed `_id` values were rejected inline, retaining the draft. Undo restored the loaded object.
4. An unsaved draft survived selecting another object and returning.
5. Save changed the same server object and updated its preview. An independent official-client read verified the saved value.
6. Collection metadata opened from the small button beside the object count/add control. Edited metadata was saved, verified independently, and restored after a page reload. Invalid metadata JSON was rejected; Undo restored the loaded value and cleared the error.
7. Delete displayed an inline confirmation, removed only the disposable selected object, updated the count, and cleared the JSON pane. Independent server reads confirmed the other objects remained.
8. A second client changed an object while its draft was open. Save rejected the stale draft and kept the text; Undo then loaded the newer server value. Snapshot checks are preflight reads, not atomic compare-and-swap.
9. The final browser build reported no console warnings/errors. The three-pane desktop layout was visually inspected.

Screenshot with disposable fixture data: `outputs/objy-json-editor.png` in the workspace root.

After testing, the temporary connection was forgotten and the original saved CLI server at `http://127.0.0.1:8179/` was selected again. Unsaved object drafts stay in page memory only. No publishing or deployment was performed.
