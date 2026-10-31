import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser-tests',
  fullyParallel: true,
  projects: ['chromium', 'firefox', 'webkit'].map(browserName => ({
    name: browserName,
    use: {
      browserName,
      ...(browserName === 'chromium'
        ? { launchOptions: { args: ['--enable-precise-memory-info'] } }
        : {}),
    },
  })),
});
