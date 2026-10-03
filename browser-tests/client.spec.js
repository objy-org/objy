import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { startServer } from '../src/server.js';
import { createFileService } from '../src/files.js';
import { clientPath } from '../src/interfaces/client.js';

const { sign } = createRequire(import.meta.url)('../src/lib/jwt.cjs');
let server, app, base, appUrl, renewals;
const secret = 'browser-client-secret';

test.beforeAll(async () => {
  renewals = 0;
  server = await startServer({ auth: { jwtSecret: secret }, cors: { origins: ['*'] }, files: createFileService({ mode: 'memory' }) });
  server.server.on('request', req => { if (req.method === 'POST' && req.url.endsWith('/renew')) renewals++; });
  base = `http://127.0.0.1:${server.port}`;
  app = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Client integration test</title>'); });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${app.address().port}`;
});
test.afterAll(async () => {
  for (const listener of [server?.server, app]) if (listener) {
    await new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); });
  }
});

async function connect(page, path = '/client.js') {
  await page.goto(appUrl);
  await page.evaluate(async url => {
    const { createClient } = await import(url);
    window.client = createClient();
    await client.login({ username: 'admin', password: '123' });
  }, base + path);
}

test('cross-origin URL import, CRUD, search, bulk, pagination, metadata and isolation', async ({ page }) => {
  await connect(page);
  const result = await page.evaluate(async () => {
    await client.createDatabase('browser');
    const db = client.database('browser');
    await db.createCollection('items', { indexes: ['n'] });
    const items = db.collection('items');
    await items.insert({ _id: 'a', n: 1 });
    await items.replace('a', { n: 2 });
    await items.patch('a', { $set: { n: 3 } });
    await items.insertMany([{ _id: 'b', n: 4 }, { _id: 'c', n: 5 }]);
    const values = [];
    for await (const row of items.iterate({}, { pageSize: 2 })) values.push(row.n);
    const filtered = await items.find({ n: { $gte: 4 } });
    const meta = await items.getMeta();
    await items.remove('a');
    return { values, filtered: filtered.length, count: await items.count(), indexes: meta.indexes };
  });
  expect(result).toEqual({ values: [3, 4, 5], filtered: 2, count: 2, indexes: ['n'] });
});

test('expired access token renews once across simultaneous browser writes', async ({ page }) => {
  await connect(page, clientPath);
  const session = await page.evaluate(() => client.getSession());
  session.accessToken = sign({ ...JSON.parse(Buffer.from(session.accessToken.split('.')[1], 'base64url')), exp: 1 }, secret);
  const initial = renewals;
  const result = await page.evaluate(async session => {
    client.setSession(session);
    const items = client.database('renew').collection('items');
    await Promise.all(Array.from({ length: 8 }, (_, i) => items.insert({ _id: String(i) })));
    return { count: await items.count(), token: client.getSession().accessToken };
  }, session);
  expect(result.count).toBe(8);
  expect(result.token).not.toBe(session.accessToken);
  expect(renewals - initial).toBe(1);
});

test('browser multipart files, NDJSON files, reference depth and errors', async ({ page }) => {
  await connect(page);
  const result = await page.evaluate(async () => {
    const items = client.database('files').collection('items');
    await items.insertFile({ _id: 'document' }, new File(['hello browser'], 'hello.txt', { type: 'text/plain' }));
    const text = await (await items.download('document')).text();
    await items.import(new Blob(['{"_id":"imported","n":1}\n']));
    await items.import([{ _id: 'array', n: 2 }]);
    await items.insert({ _id: 'ref', related: { type: 'reference', collection: 'items', value: 'document' } });
    const expanded = await items.get('ref');
    const unexpanded = await items.search({ _id: 'ref', $refDepth: 0 });
    let status;
    try { await items.get('missing'); } catch (error) { status = error.status; }
    return { text, count: await items.count(), related: expanded.related.object._id, unexpanded: unexpanded[0].related.object, status };
  });
  expect(result).toEqual({ text: 'hello browser', count: 4, related: 'document', unexpanded: undefined, status: 404 });
});

