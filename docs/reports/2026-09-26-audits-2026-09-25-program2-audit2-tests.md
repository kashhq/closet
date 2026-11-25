# Closet: verification and testing loop audit

Date: 2026-09-25. Commit measured: `6a5e64f` (main == origin/main).
Method: a scratch worktree (`npm ci` 62 s), every step timed with wall-clock
wrappers, jest `--json` for per-file timings, istanbul maps for coverage,
real GitHub Actions step timings from `gh api .../actions/runs/<id>/jobs`
(fork `agandhi4/closet`; note `gh` defaults to the original project's repository, so
`gh run list` without `-R agandhi4/closet` shows stale upstream runs).
Machine: 16 cores, Node 24.16 (the repo pins 22.x; CI uses 22). No repo file
was edited. Worktree, Postgres container and servers were removed afterwards.

## Headline

The local loop is not slow; it is serial, unenforced, and checks the wrong
things. `npm run precommit` takes 17 to 20 s, of which only ~7 s is tests.
The real problems are elsewhere:

1. **Nothing enforces anything.** No git hook exists (no husky, no
   `core.hooksPath`), and `docker-publish.yml` runs in parallel with CI rather
   than after it. A red CI still publishes `:latest` and the homelab
   autoupdater deploys it.
2. **Coverage is thin where the product is.** Outfits (18% lines), calendar
   (11%), password reset, email change, share revoke/decline, notifications
   and Open Graph have no behavior test. 30 of 58 routes have no
   integration or e2e assertion. 15 of 23 views are never rendered by a test.
3. **The type checker would have caught a live bug.**
   `wardrobe-share.service.ts` imports `UniqueConstraintException` from
   `@mikro-orm/core`, which does not exist (the class is
   `UniqueConstraintViolationException`). At runtime it is `undefined`, so the
   `catch` in `acceptInvite` does `e instanceof undefined`, which throws a
   TypeError: a duplicate accept becomes a 500 instead of the intended 400.
   Of tsc's 776 errors, 760 are "cannot find name describe/expect" (jest types
   missing from the root tsconfig); only 16 are real.
4. **The service worker is never tested in CI.** `test/pwa.spec.ts` skips
   unless `PWA_ENABLED=true`, and no CI step sets it. It passes locally in
   10 s (needs `SITE_URL` to be `https:`/`mailto:` or web-push refuses the
   VAPID subject at boot; that requirement is not in CLAUDE.md).
5. **CI is 4.5 minutes of one serial job** that rebuilds the app six times,
   installs all five Playwright browsers with OS deps twice (once per
   workflow, ~50 s each, no cache), uses `npm install` without a cache, and
   runs two 30 s load tests and Lighthouse on every push.

## 1. Timing breakdown

### Local (16 cores, warm OS cache)

| Step | Wall | Notes |
|---|---|---|
| `npm run format:check` | 1.0 s | prettier `--cache`: 0.4 s warm |
| `npm run lint` (eslint `--fix`, type-aware) | 5.8 s | `--cache`: 5.2 s cold, **0.7 s warm**. Mutates files: `precommit` runs the fixing variant |
| `npm test` (unit, ts-jest) | 2.8 s cold / 2.4 s warm | 27 files, 126 tests; jest reports 2.3 s |
| unit with `@swc/jest` | 1.9 s / 1.8 s | -0.6 s |
| `npm run test:int` (sqlite, ts-jest) | 5.0 s cold / 4.3 s warm | 13 files, 52 tests, 8 workers |
| test:int with `@swc/jest` | 3.9 s / 3.6 s | -0.7 s |
| test:int `--runInBand` | 9.7 to 10.3 s | what a 2-core CI runner approximates |
| test:int on Postgres 17 (docker) | 4.7 to 4.8 s | same 52 tests, one DB per file |
| unit + int as one jest `projects` run, swc | **4.8 s** | vs 6.7 s for the two serial runs |
| `npm run test:cov` (unit) | 4.7 s | |
| test:int with coverage | 7.0 s | |
| `nest build` (SWC) | 1.8 s | |
| `generate:build-info` / `:tailwind` / `:sw` | 0.9 / 0.9 / 1.0 s | each pays npm + ts-node/npx startup |
| `npm run build` | 4.0 s | |
| **`npm run precommit`** | **17.1 to 19.7 s** | format 1 + lint 6 + unit 2.5 + int 4.5 + build 4, strictly serial |
| `tsc --noEmit` (root tsconfig) | 2.7 s | 776 errors |
| tsc with jest types, incremental | 2.9 s cold / **1.4 s warm** | 18 errors |
| Playwright smoke incl. webServer build | 13.1 s | test itself 0.4 s |
| Playwright smoke against running server | 2.9 s | |
| Playwright default suite, 5 projects, no build | 7.4 s | 9 pass, 20 skip (pwa/auth), webkit not installable here |
| Playwright `pwa.spec.ts` (PWA_ENABLED) | 10.3 s | 3 pass; one test sleeps 1.5 s |
| Playwright `auth.spec.ts` (AUTH_ENABLED) | 5.0 s | |
| knip (unconfigured) | 4.8 s | |
| `npm audit` | 1.4 s | |
| `npm run precommit:full` (estimate) | ~90 s | adds cov 5, smoke 13, load ~30, lighthouse ~20 (both hardcode :3000, so they were not run locally; CI numbers used) |

