import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, ObjyDBError } from '../client/index.js';

const session = { database: 'auth', collection: 'users', accessToken: 'old', refreshToken: 'refresh', user: { _id: 'alice' } };
const tokens = { accessToken: 'new', refreshToken: 'next' };
const reply = (body, status = 200, headers) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
const expired = () => reply({ code: 'ACCESS_TOKEN_EXPIRED', operationStarted: false }, 401);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const clientWith = fetch => createClient({ url: 'https://db.example/proxy/', session, fetch });
const itemsOf = client => client.database('app').collection('items');

test('URL prefixes and special characters stay inside their intended path segments', async () => {
  const requests = [];
  const client = clientWith(async (url, options) => { requests.push({ url: new URL(url), options }); return reply({}); });
  await client.database('db /ü').collection('a?#%').get('id /?#%');
  assert.equal(requests[0].url.pathname, '/proxy/api/db%20%2F%C3%BC/a%3F%23%25/object/id%20%2F%3F%23%25');
  assert.equal(requests[0].url.search, '');
  for (const url of ['file:///tmp/client.js', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com/?token=x', 'https://example.com/#x']) {
    assert.throws(() => createClient({ url }), TypeError);
  }
  for (const value of ['', '.', '..', null, undefined]) assert.throws(() => client.database(value), TypeError);
});

test('headers merge without leaking bearer tokens to login, renewal or health requests', async () => {
  const calls = [];
  const client = createClient({ url: 'https://db.example', session, headers: { Authorization: 'wrong', 'x-default': 'yes' }, fetch: async (url, options) => {
    calls.push({ url, ...options });
    return reply(url.endsWith('/auth') || url.endsWith('/renew') ? tokens : {});
  } });
  await itemsOf(client).insert({}, { headers: { Authorization: 'also-wrong', 'x-default': 'override', 'x-extra': 'extra' } });
  await client.health(); await client.renew(); await client.login({ username: 'a', password: 'b' });
  assert.equal(calls[0].headers.get('authorization'), 'Bearer old');
  assert.equal(calls[0].headers.get('x-default'), 'override');
  assert.equal(calls[0].headers.get('x-extra'), 'extra');
  assert.equal(calls[0].headers.get('content-type'), 'application/json');
  for (const call of calls.slice(1)) assert.equal(call.headers.has('authorization'), false);
  for (const call of calls) { assert.equal(call.credentials, 'omit'); assert.equal(call.redirect, 'error'); }
});

test('query controls preserve falsey values and do not mutate callers', async () => {
  const calls = [];
  const client = clientWith(async (url, options) => { calls.push({ url: new URL(url), options }); return reply([]); });
  const query = { text: 'a & b / ü', $refDepth: 3, $limit: 9 };
  await itemsOf(client).find(query, { refDepth: 0, limit: 0, offset: 0, sortBy: 'value', sort: 'desc' });
  await itemsOf(client).search(query, { refDepth: 0 });
  assert.deepEqual(JSON.parse(calls[0].url.searchParams.get('q')), query);
  for (const key of ['refDepth', 'limit', 'offset']) assert.equal(calls[0].url.searchParams.get(key), '0');
  assert.deepEqual(JSON.parse(calls[1].options.body), query);
  assert.equal(query.$refDepth, 3);
});

test('session inputs and returned snapshots cannot mutate stored credentials', async () => {
  const input = structuredClone(session);
  const client = clientWith(async () => reply({}));
  client.setSession(input); input.user._id = 'mallory'; input.accessToken = 'tampered';
  const saved = client.getSession(); saved.user._id = 'bob';
  assert.deepEqual(client.getSession(), session);
  assert.throws(() => client.setSession({ ...session, accessToken: '' }), TypeError);
  assert.deepEqual(client.getSession(), session);
  client.logout();
  await assert.rejects(client.renew(), { code: 'NO_REFRESH_TOKEN' });
});

test('100 parallel expired requests share one renewal and preserve every distinct write', async () => {
  let renewals = 0, oldCalls = 0;
  const allRejected = deferred();
  const writes = [];
  const client = clientWith(async (url, options) => {
    if (url.endsWith('/renew')) { renewals++; await allRejected.promise; return reply(tokens); }
    if (options.headers.get('authorization') === 'Bearer old') {
      if (++oldCalls === 100) allRejected.resolve();
      return expired();
    }
    const body = JSON.parse(options.body); writes.push(body._id); return reply(body, 201);
  });
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) => itemsOf(client).insert({ _id: String(i) })));
  assert.equal(renewals, 1);
  assert.equal(oldCalls, 100);
  assert.equal(new Set(writes).size, 100);
  assert.deepEqual(results.map(row => row._id), Array.from({ length: 100 }, (_, i) => String(i)));
});