test('binary uploads survive renewal, replacement with an empty file and deletion', async ({ page }) => {
  await connect(page);
  const session = await page.evaluate(() => client.getSession());
  session.accessToken = sign({ ...JSON.parse(Buffer.from(session.accessToken.split('.')[1], 'base64url')), exp: 1 }, secret);
  const result = await page.evaluate(async session => {
    client.setSession(session);
    const items = client.database('binary').collection('items');
    const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 31) % 256);
    await items.insertFile({ _id: 'binary', label: 'résumé' }, new File([bytes], 'résumé.bin', { type: 'application/octet-stream' }));
    const response = await items.download('binary');
    const received = new Uint8Array(await response.arrayBuffer());
    const intact = received.length === bytes.length && received.every((value, i) => value === bytes[i]);
    const object = await items.get('binary');
    await items.replaceFile('binary', { label: 'empty' }, new Blob([], { type: 'text/plain' }));
    const empty = await (await items.download('binary')).text();
    await items.remove('binary');
    let deletedStatus;
    try { await items.download('binary'); } catch (error) { deletedStatus = error.status; }
    return { intact, label: object.label, type: response.headers.get('content-type'), empty, deletedStatus };
  }, session);
  expect(result).toEqual({ intact: true, label: 'résumé', type: 'application/octet-stream', empty: '', deletedStatus: 404 });
});

test('imported module infers a reverse-proxy prefix with both URL forms', async ({ page }) => {
  const paths = [];
  await page.route(appUrl + '/proxy/**', async route => {
    const path = new URL(route.request().url()).pathname;
    paths.push(path);
    const response = await route.fetch({ url: base + route.request().url().slice((appUrl + '/proxy').length) });
    await route.fulfill({ response });
  });
  await page.goto(appUrl);
  const result = await page.evaluate(async paths => {
    const ids = [];
    for (const [index, path] of paths.entries()) {
      const { createClient } = await import(path + '?version=test#module');
      const client = createClient();
      await client.login({ username: 'admin', password: '123' });
      const items = client.database('proxy').collection('items');
      await items.insert({ _id: String(index) });
      ids.push((await items.get(String(index)))._id);
    }
    return ids;
  }, [appUrl + '/proxy/client.js', appUrl + '/proxy' + clientPath]);
  expect(result).toEqual(['0', '1']);
  expect(paths.filter(path => path.includes('/auth'))).toEqual(['/proxy/api/_global/users/auth', '/proxy/api/_global/users/auth']);
  expect(paths.some(path => path === '/proxy/api/proxy/items/object/1')).toBe(true);
});

test('browser deadlines cover factories, response parsing and cancellation before dispatch', async ({ page }) => {
  await connect(page);
  const result = await page.evaluate(async url => {
    const { createClient } = await import(url);
    let calls = 0;
    const client = createClient({ url, fetch: async (_url, { signal }) => {
      calls++;
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      } }));
    } });
    const items = client.database('cancel').collection('items');
    const outcome = async promise => { try { await promise; return null; } catch (error) { return { code: error.code, uncertain: error.writeMayHaveSucceeded }; } };
    const controller = new AbortController(); controller.abort();
    const cancelled = await outcome(items.insert({}, { signal: controller.signal }));
    const factory = await outcome(items.import(() => new Promise(() => {}), { timeoutMs: 20 }));
    const body = await outcome(items.insert({}, { timeoutMs: 20 }));
    return { cancelled, factory, body, calls };
  }, base + '/client.js');
  expect(result).toEqual({ cancelled: { code: 'ABORTED', uncertain: false }, factory: { code: 'TIMEOUT', uncertain: false }, body: { code: 'TIMEOUT', uncertain: true }, calls: 1 });
});

test('browser import and iteration cross multiple server pages without duplicates', async ({ page }) => {
  await connect(page);
  const result = await page.evaluate(async () => {
    const items = client.database('many').collection('items');
    const records = Array.from({ length: 600 }, (_, n) => ({ _id: String(n).padStart(4, '0'), n }));
    const imported = await items.import(new Blob(records.map(row => JSON.stringify(row) + '\n')));
    const ids = [];
    for await (const row of items.iterate({}, { pageSize: 127 })) ids.push(row._id);
    const subset = [];
    for await (const row of items.iterate({ $sort: { n: -1 } }, { pageSize: 3, offset: 2, limit: 5 })) subset.push(row.n);
    await items.patchMany([{ _id: '0000', $set: { updated: true } }]);
    const updated = (await items.get('0000')).updated;
    return { imported: imported.inserted, count: ids.length, unique: new Set(ids).size, subset, updated };
  });
  expect(result).toEqual({ imported: 600, count: 600, unique: 600, subset: [597, 596, 595, 594, 593], updated: true });
});
