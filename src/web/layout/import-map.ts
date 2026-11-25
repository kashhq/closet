import { jsonForScript } from '../html';

/**
 * The URL of a page module built from views/assets/page/<name>.ts (or
 * views/assets/outbox.ts) into public/js/gen/ (buildPageModules,
 * scripts/static-assets.ts). A plain-JS module keeps its /js/<name>.js
 * (scripts/ci/plain_js.conf); converting one moves its URL here.
 */
export function pageModuleUrl(name: string): string {
  return `/js/gen/${name}.js`;
}

/**
 * Bare specifiers for every ES module the pages import, so the versioned URL
 * lives here once (the layout renders it as the page's importmap).
 * Page-specific modules (the snap strip's snap-strip, which Styling's
 * styling imports, the garment page's mask-editor and photo-input, select
 * mode's select-count, the recap's recap-export, the share confirmation's
 * share-confirm and click-gate, a look's share-saved, the Wardrobe's
 * search-shortcut) are only fetched by the page that imports them.
 *
 * Also the page modules' build (buildPageModules, scripts/static-assets.ts):
 * every name here stays a bare import in the bundles, resolved by the
 * browser, so a module shared by several (toast, single-flight) runs once
 * per document. Keep views/assets/tsconfig.page.json's `paths` and
 * knip.jsonc's in step.
 */
const IMPORTS = {
  'workbox-window': '/modules/workbox-window.prod.mjs',
  // pwa.ts imports these two only where they do something.
  'pwa-install': '/modules/pwa-install.bundle.js',
  pulltorefreshjs: '/modules/pulltorefresh/index.esm.js',
  toast: '/js/toast.js',
  'confirm-sheet': '/js/confirm-sheet.js',
  'mask-editor': pageModuleUrl('mask-editor'),
  'photo-input': '/js/photo-input.js',
  'snap-strip': '/js/snap-strip.js',
  styling: '/js/styling.js',
  locate: pageModuleUrl('locate'),
  push: pageModuleUrl('push'),
  freshness: pageModuleUrl('freshness'),
  'age-label': pageModuleUrl('age-label'),
  'single-flight': pageModuleUrl('single-flight'),
  'select-count': '/js/select-count.js',
  'recap-export': '/js/recap-export.js',
  'share-confirm': '/js/share-confirm.js',
  'share-saved': pageModuleUrl('share-saved'),
  'click-gate': '/js/click-gate.js',
  'search-shortcut': pageModuleUrl('search-shortcut'),
};

/** The names the bundles leave to the importmap. */
export const IMPORT_MAP_NAMES = Object.keys(IMPORTS);

/**
 * The importmap's script text: the page's one inline script, which the CSP
 * allows by its sha256 (src/web/security/csp.ts, #672). createApp calls it
 * once and hands the one string to the CSP and to every page
 * (`ViewContext.importMap`); nothing else may call it, or the hash and the
 * page could name different texts. Fixed per build, so the header and every
 * page stay byte-stable.
 */
export function importMapScript(version: string): string {
  return jsonForScript(importMap(version));
}

function importMap(version: string) {
  const v = `?v=${version}`;
  return {
    imports: Object.fromEntries(
      Object.entries(IMPORTS).map(([name, url]) => [name, `${url}${v}`]),
    ),
  };
}
