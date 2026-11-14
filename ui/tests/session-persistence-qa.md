# Saved server connections — 2026-11-10

## Automated checks

`npm test`: **65/65 passing**, including 13 saved-session tests and an AI authentication-stop regression. Tests use the pinned official `@objy/client` with disposable loopback `@objy/server` instances and actual IndexedDB transactions supplied by fake-indexeddb. The test lock queue models exclusive cross-tab Web Locks; real browser behavior is checked below.

Verified:

- Server selection and authenticated access survive a new connection manager, without another password login.
- Only whitelisted server metadata and access/refresh tokens are saved. No password, user profile, object, conversation or draft fields are persisted.
- Expired access tokens renew once across concurrent clients; both replacement tokens are saved and used by the next reload.
- Expired refresh tokens and rejected access tokens are removed; server details remain for sign-in.
- Offline startup and ordinary 403 permission failures preserve saved credentials and allow retry.
- A forgotten connection cannot be resurrected by an in-flight request or used by a stale tab.
- Changed server URL/authentication scope and replacement login generations cannot reuse old credentials.
- Two saved servers remain isolated; forgetting the active server does not choose another server automatically.
- A failed token save after a confirmed write preserves the receipt without duplicating the write; a subsequent request repairs persistence.
- Failed credential deletion is reported. Unavailable storage is explicit; corrupt metadata cannot trigger a request.
- Authentication failure terminates the AI loop immediately.

`npm run build:ai`, `node --check dist/app.js` and `git diff --check` passed. The build still rejects embedded database/server code in browser data bundles.

## Real browser checks

Tested the local UI at `http://127.0.0.1:4317/` against the user's authorized local `@objy/cli` test server at `http://127.0.0.1:8179/`:

1. Logged in through the connection dialog using the existing test credentials.
2. Reloaded the page. The authenticated server and catalog restored automatically, with no password prompt.
3. Opened a second tab. It restored the same saved connection.
4. Used **Forget** in the first tab. Both tabs became disconnected.
5. Reloaded the first tab. It remained disconnected, confirming persistent deletion.
6. Closed the extra tab, connected again, and reloaded the final build successfully. Left the first tab connected for the user.
7. Browser error/warning logs were empty after the final reload. The three-pane explorer remains unchanged.

Proof: `outputs/objy-saved-connection.png` in the workspace root, showing the restored server in the connection dialog. No password or token is visible. Browser verification made no object changes on the user's CLI test server.

## Limits

IndexedDB is origin-scoped storage accessible to scripts on that origin; it is not an encrypted vault or HttpOnly cookie. Clearing site data removes logins. `localhost` and `127.0.0.1` do not share storage. Forget deletes local credentials but does not revoke a copied token on the server. A crash/storage failure between server token rotation and the subsequent save can require another login. The tests cover authentication and connection behavior, not model reasoning quality.

No deployment or external server changes were made.
