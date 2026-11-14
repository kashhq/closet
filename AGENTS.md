# Closet

Self-hosted digital wardrobe for the household: catalog garments (photo with background removal, category, brand, size, color), compose outfits, plan them on a calendar, and share a wardrobe with another user. Hard fork of Libre Closet (AGPL-3.0; no upstream remote or merges). Deployed on the homelab. Stack and file detail: `docs/architecture.md`; what it used to be: `docs/history.md`.

**The primary interface is the installed PWA on phones.** Every feature must work as an installed, offline-tolerant app first and as a desktop web page second.

## Stack

Conventions: `backend.md`, `frontend.md`, `frontend-pwa.md`, `frontend-htmx.md` (hypermedia principles only; the Jinja2/FastAPI specifics do not apply)
Capabilities: pwa, push, scheduled-jobs

- **Runtime**: Node 22 (`.nvmrc`), TypeScript, plain **Fastify 5** (no framework on top), built by `tsc` to `dist/`.
- **Image**: runs as `node` (uid/gid 1000), never root; it writes only `DATA_PATH` and `MODELS_PATH`, host mounts that must be writable by uid 1000 (`docs/operations.md#permissions`; `/health/ready`'s `storage` check, the boot refuses an unwritable `DATA_PATH`, and one without its `.closet-storage` marker while photo rows exist: Images). A new runtime write path gets a `chown` in the Dockerfile and a row there.
- **Views**: server-rendered typed JSX (`hono/jsx` to strings, no Hono server) in `src/web/`, htmx 2, a few modules in `public/js/`. Not a SPA; no JSON API for the UI.
- **CSS**: Tailwind v4 + daisyUI (`views/assets/main.css` to `public/bundle.css`; `views/assets/AGENTS.md`).
- **Data**: PostgreSQL 18 only (production, pgvault-dev, and the throwaway containers check_tree and CI test on). **Drizzle ORM owns the schema, the migrations and every query** (`src/db/schema.ts`, `drizzle/`, applied at boot).
- **Auth**: a JWT in an httpOnly `access_token` cookie, into `req.auth` per request; `/mcp` takes agent tokens, `/api/v1` device tokens (`src/web/api/AGENTS.md`). Every route that changes or hands out a credential asks for the current password (`src/web/auth/AGENTS.md`).
- **PWA**: Workbox `injectManifest` over `views/assets/src-sw.ts` (to `public/sw.js`), Web Push via `web-push` + VAPID; gated by `PWA_ENABLED`.
- **Images**: `sharp`, `heic-decode`; background removal on the server only (BiRefNet, `onnxruntime-node`, a child process). Storage: local disk under `DATA_PATH`, the only backend.
- **i18n**: English only, `src/i18n/en/lang.json`, `t('KEY')` typed to its keys. **Logging**: one pino logger (`src/logger.ts`), a child per module.
- **Tests**: Vitest unit, Vitest integration (the real app in-process on a scratch Postgres database) and Playwright; `test/AGENTS.md`.

### Gotchas

In full: `docs/conventions.md#tooling-gotchas`. The web layer's are rules under Web layer.

- **Never `prettier --write` a directory**: it re-pads the persona bibles (`src/seed/personas/*.md`) and the seed breaks (`persona.spec.ts`). Use `npm run format`.
- **Upstream references are attribution only** (About, README, comments citing upstream issues); anything else is a rebrand regression: grep before a PR.
- **`npm install <package>` skips our `postinstall`**, so `patches/` are unapplied and the drift test fails; run `npx patch-package` or `npm ci`.
- **Regenerate `package-lock.json` only with Node 22 / npm 10**: npm 11 prunes entries the Docker build's `npm ci` needs.
- **macOS needs `sudo ifconfig lo0 alias 127.0.0.2`** before the integration tier or `npm run check`: without it about 22 specs fail with EADDRNOTAVAIL (`test/integration/link-sites.ts`).
- **`devkit/` is untracked** (pinned in `.devkit-rev`, filled by `.devkit-bootstrap.sh`): a fresh worktree runs `make install` before `npm test` or ESLint can find `devkit/lint/`; `rm -rf devkit` before checking out a commit older than the pin (git refuses otherwise). Never edit it: `make devkit-check` fails.
- **`public/build.json` lingers after `npm run build`**: stale styles in `start:dev`; set `NODE_ENV=development` in `.env.local` or delete it.

## Architecture

```
src/
  app.ts          createApp(): migrations, pool, Photos, outbound fetcher, weather, then Fastify: root
                  hooks (same-origin at onRequest; rate limits; session + page context at preValidation,
                  skipped for static-prefixes.ts paths; security headers; request log), parsers, static
                  roots, error + not-found handlers, then webPlugin. Used by server.ts and the harness
  server.ts       serve(): createApp, the nightly and minute timers, the cutout queue, listen
  main.ts         production entry: loadConfig, createLogger, the model runner, serve()
  config.ts       loadConfig(), the only reader of process.env     logger.ts  createLogger()
  project-root.ts PROJECT_ROOT, valid from src/ and dist/
  random.ts       seededRandom(...key): the one seeded PRNG; never Math.random or the clock
  calendar-date.ts IsoDate and day arithmetic, todayIn(tz, now): pure, shared by every layer
  web/            plugin.ts, errors.tsx, render.ts, loggable-url.ts, i18n.ts, autosave.tsx,
                  page-cache.ts, view-context.ts, schemas.ts, layout/, security/, one dir per feature
  db/ maintenance/ metrics/ cutout/ wardrobe/ push/ weather/ seed/   each: see the area index
views/assets/     main.css, src-sw.ts, fonts.css
public/           sw.js, bundle.css, vendor/, modules/, js/, assets/ (generated from icon.svg)
test/             Playwright specs; support/, integration/: test/AGENTS.md
drizzle/          generated migrations + meta/ (journal, snapshots)
docs/             the list is README's Documentation section; DESIGN.md (upstream entity model)
                  is still the reference for feature scope
```

### Area index

Each area's detail lives in an `AGENTS.md` beside its code, with `CLAUDE.md` a symlink to it so Claude Code loads it when a file in its directory is read; when planning work in an area, read its doc first. A "see Wardrobe" elsewhere means that area's doc.

| Area | Doc | Read it when the work touches |
| --- | --- | --- |
| Request security | `src/web/security/AGENTS.md` | CSRF, rate limits, proxies, outbound fetches, redirects, logout, session revocation |
| Auth | `src/web/auth/AGENTS.md` | the session, passwords, emails, the step-up rule |
| Images | `src/web/files/AGENTS.md` | storing, serving, deleting or referencing photos, pending photos |
| Background removal | `src/cutout/AGENTS.md` | cutouts, their state machine, the queue, the model child |
| Wardrobe | `src/web/wardrobe/AGENTS.md` | garments: the grid, the form, properties, bulk edit, tagging, search |
| Link import | `src/web/wardrobe/link-import/AGENTS.md` | adding a garment from a product link or Android's share sheet |
| The garment model | `src/wardrobe/AGENTS.md` | the pure rules in `src/wardrobe/`, adding an occasion or a property value |
| Wishlist | `src/web/wishlist/AGENTS.md` | the wishlist (Muse's inbox, its decision screen), a garment's status, "Bought it", the retired plans' addresses |
| Style profile | `src/web/style/AGENTS.md` | the style profile (what the agent reads of your taste) |
| Capsules | `src/web/capsules/AGENTS.md` | capsules and the capsule filter |
| Wears and washes | `src/web/wears/AGENTS.md` | wears, washes, away, laundry, availability |
| Insights | `src/web/insights/AGENTS.md` | the insights page |
| Sharing | `src/web/sharing/AGENTS.md` | the access resolver; which surfaces are share-aware vs owner-only |
| Sizes | `src/web/sizes/AGENTS.md` | sizes, body measurements, the brand hint |
| Seed personas | `src/seed/AGENTS.md` | the seed, the persona bibles, demo data |
| Calendar | `src/web/calendar/AGENTS.md` | the calendar, its entries and occasions |
| Trips | `src/web/trips/AGENTS.md` | trips and packing lists |
| Outfit selfies | `src/web/selfies/AGENTS.md` | selfies of worn entries |
| Weather | `src/weather/AGENTS.md` | the forecast, climate normals, `/weather/*` |
| Outfits | `src/web/outfits/AGENTS.md` | outfits, deleting one, what holds one |
| Styling | `src/web/styling/AGENTS.md` | the outfit composer |
| Snap strip | `src/web/strip/AGENTS.md` | the scroll-snap carousel (`SnapStrip`, `snap-strip.js`) Styling and the plan review share |
| Outfit gallery | `src/web/gallery/AGENTS.md` | the Ideas tab and anything that suggests outfits (`ideasFor`) |
| Inspiration | `src/web/inspiration/AGENTS.md` | saved looks (the Inspiration tab), their private photos, "recreate this look", the share target, their MCP tools |
| Today | `src/web/today/AGENTS.md` | the home screen |
| Weekly auto-plan | `src/web/week-plan/AGENTS.md` | "Plan my week", the daily re-plan, `planned_by` |
| Web Push | `src/push/AGENTS.md` | subscriptions, notifications, reminders |
| MCP server | `src/web/mcp/AGENTS.md` | `/mcp`, its tools, personal access tokens |
| Changes feed | `src/web/sync/AGENTS.md` | `/api/v1/changes`, its cursor, what a synced resource carries |
| JSON API | `src/web/api/AGENTS.md` | `/api/v1`, the device sign-in, problem+json, the OpenAPI spec, adding an API route |
| Health | `src/web/health/AGENTS.md` | `/health/live`, `/health/ready`, `/healthz`, a readiness check, the image `HEALTHCHECK` |
| PWA and the service worker | `src/web/shell/AGENTS.md` | the service worker, caching, offline, queued writes (the outbox), install, updates, static delivery |
| Styles and fonts | `views/assets/AGENTS.md` | the theme, colours, fonts |
| Layout | `src/web/layout/AGENTS.md` | the app bar, the dock, sections, stacking, a page's `<main>` |
| Database | `src/db/AGENTS.md` | schema internals, drizzle-kit traps, the MikroORM-era adoption |
| Maintenance | `src/maintenance/AGENTS.md` | the timers, storage reconciliation, the CLIs |
| Metrics | `src/metrics/AGENTS.md` | `/metrics`, Server-Timing, the device timings, a new timer or label |
| Tests | `test/AGENTS.md` | the integration harness, Playwright's server, Vitest traps |
| Deployment (not auto-loaded) | `docs/operations.md` | production, its env, recovery, CI publishing |

`src/web/weather/AGENTS.md` and `src/web/push/AGENTS.md` only point to Weather's and Web Push's docs. `make docs-check` (`ci-quick`) holds this index to the docs on disk (`scripts/ci/docs_rules.sh`); the size caps and symlink rule are devkit's.

### Routes

In full, with every route's owner: `docs/architecture.md#routes`. `GET /` is Today. A route is public only with `config: { public: true }` (login, registration, `/health/*` and `/healthz`, `/share`, most `/file/**` images; never an outfit selfie's); `/mcp` and `/api/v1` take a token, never the cookie (their `surface`, `src/web/surface.ts`); everything else needs a session and is the user's own. `/weather/*` exists only with `WEATHER_ENABLED`, `/push/*` only with `PWA_ENABLED`.

### Request flow

In full: `docs/architecture.md#request-flow`. Root hooks in `app.ts` (same-origin at onRequest; `req.auth` and `ViewContext` at preValidation, skipped on static paths), then a route, a static file or the not-found handler. Every response gets the security headers and, off static paths, one access line (onResponse).

### Web layer (adding a feature)

Each rule in full, with its story: `docs/web-layer.md`. A feature lives whole (routes, queries, views) in `src/web/<feature>/`, a plugin registered from `webPlugin` (`src/web/plugin.ts`). Integration specs driving HTTP are the proof that a change keeps behavior.

- **Code no feature owns**: pure goes in the `src/` root (`random.ts`, `calendar-date.ts`) or a pure layer (`src/wardrobe`, `src/weather`, `src/push`: ESLint refuses `web/`, `db/`, `drizzle-orm`, `node:*`); web-only in the `src/web/` root; features share queries, writers, urls and status basics, never pages (`docs/web-layer.md#code-no-feature-owns`).
- **Imports point down the layer stack** in `scripts/ci/layers.conf` (shared root modules, config/logger beside the pure layers, metrics, db, cutout, web, maintenance, seed; the entries and CLIs on top). `make layer-check` (ci-quick) refuses an upward edge; the `known` lines only shrink (`coupling.backend.layer_violations`). Move the shared piece down rather than adding one.
- **Routes**: `routes.tsx` exports a `FastifyPluginCallbackTypebox<WebOptions>`. Config arrives resolved as `WebConfig`; nothing in `src/web/` reads `Config` or `process.env`.
- **API parity** (#191): a feature is done when its domain function has a page caller, an API caller and, where an agent needs it, an MCP caller. Every page route that is not a GET, and every MCP tool that writes, is classified in `src/web/api/operations.ts` (its API twin, `webOnly` with a reason, or `pending` its endpoint issue); `api-parity.spec.ts` fails on one that is not.
- **Validation**: TypeBox schemas (`@sinclair/typebox` 0.34; 1.x is ESM-only) on the route, never hand-parsing; a failure is the 400 page. A maybe-empty body is `Type.Union([Type.Object(...), Type.Null()])`. Say at the route whether bad input is a 400 (stored data) or a fallback (URL state, `?week=`).
- **Auth**: `requireSession` / `decideSessionAccess`: a navigation without a session is a 302 to `/auth/login`, an htmx request a bodiless 401 with `HX-Redirect`. User id: `sessionUserId(request)`, which throws on a public route. `config: { public: true }` is the only way past the gate, and a route under a `static-prefixes.ts` path never has a session, so must be public.
- **Queries**: Drizzle via `options.db` in `queries.ts`; specs assert rows through `t.db`. A write to a synced table takes its owner's lock first, `ownerTransaction` or folded into its first statement (`src/db/owner-lock.ts`; the sync triggers refuse it otherwise, and spec fixtures write through `asFixture`; Calendar's Owner lock). Never set a synced row's `revision` or `updated_at`: the triggers own them (`src/db/AGENTS.md`, The sync triggers). **Views**: a `.tsx` per page or fragment, `ctx: ViewContext`, `<Layout>`, `<AppBar>`, `<Dock>`, strings via `t('KEY', { param })`.
- **Navigation**: a tap is a boosted `<a href>` or an htmx request, never script setting `location` (`expectNoScriptNavigation`, `test/integration/pages.ts`). A write ending on another page answers `navigateTo(reply, path)`; `HX-Redirect` only for the 401 and the photo upload.
- **Rendering** only through `renderPage` / `renderFragment` / `renderToString` (`src/web/render.ts`), which await it: `String(<Page />)` can be `[object Promise]`. Specs read markup through `unescapeHtml`.
- **Errors**: `throw new HttpError(status)` (`src/web/errors.tsx`); the root error handler renders `ErrorPage`, anything else a detail-free 500. It owns every htmx failure (#642): a fragment request gets no body and an `HX-Trigger` toast (`public/js/request-failures.js`), a boosted tap the page; never answer 200 with an error to reach htmx (`docs/web-layer.md#a-failed-htmx-request-says-so-642`). A 404 or 403 is `NotFound(resource)` / `Forbidden()` (`src/web/refusals.ts`), thrown by the domain function, which takes an `Actor` (`actorOf`), never by a route or tool (guards.conf `[refusals]`, #188). The root hook must stay at preValidation (validation runs after it, so a 400 keeps its page).
- **Hooks**: an async hook that answers must `return reply` or the handler sends again; one without async work takes `done` (`@typescript-eslint/require-await`). `createApp()` registers every root piece before `webPlugin`: a plugin inherits only what existed when it was registered.
- **An API route** (`/api/v1`, #190) lives in `src/web/<feature>/api-routes.ts`, registered in `apiPlugin`, calling the page's own domain function; it declares `operationId`, `tags` and `apiResponses(...)` (the boot refuses one without), and its PR runs `npm run api:spec` and commits `openapi.json` (the drift test). In full: `src/web/api/AGENTS.md`.
- **Escaping**: the only raw-markup hatch is `dangerouslySetInnerHTML`, fed `tHtml()` or `jsonForScript()`, never a raw value, with a reason at each site. `hono/html` is banned by ESLint.
- **Forms**: every post form is `PostForm` (`src/web/auth/form.tsx`), a native post: htmx swaps no 4xx, and boosted forms lose password saving (`expectNativePostForms`); uploads too, never `hx-post`. It submits once (`public/js/submit-once.js`); the server stays the guard where a duplicate matters. Fields: `FormField` + `inputAttributes` (`src/web/form-field.tsx`), the one spelling of an invalid field (`@field-invalid`).
- **Autosave**: every control saved on change is built by `src/web/autosave.tsx` (`AutosaveForm`, `autosaveAttributes`), never by hand with `hx-trigger="change"` (`expectAutosaveControls`); **no other swap may replace an autosave form**, or its queued save dies.
- **htmx** reads only the first `<meta name="htmx-config">`; `disableInheritance` is on, so the body's `hx-inherit="hx-boost hx-indicator"` must stay.

### Request security

The detail of each rule, its code and its spec: `src/web/security/AGENTS.md`. What every change keeps:

- **CSRF**: the root same-origin hook 403s a POST, PUT, PATCH or DELETE whose `Origin` (or `Referer`) is not this site, before the body is read; a missing Origin passes only on the bearer surfaces and the reviewed `stateless` routes that write nothing (`STATELESS_ROUTES`). Nothing changes state on a GET. The service worker never sends a navigation POST to the server: its fetch would launder the Origin (#542); the one it answers is the share target, on the device with no fetch (`navigationPostAnswer`, `src/web/shell/AGENTS.md`). The bearer surfaces (`/mcp`, `/api`) accept no Origin and refuse a foreign one. The harness sends an Origin; Playwright posts use `SAME_ORIGIN` / `signUpHeaders()`.
- **Rate limits** are per route, opt-in: `SIGN_IN_LIMIT` (one budget for the login page and the API sign-in, which adds `SIGN_IN_ACCOUNT_LIMIT`), `API_LIMIT` (and `API_PHOTO_LIMIT`, the photo-byte routes' own budget), `ACCOUNT_LIMIT` (every route that checks the current password), `LINK_IMPORT_LIMIT`, `WEATHER_SEARCH_LIMIT`, `WEATHER_LOCATION_LIMIT`, `MCP_LIMIT`, `HEALTH_LIMIT` (`/health/ready`, per address), `PHOTO_UPLOAD_LIMIT` (every route marked `photoUpload`, pages and API on one budget; a multipart body elsewhere is a 415).
- **Refusals do not reveal ids**: unseeable is a 404 like an unknown id; seeable but not changeable is a 403 (`WardrobeAccess`; the matrix is `test/integration/authorization-*.routes.ts`).
- **Outbound fetches** of a user-supplied URL or a third-party API go only through `createOutboundFetcher` (`make guard-check`).
- **Redirect targets** from the user go through `safeReturnTo`; a path carrying a secret sets `config: { secretPath: true }`; log lines name requests through `loggableUrl()`; public pages never show an email.
- **Sessions**: signing out is `POST /auth/logout`; a new password ends every other session, personal access token and push subscription; Sign out everywhere (`/auth/sign-out-everywhere`, behind the password) every other session, device token and push subscription (the session version, `sv`, #700).

### Config and logging

In full: `docs/conventions.md#config`, `#logging`. `loadConfig()` (`src/config.ts`) is the only reader of `process.env`; a bad value stops the boot naming the key, never the value (`ConfigError`). Secrets have no default. A new env var gets a schema entry and a README row. **The image bakes `.env`, never `.env.local`**. Log through the module's pino child at operation boundaries with ids (`logger.error({ err }, message)`, never the error's text: `errorFields` redacts it), never in rendering or loops, never `console` (ESLint). JSON lines carry `logger` and the operation's `request_id`, or a job's `job_id` and `parent_request_id` (`src/request-context.ts`). Bugsink's `environment` is `APP_ENV`, never NODE_ENV.

### Project rules

In full: `docs/conventions.md`, `docs/web-layer.md#client-behavior`.

- **Server owns the HTML**: htmx attributes, then CSS, then a one-line inline handler reading `data-*`; bigger is a `public/js/` module with a reason in the PR. No `_hyperscript` (`expectFullPage` fails an `_=` attribute). **Locality of behavior**: view logic beside its markup.
- **Every user-facing string goes through i18n** (`t`/`tHtml`, `src/i18n/en/lang.json`).
- **daisyUI semantic tokens, no hardcoded colors** (ESLint: palette classes, `chip-N`, colours in `style`). Muted text is `text-muted`; `text-faint` never for text; ESLint refuses `text-base-content/0`–`/69`; no `opacity-*` on text.
- **No runtime CDN imports**: client packages from `public/modules/` (`CLIENT_MODULES`) or `public/vendor/`; zero external requests (`delivery.spec.ts`).
- **Postgres in every tier**; no second driver for test speed.
- **Cookies are `Secure` only when the request is https** (`sessionCookieOptions`, `src/web/auth/session.ts`: `request.protocol`, which believes `X-Forwarded-Proto` only from `TRUSTED_PROXIES`); never a blanket `secure: true`: the HTTP twin has no TLS and its login would break (#700). `SameSite=Lax` must stay (CSRF).
- **Offline-first per `frontend-pwa.md`**: cached reads show freshness; unreachable writes are disabled with a reason, never dropped, except wears, washes and packing ticks, which the page's outbox queues and replays (`data-offline-queue`, `src/web/shell/outbox.md`, #178); heartbeat, not `navigator.onLine`.
- **"Today" is `todayIn(APP_TIMEZONE, now)`** in app and tests (`t.today()`, `householdToday()`): a UTC date is tomorrow on a New York evening. ESLint's `no-restricted-syntax` refuses `toISOString().slice/substring/split` and `toLocaleDateString`; a new consumer gets a row in `test/integration/today.spec.ts`.

### Changing the schema

`src/db/schema.ts` is the schema; `drizzle/` holds the migrations drizzle-kit generates from it. The server migrates on every boot (`createApp()`, before the pool opens and before anything queries), so a deploy is the migration. The CLIs never migrate: `requireCurrentSchema` refuses a database behind the build (`SchemaBehindError`, exit 1) or ahead of it (`SchemaAheadError`, which the boot refuses too: `docs/operations.md#migrations-and-rollback`).

1. Edit `src/db/schema.ts`. Names follow the existing ones (`<table>_<column>_index`, `_unique`, `_foreign`; a composite lists its columns in order). Every foreign key column gets an `index()` or leads a composite index or unique constraint: Postgres does not index them on its own.
2. `npx drizzle-kit generate --name <what-changed>` writes `drizzle/NNNN_<name>.sql` and its snapshot. Read the SQL: a rename makes it prompt (run it in a terminal); data fixes (backfills, deletes before `SET NOT NULL`) are hand-added to the file. Every migration starts with `SET LOCAL lock_timeout = '5s';` and a breakpoint (see 0051); `src/db/migration-lock-timeout.spec.ts` fails without it from 0051 on.
3. `npm run test:int`: `test/integration/migrations.spec.ts` asserts that drizzle-kit's `pushSchema` finds nothing to change after boot (a schema edit without its migration fails there, naming the missing statement) and lists the index names queries rely on.
4. Never edit or delete a migration that has shipped. Drizzle applies every file whose journal `when` is newer than the last row in `drizzle.__drizzle_migrations` and never re-checks hashes, so an edited file silently diverges from production.

### Deployment

Production runs on the homelab and merging to `main` deploys it: the publisher host's `make publish` (never the Mac: arm64) pushes the image and the hourly autoupdater pulls it. The env, the demo login, locked-out recovery, rotating the secret, publishing: `docs/operations.md`. Production's topology: homelab's `stacks/closet/README.md` only (devkit's docs-check and devkit-check).

- **Release identity: `APP_VERSION` is the bare 7-char sha** (`docs/decisions.md` 2026-10-13), passed once by the publisher; `/health/ready` `version`, /about, MCP and the error tracker's release all read it. Only the image *tag* says `sha-<7>`. Compose and `.env` never set it (`make release-check`). **Only the publisher moves `latest`** (the deploy), then tags `ship-<YYYY-MM-DD>-<sha7>`. No semver or date tags.

## Convention deltas

Deviations from `~/.claude/conventions/`, each with its `docs/decisions.md` entry:
- **Job outcomes add `discarded` and `interrupted`** (the cutout queue), non-alerting; any error or timeout is `failure`. `JOB_OUTCOMES` and `metrics.spec.ts` hold the list (2026-10-13, Observability contract).
- **Statement budgets come only from `recordQueries` blocks** (`build/statements.json`, `make ci-db`): the most statements each `<METHOD>:<route>` sent there, not every request the suite makes (2026-10-13, Observability contract 2).
- **No pull-request job in Actions and no pre-merge gate**: a PR merges on review rounds (`@codex review`, or `make review PR=<n>`), and main is proven at deploy by the publisher's check_tree (devkit 2026-11-02); `ci.yml` runs only by hand.
- **`nightly.yml` runs on a `schedule:`**: the page audit, Lighthouse, the real cutout model and WebKit, too slow for any PR; nothing in it gates a deploy (2026-10-16, Convention deltas declared).
- **The image smoke is `scripts/smoke-image.sh`, not devkit's `boot_image.sh`**: it boots on the host network, then runs devkit's `contract_probe.sh` (2026-10-16, Convention deltas declared).

## Commands

Each command's detail (flags, timings, what it needs): README's Development section.

```bash
nvm use                       # Node 22, the exact .nvmrc version
npm ci                        # postinstall applies patches/ via patch-package
npm run start:dev             # tsc, node and tailwind, each --watch
npm run build                 # clean, tsc (type-checks), generate
npm run start:prod            # node dist/main.js, as the image runs it; fetches the 940 MB model on first boot
npm run start:test            # the build with background removal stubbed: what Playwright and Lighthouse start
# The CLIs run from dist/ (build first) and never migrate:
npm run maintenance:reconcile # src/maintenance/AGENTS.md, like user:set-password and push:revoke-all
npm run seed                  # src/seed/AGENTS.md
npm run cutout:fetch-model    # src/cutout/AGENTS.md
npm run lint                  # eslint --fix; lint:check is the gate
npm run format                # prettier --write; format:check is the gate

# Test tiers, cheapest first; all but the first need Postgres (pgvault-dev, .env.local: README)
npm test                      # Vitest unit projects; test:watch, test:debug
(cd ../pgvault-dev && docker compose up -d --wait)
npm run test:int              # Vitest integration: the real app in-process, a scratch database per spec file
npm run test:e2e              # build, then Playwright (ten scenarios): test/AGENTS.md
npm run audit:pages           # every page/action as the demo persona vs docs/perf/
npm run lighthouse            # lhci autorun
npm run test:all              # every Vitest project; test:cov adds v8 coverage
npm run typecheck             # app, tests, scripts, then the service worker
npm run check                 # check:static (format, lint, types) + test:all (~80 s); alias precommit
npm run verify:push           # build + Chromium Playwright (the plan: make ci-e2e)
npm run precommit:full        # check + verify:push + page audit + lighthouse (minutes)
npx drizzle-kit generate --name <what-changed>   # see Changing the schema
docker build --build-arg APP_VERSION=dev -t closet .

# The plan's jobs (scripts/ci/gate_plan.sh), each on its own throwaway Postgres 18
make install                  # git hooks (.githooks/), once per checkout or worktree
make ci-deps ci-quick         # npm ci; guards (docs-check among them), secrets, lint, types
make ci-unit | ci-db | ci-e2e # each reports OVERBUDGET / FLOOR warnings (Workflow)
make ci-metrics               # the metrics report (never fails); make metrics-tighten keeps a cleanup round's gains
make review PR=<n>            # one local review round (when Codex is out of budget)
make merge PR=<n>             # squash-merge once the review rounds allow it
```

Builds, test suites, and `npm ci` go through a `build:build-runner` subagent, never inline.

## Deliberate exceptions

Planned contract items still missing (`docs/decisions.md` 2026-10-16, Convention deltas declared):
- **No `job_last_success_timestamp_seconds`** yet: lands with homelab's JobStale rule template (standardization wave 4).
- **Push and MCP outcome words** are unchanged until the owner decides them (2026-10-13, Observability contract 2).

## Workflow

<!-- ORCHESTRATION-OVERRIDE: claudebot agents skip this section.
     Your agent definition governs your workflow. -->

- **Backlog: GitHub issues, ordered by the pinned Roadmap (#27).** Pull the first unchecked item whose dependencies are done; its issue links to its design section in `docs/plans/` and lists the acceptance criteria. Open work and status live in issues, not in docs or memory. New ideas go in the **Later** milestone with where they were seen.
- Before implementing, read `docs/PROJECT_LOG.md` and this file for decisions and gotchas in the area.
- Plan in plain text and get approval before writing code or spawning implementers. Approval of a goal is not approval of an implementation.
- **Tests are budgeted and lean** (owner directive 2026-10-13; `test/AGENTS.md`): `make ci-unit` ≤ 60 s, `ci-db` ≤ 110 s (integration workers share their module graph: no `vi.mock` there), `ci-e2e` ≤ 180 s, each with a collected-count floor; the tier guard reports OVERBUDGET / FLOOR warnings, it does not fail. A test earns its place: it fails for a plausible regression in our code, proves what no kept test proves, is hermetic, and runs at the cheapest tier that can prove it. Behavior assertions go in `test/integration/` (the real app in-process); Playwright holds ten critical-path scenarios for what only a browser shows, and a new one replaces one.
- **Metrics are an on-demand report for cleanup rounds, not a per-PR gate** (`make ci-metrics` prints WORSE/BETTER and exits 0; complexity, dead code, import cycles, duplication, coverage lines and branches): a cleanup round reads it and runs `make metrics-tighten` to keep its gains. No label, no tighten commit per PR (devkit decisions 2026-11-13). Coverage is read from `make ci-db`'s report; vitest has no thresholds (`docs/decisions.md` 2026-10-16).
- **Before a feature is called done** it is verified in a browser as an installed PWA at phone width (type checks and tests verify code, not the app): Playwright at 390 px, locally in the one worktree not racing another for `:3000`, or from CI's uploaded artifacts.
- **Changes land through pull requests** (owner decision 2026-09-26), per issue slice (in full: `docs/workflow.md`): a branch `<issue>-<slug>` (own worktree when agents run in parallel); the fast loop locally; a PR linking its issue; a review round (`@codex review`, or `make review PR=<n>` at Codex's limit; docs-only PRs owe none), its P0/P1 findings answered once; `make merge PR=<n>` squash-merges. No pre-merge gate (devkit 2026-11-02): at most `DEVKIT_REVIEW_ROUNDS` (3) rounds; below the cap P0/P1 block, at it only P0, the rest filed as issues. Parallel branches that clash show on main and are fixed forward. Merging publishes, then deploys; the owner may stop any PR.
- **Migrations and parallel branches:** two branches that each generate `NNNN` collide in `drizzle/meta/_journal.json`. The later branch rebases on `main`, deletes its migration and snapshot, and regenerates (`npx drizzle-kit generate`); the drift test (ci-db) proves the result. Never hand-merge a journal.
- pre-commit runs guards, staged secrets and lint; pre-push typecheck and unit; never bypass either with `--no-verify`. If a hook fails, fix and create a new commit, never amend.
- Commit messages: concise, why over what.
- When a new pattern or gotcha lands, write it in its area's `AGENTS.md` (the area index; this file only for what every change needs) in the same commit, and add a dated `docs/decisions.md` entry for the decision behind it in the same change.
- No upstream sync: closet is a hard fork and never merges from Libre Closet. Restructure freely; offering a fix back upstream is optional, not part of the workflow.
