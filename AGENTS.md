# Closet

Self-hosted digital wardrobe for the household: catalog garments (photo with background removal, category, brand, size, color), compose outfits, plan them on a calendar, and share a wardrobe with another user. Hard fork of Libre Closet (AGPL-3.0; no upstream remote or merges). Deployed on the homelab. Stack and file detail: `docs/architecture.md`; what it used to be: `docs/history.md`.

**The primary interface is the installed PWA on phones.** Every feature must work as an installed, offline-tolerant app first and as a desktop web page second.

## Stack

Conventions: `backend.md`, `frontend.md`, `frontend-pwa.md`, `frontend-htmx.md` (hypermedia principles only; the Jinja2/FastAPI specifics do not apply)
Capabilities: pwa, push, scheduled-jobs

- **Runtime**: Node 22 (`.nvmrc`), TypeScript, plain **Fastify 5** (no framework on top), built by `tsc` to `dist/`.
- **Image**: runs as `node` (uid/gid 1000), never root; it writes only `DATA_PATH` and `MODELS_PATH`, host mounts that must be writable by uid 1000 (`docs/operations.md#permissions`; the boot refuses an unwritable `DATA_PATH`: Images). A new runtime write path gets a `chown` in the Dockerfile and a row there.
- **Views**: server-rendered typed JSX (`hono/jsx` to strings, no Hono server) in `src/web/`, htmx 2, a few client modules (`views/assets/page/`, built to `public/js/`: `src/web/shell/AGENTS.md`). Not a SPA; no JSON API for the UI.
- **CSS**: Tailwind v4 + daisyUI (`views/assets/main.css` to `public/bundle.css`; `views/assets/AGENTS.md`).
- **Data**: PostgreSQL 18 only (production, pgvault-dev, and the throwaway containers check_tree and CI test on). **Drizzle ORM owns the schema, the migrations and every query** (`src/db/schema.ts`, `drizzle/`, applied at boot).
- **Auth**: a JWT in an httpOnly `access_token` cookie; `/mcp` takes agent tokens, `/api/v1` device tokens. Every route that changes or hands out a credential asks for the current password (`src/web/auth/AGENTS.md`).
- **PWA**: Workbox `injectManifest` over `views/assets/src-sw.ts` (to `public/sw.js`), Web Push via `web-push` + VAPID; gated by `PWA_ENABLED`.
- **Images**: `sharp`, `heic-decode`; background removal on the server only (BiRefNet, `onnxruntime-node`, a child process). Storage: local disk under `DATA_PATH`, the only backend.
- **i18n**: English only, `src/i18n/en/lang.json`, `t('KEY')` typed to its keys. **Logging**: one pino logger (`src/logger.ts`), a child per module.
- **Tests**: Vitest unit, Vitest integration (the real app in-process on a scratch Postgres database) and Playwright; `test/AGENTS.md`.

### Gotchas

In full: `docs/conventions.md#tooling-gotchas`. The web layer's are rules under Web layer.

- **Never `prettier --write` a directory**: it re-pads the persona bibles (`src/seed/personas/*.md`) and the seed breaks (`persona.spec.ts`). Use `npm run format`.
- **Upstream references are attribution only** (About, README, comments); anything else is a rebrand regression.
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
  project-root.ts PROJECT_ROOT, valid from src/ and dist/
  random.ts       seededRandom(...key): the one seeded PRNG; never Math.random or the clock
  calendar-date.ts IsoDate and day arithmetic, todayIn(tz, now): pure, shared by every layer
  web/            plugin.ts, errors.tsx, render.ts, autosave.tsx, layout/, security/, one dir per feature
  db/ maintenance/ metrics/ cutout/ wardrobe/ push/ weather/ seed/   each: see the area index
