# Closet

Self-hosted digital wardrobe for the household: catalog garments (photo with background removal, category, brand, size, color), compose outfits, plan them on a calendar, and share a wardrobe with another user. MIT-licensed; every line is the owner's (`make upstream-check`, #1225). Deployed on the homelab. Stack and file detail: `docs/architecture.md`.

**The primary interface is the installed PWA on phones.** Every feature must work as an installed, offline-tolerant app first and as a desktop web page second.

## Stack

Conventions: `backend.md`, `frontend.md`, `frontend-pwa.md`, `frontend-htmx.md` (hypermedia principles only; the Jinja2/FastAPI parts do not apply)
Capabilities: pwa, push, scheduled-jobs

- **Runtime**: Node 22 (`.nvmrc`), TypeScript, plain **Fastify 5** (no framework on top), built by `tsc` to `dist/`.
- **Image**: runs as `node` (uid/gid 1000), never root; it writes only `DATA_PATH` and `MODELS_PATH`, host mounts that must be writable by uid 1000 (`docs/operations.md#permissions`). A new runtime write path gets a `chown` in the Dockerfile and a row there.
- **Views**: server-rendered typed JSX (`hono/jsx` to strings, no Hono server) in `src/web/`, htmx 2, a few client modules (`views/assets/page/`, built to `public/js/`: `src/web/shell/AGENTS.md`). Not a SPA; no JSON API for the UI.
- **CSS**: Tailwind v4 + daisyUI (`views/assets/AGENTS.md`).
- **Data**: PostgreSQL 18 only. **Drizzle ORM owns the schema, the migrations and every query** (`src/db/schema.ts`, `drizzle/`, applied at boot).
- **Auth**: a JWT in an httpOnly `access_token` cookie; `/mcp` takes agent tokens, `/api/v1` device tokens. Every route that changes or hands out a credential asks for the current password (`src/web/auth/AGENTS.md`).
- **PWA**: Workbox `injectManifest` over `views/assets/src-sw.ts` (to `public/sw.js`), Web Push via `web-push` + VAPID; gated by `PWA_ENABLED`.
- **Images**: `sharp`, `heic-decode`; background removal on the server only (a child process); storage is local disk under `DATA_PATH`.
- **i18n**: English only, `src/i18n/en/lang.json`, `t('KEY')` typed to its keys. **Logging**: one pino logger (`src/logger.ts`), a child per module.
- **Tests**: Vitest unit, Vitest integration (real app, scratch Postgres) and Playwright; `test/AGENTS.md`.

### Gotchas

In full: `docs/conventions.md#tooling-gotchas`. The web layer's are rules under Web layer.