test('manual and automatic renewal share one pending refresh', async () => {
  const started = deferred(), release = deferred(); let renewals = 0;
  const client = clientWith(async (url, options) => {
    if (url.endsWith('/renew')) { renewals++; started.resolve(); await release.promise; return reply(tokens); }
    return options.headers.get('authorization') === 'Bearer old' ? expired() : reply({ _id: 'x' });
  });
  const read = itemsOf(client).get('x');
  await started.promise;
  const manual = client.renew(); release.resolve();
  assert.equal((await manual).accessToken, 'new');
  assert.equal((await read)._id, 'x');
  assert.equal(renewals, 1);
});

for (const status of [200, 401, 403]) test(`replacing identity during refresh (${status}) preserves the new session without replay`, async () => {
  const started = deferred(), release = deferred(); let objectCalls = 0;
  const client = clientWith(async url => {
    if (url.endsWith('/renew')) { started.resolve(); await release.promise; return reply(status === 200 ? tokens : { error: 'denied' }, status); }
    objectCalls++; return expired();
  });
  const pending = assert.rejects(itemsOf(client).insert({}), status === 200 ? { code: 'SESSION_CHANGED' } : { status });
  await started.promise;
  const next = { ...session, accessToken: 'bob', refreshToken: 'bob-refresh' };
  client.setSession(next); release.resolve(); await pending;
  assert.deepEqual(client.getSession(), next);
  assert.equal(objectCalls, 1);
});

test('out-of-order login responses cannot overwrite the latest login', async () => {
  const first = deferred();
  const client = clientWith(async (_url, options) => {
    if (JSON.parse(options.body).username === 'alice') { await first.promise; return reply(tokens); }
    return reply({ accessToken: 'bob', refreshToken: 'bob-refresh' });
  });
  const stale = assert.rejects(client.login({ username: 'alice', password: 'a' }), { code: 'SESSION_CHANGED' });
  await client.login({ username: 'bob', password: 'b' });
  first.resolve(); await stale;
  assert.equal(client.getSession().accessToken, 'bob');
});

