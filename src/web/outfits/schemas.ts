import { Type } from '@sinclair/typebox';
import { ROW_ID_MAX, RowId } from '../schemas';

/**
 * The request schema pieces the outfit pages (routes.tsx) and the API
 * (api-routes.ts) both validate with, so the two surfaces take the same
 * outfits.
 */

/** `/:id` of an outfit's route. */
export const OutfitParams = Type.Object({ id: RowId });

/** What an outfit row's category may be: a garment's category, or a row kept empty. */
export const SlotCategory = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: '\\S',
});

/** "Not for me"'s optional note on one of Muse's outfits. */
export const DECLINE_NOTE_MAX = 500;

/**
 * `?before=` of a saved-outfit list's next page (#660): the previous page's
 * last id, the keyset bound outfitPageSql reads below. Not RowId's
 * resource mark: it addresses no outfit, only bounds the requester's own
 * (a stranger's id reveals nothing but where the list resumes). The
 * Saved grid's, the plan page's and a trip's add page's sentinels.
 */
export const OutfitCursor = Type.Integer({ minimum: 1, maximum: ROW_ID_MAX });
