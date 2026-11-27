import { and, eq, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { outfit } from '../../db/schema';
import {
  type LookReaction,
  type LookNoteEffect,
  type LookReactionEvent,
  lookReactionTransition,
} from '../../wardrobe/look-reaction';
import type { OutfitDismissReason } from '../../wardrobe/suggestions';
import { ownerTransaction } from '../auth/queries';
import { outfitIsComplete, ownersOutfit } from './references';

/**
 * The one writer of an agent outfit's reaction (#335; proposals.ts says
 * which list each reaction puts it on). Its own module, as the outfit
 * writers (queries.ts: reuseOutfit, a save that meets a proposal) call it.
 */

/** The owner's reactions on the Outfits tab (the agent's own moves are its tools', phase 3). */
export type OutfitReaction =
  | { event: 'love' }
  | { event: 'decline'; reason: OutfitDismissReason; note: string | null }
  | { event: 'reconsider' };

export type ReactOutcome =
  | {
      ok: true;
      from: LookReaction;
      to: LookReaction;
      /** Every piece owned: Love is "Save", the outfit the owner's now. */
      complete: boolean;
    }
  /** Not the owner's outfit, or no proposal: a 404 like an unknown id. */
  | { ok: false; reason: 'not-found' }
  /**
   * The owner's already (loved and complete: Saved, maybe planned since):
   * no reaction moves it back (a stale card), a 409.
   */
  | { ok: false; reason: 'owners' }
  /** The reaction does not take the move (a stale page, a double tap): a 409. */
  | { ok: false; reason: 'not-allowed'; reaction: LookReaction };

/**
 * Under the owner lock, the outfit locked, the machine asked
 * (lookReactionTransition), then one update: the reaction, the owner's
 * note as the move says (written with Not for me, cleared by Love and
 * Undo), the reason only while declined, and when (`reacted_at`, the
 * agent's "feedback since", phase 3). An outfit that is the owner's
 * already takes no move: a stale card's × must never set aside an outfit
 * they saved and planned.
 */
export function reactToOutfit(
  db: Queryable,
  ownerId: number,
  outfitId: number,
  change: OutfitReaction,
): Promise<ReactOutcome> {
  return ownerTransaction(db, ownerId, 'reactToOutfit', async (tx) => {
    // Parameters, never the column: this select names one table.
    const id = sql`${outfitId}::int`;
    const [row] = await tx
      .select({
        reaction: outfit.reaction,
        ownerNote: outfit.ownerNote,
        complete: outfitIsComplete(id),
        owners: ownersOutfit(id),
      })
      .from(outfit)
      .where(and(eq(outfit.id, outfitId), eq(outfit.ownerId, ownerId)))
      .for('update');
    if (!row?.reaction) return { ok: false, reason: 'not-found' };
    if (row.owners) return { ok: false, reason: 'owners' };
    const event: LookReactionEvent = change.event;
    const move = lookReactionTransition(row.reaction, event);
    if (!move.ok) {
      return { ok: false, reason: 'not-allowed', reaction: move.reaction };
    }
    const written = change.event === 'decline' ? change.note : null;
    await tx
      .update(outfit)
      .set({
        reaction: move.to,
        ownerNote: noteAfter(move.note, written, row.ownerNote),
        dismissedReason: change.event === 'decline' ? change.reason : null,
        reactedAt: sql`now()`,
      })
      .where(eq(outfit.id, outfitId));
    return { ok: true, from: move.from, to: move.to, complete: row.complete };
  });
}

/** The owner's note after a move: the one written, none, or the one it had. */
function noteAfter(
  effect: LookNoteEffect,
  written: string | null,
  current: string | null,
): string | null {
  switch (effect) {
    case 'write':
      return written;
    case 'clear':
      return null;
    case 'keep':
      return current;
  }
}

/**
 * A person's save (Styling, the outfit form, a pick of the gallery or
 * Today, create_outfit) of exactly the garments of one of the agent's proposals
 * not theirs yet: they made it theirs, so it is loved (Undone first when
 * it was set aside), through reactToOutfit. Complete, it is the owner's
 * and may be planned (outfitMayBeHeld). Called by reuseOutfit, under its
 * owner lock, only for a pending proposal (sameGarmentsOutfit's `pending`).
 * Answers whether it adopted it.
 */
export async function adoptProposal(
  tx: Queryable,
  ownerId: number,
  outfitId: number,
): Promise<boolean> {
  const loved = await reactToOutfit(tx, ownerId, outfitId, { event: 'love' });
  if (loved.ok || loved.reason !== 'not-allowed') return loved.ok;
  // Set aside: Undo first (the machine's only way back), then Love. Its
  // result needs no check: Love only refused a set-aside one, which Undo
  // takes, and the Love after it answers for both.
  await reactToOutfit(tx, ownerId, outfitId, { event: 'reconsider' });
  return (await reactToOutfit(tx, ownerId, outfitId, { event: 'love' })).ok;
}