views/assets/     main.css, src-sw.ts, fonts.css
public/           sw.js, bundle.css, vendor/, modules/, js/, assets/ (generated from icon.svg)
test/             Playwright specs; support/, integration/: test/AGENTS.md
drizzle/          generated migrations + meta/ (journal, snapshots)
docs/             README's Documentation section lists it; DESIGN.md is the feature-scope reference
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
- **Imports point down the layer stack** in `scripts/ci/layers.conf`; `make layer-check` refuses an upward edge and its `known` lines only shrink. Move the shared piece down.
- **Routes**: `routes.tsx` exports a `FastifyPluginCallbackTypebox<WebOptions>`; nothing in `src/web/` reads `Config` or `process.env`. Validation is a TypeBox schema on the route, never hand-parsing; a failure is the 400 page.
- **API parity** (#191): a feature is done when its domain function has a page caller, an API caller and, where an agent needs it, an MCP caller; every non-GET page route and writing MCP tool is classified in `src/web/api/operations.ts`. An API route lives in `src/web/<feature>/api-routes.ts` (`src/web/api/AGENTS.md`).
- **Auth**: `requireSession`; `config: { public: true }` is the only way past the gate; the user id is `sessionUserId(request)`.
- **Queries**: Drizzle via `options.db` in `queries.ts`. A write to a synced table takes its owner's lock first (`src/db/owner-lock.ts`); never set a synced row's `revision` or `updated_at` (`src/db/AGENTS.md`).
- **Navigation**: a tap is a boosted `<a href>` or an htmx request, never script setting `location`; a write ending on another page answers `navigateTo(reply, path)`.
- **Rendering** only through `renderPage` / `renderFragment` / `renderToString`, which await: `String(<Page />)` can be `[object Promise]`.
- **Errors**: `throw new HttpError(status)`; a 404 or 403 is `NotFound(resource)` / `Forbidden()`, thrown by the domain function, which takes an `Actor`. The root handler owns every htmx failure (#642): never answer 200 with an error.
- **Hooks**: an async hook that answers must `return reply`; `createApp()` registers every root piece before `webPlugin`; the root hook stays at preValidation.
- **Escaping**: the only raw-markup hatch is `dangerouslySetInnerHTML`, fed `tHtml()` or `jsonForScript()`.
- **Forms** are `PostForm` (a native post, never `hx-post`); fields are `FormField` + `inputAttributes`. **Autosave** controls come from `src/web/autosave.tsx`, and no other swap may replace an autosave form.
- **htmx** reads only the first `<meta name="htmx-config">`; `disableInheritance` is on, so the body's `hx-inherit` must stay.

### Request security

The detail of each rule, its code and its spec: `src/web/security/AGENTS.md`. What every change keeps:

- **CSRF**: the root same-origin hook 403s a POST, PUT, PATCH or DELETE whose `Origin` is not this site; nothing changes state on a GET; the service worker never sends a navigation POST to the server (#542).
- **Rate limits** are per route, opt-in (`SIGN_IN_LIMIT`, `API_LIMIT`, `ACCOUNT_LIMIT`, `PHOTO_UPLOAD_LIMIT`, and the rest in the security doc).
- **Refusals do not reveal ids**: unseeable is a 404 like an unknown id; seeable but not changeable is a 403.
- **Outbound fetches** of a user-supplied URL go only through `createOutboundFetcher` (`make guard-check`); redirect targets through `safeReturnTo`; a path carrying a secret sets `config: { secretPath: true }`; log lines name requests through `loggableUrl()`; public pages never show an email.
- **Sessions**: signing out is `POST /auth/logout`; a new password or Sign out everywhere ends the others (the session version, `sv`, #700).

### Config and logging

In full: `docs/conventions.md#config`, `#logging`. `loadConfig()` (`src/config.ts`) is the only reader of `process.env`; a bad value stops the boot naming the key, never the value. Secrets have no default. A new env var gets a schema entry and a README row. **The image bakes `.env`, never `.env.local`**. Log through the module's pino child at operation boundaries with ids (`logger.error({ err }, message)`), never in rendering or loops, never `console`. A write's outcome is one `logOp` line from its domain action, never the route's or tool's (#712; guards.conf `[op-logs]`). Bugsink's `environment` is `APP_ENV`, never NODE_ENV.

### Project rules

In full: `docs/conventions.md`, `docs/web-layer.md#client-behavior`.

- **Server owns the HTML**: htmx attributes, then CSS, then a one-line inline handler reading `data-*`; bigger is a client module (`views/assets/page/<name>.ts`, never a new `public/js/` file: `make plain-js-check`) with a reason in the PR. No `_hyperscript`. View logic beside its markup.
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

Merging to `main` deploys: the publisher host's `make publish` (never the Mac: arm64) pushes the image and the hourly autoupdater pulls it. The env, the demo login, recovery, publishing: `docs/operations.md`.

- **`APP_VERSION` is the bare 7-char sha** (`docs/decisions.md` 2026-10-13), passed once by the publisher; only the image _tag_ says `sha-<7>`. Compose and `.env` never set it (`make release-check`). **Only the publisher moves `latest`**, then tags `ship-<YYYY-MM-DD>-<sha7>`. No semver or date tags.

## Convention deltas

Deviations from `~/.claude/conventions/`, each with its `docs/decisions.md` entry:

- **Job outcomes add `discarded` and `interrupted`** (the cutout queue), non-alerting; any error or timeout is `failure`. `JOB_OUTCOMES` and `metrics.spec.ts` hold the list (2026-10-13, Observability contract).
- **Statement budgets come only from `recordQueries` blocks** (`build/statements.json`, `make ci-db`): the most statements each `<METHOD>:<route>` sent there, not every request the suite makes (2026-10-13, Observability contract 2).
- **No pull-request job in Actions and no pre-merge gate**: a PR merges on review rounds (`@codex review`, or `make review PR=<n>`), and main is proven at deploy by the publisher's check_tree (devkit 2026-11-02); `ci.yml` runs only by hand.
- **`nightly.yml` runs on a `schedule:`**: the page audit, Lighthouse, the real cutout model and WebKit, too slow for any PR; nothing in it gates a deploy (2026-10-16, Convention deltas declared).
- **The image smoke is `scripts/smoke-image.sh`, not devkit's `boot_image.sh`**: it boots on the host network, then runs devkit's `contract_probe.sh` (2026-10-16, Convention deltas declared).

## Commands

Detail: README's Development section; the full pre-#723 list: `docs/workflow.md`.

```bash
nvm use && npm ci             # Node 22, the exact .nvmrc version; postinstall applies patches/
npm run start:dev             # tsc, node and tailwind, each --watch
npm run build                 # clean, tsc (type-checks), generate
npm run lint | format         # eslint --fix | prettier --write (never a directory); lint:check, format:check gate
npm test                      # Vitest unit projects
npm run test:int              # integration: the real app in-process, a scratch database per spec file
npm run test:e2e              # build, then Playwright (ten scenarios): test/AGENTS.md
npm run check                 # check:static + test:all (~80 s); alias precommit
npx drizzle-kit generate --name <what-changed>   # see Changing the schema
make install                  # git hooks (.githooks/), once per checkout or worktree
make ci-deps ci-quick         # npm ci; guards (docs-check among them), secrets, lint, types
make ci-unit | ci-db | ci-e2e # the plan's jobs, each reports OVERBUDGET / FLOOR warnings
make review PR=<n>            # one local review round; make merge PR=<n> squash-merges
```

The CLIs (`maintenance:reconcile`, `user:set-password`, `push:revoke-all`, `seed`, `cutout:fetch-model`) run from `dist/` and never migrate; their areas' docs say how. Builds, test suites, and `npm ci` go through a `build:build-runner` subagent, never inline.

## Deliberate exceptions

Planned contract items still missing (`docs/decisions.md` 2026-10-16, Convention deltas declared):

- **No `job_last_success_timestamp_seconds`** yet: lands with homelab's JobStale rule template (standardization wave 4).
- **Push and MCP outcome words** are unchanged until the owner decides them (2026-10-13, Observability contract 2).

## Workflow

- **Backlog: GitHub issues, ordered by the pinned Roadmap (#27).** Pull the first unchecked item whose dependencies are done; new ideas go in the **Later** milestone.
- Before implementing, read `docs/PROJECT_LOG.md`, this file and the area's doc. Plan in plain text and get approval before writing code or spawning implementers.
- **Tests are budgeted and lean** (owner directive 2026-10-13; `test/AGENTS.md`): `make ci-unit` ≤ 60 s, `ci-db` ≤ 110 s, `ci-e2e` ≤ 180 s, each with a collected-count floor. A test earns its place (`test/AGENTS.md`): behavior goes in `test/integration/`; Playwright holds ten critical-path scenarios and a new one replaces one.
- **Metrics are an on-demand report for cleanup rounds** (`make ci-metrics`, `make metrics-tighten`), not a per-PR gate (devkit 2026-11-13).
- **Before a feature is called done** it is verified in a browser as an installed PWA at phone width (Playwright at 390 px).
- **Changes land through pull requests** (owner decision 2026-09-26; `docs/workflow.md`): a branch `<issue>-<slug>`, a PR linking its issue, a review round (`@codex review`, or `make review PR=<n>`; docs-only PRs owe none) with its P0/P1 findings answered once, then `make merge PR=<n>`. No pre-merge gate (devkit 2026-11-02): at most `DEVKIT_REVIEW_ROUNDS` (3) rounds. Merging publishes, then deploys.
- **Migrations and parallel branches:** two branches that each generate `NNNN` collide in `drizzle/meta/_journal.json`; the later rebases on `main`, deletes its migration and snapshot and regenerates. Never hand-merge a journal.
- pre-commit runs guards, staged secrets and lint; pre-push typecheck and unit; never bypass either with `--no-verify`; fix a failed hook in a new commit, never amend.
- A new pattern or gotcha is written in its area's `AGENTS.md` and, if it is a decision, a dated `docs/decisions.md` entry, in the same commit. What an area doc may hold: `docs/conventions.md#what-an-area-doc-holds`.
