import type { AcceptRefusal } from './queries';

/**
 * Where sharing is managed: Profile › Sharing, its own page since #728
 * (a section of Profile from #82). The writes under /wardrobe-share land
 * there, and the old manage page redirects there. Profile's row keeps the
 * section's id, so `/auth/profile#sharing` lands on the row opening it.
 */
export const SHARING_SECTION_ID = 'sharing';
export const SHARING_PATH = '/auth/profile/sharing';

/**
 * The manage page before Sharing moved into Profile (#82). Pages the
 * installed app cached still link here, so it stays, as a redirect.
 */
export const LEGACY_MANAGE_PATH = '/wardrobe-share/manage';

/**
 * The edit-link step-up page (#668): an edit link hands out write access,
 * so it is minted only with the current password, like a token.
 */
export const EDIT_INVITE_PATH = '/wardrobe-share/edit-invite';

/** Where both invite forms post (the view link's one tap, the step-up page). */
export const CREATE_INVITE_PATH = '/wardrobe-share/create-invite-link';

/**
 * An invite's landing page (public, its token a bearer secret: the route is
 * `secretPath`), and where signing in from it returns (#661).
 */
export function invitePath(token: string): string {
  return `/wardrobe-share/invite/${encodeURIComponent(token)}`;
}

/** The sharing page's query parameter naming why an invite could not be accepted. */
export const SHARE_ERROR_PARAM = 'shareError';

export function sharingRefusalUrl(refusal: AcceptRefusal): string {
  return `${SHARING_PATH}?${SHARE_ERROR_PARAM}=${refusal}`;
}
