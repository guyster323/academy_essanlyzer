import { defineConfig, devices } from '@playwright/test';

// Sibling checkouts often occupy 5173. PW_PORT pins this worktree's Vite
// so tests do not silently reuse another tree's stale bundle.
const port = Number(process.env.PW_PORT || 5173);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30 * 1000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } }
  ],
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30 * 1000
  }
});