### Where the integration tier's time goes

Profiled inside a jest worker (ms):

| Phase | Time |
|---|---|
| `import('src/app')`: the Nest + MikroORM + nestjs-i18n + AWS SDK module graph | 675 warm / 1100 cold transform |
| first `createApp()` + `init()` (DI, sqlite migrations) | 190 to 240 (Postgres similar, plus create DB) |
| a second boot in the same file | 50 to 90 |
| first request / later requests | 60 / 8 |
| `sharp` load | 23 |

Plain-Node require of the compiled app is 672 ms too, so **the per-file cost
is node_modules loading, not ts-jest transform and not migrations.** Top
costs: `@mikro-orm/migrations` 187, `@mikro-orm/postgresql` 150,
`nestjs-i18n` 143, `@mikro-orm/better-sqlite` 127, `nestjs-s3` 111,
`@nestjs/core` 109, `@nestjs/platform-fastify` 99 ms. Jest resets the
module registry per file, so every file pays ~0.7 s. With 13 files and 8
workers the files contend and each takes 1.8 to 3 s; in band each takes 0.3
to 0.9 s after the first.

Inside tests, the only real hotspot is bcrypt: `bcryptjs` (pure JS) at a
hardcoded cost of 12 costs ~230 ms per hash or compare. `user-delete.spec`
(1.3 s, 4 hashes plus compares) and `auth.spec` login (0.5 s) are most of the
test-body time. Setting cost 4 cut wall time by only 0.3 s at 16 cores, more
on CI's 2 to 4 cores. Worth doing as `BCRYPT_ROUNDS` config (it is also a
hardcoded value today), but it is not the bottleneck.

What does NOT cost time: migrations per test (they run once per file, ~150
ms), sharp warm-up (23 ms), Nest module compile in unit specs (the twelve
`createTestingModule` specs take 0.1 to 1.1 s each, but in parallel).

### CI (real, runs 36183614519, 36183374565, 36180775419 on 2026-09-25)

`Github Actions CI`, one job, 257 to 285 s:

| Step | s | Comment |
|---|---|---|
| npm install & build | 30 to 39 | `npm install`, not `npm ci`; `setup-node@v1`, no cache; `checkout@master` |
| format:check | 1 to 2 | |
| lint | 9 to 10 | |
| test:cov | 7 to 9 | |
| test:int (sqlite) | 10 to 13 | |
| Install Playwright Browsers | 41 to 55 | all 5 engines + apt deps; only chromium is used in this job |
| e2e smoke local | 10 to 11 | rebuilds (webServer runs `npm run build`) |
| auth e2e | 11 to 13 | rebuilds |
| load test local | 29 to 30 | rebuilds; 4 targets x 5 s |
| start postgres | 6 to 8 | |
| test:int (postgres) | 11 to 13 | |
| start s3mock | 7 to 8 | |
| e2e smoke remote | 9 to 11 | rebuilds |
| load test remote | 28 to 30 | rebuilds |
| lighthouse | 18 to 26 | |
| npm-check-updates | 1 to 2 | informational only, never fails |

