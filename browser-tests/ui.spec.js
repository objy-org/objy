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
    await expect(page.locator('#status')).toHaveAttribute('data-result', 'passed', { timeout: 75_000 });
    await expect(page.locator('#status')).toHaveText('15 passed, 0 failed. Server state verified.');
    expect(await exited, output).toBe(0);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
  }
});
