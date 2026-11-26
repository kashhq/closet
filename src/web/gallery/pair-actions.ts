import { type ActionDeps, logOp } from '../op-log';
import type { Actor } from '../sharing/access';
import { garmentNotFound } from '../wardrobe/garment-access';
import { allowPair, avoidPair } from './queries';

/**
 * "Clashes": the actor's two garments are never generated together again
 * (the gallery's card). Idempotent: a pair avoided already is
 * `changed: false`. A garment that is not the actor's, or the same one
 * twice, is the garment's 404.
 */
export async function avoidGarmentPair(
  { db, logger }: ActionDeps,
  actor: Actor,
  garmentId: number,
  otherId: number,
): Promise<{ changed: boolean }> {
  const outcome = await avoidPair(db, actor.userId, garmentId, otherId);
  if (outcome === 'not-found') throw garmentNotFound();
  const changed = outcome === 'added';
  logOp(logger, actor, 'garment.pair.avoided', {
    garmentId,
    otherId,
    changed,
  });
  return { changed };
}

/** "Allow again", the undo of avoidGarmentPair: a pair never avoided is allowPair's 404. */
export async function allowGarmentPair(
  { db, logger }: ActionDeps,
  actor: Actor,
  garmentId: number,
  otherId: number,
): Promise<void> {
  await allowPair(db, actor, garmentId, otherId);
  logOp(logger, actor, 'garment.pair.allowed', { garmentId, otherId });
}
