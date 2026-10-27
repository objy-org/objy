import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { startServer } from '../src/server.js';
import { createFileService } from '../src/files.js';
import { createClient } from '../client/index.js';

const { sign } = createRequire(import.meta.url)('../src/lib/jwt.cjs');
const secret = 'ui-client-secret';
const auth = { jwtSecret: secret, users: [{ _id: 'admin', username: 'admin', password: '123', role: 'admin', admin: true }] };
const expired = token => sign({ ...JSON.parse(Buffer.from(token.split('.')[1], 'base64url')), exp: 1 }, secret);
let server, base, admin, renewals;

test.beforeEach(async () => {
  renewals = 0;
  server = await startServer({ auth, files: createFileService({ mode: 'memory' }), cors: { origins: ['*'] } });
  server.server.on('request', req => { if (req.method === 'POST' && req.url.endsWith('/renew')) renewals++; });
  base = `http://127.0.0.1:${server.port}`;
  admin = createClient({ url: base });
  await admin.login({ username: 'admin', password: '123' });
});
test.afterEach(async () => {
  await new Promise(resolve => { server.server.close(resolve); server.server.closeAllConnections(); });
});

async function login(page) {
  const module = page.waitForResponse(response => response.url() === base + '/client.js');
  await page.goto(base + '/ui');
  expect((await module).status()).toBe(200);
  await page.locator('#login-btn').click();
  await expect(page.locator('#login-panel')).toBeHidden();
  await expect(page.locator('#tree')).toContainText('_global');
}

async function savedSession(page, session) {
  await page.goto(base + '/ui');
  // Startup health handling persists the current session; let it finish before seeding storage.
  await expect(page.locator('#node-label')).toContainText('node ');
  await page.evaluate(session => localStorage.setItem('spread-db-ui:session', JSON.stringify(session)), session);
}

test('API documentation renders its public GitHub header image', async ({ page }) => {
  await page.goto(base + '/ui');
  await page.locator('#api-docs-btn').click();
  await expect(page.locator('#api-docs-modal')).toBeVisible();
  const logo = page.locator('#api-docs-view img[alt="OBJY DB"]');
  await expect(logo).toHaveCount(1);
  await expect(logo).toHaveAttribute(
    'src',
    'https://raw.githubusercontent.com/spoo-technologies/objy-db/main/public/branding/objy-db-header-deep-field.png',
  );
});

test('UI uses the client for administration, JSON and bulk CRUD, queries, metadata and files', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);
  await page.locator('#add-db-btn').click();
  await page.locator('#db-name').fill('ui');
  await page.locator('#db-modal-save').click();
  await expect(page.locator('#db-modal')).toBeHidden();
  await page.locator('#add-coll-btn').click();
  await page.locator('#collection-db').fill('ui');
  await page.locator('#collection-name').fill('items');
  await page.locator('#collection-modal-save').click();
  await expect(page.locator('#breadcrumb')).toContainText('items');
  await expect(page.locator('#objects')).toContainText('No matching objects');

  await page.locator('#edit-meta-btn').click();
  await page.locator('#meta-json').fill('{"indexes":["n"]}');
  await page.locator('#meta-modal-save').click();
  await expect(page.locator('#collection-meta')).toContainText('indexes: n');

  await page.locator('#add-object-btn').click();
  await page.locator('#object-id').fill('one');
  await page.locator('#object-json').fill('{"n":1}');
  await page.locator('#object-modal-save').click();
  await expect(page.locator('#detail-title')).toHaveText('Object one');
  await page.locator('#edit-object-btn').click();
  await page.locator('#object-json').fill('{"n":2}');
  await page.locator('#object-modal-save').click();
  await expect(page.locator('#detail')).toContainText('2');

  await page.locator('#add-object-btn').click();
  await page.locator('#object-json').fill(JSON.stringify(Array.from({ length: 26 }, (_, i) => ({ _id: `bulk-${i}`, n: i }))));
  await page.locator('#object-modal-save').click();
  await expect(page.locator('#object-count')).toHaveText('1-27 shown');
  await page.locator('#limit').selectOption('25');
  await page.locator('#load-objects-btn').click();
  await expect(page.locator('#object-count')).toHaveText('1-25 shown');
  await page.locator('#next-page-btn').click();
  await expect(page.locator('#object-count')).toHaveText('26-27 shown');
  await page.locator('#query').fill('{"_id":"one"}');
  await page.locator('#load-objects-btn').click();
  await expect(page.locator('#object-count')).toHaveText('1-1 shown');

  await page.locator('#query').fill('{"$aggregate":{"fields":{"count":{"$count":true}}}}');
  await page.locator('#load-objects-btn').click();
  await expect(page.locator('#detail')).toContainText('27');
  await page.locator('#query').fill('{}');
  await page.locator('#load-objects-btn').click();
  await expect(page.locator('#object-count')).toHaveText('1-25 shown');

  await page.locator('#add-object-btn').click();
  await page.locator('#object-id').fill('document');
  await page.locator('#object-json').fill('{"name":"notes.txt"}');
  await page.locator('#object-file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello from UI') });
  await page.locator('#object-modal-save').click();
  await expect(page.locator('#object-modal')).toBeHidden();
  await page.locator('#query').fill('{"_id":"document"}');
  await page.locator('#load-objects-btn').click();
  await expect(page.locator('#detail-title')).toHaveText('Object document');
  await page.locator('#edit-object-btn').click();
  await page.locator('#object-file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('revised from UI') });
  await page.locator('#object-modal-save').click();
  await expect(page.locator('#object-modal')).toBeHidden();
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#download-file-btn').click();
  const popup = await popupPromise;
  await expect(popup.locator('body')).toContainText('revised from UI');
  await popup.close();
  await page.locator('#delete-object-btn').click();
  await page.locator('#delete-object-confirm').click();
  await expect(page.locator('#objects')).toContainText('No matching objects');

  const block = page.locator('.db-block').filter({ has: page.locator('.db-name').getByText('ui', { exact: true }) });
  await block.locator('[title="Delete collection"]').click();
  await page.locator('#delete-collection-confirm').click();
  await expect(block.locator('.coll-row')).toHaveCount(0);
  await block.locator('[title="Delete database"]').click();
  await page.locator('#delete-collection-confirm').click();
  await expect(block).toHaveCount(0);
  await page.locator('#renew-btn').click();
  await expect(page.locator('#toast')).toContainText('Token renewed');
  expect(errors).toEqual([]);
});

