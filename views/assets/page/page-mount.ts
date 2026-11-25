/**
 * A page's own setup, on every visit (#672): the module each
 * `data-page-module` names, loaded through the importmap only where a page
 * asks for it, and run on that element (`pageModule`, page-contract.ts).
 * The CSP allows no inline script, and a `<script src>` module runs once
 * per document while a boosted navigation, a fragment or a history restore
 * brings new elements without a new document; the engine (`watchMounts`,
 * views/assets/mounts.ts) mounts each element once. A head module, so it
 * sees every swap.
 *
 * A page-only module that keeps listeners of its own on the document
 * (search-shortcut, select-count, styling's) registers them at evaluation,
 * once a document; its mount here only loads it or hands it this visit's
 * element.
 */

import { STRIP_FLAGS } from '../../../src/web/page-contract';
import { type MountTable, watchMounts } from '../mounts';

/**
 * Drops one-shot flags from the address bar once the page has read them
 * (StripFlags, parts.tsx), so a reload or a copied URL does not replay
 * their toast. htmx has pushed a boosted navigation's URL before it swaps,
 * so this reads the new page's.
 */
function stripFlags(marker: HTMLElement) {
  const names = (marker.getAttribute(STRIP_FLAGS) ?? '')
    .split(' ')
    .filter(Boolean);
  const url = new URL(window.location.href);
  if (!names.some((name) => url.searchParams.has(name))) return;
  for (const name of names) url.searchParams.delete(name);
  window.history.replaceState({}, '', url);
}

const MOUNTS: MountTable = {
  'strip-flags': stripFlags,
  'snap-strips': async () =>
    (await import('snap-strip')).initSnapStrips(document),
  styling: async (rows) => (await import('styling')).initStyling(rows),
  'mask-editor': async (slot) =>
    (await import('mask-editor')).bindMaskEditor(slot),
  'open-sheet': async (dialog) => {
    if (!(dialog instanceof HTMLDialogElement)) return;
    (await import('confirm-sheet')).openSheet(dialog, null);
  },
  'search-shortcut': () => import('search-shortcut'),
  'select-count': () => import('select-count'),
  'recap-export': async (button) => {
    if (!(button instanceof HTMLButtonElement)) return;
    (await import('recap-export')).prepareRecapExport(button);
  },
  'share-confirm': async (root) =>
    (await import('share-confirm')).confirmShare(root),
  'share-saved': async () => (await import('share-saved')).forgetSavedShare(),
  locate: async (part) => (await import('locate')).initLocate(part),
};

watchMounts(MOUNTS);
