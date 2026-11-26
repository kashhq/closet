import { garmentsGoneError } from '../outfits/gone-garments';
import { type ActionDeps, logOp } from '../op-log';
import type { Actor } from '../sharing/access';
import { type WoreIdea, wearIdea } from './queries';

/**
 * "Wear this" (the Today card's post, `POST /api/v1/outfit-wears`), one line
 * whichever door (#712): `idea.worn`, `changed` false when the entry was
 * worn already (a double tap or a retry). A garment not in the actor's
 * closet refuses the whole write (garmentsGoneError, a 404 or a 409 naming
 * the garments), nothing written.
 */
export async function wearIdeaOn(
  { db, logger }: ActionDeps,
  actor: Actor,
  input: Parameters<typeof wearIdea>[2],
): Promise<WoreIdea> {
  const outcome = await wearIdea(db, actor.userId, input);
  if (outcome === 'not-found') {
    throw await garmentsGoneError(db, actor.userId, input.garmentIds, 'closet');
  }
  logOp(logger, actor, 'idea.worn', {
    day: input.day,
    occasion: input.occasion,
    outfitId: outcome.outfit.id,
    alreadySaved: outcome.outfit.alreadySaved,
    garmentIds: [...input.garmentIds],
    entryId: outcome.entryId,
    changed: outcome.worn.changed,
    wears: outcome.worn.wears,
  });
  return outcome;
}
