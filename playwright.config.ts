import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against a production build with a throw-away data directory.
// Behind an HTTPS proxy, run with NODE_USE_ENV_PROXY=1 so the server can reach providers.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 1,
  use: { baseURL: 'http://localhost:8799' },
  webServer: {
    command: 'rm -rf ./data/e2e && npm run build >/dev/null && ELF_PORT=8799 ELF_DATA_DIR=./data/e2e ELF_ALLOW_NO_PASSWORD=1 NODE_ENV=production npx tsx src/server/index.ts',
    url: 'http://localhost:8799/api/health',
    timeout: 180_000,
    reuseExistingServer: false,
  },
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
});