- **Never `prettier --write` a directory**: it re-pads the persona bibles (`src/seed/personas/*.md`) and the seed breaks (`persona.spec.ts`). Use `npm run format`.
- **Every line is ours** (MIT, #1225): outside code or text comes in only under an MIT-compatible licence, credited in `scripts/third-party-notices.ts`; `make upstream-check` (minutes, no tier) must stay at 0, and `make docs-check` refuses the original project's name.
- **`npm install <package>` skips our `postinstall`**, so `patches/` are unapplied and the drift test fails; run `npx patch-package` or `npm ci`.
- **Regenerate `package-lock.json` only with Node 22 / npm 10**: npm 11 prunes entries the Docker build's `npm ci` needs.
- **macOS needs `sudo ifconfig lo0 alias 127.0.0.2`** before the integration tier or `npm run check`, or about 22 specs fail with EADDRNOTAVAIL.
- **`devkit/` is untracked** (pinned in `.devkit-rev`): a fresh worktree runs `make install` before `npm test` or ESLint can find `devkit/lint/`; never edit it (`make devkit-check` fails).
- **`public/build.json` lingers after `npm run build`**: stale styles in `start:dev`; set `NODE_ENV=development` in `.env.local` or delete it.

## Architecture

```
src/
  app.ts          createApp(): migrations, pool, Photos, fetcher, weather, then Fastify: root hooks,
                  parsers, static roots, error + not-found handlers, webPlugin (server.ts, the harness)
  server.ts       serve(): createApp, the nightly and minute timers, the cutout queue, listen
  main.ts         production entry: loadConfig, createLogger, the model runner, serve()
  config.ts       loadConfig(), the only reader of process.env     logger.ts  createLogger()
  random.ts       seededRandom(...key): the one PRNG; never Math.random or the clock
  calendar-date.ts IsoDate, todayIn(tz, now): pure, shared by every layer
  web/            plugin.ts, errors.tsx, render.ts, autosave.tsx, layout/, security/, one dir per feature
  db/ maintenance/ metrics/ cutout/ wardrobe/ push/ weather/ seed/   each: see the area index
views/assets/     main.css, src-sw.ts, fonts.css
public/           sw.js, bundle.css, vendor/, modules/, js/, assets/ (generated from icon.svg)
test/             Playwright specs; support/, integration/: test/AGENTS.md
drizzle/          generated migrations + meta/ (journal, snapshots)
docs/             README's Documentation section lists it; feature scope is the roadmap (#27) and the area docs
```

### Area index

Each area's detail lives in an `AGENTS.md` beside its code, with `CLAUDE.md` a symlink to it so Claude Code loads it when a file in its directory is read; when planning work in an area, read its doc first. A "see Wardrobe" elsewhere means that area's doc. An area doc holds invariants, gotchas, who-owns-what and pointers, under 8 KB (`docs/conventions.md#what-an-area-doc-holds`); long reference sits in a `reference.md` beside it, read on demand.

| Area | Doc |
| --- | --- |
| Request security | `src/web/security/AGENTS.md` |
| Auth | `src/web/auth/AGENTS.md` |
| Images | `src/web/files/AGENTS.md` |
| Background removal | `src/cutout/AGENTS.md` |
| Wardrobe | `src/web/wardrobe/AGENTS.md` |
| Link import | `src/web/wardrobe/link-import/AGENTS.md` |
| The garment model | `src/wardrobe/AGENTS.md` |
| Wishlist | `src/web/wishlist/AGENTS.md` |
| Style profile | `src/web/style/AGENTS.md` |
| Capsules | `src/web/capsules/AGENTS.md` |
| Wears and washes | `src/web/wears/AGENTS.md` |
| Insights | `src/web/insights/AGENTS.md` |
| Sharing | `src/web/sharing/AGENTS.md` |
| Sizes | `src/web/sizes/AGENTS.md` |
| Seed personas | `src/seed/AGENTS.md` |
| Calendar | `src/web/calendar/AGENTS.md` |
| Trips | `src/web/trips/AGENTS.md` |
| Outfit selfies | `src/web/selfies/AGENTS.md` |
| Weather | `src/weather/AGENTS.md` |
| Outfits | `src/web/outfits/AGENTS.md` |
| Styling | `src/web/styling/AGENTS.md` |
| Snap strip | `src/web/strip/AGENTS.md` |
| Outfit gallery | `src/web/gallery/AGENTS.md` |
| Inspiration | `src/web/inspiration/AGENTS.md` |
| Today | `src/web/today/AGENTS.md` |
| Weekly auto-plan | `src/web/week-plan/AGENTS.md` |
| Web Push | `src/push/AGENTS.md` |
| MCP server | `src/web/mcp/AGENTS.md` |
| Changes feed | `src/web/sync/AGENTS.md` |
| JSON API | `src/web/api/AGENTS.md` |
| Health | `src/web/health/AGENTS.md` |
| PWA and the service worker | `src/web/shell/AGENTS.md` |
| Styles and fonts | `views/assets/AGENTS.md` |
| Layout | `src/web/layout/AGENTS.md` |
| Database | `src/db/AGENTS.md` |
| Maintenance | `src/maintenance/AGENTS.md` |
| Metrics | `src/metrics/AGENTS.md` |
| Tests | `test/AGENTS.md` |
| Deployment (not auto-loaded) | `docs/operations.md` |

`src/web/weather/AGENTS.md` and `src/web/push/AGENTS.md` only point to Weather's and Web Push's docs. `make docs-check` (`ci-quick`) holds this index to the docs on disk (`scripts/ci/docs_rules.sh`); the size caps and symlink rule are devkit's.

### Routes

In full, with every route's owner: `docs/architecture.md#routes` and `#request-flow`. `GET /` is Today. A route is public only with `config: { public: true }`; `/mcp` and `/api/v1` take a token, never the cookie (their `surface`, `src/web/surface.ts`); everything else needs a session and is the user's own. `/weather/*` exists only with `WEATHER_ENABLED`, `/push/*` only with `PWA_ENABLED`. Root hooks live in `app.ts` (same-origin at onRequest; `req.auth` and `ViewContext` at preValidation, skipped on static paths).

### Web layer (adding a feature)

Each rule in full, with its story: `docs/web-layer.md`. A feature lives whole (routes, queries, views) in `src/web/<feature>/`, a plugin registered from `webPlugin`.

- **Code no feature owns**: pure goes in the `src/` root or a pure layer (`src/wardrobe`, `src/weather`, `src/push`: ESLint refuses `web/`, `db/`, `drizzle-orm`, `node:*`); web-only in the `src/web/` root; features share queries, writers, urls and status basics, never pages.
- **Imports point down the layer stack** in `scripts/ci/layers.conf`; `make layer-check` refuses an upward edge. Move the shared piece down.
- **Routes**: `routes.tsx` exports a `FastifyPluginCallbackTypebox<WebOptions>`; nothing in `src/web/` reads `Config` or `process.env`. Validation is a TypeBox schema on the route, never hand-parsing; a failure is the 400 page. A maybe-empty body is `Type.Union([Type.Object(...), Type.Null()])`; say at the route whether bad input is a 400 (stored data) or a fallback (URL state, `?week=`). Pages are framed by `<PageShell>` with `ctx: ViewContext` and strings via `t('KEY', { param })`.
- **API parity** (#191): a feature is done when its domain function has a page caller, an API caller and, where an agent needs it, an MCP caller; every non-GET page route and writing MCP tool is classified in `src/web/api/operations.ts`. An API route lives in `src/web/<feature>/api-routes.ts` (`src/web/api/AGENTS.md`).
- **Auth**: `requireSession`; `config: { public: true }` is the only way past the gate, and a route under a `static-prefixes.ts` path never has a session, so must be `public`; the user id is `sessionUserId(request)`.
- **Queries**: Drizzle via `options.db` in `queries.ts`. A write to a synced table takes its owner's lock first (`src/db/owner-lock.ts`); never set a synced row's `revision` or `updated_at` (`src/db/AGENTS.md`).
- **Navigation**: a tap is a boosted `<a href>` or an htmx request, never script setting `location`; a write ending on another page answers `navigateTo(reply, path)`; `HX-Redirect` only for the 401 and the photo upload.
- **Rendering** only through `renderPage` / `renderFragment` / `renderToString`, which await: `String(<Page />)` can be `[object Promise]`.
- **Errors**: `throw new HttpError(status)`; a 404 or 403 is `NotFound(resource)` / `Forbidden()`, thrown by the domain function, which takes an `Actor`. The root handler owns every htmx failure (#642): never answer 200 with an error.
- **Hooks**: an async hook that answers must `return reply`; `createApp()` registers every root piece before `webPlugin`; the root hook stays at preValidation.
- **Escaping**: the only raw-markup hatch is `dangerouslySetInnerHTML`, fed `tHtml()` or `jsonForScript()`.
- **Photo routes** are marked `photoUpload` (one budget, pages and API); a multipart body elsewhere is a 415.
- **Forms** are `PostForm` (a native post, never `hx-post`); fields are `FormField` + `inputAttributes`. **Autosave** controls come from `src/web/autosave.tsx`, and no other swap may replace an autosave form.
- **htmx** reads only the first `<meta name="htmx-config">`; `disableInheritance` is on, so the body's `hx-inherit` must stay.

### Request security

The detail of each rule, its code and its spec: `src/web/security/AGENTS.md`. What every change keeps:

- **Host allowlist** (#702): a Host that is not `SITE_URL`'s, an `ALLOWED_HOSTS` entry or loopback is a bodiless 421 at onRequest, before the same-origin hook (DNS rebinding); a new name that reaches the server (a proxy, a scraper) is an `ALLOWED_HOSTS` entry.
- **CSRF**: the root same-origin hook 403s a POST, PUT, PATCH or DELETE whose `Origin` is not this site (a missing Origin passes only on the bearer surfaces and the reviewed `STATELESS_ROUTES`, which write nothing); nothing changes state on a GET; the service worker never sends a navigation POST to the server (#542).
- **Rate limits** are per route, opt-in (each budget is named in the security doc).
- **Refusals do not reveal ids**: unseeable is a 404 like an unknown id; seeable but not changeable is a 403.
- **CSP** (`src/web/security/csp.ts`, #672): no `'unsafe-inline'` script; the importmap is the one inline script, by its hash, never a nonce (a page must stay byte-stable); htmx runs no script from a swap.
- **Outbound fetches** of a user-supplied URL go only through `createOutboundFetcher` (`make guard-check`); redirect targets through `safeReturnTo`; a path carrying a secret sets `config: { secretPath: true }`; log lines name requests through `loggableUrl()`; public pages never show an email.
- **Sessions**: signing out is `POST /auth/logout`; a new password or Sign out everywhere ends the others (the session version, `sv`, #700).

### Config and logging

In full: `docs/conventions.md#config`, `#logging`. `loadConfig()` (`src/config.ts`) is the only reader of `process.env`; a bad value stops the boot naming the key, never the value. Secrets have no default. A new env var gets a schema entry and README row. **The image bakes `.env`, never `.env.local`**. Log through the module's pino child at operation boundaries with ids (`logger.error({ err }, message)`), never in rendering or loops, never `console`. A write's outcome is one `logOp` line from its domain action, never the route's or tool's (#712; guards.conf `[op-logs]`). Bugsink's `environment` is `APP_ENV`, never NODE_ENV.

### Project rules

In full: `docs/conventions.md`, `docs/web-layer.md#client-behavior`.

- **Server owns the HTML**: htmx attributes, then CSS, then a delegated `data-*` action (`views/assets/page/actions.ts`); a page's own setup is `pageModule(name)` (`page-mount.ts`); bigger is a client module (`views/assets/page/<name>.ts`, never a new `public/js/` file: `make plain-js-check`) with a reason in the PR. **No inline script, no `on*` attribute** (the CSP, #672; ESLint and `expectFullPage`). No `_hyperscript`. View logic beside its markup.
- **Every user-facing string goes through i18n** (`t`/`tHtml`, `src/i18n/en/lang.json`).
- **daisyUI semantic tokens, no hardcoded colors** (ESLint). Muted text is `text-muted`; `text-faint` never for text; no `opacity-*` on text.
- **No runtime CDN imports**: client packages from `public/modules/` or `public/vendor/`; zero external requests (`delivery.spec.ts`).
- **Postgres in every tier**; no second driver for test speed.
- **Cookies are `Secure` only when the request is https** (`sessionCookieOptions`); never a blanket `secure: true` (#700). `SameSite=Lax` must stay (CSRF).
- **Offline-first per `frontend-pwa.md`**: cached reads show freshness; unreachable writes are disabled with a reason, never dropped, except wears, washes and packing ticks, which the outbox queues and replays (`src/web/shell/outbox.md`, #178); heartbeat, not `navigator.onLine`.
- **"Today" is `todayIn(APP_TIMEZONE, now)`** in app and tests (`t.today()`, `householdToday()`): a UTC date is tomorrow on a New York evening. A new consumer gets a row in `test/integration/today.spec.ts`.

### Changing the schema

`src/db/schema.ts` is the schema; `drizzle/` holds the migrations drizzle-kit generates from it. The server migrates on every boot; the CLIs never migrate (`requireCurrentSchema`). The steps in full: `src/db/reference.md`.

1. Edit `src/db/schema.ts`; every foreign key column gets an `index()` or leads a composite index or unique constraint.
2. `npx drizzle-kit generate --name <what-changed>`; read the SQL. Every migration starts with `SET LOCAL lock_timeout = '5s';` and a breakpoint (see 0051).
3. `npm run test:int`: `migrations.spec.ts` fails on a schema edit without its migration.
4. Never edit or delete a migration that has shipped: Drizzle never re-checks hashes, so an edited file silently diverges from production.

### Deployment

Merging to `main` deploys: the publisher host's `make publish` (never the Mac: arm64) pushes the image and the hourly autoupdater pulls it. Env, recovery, publishing: `docs/operations.md`.

- **`APP_VERSION` is the bare 7-char sha** (`docs/decisions.md` 2026-10-13), passed once by the publisher; only the image _tag_ says `sha-<7>`. Compose and `.env` never set it (`make release-check`). **Only the publisher moves `latest`**, then tags `ship-<YYYY-MM-DD>-<sha7>`. No semver or date image _builds_; a release only names a shipped commit (`make release VERSION=x.y.z`: tag `v<x.y.z>`, GHCR `<x.y.z>` and `<x.y>`, kept by the prune; 2026-11-25, #637). `package.json` `version` is `0.0.0`; nothing reads it (`make release-check`).

## Convention deltas

Deviations from `~/.claude/conventions/`, each with its `docs/decisions.md` entry:

- **Job outcomes add `discarded` and `interrupted`** (the cutout queue), non-alerting; any error or timeout is `failure`. `JOB_OUTCOMES` and `metrics.spec.ts` hold the list (2026-10-13, Observability contract).
- **Statement counts are pinned by the specs alone** (an API twin's from `PAGE_WRITES`: `test/AGENTS.md`); `build/statements.json` (`make ci-db`) only reports the most each `<METHOD>:<route>` sent in `recordQueries` (2026-10-13; #721).
- **No pull-request job in Actions and no pre-merge gate**: a PR merges on review rounds (`@codex review`, or `make review PR=<n>`), and main is proven at deploy by the publisher's check_tree (devkit 2026-11-02); `ci.yml` runs only by hand.
- **`nightly.yml` runs on a `schedule:`**: the page audit, Lighthouse, the real cutout model and WebKit, too slow for any PR; nothing in it gates a deploy (2026-10-16, Convention deltas declared).
- **The image smoke is `scripts/smoke-image.sh`, not devkit's `boot_image.sh`**: it boots on the host network, then runs devkit's `contract_probe.sh` (2026-10-16, Convention deltas declared).

## Commands

Detail: README's Development section; `docs/workflow.md`.

```bash
nvm use && npm ci             # Node 22 (.nvmrc); postinstall applies patches/
npm run start:dev             # tsc, node and tailwind, watching
npm run build                 # clean, tsc (type-checks), generate
npm run lint | format         # eslint --fix | prettier --write (never a directory); lint:check, format:check gate
npm test                      # Vitest unit projects
npm run test:int              # integration: the real app in-process, scratch Postgres
npm run test:e2e              # build, then Playwright (ten scenarios): test/AGENTS.md
npm run check                 # check:static + test:all (~80 s)
make install                  # git hooks, once per checkout or worktree
make ci-quick                 # guards (docs-check among them), secrets, lint, types
make ci-unit | ci-db | ci-e2e # the plan's jobs
make review PR=<n>            # one local review round; make merge PR=<n> squash-merges
```

The CLIs (`maintenance:reconcile`, `user:set-password`, `push:revoke-all`, `order-mail:bind-owner`, `seed`, `cutout:fetch-model`) run from `dist/` and never migrate; Builds, test suites, and `npm ci` go through a `build:build-runner` subagent, never inline.

## Deliberate exceptions

Planned contract items still missing (`docs/decisions.md` 2026-10-16, Convention deltas declared):

- **No `job_last_success_timestamp_seconds`** yet: lands with homelab's JobStale rule template (standardization wave 4).
- **Push and MCP outcome words** are unchanged until the owner decides them (2026-10-13, Observability contract 2).

## Workflow

<!-- ORCHESTRATION-OVERRIDE: claudebot agents skip this section.
     Your agent definition governs your workflow. -->

- **Backlog: GitHub issues, ordered by the pinned Roadmap (#27).** Pull the first unchecked item whose dependencies are done; new ideas go in the **Later** milestone.
- Before implementing, read `docs/PROJECT_LOG.md`, this file and the area's doc. Plan in plain text and get approval before writing code or spawning implementers; approval of a goal is not approval of an implementation.
- **Tests are budgeted and lean** (owner directive 2026-10-13; `test/AGENTS.md`): `make ci-unit` ≤ 60 s, `ci-db` ≤ 110 s, `ci-e2e` ≤ 180 s, each with a collected-count floor. A test earns its place (`test/AGENTS.md`): behavior goes in `test/integration/`; Playwright holds ten critical-path scenarios and a new one replaces one.
- **Metrics are an on-demand report for cleanup rounds** (`make ci-metrics`, `make metrics-tighten`), not a per-PR gate (devkit 2026-11-13).
- **Before a feature is called done** it is verified in a browser as an installed PWA at phone width (Playwright at 390 px).
- **Changes land through pull requests** (owner decision 2026-09-26): a branch `<issue>-<slug>` (own worktree when agents run in parallel), a PR linking its issue, a review round (`@codex review`, or `make review PR=<n>`; docs-only PRs owe none) with its P0/P1 findings answered once. `make merge PR=<n>` squash-merges once the rounds allow: no pre-merge gate (devkit 2026-11-02), at most `DEVKIT_REVIEW_ROUNDS` (3) rounds; below the cap P0/P1 block, at it only P0 and the rest is filed as issues. Parallel branches that clash show on main and are fixed forward. Merging publishes, then deploys.
- **Migrations and parallel branches:** two branches that each generate `NNNN` collide in `drizzle/meta/_journal.json`; the later rebases on `main`, deletes its migration and snapshot and regenerates. Never hand-merge a journal.
- pre-commit runs guards, staged secrets and lint; pre-push typecheck and unit; never bypass either with `--no-verify`; fix a failed hook in a new commit, never amend.
- A new pattern or gotcha is written in its area's `AGENTS.md` and, if it is a decision, a dated `docs/decisions.md` entry, in the same commit. What an area doc may hold: `docs/conventions.md#what-an-area-doc-holds`.
