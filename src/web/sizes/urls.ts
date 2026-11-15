/**
 * Sizes' addresses (#24): Profile's Sizes row (its id), and the editor under
 * it (the style profile's shape). The signed-in user's own: none takes
 * `?ownerId=`.
 */

export const SIZES_SECTION_ID = 'sizes';

/** The editor, and the root of its writes. */
export const SIZES_PATH = '/auth/profile/sizes';
export const SIZES_UNIT_PATH = `${SIZES_PATH}/unit`;
export const SIZES_MEASUREMENTS_PATH = `${SIZES_PATH}/measurements`;
export const BRAND_SIZES_PATH = `${SIZES_PATH}/brands`;
/** The garment form's hint: the brand's note as the brand is typed. */
export const BRAND_SIZE_HINT_PATH = `${SIZES_PATH}/hint`;

export function brandSizeUrl(id: number, action?: 'delete'): string {
  return `${BRAND_SIZES_PATH}/${id}${action ? `/${action}` : ''}`;
}

/** The editor's one-shot flag after a write: which toast to show. */
export const SIZES_SAVED_FLAG = 'saved';
export const SIZES_SAVED = ['measurements', 'brand', 'removed'] as const;
export type SizesSaved = (typeof SIZES_SAVED)[number];

export function sizesSavedUrl(saved: SizesSaved): string {
  return `${SIZES_PATH}?${SIZES_SAVED_FLAG}=${saved}`;
}
