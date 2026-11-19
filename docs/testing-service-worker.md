# Testing the service worker's update flow and push

How `test/sw-update.spec.ts` and `test/push-notification.spec.ts (retired 2026-10-13)` (#180)
reach the parts of the worker no page request exercises, and what they
cannot reach. Both skip unless the server runs with `PWA_ENABLED=true` (the
production config, `test/AGENTS.md`).

## A second build of the worker (`test/support/next-build.ts`)

An update is the browser finding new bytes at `/sw.js`. Nothing in
Playwright can change what it finds: `context.route` and CDP's Fetch domain
(page or browser session) never see the browser fetching a registered
worker's script for an update check, only a page's or a worker's own
requests. So `startNextBuild()` puts a reverse proxy in front of the test
server, on its own port of `localhost`, and the spec opens the app there.
Everything passes through untouched (the Host header too, so the
same-origin check and redirects name the proxy; the session cookie is
`localhost`'s, whatever the port) until `deploy()`, after which `/sw.js` is
the server's worker with a message handler appended: it answers
`TEST_BUILD` with the build's id, which is how `controllingBuild(page)`
tells which worker controls a page (the server's own build never answers).
Being its own origin, each test also gets a registration no other spec
shares. It works in WebKit as well (no CDP).

The spec triggers the check with `registration.update()`, as the browser
does after a navigation, and only once pwa.js logged
`[pwa] service worker registered`: Workbox listens for `updatefound` from
then on, and a worker found before that is never offered in that document
(it is on the next open, as `wasWaitingBeforeRegister`).

What it covers: the toast on `waiting`, the old worker keeping the page
until Reload, the toast coming back after a boosted navigation, one reload
onto the new build; and with two windows, the one that did not tap keeps
its page under the new worker (clientsClaim) and its Reload still works.
The first window there is the app's first visit (no controller when pwa.js
registered), the single-window test a reopened app.

Since #656 the same scenario, at 390 px, also covers Reload disabled while
the heartbeat says offline, and the activation refresh
(`src/web/shell/updates.md`): `recordRefetches` routes every request marked
`X-Closet-Warm` (held, or one key cut, so the refresh stops where the spec
says), the due keys come from `cache.keys()` against the `activated-at`
record, and the offline open's age is read from `#freshness` with the page's
clock fast-forwarded (`page.clock`), never a sleep. Both builds have the
same static set (the proxy appends to `sw.js` only), so one precache serves
both and the page cached under A opening offline proves its `?v=` meets an
installed precache; which precache a `?v=` reads and which an activation
keeps is proved by `src/static-build.spec.ts` (a stand-in CacheStorage).

Two bugs it found in `views/assets/page/pwa.ts` (fixed with it): the other window's
Reload posted `SKIP_WAITING` to no waiting worker and did nothing, forever,
since the toast came back on every navigation; and a document opened before
the first worker controlled it never reloaded onto an update, because the
reload hung on Workbox's `isUpdate` (whether a worker controlled the page at
registration). pwa.js now keeps the update's state itself (none, waiting,
active).

## Push and notification clicks

`pushTo(page, context)` delivers a message with CDP's
`ServiceWorker.deliverPushMessage`: a real push event, payload in plain
text, as the browser hands it over after decrypting. No subscription is
needed, which Playwright's incognito contexts cannot make anyway. The spec
asserts the shown notifications through `registration.getNotifications()`
(title, body, tag, and the `data.url` a tap opens); `showNotification`
needs the full Chromium build (`channel: 'chromium'`), since the headless
shell denies notifications. Chromium only: WebKit's Linux build has no push.

No automation can tap a system notification (Playwright has no API, CDP
has no command, and a `notificationclick` dispatched from script cannot
focus or open a window). So the click's logic lives in
`src/web/push/notification-click.ts` (`openNotification`, over the few
`Clients` members it uses), which the worker's handler calls, and
`notification-click.spec.ts` drives every branch with stand-in windows: the
window already on the page, the first window navigated, a declined
navigate, no window, an off-origin or missing url.

## Proving them under load

These specs wait on the browser's worker lifecycle, so prove a change to
them in a loop under CPU load against a `start:test` server with the
production config, as for #180: 15 runs of both files, 8 workers, a busy
loop per core.
