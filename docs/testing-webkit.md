# WebKit (Safari) tests

The owner uses closet as the installed app on an iPhone, where every browser
is WebKit. The PR gate runs Playwright in Chromium only, so `nightly.yml`'s
`webkit` job runs the whole suite in the two Safari projects of
`playwright.config.ts` (#179): `webkit` (desktop Safari) and `Mobile Safari`
(an iPhone 12: 390 px, touch, `isMobile`). A red run opens or updates one
issue, "Nightly WebKit / Mobile Safari run is failing", and a green run
closes it (`scripts/webkit-nightly-issue.sh`; the job itself:
`docs/operations.md`, CI and publishing). Nothing waits on it.

## Reading a failure

Each failing spec is one of two things:

- **An app bug on Safari.** Fix the app, or give it its own issue. The
  first local run (#179) found the Styling strips unable to scroll a row
  of one garment (WebKit leaves a flex scroller's end padding out of its
  scroll width; `src/web/styling/AGENTS.md`). The same run found signing
  out hanging for good (#239): WebKit never settles a fetch whose opaque
  redirect carries `Clear-Site-Data`, which the service worker's re-fetch
  of the sign-out post was (`src/web/shell/session-caches.md`). That one
  is WebKit's own code, not the Linux build's, so it was a real iPhone's
  bug too; when a failure might be the Linux build only, reproduce it in a
  page and worker of a few lines before skipping it.
- **Something Playwright's WebKit cannot do.** The spec skips in WebKit with
  one of the reasons in `test/support/webkit-limits.ts`, each seen failing
  with the app working: offline navigations (setOffline fails them before
  the service worker answers), a service worker's own requests and console
  (only Chromium routes and reports them), push (no PushManager in the
  Linux build), and swiping in mobile WebKit (no wheel, no touch swipe; the
  `webkit` project runs those specs at 390 px with touch). A skip that hides
  an app bug does not belong there: the failure stays, and the tracking
  issue says so.

Four quirks the specs absorb rather than skip:

- **WebKit refuses a fetch while its page is leaving** and logs "Fetch API
  cannot load <url> due to access control checks.", which Playwright's
  WebKit reports as a page error although the app catches it.
  `pageErrors(page)` (`test/support/page-errors.ts`) leaves that line out;
  a spec collects the page's errors through it, never its own
  `page.on('pageerror')`.
- **A Safari tab opens the install dialog** over the first page of every
  session and it takes every tap. The Safari projects start with it
  dismissed (`INSTALL_DISMISSED` in `playwright.config.ts`, the element's
  own flag); `test/install-dialog.spec.ts (retired 2026-10-13)` covers the dialog in Chromium.
- **A refused sign-in's 401 is a console error.** WebKit logged it twice
  while the service worker relayed the auth forms (#239 until #542: the
  worker's fetch and the document load); the worker leaves every
  navigation post to the browser now. `test/auth.spec.ts` asserts that
  every console error is that line and that there is one, not how many
  (2026-10-26, #301).
- **WebKit routes a controlled page's fetches past `page.route`.** Once the
  service worker controls the page, the page's own requests go through the
  worker even where it answers nothing (`/health/live`, `src-sw.ts`), and
  Playwright's WebKit routes none of them, so the
  spec's abort never happens. A spec that fakes the heartbeat with
  `page.route` and is not about the worker blocks it
  (`test.use({ serviceWorkers: 'block' })`, `test/offline-writes.spec.ts`);
  one about the worker skips with the limit above (9 runs in 30 on a Mac's
  WebKit, 2026-10-26, #436).

Other differences met on the way: Playwright's WebKit reports a multipart
body without its files' bytes (`test/photo-downscale.spec.ts (retired 2026-10-13)` reads them off
the input) and cannot read the clipboard back (`client-behaviors.spec.ts` (retired 2026-10-13)
checks the link the tap writes); a held answer is released before
`route.fulfill` returns, since WebKit hands it to the page first
(`test/autosave.spec.ts (retired 2026-10-13)`); an htmx request a
navigation cuts off is an XHR `error` in WebKit, which htmx logs as
`htmx:sendError` (a console error), where Chromium's is a silent abort, so
`test/auth.spec.ts` awaits the registration fieldset's inline check before
it submits (seen on a Mac's WebKit, 7 runs in 8, 2026-10-26).

## Running it on the production host

Playwright's WebKit needs system libraries the production host does not have (and
`install-deps` needs root), so the browser runs in Playwright's own image,
whose tag must match `@playwright/test` in `package-lock.json`, against a
`start:test` server on the host:

```bash
npm run build
docker exec closet-pg psql -U postgres -c 'CREATE DATABASE closet_webkit'
# The production config, as the nightly runs it (PWA on, VAPID keys, https: SITE_URL),
# plus what playwright.config.ts would set for its own server (SENTRY_DSN, ORDER_MAIL_*).
PORT=3107 DATABASE_HOST=localhost DATABASE_USER=postgres DATABASE_PASS=postgres \
  DATABASE_NAME=closet_webkit PWA_ENABLED=true SITE_URL=https://closet.test \
  PUBLIC_VAPID_KEY=.. PRIVATE_VAPID_KEY=.. ACCESS_TOKEN_SECRET=<32+ chars> \
  METRICS_ENABLED=true ORDER_MAIL_JMAP_TOKEN=fmu1-e2e-stand-in \
  ORDER_MAIL_SENDERS=orders-owner@example.com ORDER_MAIL_OWNER=orders-owner@example.com \
  SENTRY_DSN=http://publickey@127.0.0.1:13107/1 npm run start:test &
docker run --rm --network host --ipc host -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:$PWD" -w "$PWD" -e PORT=3107 -e DATABASE_HOST=localhost \
  -e DATABASE_USER=postgres -e DATABASE_PASS=postgres -e DATABASE_NAME=closet_webkit \
  -e PWA_ENABLED=true -e PUBLIC_VAPID_KEY=.. -e PRIVATE_VAPID_KEY=.. \
  mcr.microsoft.com/playwright:v1.60.0-noble \
  npx playwright test --project=webkit --project="Mobile Safari" --workers=4
```

The specs reuse the running server (not CI) and read the same database for
their own rows; a few load the server's config themselves
(`order-review.spec.ts` (retired 2026-10-13)), which refuses `PWA_ENABLED` without the VAPID
keys, hence the same keys in both. Worktrees side by side each take a
port and a database of their own. Under four workers a spec that builds
many rows through the API (`capsules.spec.ts`'s appended grid page) can
time out; rerun it alone before reading it as a failure. Stop the server by its PID, never by a pattern (other
worktrees run the same command line), and drop the database.
