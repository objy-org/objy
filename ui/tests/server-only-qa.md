# Server-only verification — 2026-11-10

## Implementation

The three-pane explorer remains unchanged: database/collection tree, object list, JSON. The UI starts disconnected. All database operations use `@objy/client@0.1.0` and a required server adapter. Removed the browser adapter, embedded default, fallback connection, direct `@objy/db` dependency and its generated license. Build metadata rejects database engine/server code in the browser data bundle.

## Automated checks

`npm test`: **51/51 passed**. All database fixtures now use disposable, memory-only loopback `@objy/server` instances over HTTP through the official client. Tests cover CRUD, queries, metadata, pagination, AI execution contracts, authentication failure, independent servers, failed switching, reconnect, removing inactive/active/final connections, disconnected startup and no implicit fallback. Browser AI provider responses in these tests are scripted; actual model understanding was not reevaluated for this connection change.

`npm run build:ai`, `node --check dist/app.js` and `git diff --check` passed. The regenerated data bundle contains the client and store, with no embedded engine. npm registry reports 0.1.0 as the current client release; the installed official README was checked for URL, login, session, CRUD and browser usage.

## Browser checks

At http://127.0.0.1:4317/ with a disposable, authenticated loopback OBJY test server:

- Fresh page shows No server connected. Refresh, prompt and Send are disabled. No browser-database entry exists.
- Incorrect password shows an authentication error; correcting it connects successfully.
- Server catalog appears in the existing three panes. Selected bikes loads 50 of 55 objects; Load more loads all 55. Selecting bike-55 renders its actual JSON.
- Created ui_check/items using the UI controls, inserted ui-server-object, and opened the server-returned JSON.
- Disconnect cleared the view and disabled requests. Reconnect retained the server database, collection and object while starting with fresh UI selection.
- No browser warning/error logs were captured during these checks.

Screenshot: outputs/objy-server-only.png in the task workspace. Verification data belongs only to the disposable server, which is shut down after QA. No changes to spoo.io, no connection workaround, no persistence and no publication. The previously observed spoo.io browser connectivity issue remains pending.
