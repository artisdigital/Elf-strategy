import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PW_CHROMIUM_PATH || (process.env.PLAYWRIGHT_BROWSERS_PATH ? undefined : undefined);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  use: { baseURL: 'http://localhost:8799', launchOptions: executablePath ? { executablePath } : {} },
  webServer: {
    command: 'npm run build >/dev/null && ELF_PORT=8799 ELF_DATA_DIR=./data/e2e NODE_ENV=production npx tsx src/server/index.ts',
    url: 'http://localhost:8799/api/health',
    timeout: 120000,
    reuseExistingServer: false,
  },
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
});
