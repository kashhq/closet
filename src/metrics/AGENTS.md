# Metrics

Prometheus metrics for the homelab's VictoriaMetrics: vmagent scrapes `GET /metrics` over the Docker network for the homelab's Grafana dashboards. No analytics service or third-party script: the data stays on the homelab. Error tracking (Bugsink) lives here too: see the section at the end.

## Layout

```
metrics/       metrics.ts (Metrics: the per-app `@prometheus-io/client` Registry and every metric; the label
               vocabularies JobName, JobOutcome, CLIENT_TIMING_KINDS, CLIENT_TIMING_METRICS),
               http.ts (registerHttpMetrics: root hooks for the request histogram, route templates,
               Server-Timing), request-timing.ts (RequestTiming in async context: Server-Timing's db
               and render), error-tracker.ts (ErrorTracker: the Sentry client for Bugsink, scrubEvent)
web/metrics/   routes.ts: GET /metrics, POST /metrics/vitals, only with METRICS_ENABLED;
               client-errors.ts: POST /errors/client, only with SENTRY_DSN; beacon.ts (text/plain JSON)
public/js/     vitals.js (device timings, METRICS_ENABLED), errors.js (script errors, SENTRY_DSN);
               both loaded by the layout on signed-in pages
```

## What is exported

| Metric | Labels | Recorded by |
| --- | --- | --- |
| `http_request_duration_seconds` (histogram) | `route` (the route template; `unmatched` for a 404 no route matched), `method`, `status_class` (`2xx`) | `registerHttpMetrics`' onResponse hook, every request but a warm's (below) |
| `http_request_db_statements` (histogram) | `route` | the same hook: the request's SQL statements, begin/commit included (`StatementCounter`, Drizzle's logger hook in `src/db/client.ts`, counting into the request's `RequestTiming`); `test/integration/metrics.spec.ts` holds it equal to what node-postgres sent |
| `app_info` (gauge, always 1) | `version` (the release, the bare 7-char sha; `dev` outside an image) | `Metrics`' constructor |
| `job_duration_seconds` (histogram) | `name` (`JobName`: reconciliation, cutout, cutout_retry, reminders, reminder_prune, replan, replan_prune, order_mail, muse_rounds, sync_prune, weather_prune), `outcome` (success, failure; a cutout also discarded, interrupted) | `metrics.timeJob` around every timer's run in `server.ts`; `CutoutQueue` per photo |
| `cutout_queue_depth` (gauge) | none | the pending cutouts; a scrape answers the last finished count (Gotchas) |
| `cutout_queue_oldest_age_seconds` (gauge) | none | how long the oldest pending cutout has waited (0 with none), from the same count's oldest `cutout_requested_at`, aged at the scrape (#689: a queue waiting for its model shows as an age that only grows) |
| `push_sends_total` | `outcome` (delivered, pruned, failed) | the Web Push sender, per device |
| `mcp_tool_call_duration_seconds` (histogram) | `tool`, `outcome` (ok, refused, error) | `registerTools` (`src/web/mcp/tool.ts`) |
| `client_timing_seconds` (histogram) | `route`, `kind` (full, htmx, restore), `metric` (ttfb, lcp, inp, request, settle), `cache` (hit, miss: the service worker's page cache) | `POST /metrics/vitals` |
| `client_timing_dropped_total` | `reason` (unknown_route) | the same, for a sample naming no route of the app |
| `photo_requests_total` | `lookup` (none: a signed URL; row: asked the database) | `/file/**`, per photo served |

Plus the library's default process metrics with METRICS_ENABLED.

**The homelab contract** (observability.md's standard metrics): `http_request_duration_seconds`, `http_request_db_statements`, `job_duration_seconds` and `app_info`, with their labels, are what the RED dashboard and rules read, and **a job's `outcome` is `success` or `failure`**, which the homelab's JobFailed alert and the dashboard select (`outcome="failure"`, `stacks/homeinfra/vmalert/rules/apps.yml`). The other outcome labels (`push_sends_total`, `mcp_tool_call_duration_seconds`) are closet's own: no homelab rule or dashboard reads them. **No metric has a `job` label** (the scraper sets it; `metrics.spec.ts` checks). `route` is always a template (`/wardrobe/:id`), so cardinality is bounded by the route table. `metrics.spec.ts` holds the contract as an inline snapshot of every family's type and every series' name and label names (with the `le` and job `outcome` values); a change there is a change to the homelab's dashboards, made with them. Default process families are checked as a superset.

## The device timings

`public/js/vitals.js` (a head module, so it never blocks rendering and runs once per document; ~1.5 KB brotli) measures, per route template:

- **full**: a document load's TTFB (Navigation Timing, `responseStart`) and LCP, and whether the service worker answered from its page cache (`#freshness` stamp older than the navigation);
- **htmx**: every htmx request, `request` (`htmx:beforeRequest` to `afterRequest`) and `settle` (to `afterSettle`), with `cache` from the answer's `X-SW-Cached-At`: boosted taps, Shuffle, fragments;
- **restore**: an htmx history restore, `popstate` to `htmx:historyRestore`;
- **inp**: the slowest interaction (Event Timing, 40 ms and over) while a page was on screen, sent when it leaves or the tab hides. Safari has no Event Timing: no INP from iPhones.

**The route comes from the server**: every answer carries `Server-Timing: db;dur=..., render;dur=..., route;desc="/calendar"`. A full load reads it from Navigation Timing's `serverTiming` (a service worker copy keeps the header), an htmx request from the response header; a history restore uses the route last seen at that path. So no URL, id or query string ever leaves the device, and the server still accepts only a route it has (`Metrics.addRoute`, from an `onRoute` hook): anything else is dropped and counted.

Batches of up to 20 go out with `navigator.sendBeacon` 5 s after their first sample and whenever the page hides, as a `text/plain` string (some browsers refuse a JSON Blob). `POST /metrics/vitals` reads text/plain as JSON in its own plugin, and refuses: no session (the gate's 401/302), a body over 8 KB (413, before it is read), a batch failing the schema (400: over 20 samples, an unknown kind, a time below 0 or over 60 s), over 30 batches a minute per user (`VITALS_LIMIT`, 429). vitals.js drops a time over 60 s itself so one backgrounded tab never costs the batch.

## Server-Timing

`db` is the time the request's queries held a pool connection, the wait included (`TimedPool`, `src/db/client.ts`: `connect()` reads the timing from the caller's async context, the pool's `release` event adds to it; concurrent queries add up), `render` the time in `renderToString` (`renderPage`/`renderFragment`, `src/web/render.ts`). The timing lives in `AsyncLocalStorage`, entered by the first root onRequest hook and again at the first preValidation hook (a body parser's stream events run in the socket's context, losing it for a POST). Outside a request (timers, CLIs) nothing is recorded.

**A request that checked a secret answers without it.** `db;dur` to a tenth of a millisecond reveals whether an email's lookup found a row or a token matched. So every function that checks a secret a request carries calls `markSecretChecked()` (`request-timing.ts`) before it looks, and the onSend hook leaves the header off a marked request. They are `verifyPassword` (sign-in and every step-up form), `authenticateToken` (`/mcp`), and `findInvite`/`acceptInvite`/`declineInvite` (the invite routes). No route declares it, so a new credential route is covered if it checks through one of those; a new kind of secret check calls `markSecretChecked()` itself. The mark rides the async context, so the query layer needs no request; outside one (seed, CLIs) it does nothing. Marked requests still land in `http_request_duration_seconds`; the device timings skip them (no `route` to name). `http.spec.ts` proves an unflagged test route calling `verifyPassword` gets no header; `test/integration/metrics.spec.ts` covers the real routes. Not marked: registration (its refusal names the taken address anyway), `/share` and `/file/watermark/:shareableId` (random link ids the page already confirms).

## Gotchas

- **`/metrics` must never be public.** Caddy proxies every path, so the route answers only a direct request: one with `X-Forwarded-For` or `Forwarded` is a 404 (`NotServed`, guards.conf `@not-served`) with a warning (logger `Web`). It is a static path (`static-prefixes.ts`), so a scrape costs no session lookup and writes no request line. **A scrape never waits on the database** (pgvault on the NAS is a 5 to 500 ms round trip): `cutout_queue_depth` starts a count each scrape and answers the last one finished; only the first scrape waits, for the first attempt (failed, the gauge stays 0 until a count succeeds). The count's chain never rejects: nothing awaits it, and an unhandled rejection is a crash. A new database-read gauge does the same. Off (the default), the route does not exist: a 404, which the homelab's `expect_up` label turns into a TargetDown.
- **One registry per app, never the library's global one.** The integration specs boot many apps per process; the global registry would refuse the second `http_request_duration_seconds`. Metrics are recorded with METRICS_ENABLED off too; only exposure is gated.
- **`@prometheus-io/client` is prom-client renamed** (`prom-client@15` is deprecated). Same API; needs Node 22+. Pre-1.0: read its changelog before a minor bump, and let the contract snapshot judge it.
- **The service worker's warm requests are not observed** (`X-Closet-Warm`, `isWarmRequest` in `src/warm-request.ts`, `src/web/shell/offline-warm.md`): a device warms up to ~390 pages a day nobody waits for, which filed under `/wardrobe/:id` and `/outfits/:id` would skew their p95. Not a label (the RED dashboard reads the histogram's labels as they are) and not counted: the request log marks them `(warm)`.
- **A new label value must come from a closed set.** A route template, a `JobName`, a tool name, an outcome: never a URL, id, email or user agent. A new timer in `server.ts` wraps its run in `metrics.timeJob(<JobName>, run)`.

## Error tracking (Bugsink)

`SENTRY_DSN` (empty: off) points `@sentry/node` at the homelab's error tracker (Bugsink, Sentry-compatible). Without it `createErrorTracker` answers `DISABLED_ERROR_TRACKER`: no client, no `/errors/client`, no script on pages (byte-identical), nothing sent, and **the SDK is never loaded**: `error-tracker.ts` imports it for types only and `await import()`s it after the DSN check (a large module graph). `error-tracker.spec.ts` proves the loader is not called and that no other file names `@sentry/node`. With it: errors only (`sampleRate` 1, no tracing, sessions or client reports), `sendDefaultPii: false`, `environment` APP_ENV (`production`, `dev`, `gate`; never NODE_ENV, which every image sets to production), a `request_id` tag on any capture made inside a request, and `job_id` (plus `parent_request_id`) on one made inside a job (async context, `operationFields`, `src/request-context.ts`), `release` the image's APP_VERSION (the bare 7-char sha; `BuildInfo.release`, `src/build-info.ts`; `docs/operations.md`). Context `ErrorTracking` logs only the tracker's own trouble. **`@sentry/node` stays 10.x (`^10`)**: 11 makes `@sentry/bundler-plugins`, and through it the FSL-licensed (not OSI) `sentry` CLI, a runtime dependency of the AGPL image; revisit when Sentry drops that or the owner settles licences (#638, #639).

**One client per app, never `Sentry.init`**: a `NodeClient` and a base `Scope`, so the integration specs' apps never share one. Hence no automatic integrations (no breadcrumbs, request data or process handlers); only `dedupe`, `linkedErrors` (Drizzle keeps Postgres's error in `cause`), `nodeContext` and `contextLines`. Capture through the scope (`scope.captureException`), never `client.captureException`: only the scope hands integrations the original error.

**Captured at the choke points, nowhere else** (each tagged `source`):

- `route`: the error handler's unexpected 500 (`createErrorHandler`, `src/web/errors.tsx`), tagged with route template, method and user id. Never an `HttpError`, whatever its status (a refusal, or the owner lock's 503 by design).
- `cutout_model`: the cutout queue cannot have its model, tagged `kind`; once per outage and kind, never per retry (`captureCutoutModelUnavailable`, called only by `CutoutQueue.transition`).
- `job`, `push`, `mcp`: the metrics' failure outcomes. `observeJob`, `countPushSend` and `observeMcpCall` take an ending (`JobEnding`, `PushEnding`, `McpEnding`) whose failure variant must carry its error, so every failure the metrics count reaches Bugsink: `timeJob`, the cutout queue per photo, the push sender per device, `registerTools` for an unexpected tool error.
- `client`: `POST /errors/client`. Session-only, CSRF-checked, a body over 16 KB a 413 before it is read, `CLIENT_ERROR_LIMIT` (10 a minute per user), schema-checked (message ≤ 1000 characters, stack 8000, release a release name: `[A-Za-z0-9._-]`, at most 64). A route the app lacks (`Metrics.hasRoute`) is tagged `unknown`. Forwarded as a `ClientError` with the page's own stack (the raw stack also in the `client` context). The event's release is always the server's; the page's claim is only the tag `page_release`, so no user can file events under a release of their choosing.
- `process`: a crash of the production server. `main.ts` alone (spec processes keep Node's default) installs `createCrashHandler` on `uncaughtException`: it logs fatal, captures (tagged with the `origin`), waits up to 2 s for the send, then exits 1 so Docker restarts the container. An unhandled rejection reaches it too (Node's `--unhandled-rejections=throw`) only while no `unhandledRejection` listener exists, so there must never be one (it would swallow the crash; src/web/files/AGENTS.md relies on the crash). A second crash during the send exits at once. A boot that fails is captured the same way (`reportBootFailure`, `origin: boot`): `main.ts` makes the tracker before `serve()` (`createAppErrorTracker`, handed to `createApp` as `options.errors`) so the boot catch has one.

`public/js/errors.js` (a classic `defer` script, first in the head so its listeners precede htmx and every module): `error` and `unhandledrejection`, each distinct error once per document, at most 5 per page view, the route template from Server-Timing as vitals.js reads it. Precached with the rest (`scripts/generate-sw.ts`), DSN or not: a build's precache is its whole `?v=` set (`src/web/shell/updates.md`).

**Scrubbing** (`scrubEvent`, the `beforeSend`): the event's `request` is dropped whole, any key named like a credential (`cookie`, `authorization`, `access_token`, `password`, `token`...) is `[Filtered]`, and every string loses JWTs, `access_token=` values, personal access tokens, `Bearer` values and Drizzle's `params:` tail (what a user sent). `test/integration/error-tracking.spec.ts` posts to a stub DSN (`test/support/sentry-stub.ts`, the real transport) and scans what was sent for the owner's cookie and JWT after a route error that echoed them.
