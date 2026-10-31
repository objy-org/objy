import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createClient } from '@objy/db/client';
import { startServer } from '../src/server.js';
import { createFileService } from '../src/files.js';

const { sign } = createRequire(import.meta.url)('../src/lib/jwt.cjs');
const secret = 'client-integration-secret';
const expire = token => sign({ ...JSON.parse(Buffer.from(token.split('.')[1], 'base64url')), exp: 1 }, secret);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const collect = async iterator => { const rows = []; for await (const row of iterator) rows.push(row); return rows; };

async function setup(t, options = {}) {
  const files = createFileService({ mode: 'memory' });
  const server = await startServer({
    auth: { jwtSecret: secret, users: [{ _id: 'admin', username: 'admin', password: '123', role: 'admin', admin: true }] },
    files,
    ...options,
  });
  t.after(() => new Promise(resolve => { server.server.close(resolve); server.server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.port}`;
  const client = createClient({ url });
  await client.login({ username: 'admin', password: '123' });
  return { client, server, files, url, items: client.database('test').collection('items') };
}

test('binary files survive multi-megabyte upload, token renewal, replacement and physical cleanup', async t => {
  const { client, items, files } = await setup(t);
  const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, i) => (i * 31) % 256);
  const expired = client.getSession(); expired.accessToken = expire(expired.accessToken); client.setSession(expired);
  const object = await items.insertFile({ _id: 'binary', nested: { name: 'résumé' } }, new Blob([bytes], { type: 'application/octet-stream' }), { filename: 'résumé.bin' });
  const response = await items.download('binary');
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(Number(response.headers.get('content-length')), bytes.length);
  assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(bytes));
  assert.deepEqual((await items.get('binary')).nested, { name: 'résumé' });
  const replaced = await items.replaceFile('binary', { label: 'empty' }, new Blob([], { type: 'text/plain' }));
  assert.equal(await (await items.download('binary')).text(), '');
  assert.equal(await files.storage.getBlob(object._file.key), null);
  assert.notEqual(replaced._file.key, object._file.key);
  await items.remove('binary');
  assert.equal(await files.storage.getBlob(replaced._file.key), null);
  await assert.rejects(items.download('binary'), { status: 404 });
});

test('file metadata edits retain bytes and dropping scopes cleans up only their own files', async t => {
  const { client, items, files } = await setup(t);
  const other = client.database('other').collection('items');
  const kept = await other.insertFile({ _id: 'keep' }, new Blob(['keep']));
  const file = await items.insertFile({ _id: 'x', label: 'before' }, new Blob(['original']));
  await items.replace('x', { ...file, label: 'after' });
  await items.patch('x', { $set: { label: 'patched' } });
  assert.equal(await (await items.download('x')).text(), 'original');
  await items.drop();
  assert.equal(await files.storage.getBlob(file._file.key), null);
  assert.ok(await files.storage.getBlob(kept._file.key));
  await client.database('other').drop();
  assert.equal(await files.storage.getBlob(kept._file.key), null);
});

test('invalid file writes and duplicate uploads do not overwrite existing bytes', async t => {
  const { items, files } = await setup(t);
  await items.insertFile({ _id: 'x' }, new Blob(['original']));
  await assert.rejects(items.insertFile({ _id: 'x' }, new Blob(['duplicate'])), { status: 409 });
  await assert.rejects(items.insertFile({ _id: 'bad', _file: { key: 'forged' } }, new Blob(['bad'])), { status: 400 });
  assert.equal(await (await items.download('x')).text(), 'original');
  assert.equal((await files.storage.list()).length, 1);
  await items.insert({ _id: 'ordinary' });
  await assert.rejects(items.download('ordinary'), { status: 404 });
});

test('100 concurrent real HTTP writes renew once and remain isolated across databases', async t => {
  const { client, url } = await setup(t);
  const session = client.getSession(); session.accessToken = expire(session.accessToken);
  let renewals = 0;
  const tracked = createClient({ url, session, fetch: (url, options) => {
    if (url.endsWith('/renew')) renewals++;
    return fetch(url, options);
  } });
  const handles = ['a', 'b'].map(name => tracked.database(name).collection('items'));
  await Promise.all(Array.from({ length: 100 }, (_, i) => handles[i % 2].insert({ _id: String(i), value: i })));
  assert.equal(renewals, 1);
  assert.deepEqual(await Promise.all(handles.map(items => items.count())), [50, 50]);
  for (const [index, items] of handles.entries()) {
    const rows = await collect(items.iterate({}, { pageSize: 17 }));
    assert.equal(rows.length, 50); assert.equal(new Set(rows.map(row => row._id)).size, 50);
    assert.ok(rows.every(row => row.value % 2 === index));
  }
});

test('large NDJSON imports support bounded iteration, query controls and all mutation variants', async t => {
  const { items } = await setup(t);
  const count = 1200;
  assert.equal((await items.import(async function* () {
    for (let n = 0; n < count; n++) yield { _id: `row-${String(n).padStart(4, '0')}`, n, stale: true };
  })).inserted, count);
  const rows = await collect(items.iterate({}, { pageSize: 127 }));
  assert.equal(rows.length, count); assert.equal(new Set(rows.map(row => row._id)).size, count);
  const page = await collect(items.iterate({ $sort: { n: -1 }, $limit: 1 }, { pageSize: 3, offset: 4, limit: 7 }));
  assert.deepEqual(page.map(row => row.n), [1195, 1194, 1193, 1192, 1191, 1190, 1189]);
  const ids = Array.from({ length: 40 }, (_, i) => `row-${String(i).padStart(4, '0')}`);
  assert.equal((await items.replaceMany(ids.map(_id => ({ _id, n: -1 })), { minimal: true })).replaced, 40);
  assert.equal((await items.patchMany(ids.map(_id => ({ _id, $set: { changed: true }, $unset: ['n'] })), { minimal: true })).updated, 40);
  assert.equal(await items.count({ changed: true }), 40);
  assert.deepEqual(await items.get(ids[0]), { _id: ids[0], changed: true });
  assert.equal((await items.removeMany(ids, { minimal: true })).deleted, 40);
  assert.equal(await items.count(), count - 40);
});

test('NDJSON streamed, string and Blob updates preserve native skipped counts', async t => {
  const { items } = await setup(t);
  await items.import([{ _id: 'x', n: 1 }, { _id: 'y', n: 2 }]);
  assert.equal((await items.import(new Blob(['{"_id":"x","n":3}\n']), { operation: 'replace' })).replaced, 1);
  const patched = await items.import(async function* () {
    yield { _id: 'x', $set: { n: 4 } }; yield { _id: 'missing', $set: { n: 5 } };
  }, { operation: 'patch' });
  assert.deepEqual(patched, { updated: 1, skipped: 1 });
  assert.equal((await items.get('x')).n, 4);
  const removed = await items.import('{"_id":"x"}\n{"_id":"missing"}\n', { operation: 'remove' });
  assert.deepEqual(removed, { deleted: 1, skipped: 1 });
  assert.equal(await items.count(), 1);
});

test('malformed NDJSON and duplicate bulk IDs surface native errors without hidden individual retries', async t => {
  const { items } = await setup(t);
  await assert.rejects(items.import('{"_id":"uncommitted"}\n{bad json}\n'), error => {
    assert.equal(error.status, 400); assert.equal(error.body.line, 2); return true;
  });
  await assert.rejects(items.get('uncommitted'), { status: 404 });
  await assert.rejects(items.insertMany([{ _id: 'duplicate' }, { _id: 'duplicate' }]), { status: 400 });
  assert.equal(await items.count(), 0);
});

test('a failed import reports committed earlier chunks as a potentially successful write', async t => {
  const { items } = await setup(t, { imports: { maxBulkObjects: 2 } });
  await assert.rejects(items.import('{"_id":"one"}\n{"_id":"two"}\n{invalid}\n'), error => {
    assert.equal(error.status, 400);
    assert.equal(error.body.inserted, 2);
    assert.equal(error.body.line, 3);
    assert.equal(error.writeMayHaveSucceeded, true);
    return true;
  });
  assert.equal(await items.count(), 2);
});

test('database-scoped authentication renews at the correct endpoint and keeps its permissions', async t => {
  const { client, url } = await setup(t);
  await client.createDatabase('owned', { adminUser: { username: 'owner', password: 'owner-secret' } });
  const owner = createClient({ url });
  const loggedIn = await owner.login({ database: 'owned', username: 'owner', password: 'owner-secret' });
  assert.equal(loggedIn.user.password, undefined);
  const session = owner.getSession(); session.accessToken = expire(session.accessToken); owner.setSession(session);
  await owner.database('owned').collection('items').insert({ _id: 'mine' });
  assert.equal(owner.getSession().database, 'owned');
  assert.equal(owner.getSession().collection, 'users');
  await assert.rejects(owner.database('other').collection('items').insert({ _id: 'forbidden' }), { status: 403 });
  assert.ok(owner.getSession());
});

test('a lost acknowledgement after a real write produces uncertainty and no duplicate request', async t => {
  let writes = 0;
  const server = createServer(async req => {
    for await (const _chunk of req) { /* Drain the complete write before losing the response. */ }
    writes++; req.socket.destroy();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const client = createClient({ url: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(client.database('app').collection('items').insert({ _id: 'once' }), { code: 'NETWORK_ERROR', writeMayHaveSucceeded: true });
  assert.equal(writes, 1);
});

test('independent clients keep login, renewal and logout state isolated', async t => {
  const { client, url, items } = await setup(t);
  await items.insert({ _id: 'x' });
  const other = createClient({ url });
  await assert.rejects(other.database('test').collection('items').get('x'), { status: 401 });
  await other.login({ username: 'admin', password: '123' });
  client.logout();
  assert.equal((await other.database('test').collection('items').get('x'))._id, 'x');
  const snapshot = other.getSession(); await other.renew();
  assert.equal(client.getSession(), null);
  assert.equal(other.getSession().database, snapshot.database);
});

test('native browser module HEAD, ETag and CORS denials follow the public contract', async t => {
  const { url } = await setup(t, { cors: { origins: ['https://allowed.example'] } });
  const head = await fetch(url + '/client.js', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.ok(head.headers.get('etag')); assert.match(head.headers.get('link'), /client\/.+\.js/);
  const unchanged = await fetch(url + '/client.js', { headers: { 'if-none-match': head.headers.get('etag') } });
  assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), '');
  const denied = await fetch(url + '/api/test/items/object', { method: 'OPTIONS', headers: {
    origin: 'https://allowed.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-not-allowed',
  } });
  assert.equal(denied.status, 403);
  const unknown = await fetch(url + '/client/not-a-current-hash.js');
  assert.equal(unknown.status, 404);
});

test('redirected authenticated writes never reach a second origin', async t => {
  let forwarded = 0;
  const target = createServer((_req, res) => { forwarded++; res.end('{}'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const source = createServer((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/stolen` }); res.end(); });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const server of [source, target]) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  const client = createClient({ url: `http://127.0.0.1:${source.address().port}`, session: { database: 'auth', collection: 'users', accessToken: 'secret' } });
  await assert.rejects(client.database('app').collection('items').insert({ private: true }), { code: 'NETWORK_ERROR', writeMayHaveSucceeded: true });
  assert.equal(forwarded, 0);
});
