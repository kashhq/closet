import type { Child } from 'hono/jsx';
import { REPLAY_TIMEOUT_MS } from '../../offline-writes';
import { appIconFile } from '../app-icon';
import { jsonForScript } from '../html';
import { t } from '../i18n';
import { THEME_BASE_100 } from '../theme-colors';
import type { ViewContext } from '../view-context';
import { PhotoViewer } from '../files/photo-viewer';
import { AppStatus } from './app-status';
import { ConfirmSheet } from './confirm-sheet';

/**
 * The document shell of every page. `PageShell` renders it with the app
 * bar, the page's `<main>` and the dock inside; the pages not on the shell
 * yet (guards.conf `@page-main`'s `known` lines) render those themselves.
 *
 * English only: `lang`, `og:locale` and the default description are fixed.
 */

// https://htmx.org/reference/#config. htmx reads only the first htmx-config
// meta, so this is the whole config.
//  - No attribute inheritance (https://htmx.org/quirks/#attribute-inheritance).
//  - Three history snapshots, not ten: before every navigation htmx parses
//    and re-serializes the whole sessionStorage cache (up to 180 KB at ten
//    with 48 tiles loaded; about 9 ms a tap on a mid-range phone, 4 ms at
//    three). Three covers the usual back depth (a page, its detail, its
//    edit form); further back is fetched, through the service worker.
//  - No view transitions: while one runs (about 250 ms after every swap) the
//    page takes no taps, and the app bar and dock cross-fade for nothing.
//  - A request gives up after the outbox's replay timeout, the one bound on
//    how long the app waits for the server (0, htmx's default, spun a hung
//    hx-post forever); public/js/request-failures.js says so.
const HTMX_CONFIG = {
  disableInheritance: true,
  historyCacheSize: 3,
  timeout: REPLAY_TIMEOUT_MS,
};

// Bare specifiers for every ES module the pages import, so the versioned URL
// lives here once. Page-specific modules (the snap strip's snap-strip, which
// Styling's styling imports, the garment page's mask-editor and photo-input,
// select mode's select-count, the recap's recap-export, the share
// confirmation's share-confirm and click-gate, a look's share-saved) are
// only fetched by the page that imports them.
function importMap(version: string) {
  const v = `?v=${version}`;
  return {
    imports: {
      'workbox-window': `/modules/workbox-window.prod.mjs${v}`,
      // pwa.js imports these two only where they do something.
      'pwa-install': `/modules/pwa-install.bundle.js${v}`,
      pulltorefreshjs: `/modules/pulltorefresh/index.esm.js${v}`,
      toast: `/js/toast.js${v}`,
      'confirm-sheet': `/js/confirm-sheet.js${v}`,
      'mask-editor': `/js/mask-editor.js${v}`,
      'photo-input': `/js/photo-input.js${v}`,
      'snap-strip': `/js/snap-strip.js${v}`,
      styling: `/js/styling.js${v}`,
      locate: `/js/locate.js${v}`,
      push: `/js/push.js${v}`,
      freshness: `/js/freshness.js${v}`,
      'age-label': `/js/age-label.js${v}`,
      'live-answer': `/js/live-answer.js${v}`,
      'single-flight': `/js/single-flight.js${v}`,
      'select-count': `/js/select-count.js${v}`,
      'recap-export': `/js/recap-export.js${v}`,
      'share-confirm': `/js/share-confirm.js${v}`,
      'share-saved': `/js/share-saved.js${v}`,
      'click-gate': `/js/click-gate.js${v}`,
    },
  };
}

export interface LayoutProps {
  ctx: ViewContext;
  /** <title>; the app name when absent. */
  title?: string;
  ogTitle?: string;
  ogDescription?: string;
  /** The page's own link preview (the share page); the request URL and app icon otherwise. */
  ogUrl?: string;
  ogImage?: string;
  children?: Child;
}

/**
 * With SENTRY_DSN, on signed-in pages (POST /errors/client is
 * session-only): public/js/errors.js, which beacons uncaught errors and
 * unhandled rejections with this build's release. Without a DSN the page
 * is byte for byte what it was. The first deferred script, so its
 * listeners are in place before htmx and every module run; a classic one,
 * so it can read its own data-release.
 */
function ErrorScript({ ctx, v }: { ctx: ViewContext; v: string }) {
  if (!ctx.errorTrackingEnabled || !ctx.user) return null;
  return (
    <script defer src={`/js/errors.js${v}`} data-release={ctx.release}></script>
  );
}

/**
 * The offline outbox (#178, src/web/shell/outbox.md): queues wears, washes
 * and packing ticks offline and replays them. Signed-in pages only, whose
 * #app-status names the account. Built from views/assets/outbox.ts
 * (`npm run generate:outbox`); it imports from the importmap.
 */
function OutboxScript({ ctx, v }: { ctx: ViewContext; v: string }) {
  if (!ctx.user) return null;
  return <script type="module" src={`/js/outbox.js${v}`}></script>;
}

