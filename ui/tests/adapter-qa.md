# Database adapter verification — 2026-11-08

Local-only work; no publication, remote source synchronization or deployment.

## Automated checks

`npm test`: **50/50 passing**. `npm run build:ai` succeeds. Handwritten UI and component JavaScript pass `node --check`.

The same adapter/store contract is exercised against real `@objy/db@0.1.0` and real `@objy/server@0.1.0` over HTTP using `@objy/client@0.1.0`. Servers bind to 127.0.0.1 on an ephemeral port with no persistence. Covered operations: creation, lazy catalog reads, object loading/counts, multiple pages, inserts, filtered/aggregate/reference reads, partial patch, replacement, missing-object checks, metadata, deletion and scope lifecycle.

Additional cases cover wrong credentials leaving the previous connection intact, matching names on isolated connections, tools retaining their original store, the same AI SDK orchestration over HTTP (scripted model), confirmed writes with a subsequent refresh failure, partial multi-call creation, and losing a real successful insert's HTTP response. The uncertain-write case asserts a single model call, a single insert request and one saved object; it is not silently retried.

## Browser checks

Used the localhost app at http://127.0.0.1:4317 and a disposable authenticated OBJY server with CORS limited to that origin.

- Created a browser-local inventory/bikes collection, inserted an object and opened its JSON.
- Wrong server password displayed an inline authentication error and retained the browser connection. This check exposed and fixed an error-label selector collision with the global stale-view notice.
- Correct login listed real server databases. Selecting inventory/bikes loaded 50 of 55 objects; Load more exposed object 55 and its JSON.
- Inserted `bike-00` through the explorer and verified its actual server JSON.
- Started the real Qwen3 4B browser model. Prompt: “Show the object with _id bike-00 in inventory/bikes.” It returned the server object's exact `_id`, name and gears. This is one actual inference scenario, not a claim of general model accuracy.
- Switching connections restored the server's object selection and conversation. In a fresh verification tab, identically named browser/server databases stayed separate; switching back restored the browser's selected object and unsent draft.
- Stopped the disposable server, then attempted to select its connection. The UI displayed the network/CORS guidance and retained This browser. Disconnected the test entry afterward.
- The final localhost tab uses the embedded adapter with one disposable Browser bike test object. No object persistence was added. The temporary server was shut down.

Screenshots: outputs/objy-connections.png (final browser-local explorer) and outputs/objy-server-connection.png (real server query result).

## Limits

No user-supplied external server was available. Compatibility is verified against official 0.1.0 packages; remote servers need the corresponding HTTP API, authentication permissions and browser CORS/HTTPS access. Offset browsing is not a snapshot under concurrent writes. The existing small-model interpretation limitations remain; this change separates database access and contains uncertain HTTP write outcomes.
