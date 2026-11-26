import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import type { Photos } from '../files/photos';
import { deleteUserAndFileRows } from './queries';

/**
 * Deletes a user: their rows in one transaction (the cascade takes their
 * garments, outfits, calendar entries and shares), then their photos'
 * (pending link imports' included)
 * bytes, which no transaction holds (AGENTS.md Gotchas, "The DB cascade
 * deletes rows, never bytes"). POST /auth/delete-account and the seed's
 * `--remove` (src/seed/seed.ts) come through here. Returns how many photos
 * went.
 */
export async function deleteAccount(
  { db, photos, logger }: { db: Db; photos: Photos; logger: Logger },
  userId: number,
): Promise<number> {
  const stored = await deleteUserAndFileRows(db, userId);
  // After commit: an unlink cannot be rolled back. deleteVariants logs a
  // failure instead of throwing; the nightly reconciliation removes what is
  // left, and the account is gone either way.
  for (const photo of stored) await photos.deleteVariants(photo);
  logger.info(`Deleted user ${userId} and ${stored.length} of their photos`);
  return stored.length;
}
