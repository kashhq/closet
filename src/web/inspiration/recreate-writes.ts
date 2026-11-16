import type { Db } from '../../db/client';
import { pieceCategory } from '../../wardrobe/properties';
import { ownerTransaction } from '../auth/queries';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { garmentsGoneError } from '../outfits/gone-garments';
import { type PickResult, pickIdea } from '../outfits/pick';
import { lockLookForSave, recordPieceChoices } from './queries';
import { BY_PERSON } from '../write-origin';

/**
 * The match view's "Save as outfit" (#22c; docs/plans/2026-11-13-
 * inspiration-library.md section 4), over the outfit writer (pickIdea) and
 * the look's own queries; "Find this" is queries.ts' addPieceToWishlist.
 * Both record what the owner chose for a piece
 * (inspiration_piece.matched_garment_id) in the same transaction as what
 * they create, and both are safe to repeat: a second save of the same
 * choices is the outfit the first made, a second "Find this" of a piece
 * the wishlist item the first made.
 */

/** A strip's choice as posted: the piece's position, and its garment (null: None). */
export interface PostedChoice {
  position: number;
  garmentId: number | null;
}

export interface SavedRecreation {
  outfit: PickResult;
  /** The garments the outfit was saved with (the choices that were not None). */
  garments: number;
}

/**
 * Saves the owner's look `id` as an outfit of the garments chosen for its
 * pieces and records each choice, in one owner transaction: the look
 * locked with its pieces (lockLookForSave), the outfit through pickIdea
 * (closet garments only, top to toe, once per garment set, named after the
 * look's title, else as an idea is), then every choice recorded
 * (recordPieceChoices). A choice for a piece the look no longer has, or of
 * a garment that is not of the piece's kind, or one garment chosen for two pieces (an outfit
 * holds it once, so the save would drop a piece's choice silently), refuses
 * the save whole (409: the page is out of date); a garment gone from the closet is pickIdea's
 * refusal, named (garmentsGoneError). Nothing chosen, or a piece posted
 * twice, is a 400 (the page offers neither). The match view's save and
 * POST /api/v1/looks/{id}/outfits.
 */
export async function saveRecreation(
  db: Db,
  ownerId: number,
  id: number,
  posted: readonly PostedChoice[],
): Promise<SavedRecreation> {
  if (new Set(posted.map((c) => c.position)).size !== posted.length) {
    throw new HttpError(400, t('refusal.inspiration.pieceTwice'), {
      logDetail: `inspiration ${id}: a position posted twice`,
    });
  }
  const garmentIds = posted.flatMap((c) => c.garmentId ?? []);
  if (garmentIds.length === 0) {
    throw new HttpError(400, t('inspiration.NOTHING_CHOSEN'), {
      logDetail: `inspiration ${id}: every piece None`,
    });
  }
  if (new Set(garmentIds).size < garmentIds.length) {
    throw lookChanged(id, 'one garment chosen for two pieces');
  }
  const saved = await ownerTransaction(
    db,
    ownerId,
    'saveRecreation',
    async (tx) => {
      const look = await lockLookForSave(tx, id, ownerId);
      const choices = posted.map(({ position, garmentId }) => {
        const role = look.roles.get(position);
        if (role === undefined) throw lookChanged(id, `no piece ${position}`);
        return { position, garmentId, category: pieceCategory(role) };
      });
      const outfit = await pickIdea(tx, ownerId, {
        garmentIds,
        name: look.title ?? undefined,
        origin: 'person',
        madeBy: BY_PERSON,
      });
      if (outfit === 'not-found') return outfit;
      const recorded = await recordPieceChoices(tx, id, ownerId, choices);
      if (recorded !== choices.length) {
        throw lookChanged(
          id,
          `${choices.length - recorded} choice(s) not of their piece's kind`,
        );
      }
      return outfit;
    },
  );
  if (saved === 'not-found') {
    throw await garmentsGoneError(db, ownerId, garmentIds, 'closet');
  }
  return { outfit: saved, garments: garmentIds.length };
}

function lookChanged(id: number, detail: string): HttpError {
  return new HttpError(409, t('inspiration.LOOK_CHANGED'), {
    logDetail: `inspiration ${id}: ${detail}`,
  });
}