test('legacy saved sessions migrate and parallel startup requests share renewal', async ({ page }) => {
  const session = admin.getSession();
  const token = expired(session.accessToken);
  await savedSession(page, { accessToken: token, refreshToken: session.refreshToken, user: session.user, authDb: '_global', authColl: 'users' });
  await page.reload();
  await expect(page.locator('#login-panel')).toBeHidden();
  await expect(page.locator('#tree')).toContainText('_global');
  await expect.poll(() => renewals).toBe(1);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('spread-db-ui:session')));
  expect(saved.accessToken).not.toBe(token);
  expect(saved.database).toBe('_global');
  expect(saved.collection).toBe('users');
  expect(saved.authDb).toBeUndefined();
  await page.reload();
  await expect(page.locator('#tree')).toContainText('_global');
  expect(renewals).toBe(1);
});

test('invalid refresh tokens clear the visible and persisted session', async ({ page }) => {
  const session = admin.getSession();
  await savedSession(page, { ...session, accessToken: expired(session.accessToken), refreshToken: expired(session.refreshToken) });
  await page.reload();
  await expect(page.locator('#toast')).toContainText('Session expired');
  await expect(page.locator('#login-panel')).toBeVisible();
  await expect(page.locator('#logout-btn')).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem('spread-db-ui:session'))).toBeNull();
});

test('logging out while renewal is in flight cannot restore old views or tokens', async ({ page }) => {
  const session = admin.getSession();
  await savedSession(page, { ...session, accessToken: expired(session.accessToken) });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let started;
  const begun = new Promise(resolve => { started = resolve; });
  await page.route('**/users/renew', async route => {
    const response = await route.fetch();
    started(); await pending;
    await route.fulfill({ response });
  });
  await page.reload();
  await begun;
  await page.locator('#logout-btn').click();
  release();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#login-panel')).toBeVisible();
  await expect(page.locator('#tree')).toHaveText('Sign in to load databases.');
  expect(await page.evaluate(() => localStorage.getItem('spread-db-ui:session'))).toBeNull();
});

test('switching servers replaces the client without forwarding the old session', async ({ page }) => {
  await login(page);
  const remote = await startServer({ auth, cors: { origins: ['*'] } });
  const headers = [];
  remote.server.on('request', req => headers.push(req.headers.authorization));
  try {
    const url = `http://127.0.0.1:${remote.port}`;
    page.once('dialog', dialog => dialog.accept(url));
    await page.locator('#server-label').click();
    await expect(page.locator('#login-panel')).toBeVisible();
    await expect(page.locator('#server-label')).toContainText(String(remote.port));
    await expect.poll(() => headers.length).toBeGreaterThan(0);
    expect(headers.every(value => value === undefined)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('spread-db-ui:session'))).toBeNull();
    await page.locator('#password').fill('123');
    await page.locator('#login-btn').click();
    await expect(page.locator('#tree')).toContainText('_global');
  } finally {
    await new Promise(resolve => { remote.server.close(resolve); remote.server.closeAllConnections(); });
  }
});
