// Playwright e2e config — thin happy-path smoke tests for the two studios.
//
// Deliberately SEPARATE from the deploy-gating `npm test` (node --test): a flaky
// browser test must never block a Render deploy. Run with `npm run test:e2e`.
// testDir is scoped to e2e/ so this never touches the node:test suite under test/.
//
// The tests boot the REAL app (node server.js) and drive the REAL frontend in a
// real Chromium, but every /api/* call the studios make is intercepted and fulfilled
// with a canned response — so there is NO real Gemini/OpenAI call and NO cost, and
// the runs are deterministic. The server is only serving static files + the handful
// of non-mocked endpoints.
import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.E2E_PORT || '4599';
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1, // one server, and the masking test paints via the shared mouse
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1, // browser smoke can flake; retry before failing the run
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 45000,
  expect: { timeout: 10000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'node server.js',
    url: `${BASE_URL}/`,
    // HIDE_STAGING_BANNER keeps the staging overlay off even if the dev env/.env sets
    // IS_STAGING (the banner otherwise intercepts clicks over the studio).
    env: { PORT, NODE_ENV: 'test', HIDE_STAGING_BANNER: '1' },
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
