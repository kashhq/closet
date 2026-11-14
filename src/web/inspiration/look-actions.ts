import type { LookPiece } from '../../wardrobe/recreate';
import { type ActionDeps, logOp } from '../op-log';
import type { Actor } from '../sharing/access';
import { pieceKindValue } from './piece-input';
import {
  addInspirationPiece,
  addPieceToWishlist,
  deleteInspirationPiece,
  type FoundPiece,
  type InspirationText,
  type PiecesSet,
  setInspirationPieces,
  updateInspirationPiece,
  updateInspirationText,
} from './queries';
import {
  type PostedChoice,
  type SavedRecreation,
  saveRecreation,
} from './recreate-writes';

/**
 * A look's writes (#712), the one place each logs its outcome whichever
 * door called it (the page, `/api/v1/looks`, the MCP tools). A look is the
 * actor's own: the queries underneath throw `NotFound('inspiration')` for
 * another's. The photo's and the creates' lines stay with `writes.ts`.
 */

/** Title and/or note: a field left out of `text` is kept (and not named in the line). */
export async function editLookText(
  { db, logger }: ActionDeps,
  actor: Actor,
  id: number,
  text: Partial<InspirationText>,
): Promise<void> {
  await updateInspirationText(db, id, actor.userId, text);
  logOp(logger, actor, 'inspiration.text.changed', {
    inspirationId: id,
    title: text.title !== undefined,
    note: text.note !== undefined,
  });
}

/** One piece added at the look's next position, which it answers. */
export async function addLookPiece(
  { db, logger }: ActionDeps,
  actor: Actor,
  id: number,
  piece: LookPiece,
): Promise<number> {
  const position = await addInspirationPiece(db, id, actor.userId, piece);
  logOp(logger, actor, 'inspiration.piece.added', {
    inspirationId: id,
    position,
    kind: pieceKindValue(piece),
  });
  return position;
}

/** A piece replaced whole, at its position. */
export async function changeLookPiece(
  { db, logger }: ActionDeps,
  actor: Actor,
  id: number,
  position: number,
  piece: LookPiece,
): Promise<void> {
  await updateInspirationPiece(db, id, position, actor.userId, piece);
  logOp(logger, actor, 'inspiration.piece.changed', {
    inspirationId: id,
    position,
    kind: pieceKindValue(piece),
  });
}

export async function removeLookPiece(
  { db, logger }: ActionDeps,
  actor: Actor,
  id: number,
  position: number,
): Promise<void> {
  await deleteInspirationPiece(db, id, position, actor.userId);
  logOp(logger, actor, 'inspiration.piece.removed', {
    inspirationId: id,
    position,
  });
}

/** The look's whole list of pieces (set_inspiration_pieces, `PUT .../pieces`). */
export async function setLookPieces(
  { db, logger }: ActionDeps,
  actor: Actor,
  id: number,
  pieces: readonly LookPiece[],
): Promise<PiecesSet> {
  const set = await setInspirationPieces(db, id, actor.userId, pieces);
  logOp(logger, actor, 'inspiration.pieces.set', {
    inspirationId: id,
    kept: set.kept,
    removed: set.removed,
    added: set.added,
  });
  return set;
}

/** The match view's save: `changed` false when these garments were an outfit already. */
export async function saveLookAsOutfit(
  { db, logger }: ActionDeps,
  actor: Actor,
  id: number,
  choices: readonly PostedChoice[],
): Promise<SavedRecreation> {
  const saved = await saveRecreation(db, actor.userId, id, choices);
  logOp(logger, actor, 'inspiration.outfit.saved', {
    inspirationId: id,
    outfitId: saved.outfit.id,
    garments: saved.garments,
    changed: !saved.outfit.alreadySaved,
  });
  return saved;
}

/** "Find this": the piece's wishlist item; `changed` false when it was on the wishlist already. */
export async function findLookPiece(
  { db, logger }: ActionDeps,
  actor: Actor,
  id: number,
  position: number,
): Promise<FoundPiece> {
  const found = await addPieceToWishlist(db, actor.userId, id, position);
  logOp(logger, actor, 'inspiration.piece.found', {
    inspirationId: id,
    position,
    garmentId: found.garmentId,
    changed: found.created,
  });
  return found;
}
