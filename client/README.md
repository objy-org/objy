# JavaScript client

One dependency-free ES module consumes OBJY DB's public HTTP API in browsers and Node. The same client works through objy-platform; the server decides which object behavior and operations are available.

The bundled admin UI imports this same `/client.js` module and uses its public methods for authentication, queries, CRUD, metadata, administration and file transfers. The UI retains its own presentation and local-storage preference handling; the client owns request handling and token renewal. Existing saved UI sessions migrate automatically, renewed tokens are persisted, and changing the selected server clears the old session.

## Browser

The server exposes the module without requiring login:

```html
<script type="module">
  import { createClient } from '/client.js';

  const client = createClient();
  await client.login({ username: 'admin', password: 'your-password' });

  const items = client.database('app').collection('items');
  await items.insert({ _id: 'hello', title: 'Hello' });
  console.log(await items.get('hello'));
</script>
```

When imported from `/client.js` or its content-addressed URL, the default server URL comes from the module URL, including any proxy path prefix. Importing through objy-platform therefore connects to that gateway. Applications that bundle or copy the module must provide `url` explicitly.

For an application on another origin, enable CORS on the server:

```js
// OBJY DB configuration (also supported inside objy-platform's spread option)
server: {
  port: 8080,
  cors: { origins: ['https://app.example.com'] }
}
```

The application can then import `https://db.example.com/client.js`. CORS is disabled by default. Preflight permits Authorization, Content-Type and Prefer; additional request headers can be configured with `cors.headers`. Authentication uses bearer tokens, not cookies. objy-platform may override CORS with `gateway.cors`.

`/client.js` uses ETag revalidation. Its `Link` header identifies `/client/<content-hash>.js`, served with immutable caching. A server serves only its current content hash; deployments retaining older pinned versions must retain those artifacts in their static hosting/cache. A missing old hash fails rather than returning different code under the same URL.

## Node and bundlers

```js
import { createClient, SpreadDBError } from 'spread-db/client';

const client = createClient({ url: 'http://127.0.0.1:8080' });
```

This subpath imports only the client, never the database server or its dependencies. It uses the runtime's fetch, Blob, FormData and Web Streams APIs. A custom `fetch` implementation can be supplied. TypeScript declarations are included; collection handles accept a record type:

```ts
const items = client.database('app').collection<{ _id: string; title: string }>('items');
```

## Authentication and renewal

```js
await client.login({
  database: '_global', // default
  collection: 'users', // default
  username: 'admin',
  password: 'your-password',
});

const saved = client.getSession();
client.setSession(saved); // restore explicitly when needed
await client.renew();     // optional manual renewal
client.logout();          // clear this client's session
```

Tokens stay in memory, isolated per client. Session snapshots are detached copies and include the authentication database and collection. Applications choose whether and where to persist them. Logout does not revoke existing tokens at the server.

Automatic renewal is enabled by default. A protected request receiving `401` with `code: "ACCESS_TOKEN_EXPIRED"` and `operationStarted: false` renews the token pair and replays once. Concurrent requests share one renewal; late rejections reuse the newer access token. Login, renewal and the replay itself never recursively refresh. Set `autoRenew: false` to disable this behavior.

Permission failures, generic 401 responses, and errors after an operation began do not trigger replay. Rejected refresh tokens clear the session; network failures preserve it. Logout or replacing the session while renewal is pending prevents that renewal from restoring the previous identity. Cancelling one waiting request does not cancel renewal for other callers.

Older servers without the explicit expiration marker still support normal operations, but cannot trigger automatic renewal safely. Upgrade the server or call `renew()` explicitly.

## Operations

`client.database(name)` and `database.collection(name)` return immutable handles without changing global context.

| Handle | Methods |
|---|---|
| Client | `login`, `renew`, `getSession`, `setSession`, `logout`, `health`, `status`, `listDatabases`, `createDatabase`, `database` |
| Database | `collection`, `listCollections`, `createCollection`, `drop` |
| Collection | `get`, `insert`, `replace`, `patch`, `remove`, `find`, `search`, `count`, `iterate` |
| Collection bulk | `insertMany`, `replaceMany`, `patchMany`, `removeMany`, `import` |
| Collection files | `insertFile`, `replaceFile`, `download` |
| Collection metadata | `getMeta`, `setMeta`, `drop` |

Methods return the native response body. Single writes return objects, queries return arrays, bulk operations return their native counts/items, and successful 204 deletions return `undefined`. Missing objects throw `SpreadDBError` with status 404. `count` returns a number using native aggregation.