`Playwright Tests`, separate job, 139 s: `npm ci` 32, browsers 54, tests 44
(5 projects, `workers: 1` and `retries: 2` in CI; pwa and auth specs skip, so
it runs the same 3 specs 5 times).

`Docker Publish`, 114 s, starts at the same moment as CI. **It is not gated
on CI.**

Wall time to "known good" is ~4.5 min; roughly 60 s of that is six app
builds, 100 s browser installs across the two workflows, 60 s load tests,
20 s Lighthouse.

## 2. Coverage

### Line and branch coverage per module (unit and integration measured separately, then merged)

Totals: **unit 31% lines / 26% branches; integration 66% / 54%; merged 68% /
56%.** The unit tier adds 2 points of lines on top of integration.
(`collectCoverageFrom` excludes modules, entities, DTOs, migrations;
templates and `public/js` are not measured at all.)

| file | lines | unit L% | int L% | int B% | merged L% | merged B% |
|---|---|---|---|---|---|---|
| src/main.ts | 4 | 0 | 0 | 0 | 0 | 0 |
| src/maintenance/reconcile.cli.ts | 14 | 0 | 0 | - | 0 | 100 |
| src/wardrobe/calendar.service.ts | 132 | 0 | 11 | 12 | 11 | 12 |
| src/wardrobe/outfit.service.ts | 85 | 0 | 18 | 12 | 18 | 12 |
| src/wardrobe/outfit.controller.ts | 58 | 0 | 34 | 40 | 34 | 40 |
| src/wardrobe/calendar.controller.ts | 28 | 0 | 39 | 43 | 39 | 43 |
| src/file/s3-file/s3-file.service.ts | 29 | 45 | 45 | 45 | 45 | 45 |
| src/open-graph/open-graph.service.ts | 29 | 45 | 45 | 47 | 45 | 47 |
| src/notification/notification.service.ts | 40 | 50 | 50 | 54 | 50 | 54 |
| src/auth/auth.controller.ts | 96 | 38 | 57 | 62 | 57 | 62 |
| src/email/email.service.ts | 20 | 60 | 60 | 50 | 60 | 50 |
| src/wardrobe-share/wardrobe-share.service.ts | 67 | 28 | 63 | 50 | 63 | 50 |
| src/wardrobe-share/wardrobe-share.controller.ts | 40 | 0 | 65 | 52 | 65 | 52 |
| src/auth/auth.service.ts | 71 | 34 | 66 | 69 | 66 | 69 |
| src/wardrobe/wardrobe.controller.ts | 122 | 0 | 79 | 65 | 79 | 65 |
| src/notification/notification.controller.ts | 16 | 81 | 81 | 75 | 81 | 75 |
| src/file/file-service.abstract.ts | 138 | 69 | 76 | 67 | 83 | 79 |
| src/app.ts | 110 | 0 | 85 | 32 | 85 | 32 |
| src/wardrobe/garment.service.ts | 150 | 0 | 87 | 66 | 87 | 66 |
| src/file/controller/file.controller.ts | 25 | 88 | 72 | 60 | 88 | 70 |
| src/error-view.filter.ts | 20 | 90 | 80 | 83 | 90 | 92 |
| src/app.controller.ts | 17 | 94 | 82 | 69 | 94 | 69 |
| src/file/local-file/local-file.service.ts | 35 | 46 | 94 | 67 | 94 | 67 |
| src/maintenance/storage-reconciliation.service.ts | 87 | 29 | 93 | 83 | 99 | 84 |
| src/auth/* guards, auth-context, decorators | 5 to 28 | 50 to 100 | 67 to 100 | 67 to 88 | 100 | 82 to 100 |
| src/file/heic.ts, image-variant.ts, image-url.ts | 4 to 27 | 71 to 100 | 96 to 100 | 50 to 92 | 100 | 100 |
| src/htmx/fragment-request.ts | 9 | 100 | 78 | 45 | 100 | 100 |
| src/view-context/view-context.service.ts | 19 | 0 | 100 | 75 | 100 | 75 |

The "int" lines for services such as outfit and calendar are only
constructor and DI wiring executed at boot; no request reaches them.

### Route inventory: 58 controller methods

Legend: **I** integration spec asserts behavior; **E** Playwright asserts it
(E\* = only in a spec CI never runs with the needed env); **u** unit only;
**-** nothing. "Authz" notes whether a cross-user or share-permission
boundary is asserted.

| Route | Test | Notes |
|---|---|---|
| GET `/` | I, E | redirect to /wardrobe |
| GET `/manifest.json` | I | config + cache headers |
| GET `/healthz` | I | |
| GET `/about` | u | view never rendered |
| GET `/offline.html` | E\* | pwa.spec only, skipped in CI |
| GET `/.well-known/*` | - | |
| GET `/share` (Open Graph) | - | u = "should be defined" only |
| GET `/wardrobe` | I, E | filters, colours, fragments, VIEW share, ownerId=999 → 403 |
| GET `/wardrobe/new` | I | filters on form |
| POST `/wardrobe` | I, E | VIEW grantee → 403 asserted; MANAGE grantee create asserted |
| GET `/wardrobe/:id` | I, E | no authz test (other user's id, no share) |
| GET `/wardrobe/:id/edit` | - | |
| GET `/wardrobe/:id/clone` | - | |
| POST `/wardrobe/:id/clone` | I | own garment only |
| POST `/wardrobe/:id` (edit) | - | **the most common write has no test** |
| POST `/wardrobe/:id/photo` | I, E | HEIC, oversize, corrupt, rollback; no authz |
| POST `/wardrobe/:id/archive` | I (setup) | only used as setup in filters.spec |
| POST `/wardrobe/:id/nobg` | I | no authz |
| DELETE `/wardrobe/:id` | I | own only; code has an explicit Forbidden branch, untested |
| GET `/file/:fileName` | E | original via image-variants.spec |
| GET `/file/nobg/:fileName` | I | |
| GET `/file/thumb/:fileName` | I, E | incl. path traversal probe in E |
| GET `/file/watermark/:shareableId` | u | mocks only |
| GET `/outfits` | - | |
| GET `/outfits/new` | - | load test hits it, asserts nothing |
| POST `/outfits` | - | |
| GET `/outfits/row-fragment` | - | |
| GET `/outfits/:id` | - | |
| GET `/outfits/:id/edit` | - | |
| POST `/outfits/:id` | - | |
| DELETE `/outfits/:id` | - | |
| GET `/calendar` | - | month grid, week start, month boundaries: nothing |
| POST `/calendar` | - | |
| POST `/calendar/:id/delete` | - | |
| POST `/calendar/:id/worn` | - | |
| GET `/wardrobe-share/manage` | I (anon only) | authenticated render never asserted |
| POST `/wardrobe-share/create-invite-link` | I | |
| POST `/wardrobe-share/:id/remove` | - | **revocation untested: after remove, does the grantee lose access?** |
| GET `/wardrobe-share/invite/:token` | I | |
| POST `/wardrobe-share/invite/:token/accept` | I | duplicate-accept path is the TypeError bug above |
| POST `/wardrobe-share/invite/:token/decline` | - | |
| POST `/auth/register` | I, E | |
| POST `/auth/validate/register` | - | |
| POST `/auth/login` | I, E | wrong password asserted |
| GET `/auth/logout` | - | cookie clearing unasserted |
| GET `/auth/login` | E (URL only) | |
| GET `/auth/register` | u | DISABLE_REGISTRATION guard: unit only |
| GET `/auth/profile` | I, E | |
| GET/POST `/auth/reset` | - | |
| GET `/auth/reset-code`, POST `/auth/validate/reset-code`, POST `/auth/reset-code` | - | whole password-reset flow untested (and `pwf` session invalidation on password change is unit-only) |
| GET `/auth/delete-account` | - | |
| POST `/auth/delete-account` | I | thorough |
| GET `/auth/update-email`, POST `/auth/validate/update-email`, POST `/auth/update-email` | - | |
| GET `/notification/vapid-public-key` | - | |
| POST `/notification/subscribe` | - | |
| POST `/notification/test` | - | |

28 of 58 methods have a behavior assertion; 30 have none. Views never
rendered by any test: about, auth/{login, register, reset, reset-code,
update-email, delete-account}, calendar/index, outfits/{index, show, form},
partials/{outfit_row, calendar_worn_button}, share, wardrobe-share/manage,
offline (CI). That is 15 of 23 view names returned by controllers.

### The specific areas asked about

- **Authorization boundaries.** Tested: anonymous redirects (3 URLs), garbage
  cookie, `?ownerId` without a share → 403, VIEW grantee cannot create,
  MANAGE grantee can create, delete-account requires own credentials. Not
  tested: any object-level check (user B requesting user A's
  `/wardrobe/:id`, `/edit`, `POST /:id`, `/photo`, `/nobg`, `/archive`,
  `DELETE`, `/clone`, outfits, calendar entries, with and without a share);
  VIEW grantee on every write route other than create; share revocation
  removing access; decline; outfits and calendar under `AUTH_ENABLED=true`
  at all. `/file/*` is unauthenticated by design (UUID names); nothing
  asserts that is the intended contract.
- **Share view/edit.** Two tests, create-only. Edit, archive, delete, photo
  by a MANAGE grantee, and each of those refused for VIEW, are untested.
- **Upload failure paths.** The best-covered area: corrupt JPEG → 400 with no
  files, HEIC undecodable, HEIC oversize → 413, failed transaction → 500 with
  no File row or files, unhandled-rejection regression. Missing: S3 backend
  failure paths (s3-file.service 45%, only exercised by the smoke-remote job
  which asserts one page render), a failed cutout while the photo succeeds.
- **Calendar dates.** 11% coverage; nothing. `calendar.service.ts` is 458
  lines of UTC month/week arithmetic and i18n month/day names: the classic
  place for timezone and month-boundary bugs. This deserves pure unit tests
  with fixed dates (it is logic, not wiring) plus one integration spec.
- **Service worker.** Only `pwa.spec.ts` (precache, offline shell, lazy
  model), never run in CI. Integration covers the `/sw.js` cache header only.
  The SW source (`views/assets/src-sw.ts`) also fails type-checking (8
  errors: no `webworker` lib), so nothing verifies it even compiles
  correctly beyond esbuild's transpile.
- **Migrations on Postgres.** CI runs the whole integration tier on Postgres
  17 (every file migrates a fresh DB) and `migrations.spec.ts` asserts index
  names; `postgres-indexes.spec.ts` checks the CONCURRENTLY shape. Missing:
  a schema-drift check and `down` migrations. I ran
  `orm.getSchemaGenerator().getUpdateSchemaSQL()` after boot on both
  drivers: **both empty today**, so a drift assertion can be added to
  `migrations.spec.ts` at no cost and would have caught the two past drifts
  (missing FK index, smallint color) that CLAUDE.md describes.

## 3. Value of the existing tests

### Unit specs to delete or replace (wiring-only)

Nine specs assert only `toBeDefined()` after `createTestingModule`, with every
dependency mocked. They prove the DI graph of a hand-built mock module
compiles, which the integration tier proves for the real graph on every
file boot. Delete:

`notification.controller.spec`, `notification.service.spec`,
`email.service.spec`, `open-graph.service.spec`, `open-graph.controller.spec`,
`auth.service.spec`, `s3-file.service.spec`, `local-file.service.spec`,
`file-url.service.spec` (0.1 to 1.0 s each), and the "should be defined" case in
`auth.controller.spec` / `file.controller.spec`. They cost ~5 s of worker
CPU for zero assertions and give a false sense of
coverage (they are why notification and open-graph show ~50%).

Mostly wiring (assert mocks were called with arguments), better as
integration tests:

- `auth.controller.spec` "applies RegistrationGuard to X": reads decorator
  metadata. Replace with one integration spec with `DISABLE_REGISTRATION=true`
  asserting GET/POST register are refused.
- `file.controller.spec`: asserts `reply.header` was called with values;
  integration `wardrobe.spec` already asserts the real headers. Keep only
  the watermark case until an integration test covers `/file/watermark`.
- `error-view.filter.spec`: asserts `response.view` calls. The 302 no-warn
  path is already asserted end to end in `integration/auth.spec`. A 404 page
  render test in integration supersedes the rest.
- Guard specs (`auth.guard`, `conditional-auth.guard`, `require-session.guard`,
  `registration.guard`): small and cheap; their behaviors are half-covered by
  `integration/auth.spec`. Keep until the integration matrix exists, then
  delete.

Keep (real logic, pure or near-pure): `static-prefixes`, `fragment-request`,
`image-url`, `image-variant`, `heic`, `postgres-indexes` (source-level
invariant), `auth-context.service` (JWT/`pwf` rules), `wardrobe-share.service`
(access matrix), `file-service.abstract` (sharp pipelines; 18 tests),
`storage-reconciliation.service` (cron registration, not reachable in
integration), `app.controller` (manifest builder).

### Flaky or sleep-based

- `test/pwa.spec.ts:98` `page.waitForTimeout(1500)` to prove a negative (no
  model download). Replace with waiting for `networkidle` or a
  `page.waitForLoadState('load')` plus a request-log snapshot; 1.5 s of its
  2.4 s is the sleep.
- Playwright specs create users with `Date.now()` emails against a shared
  server and never clean up; with `reuseExistingServer` locally they
  accumulate rows in `./data` (the dev database). They should run against a
  temp `DATA_PATH`.
- CI Playwright uses `retries: 2`, which hides flakiness rather than
  reporting it (no `--fail-on-flaky-tests`).
- Integration specs share state across tests within a file (e.g.
  `wardrobe.spec` "photo lifecycle" is an ordered narrative; `share.spec`
  second test depends on the first user set). Intentional and fine at this
  size, but `it.only` on a later test fails. No timing-based sleeps in the
  jest tiers; `reconcile.spec` backdates rows with `Date.now()` offsets,
  which is deterministic.

### Duplicated setup

- Env knobs duplicated across three places: `harness.ts` BASE_ENV, each CI
  step's env block (repeated five times), and Playwright/`.env`.
- Every Playwright spec re-implements "register, create garment, upload
  photo" through `page.request`; the integration tier has `garments.ts`
  for this. A shared Playwright fixture would remove ~40 lines.
- `precommit` rebuilds, and in CI every Playwright/load step rebuilds
  (six builds per CI run).

## 4. Missing gates

| Gate | Today | Effort to add | Cost per run |
|---|---|---|---|
| Type check | none (SWC and ts-jest transpile only) | ~1 to 2 h: add `"jest"` to `types` in a `tsconfig.spec.json` (or root) and fix 18 errors: 5 in src (`app.ts` decorateRequest null ×2, `open-graph.service.ts` string\|undefined ×2, **the `UniqueConstraintException` bug**), 4 in tests (harness `Buffer` → `BlobPart`, delivery, heic, file.controller mock type), 8 in `src-sw.ts` (give it its own tsconfig with `lib: ["webworker"]` and exclude `views/` from the root one) | 1.4 s warm incremental |
| Template correctness | none | I parsed all `views/**/*.hbs` with Handlebars: 0 parse errors, every helper used is registered (`t`, `hash`, `json`, `filterErrors`, `imageUrl`, `ifInArray`, `ifEquals`, `uri`, `gt`, `formatDate`, `formatColors` + built-ins), every partial exists (`swapMain` is an inline). `join` is registered but unused. Wire this as a ~50-line script, plus check every `reply.view('x')` name maps to a file and every `{{t 'lang.X'}}` exists. Better still, one integration spec that GETs every page route and asserts 200 and no raw `lang.` / `{{` in the body, which also covers the 15 unrendered views. | <0.5 s |
| i18n completeness | none (types are generated only in dev) | Today: all six languages have the same 213 keys, none missing; 1 to 6 per language identical to English. 50 English keys are never referenced literally (some are dynamic: `MONTH_I18N_KEYS`, `DAY_I18N_KEYS`). A key-parity script over `src/i18n/*/lang.json` + used-key extraction: ~30 lines. | <0.2 s |
| Migration drift | partial (index names only) | Add `expect(await orm.getSchemaGenerator().getUpdateSchemaSQL()).toBe('')` to `migrations.spec.ts`; runs on sqlite locally and Postgres in CI. Verified empty on both today. Add an up→down→up round trip on Postgres in CI. | ~10 ms |
| Dead code | none | `knip` (4.8 s) needs a config: entries for `src/main.ts`, `src/maintenance/reconcile.cli.ts`, migrations globs, `mikro-orm.*.cli-config.ts`, `public/js/*`, `views/assets/src-sw.ts`, scripts. Unconfigured output already shows real findings: unused devDeps (`chokidar`, `source-map-support`, `ts-loader`, `@eslint/eslintrc`, `@types/sortablejs`), and unlisted deps imported directly (`fastify` in 13 files, `@mikro-orm/knex`, `dotenv` in playwright.config) that only resolve transitively. | 5 s, CI only |
| Dependency audit | `npx npm-check-updates` (informational) | `npm audit --omit=dev --audit-level=high` today reports 9 high in production deps: `@fastify/static` (path traversal in directory listing), `@nestjs/platform-fastify`/`find-my-way`, `nodemailer` (SMTP injection), `sharp` (libvips CVEs), `axios`, `form-data`, `fast-uri`, `brace-expansion`. Five need major bumps. Gate on non-major fixes now; track the majors. Add Dependabot or Renovate. | 1.4 s, CI only |
| Hooks | none | Add a `pre-commit` hook (simple-git-hooks or a committed `.githooks/` + `core.hooksPath`), plus `pre-push`. | |
| Deploy gate | none | `docker-publish.yml`: trigger on `workflow_run` of CI with `conclusion == success`, or make it a job in the CI workflow with `needs:`. | 0 |

## 5. Proposed target loop

### Principles

- The integration tier is the product's proof. Push new behavior tests
  there; delete the unit wiring tests.
- Parallelize independent checks; cache everything (eslint, prettier, tsc
  incremental, jest transform, npm, Playwright browsers).
- Build once per CI run; Playwright and load tests reuse `dist/`.
- Perf checks (load, Lighthouse) are trends, not per-push gates.

### On save / watch

- `jest --watch` with a `projects` config (unit + int), `--onlyChanged`:
  1 to 2 s for the affected files.
- `tsc -p tsconfig.json --noEmit --watch --incremental` in a terminal or the
  editor's language server.
- `start:dev` as today.

### Pre-commit, target under 10 s (expected 5 to 6 s at 16 cores)

Run in parallel (e.g. `concurrently --kill-others-on-fail` or `npm-run-all -p`):

| Check | Expected |
|---|---|
| `prettier --check --cache` on staged files | 0.4 s |
| `eslint --cache` (no `--fix` in the check) | 0.7 s warm |
| `tsc --noEmit --incremental` | 1.4 s warm |
| `jest --selectProjects unit int` with `@swc/jest`, single invocation | 4.8 s (unit + full int); with `--findRelatedTests <staged>` often 2 to 3 s |
| i18n parity + template check script | <0.5 s |

Drop `npm run build` from pre-commit: SWC compile errors are caught by jest
(which loads the same sources) and tsc; tailwind/sw generation moves to
pre-push. Wall = the jest leg, ~5 s, versus 17 to 20 s today. Install it as
an actual git hook.

### Pre-push (~25 s)

- `npm run build` once (4 s), then Playwright chromium project against
  `start:prod` on a free port with a temp `DATA_PATH`, running smoke +
  camera + image-variants + auth (AUTH_ENABLED) + pwa (PWA_ENABLED): ~15 s
  if the PWA/auth runs are Playwright projects with their own `webServer`
  entries (Playwright supports an array of `webServer`s on different ports).
- Optional if docker is up: `TEST_DATABASE_URL=... jest --selectProjects int`
  (5 s).

### CI (target ~2 min wall to a gated deploy, from ~4.5 min)

Jobs in parallel, `setup-node@v4` with `cache: npm`, `npm ci`, Playwright
browsers cached by version and only chromium + webkit installed:

1. **static** (~40 s incl. install): format, eslint, tsc, i18n/template
   check, `npm audit --omit=dev --audit-level=high`, knip.
2. **test-sqlite** (~40 s): unit + int with coverage (merged report; enforce
   a floor per directory, start at current merged 68% lines so it can only
   rise).
3. **test-postgres** (~45 s): int on a Postgres 17 service container
   (`services:` instead of the third-party action), including the drift and
   up/down checks.
4. **e2e** (~90 s): build once, upload `dist/` + `public/` as an artifact or
   build in-job; chromium: all specs incl. pwa and auth; Mobile Safari
   (webkit): smoke, camera, image-variants (the real target is an iPhone
   PWA). Then the same smoke against Postgres + s3mock using the same build.
   Drop the separate `playwright.yml` workflow (it duplicates install and
   runs desktop Firefox/WebKit, which add little) or reduce it to a nightly
   cross-browser run.
5. **publish** `needs: [static, test-sqlite, test-postgres, e2e]` on `main`.
6. **perf** (load local/remote + Lighthouse): nightly or `workflow_dispatch`,
   or on main after publish, non-blocking, reusing one build. Saves ~80 s
   per push.

### On the specific ideas

- **`@swc/jest` instead of ts-jest:** measured -0.6 s unit, -0.7 s int.
  Worth it (the build already uses SWC, and ts-jest is already
  transpile-only because of `isolatedModules`), but small. Needs
  `decoratorMetadata: true` and `legacyDecorator: true`; all 178 tests passed
  unchanged with it.
- **jest projects:** yes. One invocation for both tiers: 4.8 s vs 6.7 s.
- **One shared booted app per worker:** blocked twice over. Jest isolates the
  module registry per file, so the 0.7 s module-graph load repeats regardless,
  and `AppModule` reads `process.env` at import. The fix that unlocks
  anything here is architectural: make `createApp(config)` take a validated
  config object instead of reading env at import. That also removes the
  "different AUTH_ENABLED needs a different file" gotcha. It becomes worth it
  when the tier passes ~40 files; at 13 files it saves under 2 s.
- **Transaction rollback per test instead of fresh DB:** do not. Boot +
  migrations are ~0.2 s per file, not per test, and the most valuable specs
  (`writes.spec`, `user-delete.spec`, `reconcile.spec`) assert commit and
  rollback behavior and file side effects that a wrapping transaction would
  mask. Keep one DB per file.
- **Sharding:** unnecessary at this size; the CI job split above is the
  parallelism that matters.
- **Playwright against the in-process app:** possible (call `createApp()` and
  `listen(0)` in a global setup, skipping `npm run build`), saving ~10 s per
  local run. But the e2e tier's job is to prove the built artifact
  (`dist/`, generated `bundle.css`, `sw.js` precache manifest), so keep the
  built server in CI and use the in-process variant only for a fast local
  project.
- **vitest:** not worth a migration. The cost is module loading, not the
  runner; vitest's `isolate: false` could share the graph across files but
  collides with the env-at-import design, and Nest needs an SWC plugin for
  decorator metadata. Revisit only after `createApp(config)`.
- **bcrypt:** make the cost factor configuration (`BCRYPT_ROUNDS`, default
  12, harness 4). Removes a hardcoded value; saves ~1.5 s of CPU per int run.

### Coverage work, in priority order

1. Authorization matrix spec (`AUTH_ENABLED=true`): for every garment,
   outfit and calendar route, owner / MANAGE grantee / VIEW grantee /
   stranger / anonymous → expected status and no DB change. Table-driven, ~150
   lines, covers ~25 routes at once.
2. Share lifecycle: revoke removes access, decline, duplicate accept (fails
   today with the TypeError).
3. Outfits and calendar: CRUD integration specs; calendar date logic as pure
   unit tests over fixed dates (month boundaries, week start, DST, leap day).
4. Every-page render spec (all GET page routes, both auth modes): 200, no raw
   i18n keys, one `htmx-config` meta. Catches template and helper regressions
   for the 15 unrendered views.
5. Password reset and email change flows (with the email transport stubbed
   and the reset code read from the DB); `pwf` invalidation of old sessions.
6. Garment edit (`POST /wardrobe/:id`), edit/clone forms, archive assertions.
7. PWA spec in CI (set `PWA_ENABLED`, VAPID keys, `https:` `SITE_URL`).

### Expected numbers

| Loop | Today | Target |
|---|---|---|
| save → affected tests | n/a (no watch config) | 1 to 2 s |
| pre-commit | 17 to 20 s, manual, serial | 5 to 6 s, hook, parallel, adds tsc + i18n/template |
| pre-push | none (precommit:full ~90 s, manual) | ~25 s incl. PWA + auth e2e |
| CI to deploy | ~4.5 min, deploy not gated | ~2 min, deploy gated on all jobs |
| routes with behavior tests | 28 / 58 | 55+ / 58 after items 1 to 6 |
| merged line coverage | 68% | ~85% after items 1 to 6 |
