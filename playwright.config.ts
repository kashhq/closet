import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { APP_ORIGIN, E2E_SENTRY_DSN } from './test/support/e2e-session';

// The committed .env's public defaults (APP_NAME) for the specs, under
// whatever the environment sets, as the server reads them (src/config.ts).
const committedEnv = parseEnv(
  readFileSync(path.resolve(__dirname, '.env'), 'utf8'),
);
for (const [key, value] of Object.entries(committedEnv)) {
  process.env[key] ??= value;
}
// The server refuses to boot without a signing secret (src/config.ts). The
// specs only sign in through the app, so a fresh one per run will do unless
// the caller (CI) passes its own. The webServer inherits process.env.
process.env.ACCESS_TOKEN_SECRET ??= randomBytes(32).toString('hex');
// A test server is never production (the gate says `gate`, a developer's
// run `dev`: the error tracker's environment), and only outside it may
// bcrypt run at its floor, which every spec's own accounts are hashed at.
process.env.APP_ENV ??= 'dev';
process.env.PASSWORD_HASH_ROUNDS ??= '4';
// Production runs with the metrics on: the pages load the timing beacon
// (public/js/vitals.js); the scenarios run with it in the page, as users do.
process.env.METRICS_ENABLED ??= 'true';
// The order mail stays off: its boot needs ORDER_MAIL_OWNER's account to
// exist already (#706), which a fresh e2e database never has, and no
// scenario reads the review list (test/integration/order-mail.spec.ts does).
// Error tracking on, as production runs it (Bugsink): signed-in pages load
// public/js/errors.js. The DSN is Bugsink's stand-in on a port nothing
// listens on; the server's events fail to send, logged and dropped, never
// reaching a real tracker.
process.env.SENTRY_DSN ??= E2E_SENTRY_DSN;

/**
 * A Safari tab (not the installed app) opens the install dialog over the
 * first page of every session (public/js/pwa.js, offerInstall), and it
 * takes every tap until dismissed. The Safari projects start as a user who
 * has dismissed it: @khmyznikov/pwa-install's own flag, which it reads from
 * sessionStorage or localStorage.
 */
const INSTALL_DISMISSED = {
  cookies: [],
  origins: [
    {
      origin: APP_ORIGIN,
      localStorage: [{ name: 'pwa-hide-install', value: 'true' }],
    },
  ],
};

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './test',
  /* test/integration/ holds the Vitest in-process tier (npm run test:int).
   * screenshots.spec.ts is a generator, not a test: only `make screenshots`
   * (SEED_SCREENSHOTS) runs it, so the gate's e2e tier stays the ten
   * critical-path scenarios the floor counts. */
  testIgnore: [
    '**/integration/**',
    ...(process.env.SEED_SCREENSHOTS ? [] : ['**/screenshots.spec.ts']),
  ],
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* CI's runner has 4 vCPUs beside the server and Postgres: two browsers.
   * Specs own their data (their own users; screenshots.spec.ts resets its
   * personas and runs serially in one worker), so they may run together. */
  workers: process.env.CI ? 2 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('')`: :3000 unless
     * PORT names another, which the webServer then listens on. */
    baseURL: APP_ORIGIN,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    /* The Safari projects run nightly (.github/workflows/nightly.yml, #179). */
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], storageState: INSTALL_DISMISSED },
    },

    /* Test against mobile viewports. */
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'], storageState: INSTALL_DISMISSED },
    },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Outside CI a server already listening on the port is reused instead (a
   * start:dev or start:prod one runs the real model on uploads). */
  webServer: {
    // Serves the existing build (the npm scripts test:e2e and verify:push,
    // and CI, build first) with background removal stubbed: an upload's
    // cutout arrives at once without the model, unless a spec holds it
    // pending (test/support/cutout-stub.ts).
    command: 'npm run start:test',
    url: `${APP_ORIGIN}/health/ready`,
    reuseExistingServer: !process.env.CI,
    stderr: 'pipe',
  },
});
