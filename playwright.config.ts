import { defineConfig, devices, type Project } from '@playwright/test';
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
// Every scenario signs its own people up (test/support/e2e-session.ts), on
// one server: not the default first-user, which closes after the first.
process.env.REGISTRATION ??= 'open';
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
 * first page of every session (views/assets/page/pwa.ts, offerInstall), and it
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
 * The browsers, each under the name `--project=` takes: make ci-e2e runs
 * chromium, the nightly the Safari pair (.github/workflows/nightly.yml,
 * #179), npm run test:e2e all five. The Safari projects start with the
 * install dialog dismissed (INSTALL_DISMISSED).
 */
// CI sets CI; a run without it is a developer's.
const IN_CI = Boolean(process.env.CI);

const BROWSERS: readonly [name: string, device: string, safari?: true][] = [
  ['chromium', 'Desktop Chrome'],
  ['firefox', 'Desktop Firefox'],
  ['webkit', 'Desktop Safari', true],
  ['Mobile Chrome', 'Pixel 5'],
  ['Mobile Safari', 'iPhone 12', true],
];
const projects: Project[] = BROWSERS.map(([name, device, safari]) => ({
  name,
  use: safari
    ? { ...devices[device], storageState: INSTALL_DISMISSED }
    : devices[device],
}));

export default defineConfig({
  testDir: 'test',
  /* test/integration/ holds the Vitest in-process tier (npm run test:int).
   * screenshots.spec.ts is a generator, not a test: only `make screenshots`
   * (SEED_SCREENSHOTS) runs it, so the gate's e2e tier stays the
   * critical-path scenarios the floor counts. */
  testIgnore: [
    '**/integration/**',
    ...(process.env.SEED_SCREENSHOTS ? [] : ['**/screenshots.spec.ts']),
  ],
  /* Every test may run beside any other, in any file: a spec owns its data. */
  fullyParallel: true,
  /* In CI a stray test.only fails the run, and a failure gets two retries
   * (traced: `trace` below); a local run fails at once. */
  forbidOnly: IN_CI,
  retries: IN_CI ? 2 : 0,
  /* CI's runner has 4 vCPUs beside the server and Postgres: two browsers.
   * Specs own their data (their own users; screenshots.spec.ts resets its
   * personas and runs serially in one worker), so they may run together. */
  workers: IN_CI ? 2 : undefined,
  /* An HTML report under playwright-report/ (ci.yml keeps it when a run
   * fails); test:e2e:ci passes --reporter=list, which the floors read. */
  reporter: [['html']],
  use: {
    /* Base URL to use in actions like `await page.goto('')`: :3000 unless
     * PORT names another, which the webServer then listens on. */
    baseURL: APP_ORIGIN,
    /* A retried failure records a trace to open in the trace viewer. */
    trace: 'on-first-retry',
  },

  projects,

  /* Outside CI a server already listening on the port is reused instead (a
   * start:dev or start:prod one runs the real model on uploads). */
  webServer: {
    // Serves the existing build (the npm scripts test:e2e and verify:push,
    // and CI, build first) with background removal stubbed: an upload's
    // cutout arrives at once without the model, unless a spec holds it
    // pending (test/support/cutout-stub.ts).
    command: 'npm run start:test',
    url: `${APP_ORIGIN}/health/ready`,
    reuseExistingServer: !IN_CI,
    // The server's log only when it fails to start.
    stderr: 'pipe',
  },
});