export function Layout({
  ctx,
  title,
  ogTitle = ctx.appName,
  ogDescription = t('APP_DESCRIPTION'),
  ogUrl = ctx.ogUrl,
  ogImage = ctx.ogImage,
  children,
}: LayoutProps) {
  // Every first-party static URL carries ?v=appVersion (src/build-info.ts):
  // app.ts serves /modules, /js, /vendor, /assets and bundle.css immutable
  // for a year, so the key is what rolls the cache on deploy.
  const v = `?v=${ctx.appVersion}`;
  return (
    // data-signed-in: pwa.js starts Web Push (push.js) only on signed-in
    // pages; the session cookie is httpOnly, so scripts cannot tell.
    <html lang="en" data-signed-in={ctx.user ? '' : undefined}>
      <head>
        <meta charset="UTF-8" />
        {/* No viewport-fit=cover: iOS standalone handles the safe areas
            itself, and cover puts content under the home indicator. */}
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        {/* The browser's and the installed app's bars match the page in
            either scheme (main.css's themes follow the system's). */}
        <meta
          name="theme-color"
          media="(prefers-color-scheme: light)"
          content={THEME_BASE_100.light}
        />
        <meta
          name="theme-color"
          media="(prefers-color-scheme: dark)"
          content={THEME_BASE_100.dark}
        />
        <meta name="description" content={ogDescription} />
        <link rel="canonical" href={ctx.canonicalUrl} />
        {/* https://ogp.me/ */}
        <meta property="og:locale" content="en_US" />
        <meta property="og:url" content={ogUrl} />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={ogTitle} />
        <meta property="og:description" content={ogDescription} />
        <meta property="og:image" content={ogImage} />
        <meta property="og:image:width" content="1000" />
        <meta property="og:image:height" content="1000" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta property="twitter:domain" content={ctx.siteUrl} />
        <meta property="twitter:url" content={ogUrl} />
        <meta name="twitter:title" content={ogTitle} />
        <meta name="twitter:description" content={ogDescription} />
        <meta name="twitter:image" content={ogImage} />
        <meta property="og:site_name" content={ctx.appName} />

        <link rel="icon" href={`/favicon.ico${v}`} sizes="48x48" />
        {/* iOS scales it to 180 px; Firefox also reads it as the site icon
            on every cold load, so never the 1000 px ICON_NAME. */}
        <link
          rel="apple-touch-icon"
          href={`/assets/${appIconFile(ctx.iconName, 192)}${v}`}
        />

        <meta name="htmx-config" content={JSON.stringify(HTMX_CONFIG)} />

        <title>{title ?? ctx.appName}</title>
        {/* Served from config by src/web/shell, not a static file. */}
        <link rel="manifest" href="/manifest.json" />
        <link href={`/bundle.css${v}`} rel="stylesheet" />
        <ErrorScript ctx={ctx} v={v} />
        {/* Libraries are served from node_modules (registerStaticAssets in
            app.ts), never a CDN. */}
        <script defer src={`/modules/htmx.min.js${v}`}></script>
        <script defer src={`/js/color-multiselect.js${v}`}></script>
        <script
          type="importmap"
          dangerouslySetInnerHTML={{
            __html: jsonForScript(importMap(ctx.appVersion)),
          }}
        />
        {/* Heartbeat-driven online/offline state and the banner in
            AppStatus; runs everywhere, service worker or not. */}
        <script type="module" src={`/js/connectivity.js${v}`}></script>
        {/* The confirmation sheet (ConfirmSheet): hx-confirm and a PostForm's
            confirm. Before submit-once, which skips a declined submit. */}
        <script type="module" src={`/js/confirm-sheet.js${v}`}></script>
        {/* Every PostForm posts once per tap (double-submit guard). */}
        <script type="module" src={`/js/submit-once.js${v}`}></script>
        {/* Save-on-change forms drop answers a newer edit overtook
            (src/web/autosave.tsx). */}
        <script type="module" src={`/js/autosave.js${v}`}></script>
        {/* The status region's writer: a write's result and every other
            toast, in #toast-host (AppStatus). */}
        <script type="module" src={`/js/toast.js${v}`}></script>
        {/* A failed or timed-out htmx request says so: the error page
            for a boosted tap, a toast otherwise (src/web/errors.tsx). */}
        <script type="module" src={`/js/request-failures.js${v}`}></script>
        {/* The app bar's back arrow goes back like a native app's. After
            submit-once, whose cancelled submits it must see as cancelled. */}
        <script type="module" src={`/js/back.js${v}`}></script>
        {/* Escape closes an open app bar menu (a <details> has no key). */}
        <script type="module" src={`/js/menu-escape.js${v}`}></script>
        {/* The shared photo viewer (src/web/files/photo-viewer.tsx): one
            document listener opens any [data-photo-open]. */}
        <script type="module" src={`/js/photo-viewer.js${v}`}></script>
        <OutboxScript ctx={ctx} v={v} />
        {ctx.pwaEnabled && (
          // Service worker registration, update toast, Web Push, the install
          // dialog, iOS pull to refresh. In the head so hx-boost body swaps
          // never re-run it.
          <script type="module" src={`/js/pwa.js${v}`}></script>
        )}
        {ctx.metricsEnabled && ctx.user && (
          // The device's page-load, htmx and interaction timings, beaconed
          // to POST /metrics/vitals (session-only, so signed-in pages only).
          // A module: deferred, never blocks rendering; in the head, so it
          // runs once per document and sees every boosted navigation.
          <script type="module" src={`/js/vitals.js${v}`}></script>
        )}
      </head>

      {/* hx-boost swaps the body on every link and form
          (https://htmx.org/attributes/hx-boost/). With disableInheritance on,
          hx-inherit hands it down explicitly or no link is boosted. Every
          request lights the app bar's spinner (#loading) and marks the tapped
          link htmx-request (pressed styling in main.css), so a slow network
          never looks like a dead tap; an element with its own hx-indicator
          (the photo form) keeps it. */}
      <body
        hx-boost="true"
        hx-indicator="#loading, closest a"
        hx-inherit="hx-boost hx-indicator"
        class="h-screen flex flex-col"
      >
        {children}
        <AppStatus ctx={ctx} />
        <PhotoViewer />
        <ConfirmSheet />
      </body>
    </html>
  );
}
