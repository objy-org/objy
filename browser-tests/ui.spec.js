import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// CI runs the same authenticated, disposable-server suite used for manual checks.
// Each browser gets its own server, origin, credentials and in-memory database.
test('integrated database UI: connection, CRUD, queries, metadata, nodes and reload', async ({ page }) => {
  test.setTimeout(90_000);
  const child = spawn(process.execPath, ['ui/scripts/browser-tests.mjs', '--skip-build'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.once('exit', code => reject(new Error(`Runner exited ${code}: ${output}`)));
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Browser regression tests: (http:\/\/127\.0\.0\.1:\d+\/__qa\/)/);
      if (match) resolve(match[1]);
    });
    child.stderr.on('data', chunk => { output += chunk; });
  });
  try {
    await page.goto(await ready);
    await page.getByRole('button', { name: 'Run checks', exact: true }).click();
    await expect(page.locator('#status')).toHaveAttribute('data-result', /passed|failed/, { timeout: 75_000 });
    expect(await page.locator('#status').getAttribute('data-result'), await page.locator('#results').innerText()).toBe('passed');
    await expect(page.locator('#status')).toHaveText('16 passed, 0 failed. Server state verified.');
    expect(await exited, output).toBe(0);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
  }
});

// Exercise real trusted clicks and pop-up navigation, beyond the regression
// harness's intercepted window.open/save boundary. Each test owns its server.
test('attachments open native image, text and PDF tabs through authenticated downloads', async ({ page, context }) => {
  const { testServer } = await import('../ui/tests/helpers/server.mjs');
  const { createServerAdapter } = await import('../ui/src/data/adapters.js');
  const { createFileService } = await import('../src/files.js');
  const { png, pdf } = await import('../ui/tests/helpers/attachment-fixtures.mjs');
  const backend = await testServer({ files: createFileService({ mode: 'memory' }),
    auth: { enabled: true }, environment: { OBJYDB_ADMIN_PASSWORD: 'native-tabs-only' } });
  const adapter = createServerAdapter({ url: backend.url, username: 'admin', password: 'native-tabs-only' });
  try {
    await adapter.open();
    await adapter.createDatabase('native_tabs');
    await adapter.createCollection('native_tabs', 'files');
    await adapter.insertFile('native_tabs', 'files', { _id: 'picture', name: 'pixel.png' }, new File([png], 'pixel.png', { type: 'image/png' }));
    await adapter.insertFile('native_tabs', 'files', { _id: 'text', name: 'note.txt' }, new File(['Native attachment text'], 'note.txt', { type: 'text/plain' }));
    await adapter.insertFile('native_tabs', 'files', { _id: 'pdf', name: 'document.pdf' }, new File([pdf], 'document.pdf', { type: 'application/pdf' }));
    await page.goto(backend.url);
    await page.locator('#connection-control').click();
    await page.locator('[name=username]').fill('admin');
    await page.locator('[name=password]').fill('native-tabs-only');
    await page.locator('.modal [type=submit]').click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await page.locator('[aria-label="native_tabs, database"]').click();
    await page.locator('[aria-label="files, collection"]').click();
    for (const id of ['picture', 'text', 'pdf']) {
      await page.locator(`[aria-label="${id}"]`).click();
      const nextTab = context.waitForEvent('page').then(tab => ({ tab,
        opened: id === 'pdf' ? Promise.any([
          tab.waitForURL(/^blob:/).then(() => null),
          tab.waitForEvent('download'), // Some browser configurations save PDFs.
        ]) : tab.waitForURL(/^blob:/),
      }));
      await page.locator('[data-open-file]').click();
      const { tab, opened } = await nextTab;
      try {
        const download = await opened;
        await expect(page.locator('.modal')).toHaveCount(0);
        if (download) { expect(await download.failure()).toBeNull(); continue; }
        expect(await tab.evaluate(() => window.opener)).toBeNull();
        if (id === 'picture') await expect.poll(() => tab.locator('img').evaluate(img => img.naturalWidth)).toBe(1);
        if (id === 'text') await expect(tab.locator('body')).toContainText('Native attachment text');
      } finally { await tab.close(); }
    }
  } finally {
    await adapter.close();
    await backend.close();
  }
});
