import { SECTION_HOME } from '../layout/sections';
import { destinationQuery, type OutfitDestination } from './destination';
import { type OutfitList, withOutfitList } from './outfit-list';

/**
 * The Outfits page's addresses, built from parsed values (nothing needs
 * encoding). The Saved tab is the dock's Outfits tab and a
 * stale-while-revalidate tab root (page-cache.ts) when it has no query.
 */

export const SAVED_PATH = SECTION_HOME.outfits;

/**
 * The Saved tab, picking for a day when `destination` is one (R5: the
 * calendar's "Pick a saved outfit"). A trip's outfits are added from the
 * trip's own page, so the grid reads a day only.
 */
export function savedUrl(destination: OutfitDestination): string {
  return destination.kind === 'day'
    ? `${SAVED_PATH}?${destinationQuery(destination)}`
    : SAVED_PATH;
}

/** The Saved grid's next page (#660): its sentinel's GET, always a fragment. */
export const SAVED_TILES_PATH = `${SAVED_PATH}/tiles`;

/**
 * The Saved grid's page below `before`, for the same list and day as the
 * page that drew the sentinel.
 */
export function savedTilesUrl(
  destination: OutfitDestination,
  list: OutfitList,
  before: number,
): string {
  const query = [
    destination.kind === 'day' && destinationQuery(destination),
    `before=${before}`,
  ].filter(Boolean);
  return withOutfitList(`${SAVED_TILES_PATH}?${query.join('&')}`, list);
}

/** An outfit's page. */
export function outfitUrl(id: number): string {
  return `${SAVED_PATH}/${id}`;
}
