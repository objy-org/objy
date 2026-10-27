![OBJY DB](https://raw.githubusercontent.com/spoo-technologies/objy-db/main/public/branding/objy-db-logo-signal.png)

# OBJY DB JavaScript Client

<p align="center"><strong>One client. Browser and Node. No runtime dependencies.</strong></p>

The OBJY DB client is a small ES module over the public HTTP API. It handles URLs, authentication, token renewal, queries, bulk imports, files, cancellation, and native server errors without adding an ORM or hiding database behavior.

[Quick start](#quick-start) | [API reference](../API.md) | [Database README](../README.md)

## Quick Start

### Node and Bundlers

```js
import { createClient } from 'objydb/client';

const client = createClient({ url: 'http://127.0.0.1:8080' });
await client.login({ username: 'admin', password: 'your-password' });

const items = client.database('app').collection('items');

await items.insert({ _id: 'hello', title: 'Hello' });
console.log(await items.get('hello'));
```

The `objydb/client` subpath imports only the client. It never starts the database server or loads its server dependencies.

### Browser

Every OBJY DB node serves the client at `/client.js` without authentication:

```html
<script type="module">
  import { createClient } from '/client.js';

  const client = createClient();
  await client.login({ username: 'admin', password: 'your-password' });

  const items = client.database('app').collection('items');
  console.log(await items.find({ status: 'active' }));
</script>
```

When loaded from `/client.js`, the default server URL is derived from the module URL, including a reverse-proxy path prefix. Bundled or copied clients should pass `url` explicitly.

## The Client Model

```text
client
  database("app")
    collection("items")
```

Database and collection handles are immutable. Creating a handle does not change global context, so one client can safely work across many databases and collections.

```js
const app = client.database('app');
const archive = client.database('archive');

const activeItems = app.collection('items');
const oldItems = archive.collection('items');
```

Methods return native server results:

- Single writes and reads return objects.
- Queries and aggregations return arrays.
- Bulk operations return their normal count and item summaries.
- Successful `204` deletions return `undefined`.
- Missing objects throw `SpreadDBError` with status `404`.

## API at a Glance

| Handle | Methods |
| --- | --- |
| Client | `login`, `renew`, `getSession`, `setSession`, `logout`, `health`, `status`, `listDatabases`, `createDatabase`, `database` |
| Database | `collection`, `listCollections`, `createCollection`, `drop` |
| Collection | `get`, `insert`, `replace`, `patch`, `remove`, `find`, `search`, `count`, `iterate` |
| Bulk | `insertMany`, `replaceMany`, `patchMany`, `removeMany`, `import` |
| Files | `insertFile`, `replaceFile`, `download` |
| Metadata | `getMeta`, `setMeta`, `drop` |

## Context and CRUD

```js
await client.createDatabase('app', {
  meta: { purpose: 'demo' },
  adminUser: {
    collection: 'users',
    username: 'owner',
    password: 'your-password',
  },
});

const db = client.database('app');
await db.createCollection('items', { indexes: ['status'] });

const items = db.collection('items');

await items.insert({ _id: 'hello', title: 'Hello', status: 'draft' });
await items.replace('hello', { title: 'Full replacement' });
await items.patch('hello', {
  $set: { status: 'active' },
  $unset: ['unused'],
});

const item = await items.get('hello');
await items.remove('hello');
```

`replace` stores the complete supplied object and also creates it when absent. `patch` uses the server's Mongo-like `$set` and `$unset` semantics.

## Query and Aggregate

```js
const rows = await items.find(
  { status: 'active' },
  { limit: 20, offset: 0, sortBy: '_id', sort: 'asc' },
);

await items.search({
  status: 'active',
  $sort: { score: -1 },
  $pageSize: 50,
});

await items.search({
  status: 'active',
  $aggregate: {
    groupBy: 'category',
    fields: {
      total: { $sum: 'score' },
      count: { $count: true },
    },
  },
});

await items.search({
  $vector: { vector: [1, 0, 0], limit: 10 },
});

await items.get('hello', { refDepth: 0 });
```

`find` encodes a GET query. `search` sends the query as a POST body and is the natural choice for large filters, aggregation, and vectors. URL options passed to `find` override controls inside the query body. `count` returns a number through native aggregation.

For ordinary paged reads:

```js
for await (const item of items.iterate(
  { status: 'active' },
  { pageSize: 100, limit: 1000 },
)) {
  console.log(item);
}
```

`iterate` requests pages of at most 250 and defaults to `_id` order. Its offset and limit apply to the complete iteration. It is not a snapshot: concurrent writes can change page membership. Vector and aggregate queries are not iterable.

## Bulk and Streaming

```js
await items.insertMany(
  [{ _id: 'one' }, { _id: 'two' }],
  { minimal: true },
);

await items.replaceMany([
  { _id: 'one', title: 'Replacement' },
]);

await items.patchMany([
  { _id: 'one', $set: { title: 'Patched' } },
]);

await items.removeMany(['one', 'two']);
```

For large writes, `import` sends NDJSON and keeps the server's bounded, bulk-first path:

```js
await items.import(new Blob([
  '{"_id":"one","score":1}\n',
  '{"_id":"two","score":2}\n',
]));

await items.import(
  [{ _id: 'one', $set: { score: 3 } }],
  { operation: 'patch' },
);

await items.import(async function* () {
  yield { _id: 'three', score: 3 };
  yield { _id: 'four', score: 4 };
});
```

Operations are `insert` (default), `replace`, `patch`, and `remove`. Sources may be NDJSON text, Blob/File, arrays, byte streams, object iterables, or factories returning fresh sources.

The client sets NDJSON and minimal-response headers automatically. It never silently buffers a large iterable or splits it into unrelated requests. Earlier server-side chunks may remain committed if a later chunk fails.

## Files

```js
await items.insertFile(
  { _id: 'document', title: 'Notes' },
  new Blob(['hello']),
  { filename: 'notes.txt' },
);

await items.replaceFile(
  'document',
  { title: 'Revised notes' },
  new Blob(['revised']),
);

const response = await items.download('document');
const blob = await response.blob();
```

`download` returns the native `Response`, so callers can read it as a blob, stream `response.body`, or cancel the body when abandoning a download.

## Authentication

```js
await client.login({
  database: '_global', // default
  collection: 'users', // default
  username: 'admin',
  password: 'your-password',
});

const saved = client.getSession();
client.setSession(saved);

await client.renew();
client.logout();
```

Sessions live in memory and are isolated per client. `getSession()` returns a detached snapshot containing tokens and the authentication database and collection. The application decides whether and where to persist it. Logout clears local state but does not revoke tokens at the server.

Automatic renewal is enabled by default. When a protected request receives an explicit, safe-to-replay token-expiration response, concurrent callers share one renewal and each request replays at most once. Disable this with `autoRenew: false`.

<details>
<summary><strong>Renewal and replay safety</strong></summary>

Automatic replay requires `401`, `code: "ACCESS_TOKEN_EXPIRED"`, and `operationStarted: false`. Generic authentication failures, permission denials, and failures after execution began are never replayed.

Rejected refresh tokens clear the session; transport failures preserve it. Login, renewal, and replay never recursively renew. Logging out or replacing the session during renewal prevents the old identity from returning. Cancelling one waiter does not cancel a shared renewal needed by other requests.

Replayable bodies include JSON, text, Blob/File, arrays, and multipart files. Streams and general iterators need a factory that creates a fresh source; otherwise the client reports `BODY_NOT_REPLAYABLE`. Array imports snapshot their JSON before sending.

Older servers without the explicit expiration marker still work, but cannot safely trigger automatic renewal. Call `renew()` explicitly or upgrade the server.

</details>

## Errors and Cancellation

```js
import { SpreadDBError } from 'objydb/client';

try {
  await items.patch(
    'hello',
    { $set: { status: 'done' } },
    {
      signal: abortController.signal,
      timeoutMs: 10_000,
    },
  );
} catch (error) {
  if (error instanceof SpreadDBError) {
    console.log({
      status: error.status,
      code: error.code,
      body: error.body,
      writeMayHaveSucceeded: error.writeMayHaveSucceeded,
    });
  }
}
```

The default timeout is 30 seconds; `timeoutMs: 0` disables it. A deadline covers asynchronous source creation, token renewal, replay, response parsing, and download consumption.

Errors preserve server status, body, and headers. Transport failures are never used to retry writes automatically. If a timeout, cancellation, or connection failure happens after sending a write, `writeMayHaveSucceeded` can be true. Partial imports report committed counts in the error body. Redirects are rejected so credentials never cross origins.

## TypeScript and Runtime Support

TypeScript declarations are included:

```ts
type Item = {
  _id: string;
  title: string;
  status?: string;
};

const items = client
  .database('app')
  .collection<Item>('items');
```

The client uses the host runtime's `fetch`, `Blob`, `FormData`, and Web Streams APIs. A custom `fetch` implementation may be supplied. Streaming request-body support is detected at runtime; Blob and text imports remain the portable fallback.

## Browser Delivery and CORS

For an application on another origin, enable CORS:

```js
server: {
  port: 8080,
  cors: {
    origins: ['https://app.example.com'],
  },
}
```

CORS is disabled by default. Preflight permits `Authorization`, `Content-Type`, and `Prefer`; configure extra request headers with `cors.headers`. Authentication uses bearer tokens, not cookies.

`/client.js` supports ETag revalidation. Its `Link` header identifies an immutable `/client/<content-hash>.js` URL. A server exposes only its current hash, so deployments pinning older versions must retain those files in their own static hosting or cache.

## Deliberate Boundaries

The client does not add:

- Transactions.
- Realtime subscriptions.
- Server-side session revocation.
- Private cluster or replication operations.
- Automatic transport retries for writes.
- Hidden global database or collection context.

It stays thin on purpose: the server owns data semantics, permissions, routing, durability, and query planning.

## Development

Run `npm run test:client` for the focused Node suite or `npm run test:browser` for Chromium, Firefox, and WebKit coverage. Browser engines can be installed with:

```sh
npx playwright install chromium firefox webkit
```
