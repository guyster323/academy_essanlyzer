import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30 * 1000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } }
  ],
  webServer: {
    command: 'npm run dev:client',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30 * 1000
  }
});
