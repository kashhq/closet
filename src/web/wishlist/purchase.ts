import { ownerTransaction } from '../auth/queries';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { logOp } from '../op-log';
import {
  type Actor,
  type AuthorizedWardrobe,
  type WardrobeNeed,
} from '../sharing/access';
import {
  type GarmentAddress,
  garmentNotFound,
  garmentWardrobe,
} from '../wardrobe/garment-access';
import { buyGarment, type Purchase } from '../wardrobe/status';
import type { WardrobeDeps } from '../wardrobe/writes';
import { decide } from './decisions';

/**
 * What "Bought it" needs of the wardrobe: a MANAGE share buys, and asking
 * for the replaced garment's archive too is the owner's alone (a grantee
 * asking is a 403 before anything is read or written). The route asks it
 * first, for its refused form; buyWishlistItem again.
 */
export function purchaseNeed(archiveReplaced: boolean): WardrobeNeed {
  return archiveReplaced ? 'own' : 'manage';
}

/**
 * "Bought it" (POST /wardrobe/:id/bought), in one owner transaction: the
 * buy (buyGarment: the wishlist item into the closet with its purchase,
 * and the garment it replaces archived when asked), then, for a Muse pick,
 * its need settled (decide's `bought`: resolved by it, its other open
 * picks set aside as chose_another, #333). The lock is the wardrobe
 * owner's, not necessarily the actor's: a MANAGE grantee buys too. An id
 * outside the wardrobe is a 404, an item no longer on the wishlist a 409.
 */
export async function buyWishlistItem(
  { db, logger }: Pick<WardrobeDeps, 'db' | 'logger'>,
  actor: Actor,
  address: GarmentAddress,
  purchase: Purchase & { archiveReplaced: boolean },
): Promise<AuthorizedWardrobe & { archivedReplaced: number | null }> {
  const wardrobe = await garmentWardrobe(
    db,
    actor,
    address,
    purchaseNeed(purchase.archiveReplaced),
  );
  const { ownerId } = wardrobe.access;
  const garmentId = address.id;
  // The owner lock before buyGarment's garment locks: decide needs it, and a
  // pick takes it before its garments, so the other order could deadlock.
  const outcome = await ownerTransaction(
    db,
    ownerId,
    'buyWishlistItem',
    async (tx) => {
      const bought = await buyGarment(tx, garmentId, ownerId, purchase);
      if (!bought.ok) return bought;
      // Not a suggestion: the writer finds no group and writes nothing.
      const settled = await decide(tx, ownerId, { kind: 'bought', garmentId });
      return { ...bought, settled };
    },
  );
  if (!outcome.ok) {
    if (outcome.reason === 'not-found') throw garmentNotFound();
    throw new HttpError(409, t('wishlist.NOT_ON_WISHLIST'), {
      logDetail: `garment ${garmentId} is ${outcome.status}`,
    });
  }
  const settled = outcome.settled.ok ? outcome.settled : undefined;
  logOp(logger, actor, 'garment.bought', {
    garmentId,
    ownerId,
    archivedReplaced: outcome.archivedReplaced,
    needId: settled?.groupId ?? null,
    setAside: settled?.dismissed ?? [],
  });
  return { ...wardrobe, archivedReplaced: outcome.archivedReplaced };
}
