import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'test/e2e', timeout: 60_000, retries: 0, reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4455', trace: 'retain-on-failure' },
  projects: [{ name: 'mobile-webkit', use: { ...devices['iPhone 13'], browserName: 'webkit' }, testMatch: /mobile\.spec\.ts/ }, { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile/ }, { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium' }, testMatch: /mobile\.spec\.ts/ }],
  webServer: { command: 'node examples/plain-html/server.mjs', url: 'http://127.0.0.1:4455/', reuseExistingServer: false, env: { PORT: '4455', BUGFRAME_DIR: '.e2e-reports', BUGFRAME_ADMIN_TOKEN: 'demo-admin-token', BUGFRAME_DEMO_PASSWORD: 'e2e-test-password', BUGFRAME_DEMO_ADMIN_PASSWORD: 'e2e-admin-password', BUGFRAME_DEMO_CUSTOMER_PASSWORD: 'e2e-customer-password', BUGFRAME_DEMO_LOGIN_LIMIT: '100' } },
});
