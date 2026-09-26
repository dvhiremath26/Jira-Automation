import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One result per key, with no retry-pass ambiguity in Xray.
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  reporter: [
    ['html', { outputFolder: 'TCOE-Report', open: 'never' }],
    // In the pinned Playwright version, static annotations become JUnit properties.
    // A test_key property maps to an existing Xray Test; a title/tag alone does not.
    ['junit', { outputFile: 'results/xray-results.xml', stripANSIControlSequences: true }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
