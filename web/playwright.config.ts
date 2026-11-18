import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests drive a real browser because the things most likely to break
 * here — pointer capture during a drag, wheel zoom, file drop, clipboard paste —
 * have no meaningful unit-test equivalent. See docs/development/TESTING.md.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
