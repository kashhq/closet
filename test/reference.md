# Tests: reference

Moved out of `AGENTS.md` (#723) so the auto-loaded doc keeps only invariants, gotchas and ownership. Not auto-loaded: read it before changing this area. Where it disagrees with the code or a spec, they win.

- **Tests**: three tiers, each reported against a budget and a floor by the Makefile, as OVERBUDGET / FLOOR warnings, never failures (`make ci-unit` ≤ 60 s, `ci-db` ≤ 110 s, `ci-e2e` ≤ 180 s; devkit `bin/tier_guard.sh`, counting tests that ran; `docs/decisions.md` 2026-10-13, Lean test suite, and 2026-10-14, db tier under budget). Vitest unit (`src/**/*.spec.ts`, and `scripts/**/*.spec.ts` for the tooling's rules; mocks everything, verifies wiring); Vitest integration (`test/integration/`, the real app in-process on a scratch Postgres database per spec file, cloned from a template the migrations reached once per run, driven through `app.inject()`, verifies behavior: HTML, headers, rows, files); Playwright e2e (`test/*.spec.ts`: ten critical-path scenarios, one per file, in a real browser against a built server: login, add from a photo, style an outfit, plan on the calendar, wear and wash, a trip, a shared wardrobe, the offline shell, the worker's update, the image cache across sessions). **A test earns its place**: it fails for a plausible regression in our code, proves something no kept test proves, is hermetic, and runs at the cheapest tier that can prove it (logic in unit; real SQL in integration; only what a browser alone shows in e2e; a shipped migration is frozen and gets no spec). A new e2e scenario replaces one or is argued in the PR. Both Vitest tiers are projects of one `vitest.config.mts` (Vite's Oxc transform, JSX settings from `tsconfig.json`; specs import `describe`/`it`/`expect`/`vi` from `'vitest'`, no globals). Integration specs assert rows through `t.db` (Drizzle) and log lines through `t.logs` (what the app really wrote; `captureLogs()` in `test/support/log-capture.ts` for a unit). `recordQueries(work)` (harness, over `test/support/query-recorder.ts`) counts the statements and rows a request reads, with their SQL text, for proving a page reads what it shows. Plus the page audit (`npm run audit:pages`, `scripts/audit/`: every page and action timed and counted as the demo persona against `docs/perf/`'s baseline; `docs/perf/README.md`) and Lighthouse CI. Vitest replaced Jest on 2026-09-25, the first step of the platform migration that ended with NestJS's removal on 2026-09-26.

## Layout

```
  support/             scratch-database.ts (integration tier + page audit: per-file databases cloned from
                       the migrated template, migrated-template-setup.ts; the sweep), e2e-session.ts (Playwright
                       signIn), e2e-data.ts (Playwright's garments, outfits, capsules through the app's POSTs),
                       test-server.ts (`npm run start:test`: the build served with a stubbed cutout runner,
                       for Playwright and Lighthouse), cutout-stub.ts + cutout-hold.ts (that runner, and
                       the `cutouts` fixture that holds an owner's cutouts pending),
                       query-recorder.ts (recordStatements: every SQL statement this process sends
                       while a callback runs, with rows, start and time; recordQueries and the page audit),
                       statement-budgets.ts (+ -setup, -global: with STATEMENTS_OUT, `make ci-db`, the
                       most statements each `<METHOD>:<route>` sent inside a recordQueries block, merged
                       into build/statements.json, which metrics.conf's `statements` collector reports),
                       multipart.ts, pwa-env.ts (PWA_ENV: the PWA's config with a throwaway VAPID pair),
                       household-today.ts (householdToday: the server's "today" for Playwright),
                       log-capture.ts (LogCapture, captureLogs: the app's log lines as records),
                       weather-stub.ts (Open-Meteo's stand-in on 127.0.0.2: the seed's weather,
                       forecast and archive),
                       h2-wire.ts (a hostile HTTP/2 server writing frames by hand: header floods,
                       cut bodies, lying lengths; outbound-fetch.spec.ts), tls-certificate.ts (a throwaway
                       self-signed certificate the fetcher trusts only through its `tls` option),
                       jmap-stub.ts (Fastmail's JMAP stand-in on 127.0.0.2 as `jmap.test`: session, inbox
                       query, Email/get; createTestApp's `orderMail`, required with ORDER_MAIL_JMAP_TOKEN;
                       test-server.ts starts it when the token is set),
                       order-mail-shop.ts (the forwarded order email and the shop its links reach:
                       order-mail.spec.ts and the page audit),
                       sentry-stub.ts (Bugsink's stand-in: a local DSN the real Sentry transport posts to,
                       on a free port, or Playwright's SENTRY_STUB_PORT; recordErrors, an in-memory
                       ErrorTracker for unit specs),
                       page-errors.ts (pageErrors: what a spec asserts went wrong in the page),
                       heic-stub-worker.ts (the HEIC decoder's stand-in thread, steered by the
                       uploaded bytes: block, hang, crash, out of heap; src/web/files/AGENTS.md),
                       touch-targets.ts (the phone's sizing, #636: no field under 16 px, no control's
                       hit box under 44 px; the trips scenario runs it at 390 px with hasTouch),
                       webkit-limits.ts (why a spec skips in the Safari projects),
                       static-assets-setup.ts (globalSetup: public/modules/ and the precompressed
                       variants, as the build lays them out),
                       schema-drift.ts (drizzle-kit pushSchema), prototype-hygiene.ts (built-in prototypes
                       kept free of enumerable keys in shared workers, #620), legacy-migrations.ts + legacy-migrations/
                       (the frozen MikroORM tree; migration-runner.spec.ts builds a MikroORM-era database)
  integration/         Vitest in-process specs + harness.ts (createTestApp: t.inject, t.db, t.logs, t.today; multipart,
                       HTML helpers); authorization-matrix.ts (describeMatrix: the authorization matrix, which
                       authorization-<group>.spec.ts run per route group over authorization-<group>.routes.ts's
                       ROUTES), authorization-coverage.spec.ts
                       (every id route is in the matrix or exempt, #182)
```

## Gotchas

- **A signed-in page in the PWA specs warms the whole wardrobe** (#286): after `load`, the worker fetches every page and thumb into the session caches. A spec asserting what is cached, or that an unvisited page is the offline page, calls `withoutWarming(context)` (`test/support/service-worker.ts`: the pages never post `WARM_PAGES`) first, as `pwa.spec.ts` and `image-cache-privacy.spec.ts` do.

- **Playwright's server runs with `METRICS_ENABLED=true`** unless the environment says otherwise (`playwright.config.ts`), as production does: every signed-in page loads `public/js/vitals.js` and beacons to `POST /metrics/vitals`, (`test/integration/metrics.spec.ts` reads `/metrics`). A spec counting a page's requests sees the script and, a few seconds in, its beacon.
- **Playwright's server runs with error tracking on** (`playwright.config.ts` sets `SENTRY_DSN` unless the environment does), as production does, so every signed-in page loads `public/js/errors.js`. The DSN is `SENTRY_STUB_PORT` (`e2e-session.ts`: `PORT` + 10000), where nothing listens: events fail to send, logged as `Could not send an event to Bugsink` and dropped (`test/integration/error-tracking.spec.ts` posts to the real stand-in).
- **`page.clock.install()` empties Navigation Timing** (`performance.getEntriesByType('navigation')` is `[]` under it): a spec with the fake clock never sees a full load's Server-Timing (freshness.js's cache stamp and page tag, vitals' route); reach the page by a boosted tap, whose xhr headers carry them (`offline-writes.spec.ts`).
- **Playwright cannot subscribe to push.** Its contexts are incognito, where Chromium refuses `pushManager.subscribe()` (AbortError, "permission denied") whatever the permission. A persistent context does subscribe, through Google's push service on the internet and at a `*.google.com` endpoint the server's push-host list refuses, so no spec uses one. `push-stub.ts` stands in (`screenshots.spec.ts`); the push routes are `test/integration/push*.spec.ts`.
- **`npm run test:cov` is the gate's db job; coverage is reported by the metrics ratchet, not gated by vitest** (2026-10-16; report-only since 2026-11-13): its `coverage/coverage-summary.json` feeds `coverage.backend.lines|branches` in `docs/metrics/ratchet.json` (`make ci-metrics`). A drop shows as WORSE in `make ci-metrics`; a cleanup round runs `make metrics-tighten`. Never write a spec only to lift a number. Functions and statements are no longer gated.
- **Both Vitest tiers also run with the clock shifted** (`GATE_JOBS_CLOCK`, 30 and 365 days ahead; devkit README "Clock shift"), so a spec that dates fixtures from the real clock beside a pinned one fails the day it is written. What the shift cannot move goes in `scripts/ci/clock_shift.conf` with its reason; bumping a date is no fix. **Covered branches must not move with the date** (the ratchet's `coverage.backend.branches` drifted by one every few days until 2026-10-22): a spec that renders the weather stub's weather or seeds a persona from today pins `Date` to `STUB_WEATHER_NOW` (`weather-stub.ts`) before its app boots, and a branch only a race or a date reaches gets a spec that reaches it every run. App code that judges a row's age stamps the row from its own clock (`pending_photo.created_at`), not a column's `defaultNow()`. The shift moves only JS's `Date`: what a real-clock reader checks (OpenSSL: `tls-certificate.ts`'s window is fixed) is never dated from it, and a file's mtime stays real.
- **Playwright's server runs with the order mail off** (#706): a fresh e2e database has no account for `ORDER_MAIL_OWNER`, so the order mail would boot off and mark `order_mail_owner` down. With `ORDER_MAIL_*` set in the environment, `test-server.ts` points it at `jmap-stub.ts`'s empty inbox, never Fastmail. The review list is `test/integration/order-mail.spec.ts`, whose harness inserts its owner before the boot.
- **`test/support/legacy-migrations.ts` loads the MikroORM migrations through `dynamicImportProvider`.** MikroORM's default is an `import()` inside `node_modules`, which Vitest does not intercept: Node then loads the migration `.ts` itself with type stripping, outside Vitest's resolution. The provider's `import()` sits in our file, so Vitest's module runner handles it. The frozen migrations import nothing from `src/` (Migration20260925182919 keeps its own copy of the colour list: its ordinals are positions in the enum as it was).

- **Vitest is pinned to `~4.0`.** Vitest 4.1 depends on Vite 8, whose optional peer chain (`@vitejs/devtools` back to `vitest`) crashes npm 10's resolver with "Cannot read properties of null (reading 'edgesOut')", and npm 11 lockfiles break the Docker build (see the lockfile gotcha). Bump only when `npx -y npm@10 install -D vitest@<new>` resolves, and prove the lockfile with `npm ci --dry-run` on npm 10.
- **Nothing in Vitest boots the image or `main.ts`**, so line coverage leaves out `src/main.ts`, `src/server.ts`, `src/**/*.cli.ts` and `src/cutout/child.ts` (`vitest.config.mts`). `scripts/smoke-image.sh` is their test: CI boots the built image with it before every publish, and the nightly runs it with the real model plus `cutout-model.spec.ts` (`docs/operations.md`, CI and publishing). A change to boot, shutdown or the Dockerfile is proved by running it locally against a throwaway pgvault-dev database; the page it checks is `/auth/login`, so a login-page change that drops `<title>…Closet</title>`, the boosted `<body>` or the password field fails it.
