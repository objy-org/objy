# Collection JSON queries — 2026-11-10

`npm test`: **75/75 passing**. Build, JavaScript syntax checks and `git diff --check` passed.

Seven new real-server tests cover native filters and sort, collection totals versus match counts, Load more, explicit JSON pagination, aggregation, native reference expansion, read-only derived results, query retention through refresh/writes, per-collection isolation, empty results, failed requests retaining the previous snapshot, and paging beyond the server's 250-row cap.

Actual browser verification used the local UI at `http://127.0.0.1:4317/` with an isolated in-memory OBJY server and disposable fixture data:

- Query bar spans the object list and JSON pane; the database tree remains left.
- Enter executed `{"active":true}`, returning two of three fixture objects.
- Shift+Enter added a newline without running; Enter subsequently ran the multiline JSON.
- Malformed JSON showed an inline error and kept the previous results.
- A native aggregation returned `{"total":1650,"count":2}`. Selecting the result showed read-only JSON with no Save/Delete controls.
- Clear restored ordinary object browsing. A zero-match query showed `No matches` and a result count of zero.
- Switching collections kept query text and results isolated.
- A filtered object remained editable. Saving an updated `gears` field updated its preview and retained the active filter/results.
- Final browser console warning/error logs were empty. The desktop layout was visually inspected.

Screenshot: `outputs/objy-collection-query.png` in the workspace root (disposable fixture data).

The temporary connection was forgotten and its server stopped. The UI was left connected to the user's saved CLI server at `http://127.0.0.1:8179/`; no objects on that server were modified. No publication or deployment occurred.

Query text/results are page-local. Ordinary filters use offset pagination and can change membership during concurrent server writes. Queries containing explicit window controls, aggregation or vector search use the server's native result window without automatic Load more; the count shown is the number of returned rows. Aggregation, vector and reference-expanded results are read only. No model inference is involved in executing the query bar.