```js
await client.createDatabase('app', { meta: { purpose: 'demo' }, adminUser: {
  collection: 'users', username: 'owner', password: 'your-password',
} });
const db = client.database('app');
await db.createCollection('items', { indexes: ['status'] });
const items = db.collection('items');

await items.replace('hello', { title: 'Full replacement' }); // also creates if absent
await items.patch('hello', { $set: { status: 'active' }, $unset: ['unused'] });

await items.find({ status: 'active' }, { limit: 20, offset: 0, sortBy: '_id', sort: 'asc' });
await items.search({ status: 'active', $sort: { score: -1 } });
await items.search({ $aggregate: { fields: { total: { $sum: 'score' } } } });
await items.search({ $vector: { vector: [1, 0, 0], limit: 10 } });
await items.get('hello', { refDepth: 0 });

for await (const item of items.iterate({ status: 'active' }, { pageSize: 100, limit: 1000 })) {
  console.log(item);
}

await items.insertMany([{ _id: 'one' }, { _id: 'two' }], { minimal: true });
await items.replaceMany([{ _id: 'one', title: 'Replacement' }]);
await items.patchMany([{ _id: 'one', $set: { title: 'Patched' } }]);
await items.removeMany(['one', 'two']);
```

`find` encodes a GET query; `search` posts the query unchanged. URL controls (`limit`, `offset`, `sortBy`, `sort`, `refDepth`) override query-body controls. Aggregates and vector search use `search`; no separate endpoint is invented. Queries run on stored data, including through OBJY.

`iterate` fetches ordinary queries in pages of at most 250, defaulting to `_id` order unless a sort was supplied. Its `offset` and `limit` options describe the entire iteration. It does not provide a snapshot or guarantee uniqueness while other clients mutate the collection. It does not paginate vector or aggregate queries.

## Files and imports

```js
await items.insertFile({ _id: 'document', title: 'Notes' }, new Blob(['hello']), { filename: 'notes.txt' });
await items.replaceFile('document', { title: 'Revised notes' }, new Blob(['revised']));
const response = await items.download('document');
const blob = await response.blob(); // or consume response.body; cancel it if abandoning a download

await items.import(new Blob(['{"_id":"one","score":1}\n']));
await items.import([{ _id: 'one', $set: { score: 2 } }], { operation: 'patch' });

// Node or a browser/connection supporting streaming uploads:
await items.import(async function* () {
  yield { _id: 'two', score: 2 };
  yield { _id: 'three', score: 3 };
});
```

Import operations are `insert` (default), `replace`, `patch`, and `remove`. Sources may be NDJSON text, Blob/File, arrays, byte ReadableStreams, object iterables, or a factory returning a fresh source. The client sets NDJSON content type and minimal-response headers. Runtime support is checked for streaming request bodies; connection restrictions may still reject streaming uploads. Blob/text uploads work across the tested browsers. Large iterables are never silently buffered or split into different requests.

Text, blobs, arrays and multipart files can be replayed after authentication rejection. A stream or general iterator needs a factory to produce a fresh source for replay; otherwise expiration reports `BODY_NOT_REPLAYABLE`. Importing arrays snapshots their JSON before sending. Earlier server-side import chunks may remain committed after a later failure.

## Errors, cancellation and limits

```js
try {
  await items.patch('hello', { $set: { status: 'done' } }, {
    signal: abortController.signal,
    timeoutMs: 10_000,
  });
} catch (error) {
  if (error instanceof SpreadDBError) {
    console.log(error.status, error.code, error.body, error.writeMayHaveSucceeded);
  }
}
```

The default timeout is 30 seconds; `timeoutMs: 0` disables it. A request's deadline covers asynchronous import factories, token renewal and replay, and downloads retain their deadline until their body is consumed or cancelled. Errors preserve server status, body and headers. Network failures and cancellations after sending a write may leave its outcome uncertain; writes are never automatically retried for transport failures. Failed imports with nonzero committed counts also set `writeMayHaveSucceeded`; inspect the error body for those counts before deciding how to proceed. Redirects are rejected, and credentials are never forwarded to another origin.

The client does not add transactions, realtime subscriptions, server-side session revocation, or private cluster/replication operations. Through objy-platform, managed collections currently reject bulk, NDJSON and multipart writes; the client surfaces that response without substituting multiple writes. OBJY behavior executes on the server.

## Validation

Run `npm run test:client` for the focused Node client suite, `npm test` for all Node tests, and `npm run test:browser` for Chromium, Firefox and WebKit tests. The client suite covers authentication races, concurrent writes, file integrity and cleanup, bulk imports, partial failures, pagination, cancellation, timeouts and HTTP errors. Browser engines can be installed with `npx playwright install chromium firefox webkit`. objy-platform contains additional Node and browser integration tests exercising this same client through its public gateway.
