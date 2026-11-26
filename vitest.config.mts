import { defineConfig } from 'vitest/config';

import { clockShift, loadScaled } from './devkit/lint/vitest.base.mjs';

// Two tiers, one run (`npm run test:all`, the pre-commit hook): one worker
// pool, one coverage report. `npm test` selects the unit projects (`unit*`),
// `npm run test:int` the integration project.
export default defineConfig({
  // A no-op unless tier_guard runs the tier under DEVKIT_CLOCK_SHIFT (the gate's
  // CLOCK group): then the shifted, ticking Date, first in every project's
  // setupFiles so their own run on it (devkit README "Clock shift").
  plugins: [clockShift()],
  // TypeScript and TSX go through Vite's own Oxc transform (Vite 8), which takes
  // jsx/jsxImportSource (hono/jsx) from tsconfig.json.
  test: {
    // Global, inherited by every project (extends: true). The budget covers
    // an integration spec's beforeAll: scratch database, migrations and app
    // boot, slower on CI's 4-vCPU runner. loadScaled stretches it by the
    // gate's DEVKIT_LOAD_SCALE (at most x2) on an overloaded box.
    testTimeout: loadScaled(30_000),
    hookTimeout: loadScaled(30_000),
    // Four on a developer machine, where the gate runs two PRs at once
    // (GATE_SLOTS=2) beside Postgres in Docker and more workers overload it
    // (the Mac reached load 95 on 2026-10-12); all cores in CI, whose test job
    // runs nothing else (.github/workflows/ci.yml).
    maxWorkers: process.env.CI ? '100%' : 4,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // Process entry points no Vitest worker runs, so line coverage would
      // only report them as 0%: main.ts and server.ts (listen, timers,
      // SIGTERM), the CLIs' wrappers around specced code, and the model's
      // child process (forked and type-stripped, never instrumented).
      // scripts/smoke-image.sh covers them in the built image: booted,
      // served and stopped before every publish (ci.yml), and nightly the
      // fetch CLI plus a real cutout through child.ts (nightly.yml).
      exclude: [
        'src/**/*.spec.{ts,tsx}',
        'src/**/*.cli.ts',
        'src/main.ts',
        'src/server.ts',
        'src/cutout/child.ts',
      ],
      reportsDirectory: 'coverage',
      // text: per file in the log, so a coverage drop names the file that
      // fell. html: coverage/index.html. json-summary:
      // coverage/coverage-summary.json, which the metrics ratchet's `cov`
      // collector reads after `make ci-db` (scripts/ci/metrics.conf). The
      // ratchet gates lines and branches against docs/metrics/ratchet.json,
      // so no thresholds here (docs/decisions.md 2026-10-16).
      reporter: ['text', 'html', 'json-summary'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          // scripts/: the repo tooling's pure rules (static-assets, and the
          // statement-budget helper from test/support/, which no project globs).
          include: ['src/**/*.spec.{ts,tsx}', 'scripts/**/*.spec.ts'],
          exclude: [
            'scripts/**/*.browser.spec.ts',
            'src/web/calendar/**/*.spec.{ts,tsx}',
            'src/calendar-date.spec.ts',
            'src/web/date-labels.spec.ts',
          ],
        },
      },
      {
        // The page audit's in-browser measures against fixed HTML in a real
        // Chromium page (scripts/audit/a11y.browser.spec.ts, #1209), and a
        // client module's behaviour beside it (views/assets/page/*.browser.spec.ts):
        // layout and dialogs are the thing under test, so no DOM shim stands in. Not `unit*`, and
        // left out of test:all and test:cov, because ci-unit and ci-db need
        // no browser; `make ci-e2e` runs it first, after it installs
        // Chromium. Locally: npm run test:audit-browser.
        extends: true,
        test: {
          name: 'audit-browser',
          include: [
            'scripts/**/*.browser.spec.ts',
            'views/assets/*.browser.spec.ts',
            'views/assets/page/**/*.browser.spec.ts',
          ],
        },
      },
      {
        // The calendar's date logic in a DST zone: UTC (CI's zone) hides
        // every local-time mistake, and the calendar must not depend on the
        // process's zone at all (APP_TIMEZONE decides "today"). `env` is
        // applied to the worker's real process.env before the spec is
        // imported, and assigning TZ there makes V8 reload its zone. That
        // holds for child processes only, so the pool is pinned to forks
        // (worker threads share the parent's zone). Each spec asserts the
        // offset in its first test.
        extends: true,
        test: {
          name: 'unit-new-york',
          include: [
            'src/web/calendar/**/*.spec.{ts,tsx}',
            'src/calendar-date.spec.ts',
            'src/web/date-labels.spec.ts',
          ],
          env: { TZ: 'America/New_York' },
          pool: 'forks',
        },
      },
      {
        // The real app in-process on a scratch Postgres database per spec
        // file and a temp DATA_PATH, driven through Fastify's inject(). Needs
        // pgvault-dev on localhost:5432 or TEST_DATABASE_URL (see
        // test/support/scratch-database.ts). Files run in parallel on the
        // forks pool; `isolate: false` keeps each worker's module graph
        // across its files, so the app's graph is imported once per worker,
        // not once per file (about a second of CPU each, a third of the
        // tier's work; docs/decisions.md 2026-10-14). That is safe because
        // nothing in src/ reads process.env at import (loadConfig is called
        // per app), every file boots and closes its own app (rate-limit
        // stores, metrics registry and error tracker are per app), and
        // Vitest restores spies after every file. It forbids what would leak:
        // vi.mock/vi.doMock in test/integration/ (eslint.config.mjs), timers
        // left fake (the setup file below restores them), importing another
        // spec file (it would collect no tests on its own turn), and a module
        // that adds enumerable keys to a built-in prototype (the setup file
        // fails the file that loaded it; test/support/prototype-hygiene.ts).
        extends: true,
        test: {
          name: 'integration',
          isolate: false,
          include: ['test/integration/**/*.spec.{ts,tsx}'],
          // Drops scratch databases that killed runs left on the server, makes
          // the migrated template every spec file clones (migrations once per
          // run, not per file), and lays out public/ as the build does
          // (modules, precompressed files).
          globalSetup: [
            'test/support/sweep-scratch-databases.ts',
            'test/support/migrated-template-setup.ts',
            'test/support/static-assets-setup.ts',
            // With STATEMENTS_OUT (make ci-db): the statement counts the
            // specs pin, for the metrics ratchet (statement-budgets.ts).
            'test/support/statement-budgets-global.ts',
          ],
          setupFiles: [
            'test/support/statement-budgets-setup.ts',
            'test/support/shared-worker-setup.ts',
          ],
        },
      },
    ],
  },
});
