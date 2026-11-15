/**
 * The style profile's address (#34): a section of the Profile, so the dock
 * marks it there. Never with `?ownerId=`: the profile is the signed-in
 * user's own.
 */
export const STYLE_PROFILE_PATH = '/auth/profile/style';

/** The page's Outfit rules section (#21b), and the root of its writes. */
export const OUTFIT_RULES_SECTION_ID = 'outfit-rules';
export const OUTFIT_RULES_PATH = `${STYLE_PROFILE_PATH}/rules`;

export function outfitRuleDeleteUrl(id: number): string {
  return `${OUTFIT_RULES_PATH}/${id}/delete`;
}

/** The page's one-shot flag after a write: which toast to show. */
export const STYLE_SAVED_FLAG = 'saved';
export const STYLE_SAVED = [
  'profile',
  'rule-added',
  'rule-removed',
  'pair-allowed',
] as const;
export type StyleSaved = (typeof STYLE_SAVED)[number];

/** The page after a write, at the section the write was in. */
export function styleSavedUrl(saved: StyleSaved): string {
  const url = `${STYLE_PROFILE_PATH}?${STYLE_SAVED_FLAG}=${saved}`;
  return saved === 'profile' ? url : `${url}#${OUTFIT_RULES_SECTION_ID}`;
}
