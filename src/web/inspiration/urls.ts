import type { UnreadReason } from './writes';

/**
 * The Inspiration tab's addresses (#22), built from parsed values. Under
 * the Outfits section (sections.ts): a look is the start of an outfit.
 */

export const INSPIRATION_PATH = '/inspiration';
export const NEW_INSPIRATION_PATH = `${INSPIRATION_PATH}/new`;
export const INSPIRATION_LINK_PATH = `${INSPIRATION_PATH}/link`;
export const INSPIRATION_TILES_PATH = `${INSPIRATION_PATH}/tiles`;

/** The tab's next page of tiles (#528): the looks below `before`, an id. */
export function inspirationTilesUrl(before: number): string {
  return `${INSPIRATION_TILES_PATH}?before=${before}`;
}

/** A look's page; `unread` says once why a link came without its photo. */
export function inspirationUrl(id: number, unread?: UnreadReason): string {
  const path = `${INSPIRATION_PATH}/${id}`;
  return unread ? `${path}?unread=${unread}` : path;
}

export function inspirationPhotoPath(id: number): string {
  return `${INSPIRATION_PATH}/${id}/photo`;
}

export function deleteInspirationPath(id: number): string {
  return `${INSPIRATION_PATH}/${id}/delete`;
}

/** Where a look's piece form posts a new piece. */
export function inspirationPiecesPath(id: number): string {
  return `${INSPIRATION_PATH}/${id}/pieces`;
}

/** A piece's autosave. */
export function inspirationPiecePath(id: number, position: number): string {
  return `${inspirationPiecesPath(id)}/${position}`;
}

export function deleteInspirationPiecePath(
  id: number,
  position: number,
): string {
  return `${inspirationPiecePath(id, position)}/delete`;
}

/** The look's pieces on its page: where a piece write lands. */
export function inspirationPiecesUrl(id: number): string {
  return `${inspirationUrl(id)}#${LOOK_PIECES_ID}`;
}

/** The pieces' section on a look's page. */
export const LOOK_PIECES_ID = 'look-pieces';

/** "Recreate this look": the closet's closest garments to each piece. */
export function recreateLookUrl(id: number): string {
  return `${INSPIRATION_PATH}/${id}/recreate`;
}

/** "Save as outfit": the match view's form, posting every piece's choice. */
export function saveRecreationPath(id: number): string {
  return `${recreateLookUrl(id)}/outfit`;
}

/** "Find this": a missing piece to the wishlist. */
export function findPiecePath(id: number, position: number): string {
  return `${inspirationPiecePath(id, position)}/find`;
}

/** A piece's heading on the match view, where "Find this" lands. */
export function recreatePieceId(position: number): string {
  return `recreate-piece-${position}`;
}

/** The match view at one piece. */
export function recreatePieceUrl(id: number, position: number): string {
  return `${recreateLookUrl(id)}#${recreatePieceId(position)}`;
}
