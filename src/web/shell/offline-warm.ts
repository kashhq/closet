/**
 * What the server's warm list and the service worker's warm agree on
 * (#286; views/assets/src-sw.ts bundles this file: keep it free of Node and
 * DOM). The worker asks GET WARM_LIST_PATH for the signed-in account's own
 * wardrobe and fetches what its caches lack, so the installed app can read
 * every garment and outfit offline (src/web/shell/offline-warm.md).
 */

import { TAB_ROOTS } from '../page-cache';
import { GRID_PAGE_SIZE } from '../wardrobe/grid-page-size';

/** The warm list's route (src/web/shell/routes.tsx). */
export const WARM_LIST_PATH = '/offline/warm';

/**
 * A warm asks again for a copy older than this (with its ETag: an unchanged
 * page answers 304 and costs its headers, #708), and runs at most this often.
 */
export const WARM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A warm stops once it has added this much to the origin's storage use
 * (what it was at the run's start, so photos visited before never stop it).
 */
export const WARM_USAGE_BUDGET_BYTES = 50 * 1024 * 1024;

/**
 * Caps on what one device warms (docs/plans/2026-09-28-caching-and-offline.md,
 * section 2): the newest first. The garments cover the 0.1 target closet
 * (500, #708), the outfits its newest quarter; about 21 MB at the caps
 * (7.7 KB a garment page, 5.7 an outfit's, ~25 KB a thumb), inside
 * WARM_USAGE_BUDGET_BYTES. Raised once an unchanged page cost a warm only
 * its headers (send()'s ETag, PageRefresh's 304); each page is still a
 * request a day, so the outfits stop short of all of them. The demo
 * wardrobe (83 garments, 26 outfits) is well under both.
 */
export const WARM_GARMENT_CAP = 500;
export const WARM_OUTFIT_CAP = 250;

/**
 * The Muse inbox's pages a warm names (#333): the inbox itself, its needs'
 * decision screens and the pages of what is still wanted, newest first.
 * Their thumbs count the same, beside the closet's.
 */
export const WARM_WISHLIST_CAP = 60;

/**
 * The trips ahead or on that a warm names, nearest first (#657), beside the
 * laundry: the pages whose queueable controls (packing ticks, Washed) must
 * work offline without a prior visit.
 */
export const WARM_TRIP_CAP = 20;

/**
 * The most pages a warm list names (pages and fragments): next week, the laundry and the trips (WARM_TRIP_CAP), a page per capped garment and outfit, the inbox's
 * (WARM_WISHLIST_CAP), and the grid's later pages, one per GRID_PAGE_SIZE
 * warmed garments at most. The worker sizes its page cache from it.
 */
export const WARM_PAGE_CAP =
  1 +
  1 +
  WARM_TRIP_CAP +
  WARM_GARMENT_CAP +
  WARM_OUTFIT_CAP +
  WARM_WISHLIST_CAP +
  Math.ceil(WARM_GARMENT_CAP / GRID_PAGE_SIZE);

// Thumbs an outfit shows that no warmed garment page does: its archived
// pieces, or ones past the garment cap.
const WARM_OUTFIT_ONLY_THUMBS = 100;

/**
 * The most thumbs a warm list names (the server cuts the list there): the
 * capped garments', their outfits' others, and the inbox's products. The worker sizes its image
 * cache from it.
 */
export const WARM_IMAGE_CAP =
  WARM_GARMENT_CAP + WARM_OUTFIT_ONLY_THUMBS + WARM_WISHLIST_CAP;

/**
 * The warm list: same-origin paths with their query, nothing else.
 *  - pages: whole pages (next week, garments, outfits), never a tab root;
 *  - fragments: the wardrobe grid's later pages, fetched as htmx requests so
 *    they land under the `|hx` key the grid's own scroll reads;
 *  - images: the thumbs those pages show;
 *  - keep: detail pages that still exist but are not warmed (wishlist items,
 *    pieces past the caps): a visited copy of one stays. Every other cached
 *    garment or outfit page (isWarmedDetailPage) is of a deleted or archived
 *    one, and a warm removes it.
 */
export interface WarmList {
  pages: string[];
  fragments: string[];
  images: string[];
  keep: string[];
}

// A garment's or an outfit's own page, the owner's (no ?ownerId=, so never
// a shared wardrobe's), exactly as garmentUrl and outfitUrl build them.
const DETAIL_PAGE = /^\/(?:wardrobe|outfits)\/\d+$/;

/** Whether a warm owns this cached page's fate: kept only while listed. */
export function isWarmedDetailPage(url: {
  pathname: string;
  search: string;
}): boolean {
  return url.search === '' && DETAIL_PAGE.test(url.pathname);
}

const LIST_KEYS = ['pages', 'fragments', 'images', 'keep'] as const;

/**
 * The server's answer, checked at the worker's boundary: undefined unless
 * every list is an array of root-relative paths (never another origin, never
 * a protocol-relative `//host`). A tab root among the pages is dropped: the
 * worker opens those stale-while-revalidate, so a copy the warm stored or
 * refreshed would be shown stale after the user's own edits (the Back
 * button after a save, test/back-navigation.spec.ts (retired 2026-10-13)). They are cached only
 * when opened.
 */
export function parseWarmList(value: unknown): WarmList | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const lists = LIST_KEYS.map((key) => record[key]);
  if (!lists.every(isPathList)) return undefined;
  const [pages, fragments, images, keep] = lists;
  return {
    pages: pages.filter((path) => !TAB_ROOTS.has(path)),
    fragments,
    images,
    keep,
  };
}

function isPathList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (path) =>
        typeof path === 'string' &&
        path.startsWith('/') &&
        !path.startsWith('//'),
    )
  );
}
