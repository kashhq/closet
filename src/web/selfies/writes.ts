import type { MultipartFile } from '@fastify/multipart';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import type { IsoDate } from '../../calendar-date';
import { calendarEntryNotFound } from '../calendar/entry-actions';
import { ownEntryDay } from '../calendar/queries';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { unkeyedPhoto } from '../files/image-variant';
import type { Photos } from '../files/photos';
import type { NewPhotoRow } from '../files/queries';
import { NotFound } from '../refusals';
import type { Actor } from '../sharing/access';
import { deleteSelfie, type SelfieOutcome, setEntrySelfie } from './queries';

/**
 * The selfie writes that involve photo bytes, which a transaction cannot
 * roll back (AGENTS.md Gotchas, the commit contract): Photos stores the
 * bytes and returns the row; setEntrySelfie inserts it with the selfie and
 * the entry's worn mark in one transaction; bytes of a refused or failed
 * write are deleted, and bytes a committed write replaced or removed are
 * unlinked after the commit.
 *
 * Selfies are private like the calendar (AGENTS.md): each write takes the
 * Actor and reaches only `actor.userId`'s own entries and selfies, so a
 * grantee of any share is a stranger here, refused with the 404 of an
 * unknown id, never a 403.
 */

export interface SelfieDeps {
  db: Db;
  photos: Photos;
  logger: Logger;
}

/** A selfie taken: whether it replaced the entry's last, and the entry's worn mark. */
export interface AttachedSelfie {
  selfieId: number;
  /** The entry's day. */
  day: IsoDate;
  replaced: boolean;
  worn: Exclude<SelfieOutcome, string>['worn'];
}

function notYetWorn(): HttpError {
  return new HttpError(409, t('refusal.day.plannedNotWorn'));
}

/**
 * POST /calendar/:id/selfie: the multipart `photo` becomes the owner's
 * entry's selfie and the entry is marked worn. The entry is looked up
 * before the body is read, so a refused upload stores nothing: another
 * user's entry is a 404 (ids reveal nothing), a day after today a 409
 * (it cannot be worn yet). HEIC and every other format go through Photos'
 * one pipeline; the selfie keeps its background (no cutout is queued).
 * Answers what it did: the page redirects to the entry's day, the API
 * (PUT /calendar-entries/{id}/selfie, whose `via` marks the log line)
 * answers it.
 */
export async function attachSelfie(
  { db, photos, logger }: SelfieDeps,
  actor: Actor,
  input: {
    entryId: number;
    parts: AsyncIterable<MultipartFile>;
    today: IsoDate;
    via?: string;
  },
): Promise<AttachedSelfie> {
  const { entryId, today } = input;
  const ownerId = actor.userId;
  const day = await ownEntryDay(db, entryId, ownerId);
  if (day === undefined) throw calendarEntryNotFound();
  if (day > today) throw notYetWorn();
  const photo = await photos.storeUploadParts(input.parts, ownerId);
  if (!photo) throw new HttpError(400, t('refusal.request.noFile'));
  const outcome = await commitSelfie({ db, photos, logger }, photo, () =>
    setEntrySelfie(db, { entryId, ownerId, photo, at: new Date(), today }),
  );
  const { selfieId, replaced, worn } = outcome;
  const wornNote = worn.changed
    ? `entry marked worn (${worn.wears} wears logged)`
    : 'entry already worn';
  logger.info(
    `Selfie ${selfieId} of calendar entry ${entryId} ${replaced ? 'replaced' : 'taken'} by user ${ownerId}${input.via ?? ''}: ${photo.fileName}; ${wornNote}`,
  );
  if (replaced) await photos.deleteVariants(unkeyedPhoto(replaced));
  return { selfieId, day: outcome.day, replaced: replaced !== null, worn };
}

/**
 * Runs the selfie's write for bytes already stored: if it throws (rolled
 * back) or refuses (the entry went, or its day is ahead, between the
 * look-up and the write), the new bytes go, since nothing points at them.
 */
async function commitSelfie(
  { photos, logger }: SelfieDeps,
  photo: NewPhotoRow,
  write: () => Promise<SelfieOutcome>,
): Promise<Exclude<SelfieOutcome, string>> {
  let outcome: SelfieOutcome;
  try {
    outcome = await write();
  } catch (error) {
    logger.warn(`Rolled back; removing orphaned selfie ${photo.fileName}`);
    await photos.deleteVariants(unkeyedPhoto(photo.fileName));
    throw error;
  }
  if (outcome === 'not-found' || outcome === 'future') {
    await photos.deleteVariants(unkeyedPhoto(photo.fileName));
    throw outcome === 'not-found' ? calendarEntryNotFound() : notYetWorn();
  }
  return outcome;
}

/**
 * POST /selfies/:id/delete: removes the actor's selfie (an entry's, or a
 * look kept after its outfit was deleted), row then bytes; anyone else's
 * is NotFound('selfie').
 */
export async function removeSelfie(
  { db, photos, logger }: SelfieDeps,
  actor: Actor,
  selfieId: number,
  via = '',
): Promise<void> {
  const fileName = await deleteSelfie(db, selfieId, actor.userId);
  if (fileName === undefined) {
    throw new NotFound('selfie', {
      logDetail: `selfie ${selfieId} is not user ${actor.userId}'s`,
    });
  }
  // Only after commit: an unlink cannot be rolled back.
  await photos.deleteVariants(unkeyedPhoto(fileName));
  logger.info(
    `Selfie ${selfieId} removed by user ${actor.userId}${via}: ${fileName}`,
  );
}
