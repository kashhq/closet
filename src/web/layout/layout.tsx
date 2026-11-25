import type { Child } from 'hono/jsx';
import { REPLAY_TIMEOUT_MS } from '../../offline-writes';
import { appIconFile } from '../app-icon';
import { t } from '../i18n';
import { THEME_BASE_100 } from '../theme-colors';
import type { ViewContext } from '../view-context';
import { PhotoViewer } from '../files/photo-viewer';
import { AppStatus } from './app-status';
import { importMapScript, pageModuleUrl } from './import-map';
import { ConfirmSheet } from './confirm-sheet';
import { pageIdentity } from '../page-contract';

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
//  - No attribute settling: htmx inserts an element that replaces one of the
//    same id wearing the old element's class and style, and gives it its
//    own only after the settle delay (20 ms), a frame drawn with the wrong
//    look. A month cell's weather chip arrived with its empty slot's classes
//    at base size, widening the date column, then shrank (the calendar
//    scenario measured between the two). The settle exists for CSS
//    transitions between the two classes, which nothing here uses.
//  - No script from a swap, and no eval (#672): htmx drops every <script> a
//    boosted body, a fragment or an error page brings, a same-origin src
//    included, so a page's setup is page-mount.ts's `data-page-module` and a
//    data island an attribute. Never `inlineScriptNonce`: htmx would stamp
//    it on whatever script a swap carries, an injected one too.
const HTMX_CONFIG = {
  allowEval: false,
  allowScriptTags: false,
  attributesToSettle: [],
  disableInheritance: true,
  historyCacheSize: 3,
  timeout: REPLAY_TIMEOUT_MS,
};

/**
 * A page's own link preview: the og tags (the share page's garment, a public
 * entry page's description). Each falls back to the app's, or the request's
 * URL and the app icon. `PageShell`'s `meta`.
 */
export interface PageMeta {
  ogTitle?: string;
  ogDescription?: string;
  ogUrl?: string;
  ogImage?: string;
}

export interface LayoutProps extends PageMeta {
  ctx: ViewContext;
  /** <title>; the app name when absent. */
  title?: string;
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
 * (`npm run generate:pages`); it imports from the importmap.
 */
function OutboxScript({ ctx, v }: { ctx: ViewContext; v: string }) {
  if (!ctx.user) return null;
  return <script type="module" src={`${pageModuleUrl('outbox')}${v}`}></script>;
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
    // data-asset-version: the build this page was rendered with, which the
    // worker checks before claiming it (pwa.js, claimIfUncontrolled).
    <html lang="en" {...pageIdentity(ctx.user !== undefined, ctx.appVersion)}>
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
        {/* The page's one inline script, allowed by its hash (csp.ts). */}
        <script
          type="importmap"
          dangerouslySetInnerHTML={{ __html: importMapScript(ctx.appVersion) }}
        />
        {/* Heartbeat-driven online/offline state and the banner in
            AppStatus; runs everywhere, service worker or not. */}
        <script
          type="module"
          src={`${pageModuleUrl('connectivity')}${v}`}
        ></script>
        {/* The garment form's colour field; delegated, so one load serves
            every form a navigation brings. */}
        <script
          type="module"
          src={`${pageModuleUrl('color-picker')}${v}`}
        ></script>
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
        <script type="module" src={`${pageModuleUrl('back')}${v}`}></script>
        {/* Escape closes an open app bar menu (a <details> has no key). */}
        <script
          type="module"
          src={`${pageModuleUrl('menu-escape')}${v}`}
        ></script>
        {/* The shared photo viewer (src/web/files/photo-viewer.tsx): one
            document listener opens any [data-photo-open]. */}
        <script type="module" src={`/js/photo-viewer.js${v}`}></script>
        {/* The one-line behaviours a control asks for by data-* (the CSP
            allows no inline handler) and each page's own setup on every
            visit (data-page-module): delegated, and in the head, so every
            swap is seen. */}
        <script type="module" src={`${pageModuleUrl('actions')}${v}`}></script>
        <script
          type="module"
          src={`${pageModuleUrl('page-mount')}${v}`}
        ></script>
        <OutboxScript ctx={ctx} v={v} />
        {ctx.pwaEnabled && (
          // Service worker registration, update toast, Web Push, the install
          // dialog, iOS pull to refresh. In the head so hx-boost body swaps
          // never re-run it.
          <script type="module" src={`${pageModuleUrl('pwa')}${v}`}></script>
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
          (the photo form) keeps it. `min-h-dvh` follows iOS's toolbars, so the
          viewport never collapses under a scroll. */}
      <body
        hx-boost="true"
        hx-indicator="#loading, closest a"
        hx-inherit="hx-boost hx-indicator"
        class="h-screen min-h-dvh flex flex-col"
      >
        {children}
        <AppStatus ctx={ctx} />
        <PhotoViewer />
        <ConfirmSheet />
      </body>
    </html>
  );
}
