# Stack and architecture in full

Read on demand (not auto-loaded). The root `AGENTS.md` keeps a short Stack list and architecture tree; this is the fuller description of each piece and each file. Moved out of the root in #259; what the stack used to be is in `docs/history.md`.

## Stack

Conventions: `backend.md`, `frontend.md`, `frontend-pwa.md`, `frontend-htmx.md` (hypermedia principles only; the Jinja2/FastAPI specifics do not apply)

- **Runtime**: Node 22 (`.nvmrc` pins `v22.20.0`), TypeScript, **Fastify 5**, plain: no framework on top (`FastifyReply`, `reply.setCookie`, Fastify plugins and hooks). NestJS left on 2026-09-26, the last step of the platform migration (Jest to Vitest, MikroORM to Drizzle, Handlebars to JSX, Nest to plain Fastify). Built by `tsc` (`tsconfig.build.json`, `src/` to `dist/`).
- **Views**: server-rendered HTML with htmx 2 for interactivity; the little client logic left is inline handlers and small client modules (TypeScript in `views/assets/page/`, built to `public/js/`, the rest still plain JS there) (`_hyperscript` was removed on 2026-09-26, see `docs/web-layer.md#client-behavior`). Not a SPA. There is no JSON API for the UI. Every page is typed JSX (`hono/jsx`, rendered to strings, no Hono server) in `src/web/` (see Web layer), the 404 and error page included.
- **CSS**: Tailwind v4 (`@tailwindcss/cli`) + daisyUI, source `views/assets/main.css`, compiled to `public/bundle.css`. The theme, the fonts and why the fonts step runs before Tailwind: `views/assets/AGENTS.md`.
- **Data**: PostgreSQL only (18 in production on pgvault and locally, 17 in CI). **Drizzle ORM owns the schema, the migrations and every query** (`src/db/schema.ts`, `drizzle/`, applied at boot; see Changing the schema). The MikroORM and SQLite history and the legacy migration tree: `src/db/AGENTS.md`.
- **Auth**: login is always required. A JWT in an httpOnly `access_token` cookie (never `Secure`, see `docs/conventions.md#conventions`), resolved once per request into `req.auth`; every route needs a session unless it says `config: { public: true }`, and `/mcp` takes personal access tokens (of kind `mcp`; native clients' `device` tokens are for the API, #190) instead. Every route that changes or hands out a credential asks for the current password. The session, the step-up rule, emails and password changes: `src/web/auth/AGENTS.md`.
- **PWA**: Workbox `injectManifest` over a hand-written service worker (`views/assets/src-sw.ts`, esbuild to `.js`, injected to `public/sw.js`), `/manifest.json` served from config by `src/web/shell`, `@khmyznikov/pwa-install` (browser tabs that can install) and `pulltorefreshjs` (iOS standalone), both imported by `views/assets/page/pwa.ts` only where they apply, Web Push via `web-push` + VAPID keys (`src/web/push/`, see Web Push). Gated by `PWA_ENABLED`.
- **Images**: `sharp` for transcoding, `heic-decode` (libheif) for HEIC uploads. Background removal runs on the server only: BiRefNet 512x512 with `onnxruntime-node` in a child process (`src/cutout/`). The in-browser model (`@imgly/background-removal`, `onnxruntime-web`) and the `CUTOUT_MODE` switch were removed on 2026-09-26. See Architecture, Images and Background removal.
- **Storage**: local disk under `DATA_PATH`, the only backend (the S3 backend, `nestjs-s3` and the AWS SDK were removed 2026-09-26; production never used them).
- **i18n**: English only, strings in `src/i18n/en/lang.json` (the other five languages were deleted on 2026-09-26), read through `t('KEY')` from `src/web/i18n.ts`, typed to the catalog's keys.
- **Logging**: one pino logger (`src/logger.ts`), stdout the only default sink (`LOG_FILE` opts into a file), a child per module (`logger`). See `docs/conventions.md#logging`.
- **Tests**: three tiers: Vitest unit, Vitest integration (`test/integration/`, the real app in-process on a scratch Postgres database) and Playwright e2e; see Test tiers under Commands, and `test/AGENTS.md` for the harness.

## Architecture

```
src/
  app.ts               createApp(config, logger, options): migrations, the pool, Photos, the outbound
                       fetcher (options.outboundFetch: the specs' resolver and address policy only),
                       the weather service when WEATHER_ENABLED (options.weather: the tests' stand-in
                       for Open-Meteo only), then the Fastify instance:
                       root hooks (same-origin check at onRequest, rate-limit plugin, session resolution
                       and page context at preValidation, skipped for the static paths in
                       static-prefixes.ts; security headers; the request log line), cookie, compression,
                       form and multipart parsers, static roots, the error and not-found handlers, then
                       webPlugin. Shared by server.ts (listen) and the integration harness (ready + inject)
  server.ts            serve(config, logger, cutoutRunner, options): createApp, the nightly timers, the
                       push reminders' minute timer (with PWA_ENABLED), the week's re-plan minute
                       timer (always; the forecast part with WEATHER_ENABLED), the cutout queue started with
                       the runner, SIGTERM/SIGINT -> close, listen
  main.ts              the production entry: loadConfig + createLogger, the model's runner (ModelRunner,
                       model verified or downloaded at boot), serve()
  config.ts            loadConfig(): the TypeBox env schema (the ONLY place config is declared and the only
                       reader of process.env), .env.local then .env, typed Config. See `docs/conventions.md#config`
  logger.ts            createLogger(config) (stdout, plus an opt-in LOG_FILE), createLoggerTo(level, stream) (tests)
  project-root.ts      PROJECT_ROOT for public/, drizzle/, node_modules/ paths; valid from src/ and dist/
  random.ts            seededRandom(...key): the one seeded PRNG (sfc32 over a SHA-256 of the key), for
                       the seed's history and the outfit generator; never Math.random or the clock
  calendar-date.ts     a calendar day as a plain 'YYYY-MM-DD' string: IsoDate, day arithmetic, todayIn(tz, now).
                       Pure and shared by the pure layers and src/web/, so it lives at the root (src/web/calendar/AGENTS.md)
  web/                 Every route and page (see `docs/web-layer.md`): plugin.ts (registered by createApp),
                       errors.tsx (error page + handler), render.ts, loggable-url.ts, i18n.ts (t),
                       autosave.tsx (every form saved on change, see `docs/web-layer.md#autosave`),
                       page-cache.ts (what the service worker's page cache and the server share),
                       view-context.ts (the typed reply.locals and its builder), layout/ (JSX shell), and
                       one directory per feature, each in the area index below (sharing/:
                       /wardrobe-share/* and the access resolver; share/: /share, the public
                       share-link page, its Open Graph preview, the Share button and `setPublicShare`, #669). layout/parts.tsx: pieces the
                       garment, outfit and share pages share (thumb, back link, empty state).
                       schemas.ts: shared TypeBox pieces (RowId, IsoDateSchema).
                       date-labels.ts: every date a user reads (dayLabel, relativeDay, dateLabel; never ISO).
                       security/: same-origin hook, rate limits, safeReturnTo, origin,
                       outbound-fetch.ts (the only fetcher of anything on the internet: user-supplied
                       URLs and the weather's fixed API) and public-address.ts (its address rule); see
                       Request security, Outbound fetches
  db/                  Drizzle: the schema and migration authority, and the query layer
                       (its files, the MikroORM adoption and the gotchas: src/db/AGENTS.md)
  maintenance/         the nightly and minutely timers, storage reconciliation, the CLIs
                       (src/maintenance/AGENTS.md)
  metrics/             Prometheus metrics, Server-Timing, the device timings: src/metrics/AGENTS.md
  cutout/              Background removal (see Background removal):
                       src/cutout/AGENTS.md
  wardrobe/            The garment model, pure (no database, web or strings; lint-enforced): src/wardrobe/AGENTS.md
  push/                The push reminders' schedule, pure (lint-enforced): src/push/AGENTS.md
  weather/             The weather, pure (lint-enforced): src/weather/AGENTS.md
  seed/                The seed personas: src/seed/AGENTS.md
  i18n/en/lang.json    the English string catalog
views/
  assets/              main.css (Tailwind source), src-sw.ts (service worker source), fonts.css (the
                       webfonts' entry for `npm run generate:vendor`)
public/                Static: sw.js, bundle.css, vendor/, modules/, *.br/*.gz (generated), js/,
                       assets/ (icon.svg is the source; icon.png, icon-192.png, icon-512.png and
                       favicon.ico come from `npm run generate:icons`)
test/                  Playwright specs (check_tree runs them in Chromium, the nightly in WebKit too; PWA on)
  support/, integration/  the harness and its helpers: test/AGENTS.md
drizzle/               Generated migrations (NNNN_name.sql) + meta/ (journal, snapshots). Shipped in the image
docs/DESIGN.md         Upstream MVP design doc and entity model. Assess feature work against it.
```

`src/web/` is effectively the application layer: `app.ts` builds services there that the CLIs reuse.

**The pure layers** (`src/wardrobe`, `src/weather`, `src/push`) import nothing from `src/web/` or `src/db/`, no `drizzle-orm` and no `node:*` module, so their rules run in a unit test with no mock and a feature can import them freely. ESLint enforces it (`no-restricted-imports` in `eslint.config.mjs`; specs are exempt). The whole of `src/` is layered in `scripts/ci/layers.conf` (devkit's layer guard, `make layer-check` in ci-quick): shared root modules, then config and the logger beside the pure layers, metrics, db, cutout, web, maintenance, seed, with the entries and the CLIs on top. Shared code they need moves down to `src/` (`calendar-date.ts`, `random.ts`); code that needs a web type is generic over it (`InsightGarment<Photo>`, `generateIdeas<G>`). What else belongs at which level: `docs/web-layer.md#code-no-feature-owns`.

## Routes

`GET /` is Today, the home screen (#15; signed out it sends to the login page like any page); there is no landing page, and no privacy, terms or sitemap routes. Public (`config: { public: true }`; reachable signed out): login, registration, logout (the POST, and the GET that asks first), `/about`, `/offline.html`, `/health/live`, `/health/ready` (and its alias `/healthz`; see Health, `src/web/health/AGENTS.md`), `/manifest.json`, `/.well-known/*`, the Open Graph share page `/share`, the invite landing `/wardrobe-share/invite/:token`, and every `/file/**` image except an outfit selfie's or a saved look's (a 404 there, whoever asks). Everything else needs a session, except `/mcp`, which needs an agent token, and `/api/v1/*`, which needs a device token (but `POST /api/v1/auth/token`, the device sign-in, and `GET /api/v1/openapi.json`); neither reads the cookie (their `surface`, `src/web/surface.ts`; see MCP server, JSON API). `GET /api/v1/changes` is the native clients' sync over the caller's own wardrobe and the ones shared with them (see Changes feed). `/laundry` is the signed-in user's own hamper (see Wears and washes), and `/wardrobe/insights` with `/wardrobe/insights/unworn` (its unworn list whole, #728) their own figures (see Insights). `/auth/profile` is an index of the signed-in user's settings (#728); each setting is its own page under it: `/auth/profile/sharing` (see Sharing), `/auth/profile/weather` (only with `WEATHER_ENABLED`), `/auth/profile/week`, `/auth/profile/notifications` (only with `PWA_ENABLED`), `/auth/profile/style`, `/auth/profile/sizes`, and `/auth/tokens` and `/auth/devices` below. `/auth/tokens*` (Agent Access) and `/auth/devices` with `/auth/devices/:id/revoke` (Profile › Devices, #189) are the signed-in user's own agent and device tokens (see Auth, MCP server). `/auth/profile/style` is the signed-in user's own style profile, with its outfit rules (`/auth/profile/style/rules*`, #21b; see Style profile). `/wardrobe/wishlist` is Muse's inbox, `/wardrobe/wishlist/needs/:id` a need's decision screen, both read by whoever reads the wishlist; `/wardrobe/wishlist/seen` and every decision (`/wardrobe/:id/choose`, `/dismiss`, `/undo`, `/returned`, `/wardrobe/wishlist/needs/:id/dismiss`, `/undo`) are the owner's alone (see Wishlist, `suggestions.md`). The wardrobe plans' addresses (`/wardrobe/plans*`, `/wardrobe/shopping`, `/wardrobe/:id/plan-items`) are retired since #337: a GET answers 302 to the inbox (the garment, for plan items), a post a 4xx (see Wishlist). `/weather/*` is the signed-in user's own weather and exists only with `WEATHER_ENABLED` (see Weather). `/calendar/plan` plans one more outfit on a day (see Calendar); `/calendar/plan-week` and its Undo, and `/auth/profile/week`, are the signed-in user's own weekly auto-plan and week template (see Weekly auto-plan). `/trips/*` are the signed-in user's own trips and packing lists, the Calendar's Trips tab (see Trips). `/outfits/ideas` is the Outfits page's Ideas tab, generated outfits to pick (see Outfit gallery). `/inspiration/*` is its Inspiration tab, the signed-in user's own saved looks, their pieces (`/inspiration/:id/pieces*`, a piece's "Find this" at `/find`) and "Recreate this look" (`/inspiration/:id/recreate`, its "Save as outfit" at `/recreate/outfit`), their photos (`/inspiration/photo/*`) served to them alone, and the share confirmation (`/inspiration/share/confirm`: the manifest's share target, `POST /inspiration/share`, is answered by the service worker on the device; a photo waits there for Save look, a link goes on to the link import; without a worker the server's route writes nothing and only redirects, the same-origin hook's one `stateless` exemption) (see Inspiration). `/styling` is Styling, the outfit composer (see Styling); `/outfits/new` and `/outfits/:id/edit` only redirect into it. `/today/*` is Today's Refresh and "Wear this", the signed-in user's own day (see Today). `POST /calendar/:id/selfie`, `POST /selfies/:id/delete` and the images `GET /selfies/:fileName` and `/selfies/thumb/:fileName` are the signed-in user's own outfit selfies, served to them alone (see Outfit selfies). `/push/*` exists only with `PWA_ENABLED` (see Web Push). `/offline/warm` is the list the service worker warms for offline reading, always the signed-in user's own wardrobe (`src/web/shell/offline-warm.md`). `/about` carries the upstream attribution. `manifest.json` is not a static file: `src/web/shell` serves it from config so `APP_NAME` and `ICON_NAME` flow into the installed PWA's name and icon.

## Request flow

Every request goes through the root hooks in `app.ts` (the same-origin check at onRequest; session into `req.auth` and `ViewContext` into `reply.locals` at preValidation, skipped on static paths), then:

- **A route** (`src/web/<feature>/routes.tsx`): the plugin's `requireSession` preValidation hook → the route's schema validation (400 page on failure) → the handler → `renderPage(reply, <FeaturePage ctx={viewContext(reply)} />)` or `renderFragment(...)` → JSX components in the shared `Layout`.
- **A static file** (`public/`; `/modules/*` is `public/modules/`): `@fastify/static`, precompressed, with the cache policy in `src/static-assets.ts`.
- **No route**: the not-found handler throws `HttpError(404, 'Cannot GET <url>')` into the error handler, which renders the 404 page (signed-in chrome included: the root hooks ran) or, on a static path, answers `{ statusCode, message }`.

Every response gets the security headers (root onSend) and, off the static paths, one log line (root onResponse). Off the static paths a second root onSend relays a redirect's `Clear-Site-Data` to the document it lands on (`createCacheClearRelay`, `src/web/auth/AGENTS.md`).

htmx in the browser swaps fragments returned by further routes. A route that serves both a page and a fragment decides with `isFragmentRequest` from `src/htmx/fragment-request.ts` (shared with the service worker's cache keys) and sets `Vary`: in the web layer, `wantsFragment(request, reply)` does both.

## Area index

The area index lives in the root `AGENTS.md` (Area index), the one copy `make docs-check` holds to the docs on disk.

#### Routes

In full, with every route's owner: `docs/architecture.md#routes`. `GET /` is Today. A route is public only with `config: { public: true }` (login, registration, `/health/*` and `/healthz`, `/share`, most `/file/**` images; never an outfit selfie's); `/mcp` and `/api/v1` take a token, never the cookie (their `surface`, `src/web/surface.ts`); everything else needs a session and is the user's own. `/weather/*` exists only with `WEATHER_ENABLED`, `/push/*` only with `PWA_ENABLED`.

#### Request flow

In full: `docs/architecture.md#request-flow`. Root hooks in `app.ts` (same-origin at onRequest; `req.auth` and `ViewContext` at preValidation, skipped on static paths), then a route, a static file or the not-found handler. Every response gets the security headers and, off static paths, one access line (onResponse).
