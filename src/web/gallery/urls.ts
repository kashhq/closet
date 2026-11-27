import {
  destinationQuery,
  type OutfitDestination,
} from '../outfits/destination';

/**
 * Where the gallery is: the Outfits page's Ideas tab and what scopes it.
 * Every link, the sentinel and the writes' redirects are built here from
 * parsed values, never from the request's own string.
 */

export const IDEAS_PATH = '/outfits/ideas';
/** "Allow again" (allowPair): the garment page's and the Style page's (#21b). */
export const IDEAS_ALLOW_PATH = `${IDEAS_PATH}/allow`;

/**
 * The one-shot flag a pick's or a save's redirect carries when the outfit
 * already existed (pickIdea's and createOutfit's alreadySaved): the outfit
 * and calendar pages show AlreadySavedToast for it. Its value says which:
 * `1`, already the owner's ("Already saved"); `agent`, one of the agent's
 * proposals the save made theirs (#335, "Saved the agent's outfit").
 */
export const ALREADY_SAVED_FLAG = 'alreadySaved';

export type AlreadySaved = 'saved' | 'agent';

/** The flag as a query parameter (`alreadySaved=…`), '' for an outfit created now. */
export function alreadySavedParam(result: {
  alreadySaved: boolean;
  adoptedProposal: boolean;
}): string {
  if (!result.alreadySaved) return '';
  return `${ALREADY_SAVED_FLAG}=${result.adoptedProposal ? 'agent' : '1'}`;
}

/** The flag as the pages read it: URL state, so anything else is no toast. */
export function alreadySavedOf(
  value: string | undefined,
): AlreadySaved | undefined {
  if (value === '1') return 'saved';
  return value === 'agent' ? 'agent' : undefined;
}

export interface GalleryState {
  /** `?for=`: where a pick goes (OutfitDestination: a day, a trip #10, or none). */
  destination: OutfitDestination;
  /** `?capsule=`: only this capsule's garments. */
  capsuleId?: number;
  /** `?with=`: this garment in every idea ("Style this"). */
  withId?: number;
  /** `?seed=`: which ideas; Shuffle moves it. */
  seed?: number;
}

/**
 * The gallery (or `path`, its paging route) for `state`, with `page` when
 * given. The values are parsed ones (ids, a seed, a real date and a known
 * occasion), so nothing needs encoding and the URL stays readable.
 */
export function ideasUrl(
  state: GalleryState,
  options: { path?: string; page?: number } = {},
): string {
  const query = [
    destinationQuery(state.destination),
    state.capsuleId !== undefined && `capsule=${state.capsuleId}`,
    state.withId !== undefined && `with=${state.withId}`,
    state.seed !== undefined && `seed=${state.seed}`,
    options.page !== undefined && `page=${options.page}`,
  ].filter(Boolean);
  const path = options.path ?? IDEAS_PATH;
  return query.length > 0 ? `${path}?${query.join('&')}` : path;
}
