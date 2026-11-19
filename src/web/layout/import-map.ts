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
  'mask-editor': '/js/mask-editor.js',
  'photo-input': '/js/photo-input.js',
  'snap-strip': '/js/snap-strip.js',
  styling: '/js/styling.js',
  locate: '/js/locate.js',
  push: '/js/push.js',
  freshness: '/js/freshness.js',
  'age-label': '/js/age-label.js',
  'single-flight': '/js/single-flight.js',
  'select-count': '/js/select-count.js',
  'recap-export': '/js/recap-export.js',
  'share-confirm': '/js/share-confirm.js',
  'share-saved': '/js/share-saved.js',
  'click-gate': '/js/click-gate.js',
  'search-shortcut': '/js/search-shortcut.js',
} as const;

/** The names the bundles leave to the importmap. */
export const IMPORT_MAP_NAMES = Object.keys(IMPORTS);

export function importMap(version: string) {
  const v = `?v=${version}`;
  return {
    imports: Object.fromEntries(
      Object.entries(IMPORTS).map(([name, url]) => [name, `${url}${v}`]),
    ),
  };
}
