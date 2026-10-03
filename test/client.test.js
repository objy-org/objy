import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createClient, SpreadDBError } from 'spread-db/client';
import { startServer } from '../src/server.js';
import { createFileService } from '../src/files.js';
import { clientPath } from '../src/interfaces/client.js';

const { sign } = createRequire(import.meta.url)('../src/lib/jwt.cjs');
const secret = 'client-test-secret';
const expired = token => sign({ ...JSON.parse(Buffer.from(token.split('.')[1], 'base64url')), exp: 1 }, secret);
const response = (body, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const rejection = () => response({ error: 'expired', code: 'ACCESS_TOKEN_EXPIRED', operationStarted: false }, 401);
const oldSession = { database: 'a', collection: 'users', accessToken: 'old', refreshToken: 'refresh' };
const newTokens = { accessToken: 'new', refreshToken: 'next' };
const mock = fetch => createClient({ url: 'http://example.test', session: oldSession, fetch });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function setup(t, options = {}) {
  const server = await startServer({ auth: { jwtSecret: secret }, files: createFileService({ mode: 'memory' }), ...options });
  t.after(() => new Promise(resolve => { server.server.close(resolve); server.server.closeIdleConnections(); }));
  const url = `http://127.0.0.1:${server.port}`;
  const client = createClient({ url });
  await client.login({ username: 'admin', password: '123' });
  return { client, server, url };
}

test('public client CRUD, queries, iteration, bulk, metadata and independent database handles', async t => {
  const { client } = await setup(t);
  await client.createDatabase('client-a', { meta: { purpose: 'test' } });
  const db = client.database('client-a');
  await db.createCollection('items', { indexes: ['value'] });
  const items = db.collection('items');
  assert.deepEqual((await items.getMeta()).indexes, ['value']);
  await items.setMeta({ indexes: ['label'] });
  assert.deepEqual((await db.listCollections()).collections, ['items']);
  const row = await items.insert({ _id: 'one', value: 1 });
  assert.equal(row._id, 'one');
  await items.replace('one', { value: 2, stale: true });
  await items.patch('one', { $set: { value: 3 }, $unset: ['stale'] });
  assert.deepEqual(await items.get('one'), { _id: 'one', value: 3 });
  await items.insertMany(Array.from({ length: 270 }, (_, i) => ({ _id: `x-${String(i).padStart(3, '0')}`, value: i })));
  assert.equal(await items.count({}), 271);
  assert.equal((await items.find({ value: { $gte: 260 } }, { sortBy: 'value', sort: 'desc', limit: 2 }))[0].value, 269);
  const aggregate = await items.search({ $aggregate: { fields: { total: { $sum: 'value' } } } });
  assert.ok(aggregate[0].total > 0);
  const seen = [];
  for await (const item of items.iterate({}, { pageSize: 100 })) seen.push(item._id);
  assert.equal(new Set(seen).size, 271);
  await items.replaceMany([{ _id: 'one', value: 4 }]);
  await items.patchMany([{ _id: 'one', $set: { value: 5 } }]);
  assert.equal((await items.get('one')).value, 5);
  const other = client.database('client-b').collection('items');
  await other.insert({ _id: 'one', value: 99 });
  assert.equal((await items.get('one')).value, 5);
  assert.equal((await other.get('one')).value, 99);
  assert.equal((await items.removeMany(['one'])).deleted, 1);
  await assert.rejects(items.get('one'), error => error instanceof SpreadDBError && error.status === 404);
  assert.ok((await client.listDatabases()).databases.includes('client-a'));
  assert.equal((await client.health()).ok, true);
  assert.ok(await client.status());
  await items.drop();
  await db.drop();
});

test('files, references, NDJSON operations and read cancellation', async t => {
  const { client } = await setup(t);
  const items = client.database('files').collection('items');
  await items.insertFile({ _id: 'file', label: 'text' }, new Blob(['hello']), { filename: 'hello.txt' });
  assert.equal(await (await items.download('file')).text(), 'hello');
  await items.replaceFile('file', { label: 'new' }, new Blob(['new']));
  assert.equal(await (await items.download('file')).text(), 'new');
  await items.insert({ _id: 'ref', target: { type: 'reference', collection: 'items', value: 'file' } });
  assert.equal((await items.get('ref')).target.object._id, 'file');
  assert.equal((await items.search({ _id: 'ref', $refDepth: 0 }))[0].target.object, undefined);
  await items.import([{ _id: 'i', n: 1 }]);
  await items.import('{"_id":"i","n":2}\n', { operation: 'replace' });
  await items.import(new Blob(['{"_id":"i","$set":{"n":3}}\n']), { operation: 'patch' });
  assert.equal((await items.get('i')).n, 3);
  await items.import(async function* () { yield { _id: 'i' }; }, { operation: 'remove' });
  await assert.rejects(items.get('i'), { status: 404 });
  await items.remove('file');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(items.get('ref', { signal: controller.signal }), { code: 'ABORTED', writeMayHaveSucceeded: false });
});

test('real expired tokens renew automatically before replaying a write exactly once', async t => {
  const { client, url } = await setup(t);
  const session = client.getSession();
  session.accessToken = expired(session.accessToken);
  let renewals = 0;
  let writes = 0;
  const tracked = createClient({ url, session, fetch: (url, options) => {
    if (url.endsWith('/renew')) renewals++;
    if (options.method === 'POST' && url.includes('/object')) writes++;
    return fetch(url, options);
  } });
  const items = tracked.database('renewal').collection('items');
  await items.insert({ _id: 'once' });
  assert.equal(renewals, 1);
  assert.equal(writes, 2);
  assert.equal(await items.count(), 1);
  assert.notEqual(tracked.getSession().accessToken, session.accessToken);
});

test('parallel expired requests share renewal, preserve payloads, and handle late failures', async () => {
  const gate = defer(); let renewals = 0; let oldCalls = 0;
  const bodies = [];
  const client = mock(async (url, options) => {
    if (url.endsWith('/renew')) { renewals++; await gate.promise; return response(newTokens); }
    if (options.headers.get('authorization') === 'Bearer old') {
      oldCalls++;
      if (oldCalls === 3) { gate.resolve(); await new Promise(resolve => setTimeout(resolve, 20)); }
      return rejection();
    }
    bodies.push(JSON.parse(options.body));
    return response(JSON.parse(options.body), 201);
  });
  const items = client.database('a').collection('items');
  const data = { n: 1 };
  const first = items.insert(data); data.n = 100;
  await Promise.all([first, items.insert({ n: 2 }), items.insert({ n: 3 })]);
  assert.equal(renewals, 1);
  assert.deepEqual(bodies.map(body => body.n).sort(), [1, 2, 3]);
  assert.equal(client.getSession().refreshToken, 'next');
});

test('permission errors, ambiguous writes, disabled renewal and repeated expiry never loop', async () => {
  for (const [status, body] of [
    [403, { error: 'forbidden' }], [500, { error: 'failed' }],
    [401, { code: 'ACCESS_TOKEN_EXPIRED', operationStarted: false, writeMayHaveSucceeded: true }],
    [401, { code: 'ACCESS_TOKEN_EXPIRED', operationStarted: true }],
    [401, { error: 'generic unauthorized' }],
  ]) {
    let calls = 0;
    const client = mock(async () => { calls++; return response(body, status); });
    await assert.rejects(client.database('a').collection('items').insert({}), { status });
    assert.equal(calls, 1);
  }
  let calls = 0;
  const repeat = mock(async url => { calls++; return url.endsWith('/renew') ? response(newTokens) : rejection(); });
  await assert.rejects(repeat.database('a').collection('items').get('x'), { status: 401 });
  assert.equal(calls, 3);
  calls = 0;
  const disabled = createClient({ url: 'http://example.test', session: oldSession, autoRenew: false, fetch: async () => { calls++; return rejection(); } });
  await assert.rejects(disabled.database('a').collection('items').get('x'), { status: 401 });
  assert.equal(calls, 1);
});

test('logout during renewal cannot restore a session or replay under another identity', async () => {
  const gate = defer(); const begun = defer(); let writes = 0;
  const client = mock(async url => {
    if (url.endsWith('/renew')) { begun.resolve(); await gate.promise; return response(newTokens); }
    writes++; return rejection();
  });
  const work = client.database('a').collection('items').insert({});
  await begun.promise;
  client.logout(); gate.resolve();
  await assert.rejects(work, { code: 'SESSION_CHANGED' });
  assert.equal(client.getSession(), null);
  assert.equal(writes, 1);
});

test('invalid refresh ends session; transport failure preserves it; writes are never network-retried', async () => {
  const denied = mock(async url => url.endsWith('/renew') ? response({ error: 'invalid refresh' }, 401) : rejection());
  await assert.rejects(denied.database('a').collection('items').get('x'), { status: 401 });
  assert.equal(denied.getSession(), null);
  let calls = 0;
  const offline = mock(async () => { calls++; throw new TypeError('offline'); });
  await assert.rejects(offline.renew(), { code: 'NETWORK_ERROR' });
  assert.equal(offline.getSession().refreshToken, 'refresh');
  await assert.rejects(offline.database('a').collection('items').insert({}), { writeMayHaveSucceeded: true });
  assert.equal(calls, 2);
});

test('cancelling one renewal waiter leaves other operations alive', async () => {
  const gate = defer(); const begun = defer();
  const client = mock(async (url, options) => {
    if (url.endsWith('/renew')) { begun.resolve(); await gate.promise; return response(newTokens); }
    return options.headers.get('authorization') === 'Bearer old' ? rejection() : response({ _id: 'x' });
  });
  const controller = new AbortController();
  const items = client.database('a').collection('items');
  const first = items.get('x', { signal: controller.signal });
  const second = items.get('x');
  await begun.promise; controller.abort();
  await assert.rejects(first, { code: 'ABORTED' });
  gate.resolve();
  assert.equal((await second)._id, 'x');
});

test('non-replayable streams fail explicitly; factories allow safe retry', async () => {
  let renewals = 0; let factories = 0;
  const client = mock(async (url, options) => {
    if (url.endsWith('/renew')) { renewals++; return response(newTokens); }
    return options.headers.get('authorization') === 'Bearer old' ? rejection() : response({ inserted: 1 });
  });
  const items = client.database('a').collection('items');
  await assert.rejects(items.import(new ReadableStream({ start(c) { c.close(); } })), { code: 'BODY_NOT_REPLAYABLE' });
  assert.equal(renewals, 0);
  const result = await items.import(() => { factories++; return new ReadableStream({ start(c) { c.close(); } }); });
  assert.equal(result.inserted, 1);
  assert.equal(factories, 2);
});

test('served module caching, package exports, configured CORS and preflight', async t => {
  const { url } = await setup(t, { cors: { origins: ['https://app.example'] } });
  const module = await fetch(url + '/client.js', { headers: { origin: 'https://app.example' } });
  assert.match(module.headers.get('content-type'), /javascript/);
  assert.equal(module.headers.get('access-control-allow-origin'), 'https://app.example');
  assert.match(await module.text(), /export function createClient/);
  assert.equal((await fetch(url + '/client.js', { headers: { 'if-none-match': module.headers.get('etag') } })).status, 304);
  assert.match((await fetch(url + clientPath)).headers.get('cache-control'), /immutable/);
  const preflight = await fetch(url + '/api/a/items/object', { method: 'OPTIONS', headers: {
    origin: 'https://app.example', 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'authorization,content-type',
  } });
  assert.equal(preflight.status, 204);
  const blocked = await fetch(url + '/api/a/items/object', { method: 'OPTIONS', headers: {
    origin: 'https://unlisted.example', 'access-control-request-method': 'PATCH',
  } });
  assert.equal(blocked.status, 403);
});

test('write timeouts are uncertain and never retried', async () => {
  let calls = 0;
  const client = mock((_url, { signal }) => new Promise((_resolve, reject) => {
    calls++;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await assert.rejects(client.database('a').collection('items').insert({}, { timeoutMs: 10 }), {
    code: 'TIMEOUT', writeMayHaveSucceeded: true,
  });
  assert.equal(calls, 1);
});

test('malformed renewal responses do not replace valid session state', async () => {
  const client = mock(async () => response({ accessToken: 'incomplete' }));
  await assert.rejects(client.renew(), { code: 'INVALID_RESPONSE' });
  assert.deepEqual(client.getSession(), oldSession);
});

test('native vector queries and minimal bulk results retain server semantics', async t => {
  const { client, server } = await setup(t);
  const items = client.database('vectors').collection('items');
  const result = await items.insertMany([{ _id: 'a', _vec: [1, 0] }, { _id: 'b', _vec: [0, 1] }], { minimal: true });
  assert.equal(result.inserted, 2);
  assert.equal(result.items, undefined);
  try { await items.search({ $vector: { vector: [1, 0], limit: 1 } }); }
  catch (error) { assert.equal(error.status, 503); }
  await server.node.awaitVectorIndexes();
  const rows = await items.search({ $vector: { vector: [1, 0], limit: 1 } });
  assert.equal(rows[0]._id, 'a');
  assert.equal(rows[0]._vec, undefined);
});

test('streamed request factories work against the native server after expired-token rejection', async t => {
  const { client } = await setup(t);
  const session = client.getSession(); session.accessToken = expired(session.accessToken);
  client.setSession(session);
  let factories = 0;
  const items = client.database('streams').collection('items');
  const result = await items.import(async function* () {
    factories++;
    for (let i = 0; i < 4; i++) yield { _id: String(i), n: i };
  });
  assert.equal(result.inserted, 4);
  assert.equal(factories, 2);
  assert.equal(await items.count(), 4);
});

test('identifiers are encoded, session snapshots detached, and invalid paths rejected', async t => {
  const { client } = await setup(t);
  const session = client.getSession(); session.database = 'tampered';
  assert.equal(client.getSession().database, '_global');
  const items = client.database('space name').collection('mixed ü');
  await items.insert({ _id: 'id /?#ü' });
  assert.equal((await items.get('id /?#ü'))._id, 'id /?#ü');
  assert.throws(() => client.database('..'), TypeError);
  assert.throws(() => createClient(), TypeError);
});