for (const method of ['insert', 'replace', 'patch', 'remove']) test(`${method} surfaces HTTP errors without retrying`, async () => {
  for (const status of [400, 401, 403, 409, 413, 415, 429, 500, 501, 503]) {
    let calls = 0;
    const client = clientWith(async () => { calls++; return reply({ error: 'rejected', code: 'TEST_ERROR' }, status, { 'retry-after': '10' }); });
    const items = itemsOf(client);
    const operation = method === 'insert' ? items.insert({}) : method === 'remove' ? items.remove('x') : items[method]('x', {});
    await assert.rejects(operation, error => {
      assert.ok(error instanceof ObjyDBError);
      assert.equal(error.status, status); assert.equal(error.code, 'TEST_ERROR');
      assert.equal(error.headers['retry-after'], '10');
      assert.equal(error.writeMayHaveSucceeded, status >= 500 && status !== 501);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('malformed JSON and non-JSON error responses retain useful error information', async () => {
  const client = clientWith(async () => new Response('not-json', { status: 200 }));
  await assert.rejects(itemsOf(client).get('x'), { code: 'INVALID_RESPONSE', writeMayHaveSucceeded: false });
  await assert.rejects(itemsOf(client).insert({}), { code: 'INVALID_RESPONSE', writeMayHaveSucceeded: true });
  const failed = clientWith(async () => new Response('proxy unavailable', { status: 502 }));
  await assert.rejects(itemsOf(failed).get('x'), { status: 502, message: 'proxy unavailable', writeMayHaveSucceeded: false });
});

test('all committed import counts mark partial failures while skipped counts do not', async () => {
  for (const operation of ['inserted', 'replaced', 'updated', 'deleted']) {
    for (const count of [0, 2]) {
      const client = clientWith(async () => reply({ error: 'line failed', [operation]: count, skipped: 3 }, 400));
      await assert.rejects(itemsOf(client).import('invalid\n'), { status: 400, writeMayHaveSucceeded: count > 0 });
    }
  }
});

test('missing refresh tokens never trigger an automatic retry', async () => {
  let calls = 0;
  const client = clientWith(async () => { calls++; return expired(); });
  client.setSession({ ...session, refreshToken: undefined });
  await assert.rejects(itemsOf(client).insert({}), { status: 401 });
  assert.equal(calls, 1);
});

test('pre-cancelled writes never dispatch and invalid timeouts fail before sending', async () => {
  let calls = 0;
  const client = clientWith(async () => { calls++; return reply({}); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(itemsOf(client).insert({}, { signal: controller.signal }), { code: 'ABORTED', writeMayHaveSucceeded: false });
  for (const timeoutMs of [-1, Infinity, NaN]) await assert.rejects(itemsOf(client).get('x', { timeoutMs }), TypeError);
  assert.equal(calls, 0);
});

test('timeout while awaiting renewal does not replay or cancel a shared refresh', async () => {
  const release = deferred(); let writes = 0;
  const client = clientWith(async url => {
    if (url.endsWith('/renew')) { await release.promise; return reply(tokens); }
    writes++; return expired();
  });
  await assert.rejects(itemsOf(client).insert({}, { timeoutMs: 20 }), { code: 'TIMEOUT', writeMayHaveSucceeded: false });
  const refresh = client.renew(); release.resolve(); await refresh;
  assert.equal(writes, 1);
  assert.equal(client.getSession().accessToken, 'new');
});

test('multipart replay rebuilds FormData and preserves bytes, filename and snapshotted metadata', async () => {
  const sent = [];
  const client = clientWith(async (url, options) => {
    if (url.endsWith('/renew')) return reply(tokens);
    assert.equal(options.headers.has('content-type'), false);
    sent.push(options.body);
    return sent.length === 1 ? expired() : reply({ _id: 'file' });
  });
  const metadata = { _id: 'file', name: 'original' };
  const bytes = new Uint8Array([0, 255, 1, 128, 13, 10]);
  const pending = itemsOf(client).insertFile(metadata, new Blob([bytes], { type: 'application/octet-stream' }), {
    filename: 'résumé.bin', headers: { 'content-type': 'wrong/boundary' },
  });
  metadata.name = 'mutated'; await pending;
  assert.equal(sent.length, 2); assert.notEqual(sent[0], sent[1]);
  for (const form of sent) {
    assert.equal(JSON.parse(form.get('object')).name, 'original');
    assert.equal(form.get('file').name, 'résumé.bin');
    assert.deepEqual(new Uint8Array(await form.get('file').arrayBuffer()), bytes);
  }
});

test('array imports snapshot records and preserve the NDJSON replay body', async () => {
  const bodies = [];
  const client = clientWith(async (url, options) => {
    if (url.endsWith('/renew')) return reply(tokens);
    bodies.push(await options.body.text());
    assert.equal(options.headers.get('content-type'), 'application/x-ndjson');
    assert.equal(options.headers.get('prefer'), 'return=minimal');
    return bodies.length === 1 ? expired() : reply({ inserted: 1 });
  });
  const records = [{ _id: 'x', value: 1 }];
  const pending = itemsOf(client).import(records); records[0].value = 2; records.push({ _id: 'y' });
  await pending;
  assert.deepEqual(bodies, ['{"_id":"x","value":1}\n', '{"_id":"x","value":1}\n']);
});

test('iteration respects total limits, offset, early exit and invalid controls', async () => {
  const calls = [];
  const client = clientWith(async url => {
    const params = new URL(url).searchParams; calls.push(params);
    const offset = Number(params.get('offset')), limit = Number(params.get('limit'));
    return reply(Array.from({ length: Math.min(limit, 20 - offset) }, (_, i) => ({ _id: String(i + offset) })));
  });
  const items = itemsOf(client); const rows = [];
  for await (const row of items.iterate({}, { offset: 3, limit: 5, pageSize: 2 })) rows.push(row._id);
  assert.deepEqual(rows, ['3', '4', '5', '6', '7']);
  assert.deepEqual(calls.map(params => params.get('limit')), ['2', '2', '1']);
  calls.length = 0;
  for await (const _row of items.iterate({}, { limit: 0 })) assert.fail('zero limit yielded a row');
  assert.equal(calls.length, 0);
  for await (const _row of items.iterate({}, { pageSize: 2 })) break;
  assert.equal(calls.length, 1);
  for (const options of [{ pageSize: 0 }, { pageSize: 251 }, { pageSize: 1.5 }, { offset: -1 }, { limit: -1 }]) {
    await assert.rejects(items.iterate({}, options).next(), TypeError);
  }
  for (const query of [{ $aggregate: {} }, { $vector: {} }]) await assert.rejects(items.iterate(query).next(), TypeError);
});

test('cancelling a download cancels its underlying stream and clears the deadline', async () => {
  let cancelled, signal;
  const client = clientWith(async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ cancel(reason) { cancelled = reason; } }), { headers: { 'content-type': 'application/octet-stream' } });
  });
  const result = await itemsOf(client).download('x', { timeoutMs: 20 });
  assert.equal(result.headers.get('content-type'), 'application/octet-stream');
  await result.body.cancel('finished');
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(cancelled, 'finished'); assert.equal(signal.aborted, false);
});

test('an async import factory is bounded by the request deadline before any write is sent', { timeout: 2000 }, async () => {
  let calls = 0;
  const client = clientWith(async () => { calls++; return reply({}); });
  await assert.rejects(itemsOf(client).import(() => new Promise(() => {}), { timeoutMs: 20 }), { code: 'TIMEOUT', writeMayHaveSucceeded: false });
  assert.equal(calls, 0);
});

test('timeout during response parsing retains TIMEOUT even when fetch throws AbortError', async () => {
  const client = clientWith(async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) { signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true }); },
  })));
  await assert.rejects(itemsOf(client).insert({}, { timeoutMs: 20 }), { code: 'TIMEOUT', writeMayHaveSucceeded: true });
});
