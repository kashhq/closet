import type { MultipartFile } from '@fastify/multipart';
import { type CutoutRow, lockCutoutRow } from '../../cutout/queries';
import {
  type InitialCutoutColumns,
  initialCutoutState,
} from '../../cutout/state';
import type { Db, Queryable } from '../../db/client';
import { createOnce } from '../../db/create-once';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { parseStoredName, unkeyedPhoto } from '../files/image-variant';
import {
  draftsHeld,
  MAX_DRAFTS_PER_USER,
  MAX_PENDING_PER_USER,
  type PendingPhoto,
  type PendingScope,
  recordDraftBatch,
  recordPendingPhoto,
  takePendingPhoto,
} from '../files/pending-photos';
import type { Photos, QuarterTurn } from '../files/photos';
import {
  insertPhotoRow,
  lockOwnersAndPhotoName,
  type NewPhotoRow,
} from '../files/queries';
import type { Logger } from '../../logger';
import { type EntryStatus, statusOfClone } from '../../wardrobe/status';
import {
  type DeleteOutcome,
  deleteGarment,
  findGarment,
  type GarmentDetail,
  type GarmentPhoto,
  garmentIdByClientId,
  insertGarment,
  insertGarmentOnce,
  lockGarment,
  replacePhotoRow,
} from './queries';
import type { GarmentFields } from './garment-input';
import { garmentNotFound } from './garment-access';
import { BY_PERSON, type WriteOrigin } from '../write-origin';

/**
 * The garment writes that involve photo bytes, which a transaction cannot
 * roll back. The contract (AGENTS.md Gotchas, "Photo bytes are written
 * before any row"): Photos writes the bytes and returns the `file` row; the
 * row is inserted in the same transaction as the garment write that points
 * at it; if that transaction fails the new bytes are deleted, and bytes a
 * committed write replaced or orphaned are deleted after the commit.
 */

export interface WardrobeDeps {
  db: Db;
  photos: Photos;
  logger: Logger;
  /**
   * Told when a photo was queued (src/cutout/queue.ts); `enabled` is
   * CUTOUT_ENABLED, which decides whether a new photo is queued at all.
   */
  cutouts: { wake(): void; readonly enabled: boolean };
}

/**
 * The `request` event's outcome for a new upload: `pending` (queued), or
 * `none` with CUTOUT_ENABLED=false: the original with the mask editor's
 * pencil, and no row left pending for a queue that never runs.
 */
function requestedCutout(cutouts: WardrobeDeps['cutouts']): SwappedCutout {
  return cutouts.enabled ? 'pending' : 'none';
}

/**
 * Runs `write` in one transaction with `photo`'s row inserted first (its id
 * handed over); if it does not commit, the photo's bytes go too.
 */
async function commitWithPhoto<T>(
  { db, photos, logger }: WardrobeDeps,
  photo: NewPhotoRow & InitialCutoutColumns,
  write: (tx: Queryable, photoId: number) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(async (tx) =>
      write(tx, await insertPhotoRow(tx, photo)),
    );
  } catch (error) {
    logger.warn(`Rolled back; removing orphaned upload ${photo.fileName}`);
    await photos.deleteVariants(unkeyedPhoto(photo.fileName));
    throw error;
  }
}

/**
 * More rows a new garment's save writes in the garment's own transaction,
 * given its id: an order item marked added (#25), a Muse need settled by
 * "Bought a different one" (#333), a suggestion's provenance (#337), so
 * the garment never exists without what it was added for.
 */
export type WithGarment = (
  tx: Queryable,
  garmentId: number,
) => Promise<unknown>;

/**
 * A new garment in `ownerId`'s wardrobe, in the closet or on the wishlist
 * (the form has no photo; it comes next), with `withGarment`'s rows. The
 * insert alone is one statement: a transaction only when rows ride with
 * it (#161: begin and commit are two more round trips).
 */
export function createGarment(
  { db }: WardrobeDeps,
  ownerId: number,
  fields: GarmentFields,
  status: EntryStatus,
  madeBy: WriteOrigin,
  withGarment?: WithGarment,
): Promise<number> {
  if (!withGarment) {
    return insertGarment(db, ownerId, fields, null, status, madeBy);
  }
  return db.transaction(async (tx) => {
    const id = await insertGarment(tx, ownerId, fields, null, status, madeBy);
    await withGarment(tx, id);
    return id;
  });
}

/**
 * createGarment for a create that carries the client's own id (the API's,
 * #563): a retry finds the owner's row of that id and answers it
 * (`created: false`, nothing else written). A client id whose garment was
 * deleted since (createOnce's tombstone) is a 410: never created again. The id
 * is not compared with the row's content: a retry may follow the client's
 * own later edits, and the id names the create.
 *
 * `settle` resolves what rides with a new garment (a Muse need it was
 * bought for, postedDestination), and runs only after the insert has
 * proved the create new, in the insert's transaction holding the owner
 * lock, on that transaction (`tx`, never the pool: a second connection
 * would wait on a lock its own request holds): a retry of a create that settled its need answers the first row
 * instead of the need's refusal, and no concurrent first create can settle
 * the need between the check and the write. Its refusal rolls the garment
 * back.
 */
export async function createGarmentOnce(
  { db }: WardrobeDeps,
  ownerId: number,
  fields: GarmentFields,
  status: EntryStatus,
  clientId: string,
  settle?: (tx: Queryable) => Promise<WithGarment | undefined>,
): Promise<{ id: number; created: boolean }> {
  const write = async (tx: Queryable) => {
    const id = await insertGarmentOnce(tx, ownerId, fields, status, clientId);
    if (id === null) return undefined;
    const withGarment = await settle?.(tx);
    await withGarment?.(tx, id);
    return id;
  };
  const once = await createOnce(
    // A transaction only when rows ride with the insert, as createGarment.
    () => (settle ? db.transaction(write) : write(db)),
    async () => (await garmentIdByClientId(db, ownerId, clientId)) ?? undefined,
  );
  if (once === 'gone') throw new HttpError(410, t('GARMENT_DELETED'));
  return { id: once.row, created: once.created };
}

/**
 * Keeps `fileName`, just stored by this request, as `userId`'s pending
 * photo (src/web/files/pending-photos.ts): its row, which evicts their
 * oldest past MAX_PENDING_PER_USER, bytes included. The one way a pending
 * photo is kept, whichever source stored it (link import's fetch, the add
 * sheet's upload). The bytes are this request's own, so a failed row insert
 * deletes them.
 */
export async function keepPendingPhoto(
  { db, photos, logger }: Pick<WardrobeDeps, 'db' | 'photos' | 'logger'>,
  fileName: string,
  userId: number,
): Promise<void> {
  let evicted: string[];
  try {
    evicted = await recordPendingPhoto(db, fileName, userId);
  } catch (error) {
    await photos.deleteVariants(unkeyedPhoto(fileName));
    throw error;
  }
  for (const name of evicted) {
    await photos.deleteVariants(unkeyedPhoto(name));
  }
  if (evicted.length > 0) {
    logger.info(
      `User ${userId} is over ${MAX_PENDING_PER_USER} pending photos: evicted ${evicted.join(', ')}`,
    );
  }
}

/**
 * What an add-sheet upload kept (stagePhotoUploads): one pending photo, as
 * the camera and a one-photo library pick always kept (#97), or a batch of
 * drafts from a pick of several (#200), with the names of the photos it
 * left out because they could not be read.
 */
export type StagedPhotos =
  | { kind: 'single'; fileName: string }
  | { kind: 'batch'; first: string; count: number; leftOut: string[] };

/**
 * POST /wardrobe/new/photo (the add sheet's camera and library): every
 * multipart `photo`, stored in turn as storeUpload stores any garment
 * photo (awaited one at a time, so at most one HEIC is buffered). One
 * photo is kept as `userId`'s pending photo (keepPendingPhoto), and its
 * refusal is the request's, as before #200. Several are kept together as
 * a batch of drafts for `ownerId`'s wardrobe (recordDraftBatch): one that
 * cannot be read is left out and named, the others kept; the whole upload
 * is refused, keeping nothing, when none could be read or the drafts
 * would pass MAX_DRAFTS_PER_USER (the parser's `files` limit, set by the
 * route to the room left, stops it early; the batch's record checks again
 * under the user's lock).
 */
export async function stagePhotoUploads(
  deps: Pick<WardrobeDeps, 'db' | 'photos' | 'logger'>,
  parts: AsyncIterable<MultipartFile>,
  userId: number,
  ownerId: number,
): Promise<StagedPhotos> {
  const { logger } = deps;
  const { stored, refused } = await storeEachPhoto(deps, parts, userId);
  const picked = stored.length + refused.length;
  if (picked === 0) throw new HttpError(400, t('refusal.request.noFile'));
  if (picked === 1) {
    if (refused[0]) throw refused[0].error;
    const fileName = stored[0];
    await keepPendingPhoto(deps, fileName, userId);
    logger.info(
      `Photo ${fileName} uploaded by user ${userId}, pending its garment form`,
    );
    return { kind: 'single', fileName };
  }
  if (stored.length === 0) {
    logger.warn(
      `Upload by user ${userId}: none of ${picked} photos could be read`,
    );
    throw new HttpError(400, t('drafts.NONE_READ'));
  }
  const batchId = await keepDraftBatch(deps, stored, userId, ownerId);
  const leftOut = refused.map((photo) => photo.name);
  logger.info(
    `Batch ${batchId.slice(0, 8)} of ${stored.length} drafts uploaded by user ${userId} for wardrobe ${ownerId}${
      leftOut.length > 0 ? `; left out (unreadable): ${leftOut.join(', ')}` : ''
    }`,
  );
  return { kind: 'batch', first: stored[0], count: stored.length, leftOut };
}

/**
 * Every `photo` part stored in turn (other parts drained), the ones the
 * photo itself refuses set aside with their errors. Anything else (the
 * parser's `files` limit, storage failing) deletes what was stored and
 * throws: the limit as the drafts' refusal.
 */
async function storeEachPhoto(
  { db, photos, logger }: Pick<WardrobeDeps, 'db' | 'photos' | 'logger'>,
  parts: AsyncIterable<MultipartFile>,
  userId: number,
): Promise<{ stored: string[]; refused: { name: string; error: unknown }[] }> {
  const stored: string[] = [];
  const refused: { name: string; error: unknown }[] = [];
  try {
    for await (const part of parts) {
      if (part.fieldname !== 'photo') {
        part.file.resume();
        continue;
      }
      const result = await photos.storeUpload(part, userId).then(
        (row) => ({ ok: true as const, fileName: row.fileName }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (result.ok) {
        stored.push(result.fileName);
        continue;
      }
      if (!refusesThePhoto(result.error)) throw result.error;
      // What the decode left unread, so the next part can arrive.
      part.file.resume();
      refused.push({ name: part.filename, error: result.error });
    }
  } catch (error) {
    await deleteStoredPhotos(photos, stored);
    if (!isFilesLimit(error)) throw error;
    const held = await draftsHeld(db, userId);
    logger.warn(
      `Upload by user ${userId} refused: past ${MAX_DRAFTS_PER_USER} drafts (${held} held)`,
    );
    throw draftsFull(held);
  }
  return { stored, refused };
}

/**
 * `stored` (this request's bytes) kept as one batch of drafts; its id. A
 * batch the user has no room for deletes the bytes and is refused (409).
 */
async function keepDraftBatch(
  { db, photos, logger }: Pick<WardrobeDeps, 'db' | 'photos' | 'logger'>,
  stored: string[],
  userId: number,
  ownerId: number,
): Promise<string> {
  const recorded = await recordDraftBatch(db, stored, userId, ownerId).catch(
    async (error: unknown) => {
      await deleteStoredPhotos(photos, stored);
      throw error;
    },
  );
  if ('batchId' in recorded) return recorded.batchId;
  await deleteStoredPhotos(photos, stored);
  logger.warn(
    `Batch of ${stored.length} by user ${userId} refused: past ${MAX_DRAFTS_PER_USER} drafts (${recorded.refused.held} held)`,
  );
  throw draftsFull(recorded.refused.held);
}

async function deleteStoredPhotos(
  photos: Photos,
  names: readonly string[],
): Promise<void> {
  for (const name of names) await photos.deleteVariants(unkeyedPhoto(name));
}

/** A photo's own refusal (not an image, too large): the sender's, a 4xx. */
function refusesThePhoto(error: unknown): boolean {
  const { statusCode } = error as { statusCode?: unknown };
  return (
    typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
  );
}

/** @fastify/multipart's refusal past the request's `files` limit. */
function isFilesLimit(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'FST_FILES_LIMIT';
}

function draftsFull(held: number): HttpError {
  return new HttpError(
    409,
    t('drafts.FULL', { held, max: MAX_DRAFTS_PER_USER }),
  );
}

/** A garment saved with the pending photo it claimed, and the draft that photo was (#200). */
export interface ClaimedGarment {
  id: number;
  /** The draft's batch and the drafts still waiting after it; undefined for a single photo. */
  draft: PendingPhoto['draft'];
}

/**
 * A new garment whose photo was stored before its form was saved: a
 * pending photo (keepPendingPhoto), fetched from a link or uploaded from
 * the add sheet. The form carries the name as its hidden `linkPhoto` (the
 * field's name since link import; cached forms still post it). Here, in
 * one transaction, the pending row goes, the `file` row is inserted (queued
 * for its cutout) and the garment with it, so nothing reaches `garment` or
 * `file` until the form is saved.
 *
 * Undefined when `userId` cannot claim the name for `ownerId`'s wardrobe:
 * no pending row of theirs in that scope (someone else's, a draft uploaded
 * for another wardrobe, or claimed, discarded, evicted or reconciled already),
 * its bytes gone, or already a `file` row. Nothing is written then, and no
 * bytes are ever deleted here: the name came from the client.
 */
export async function createGarmentWithPendingPhoto(
  { db, photos, logger, cutouts }: WardrobeDeps,
  ownerId: number,
  userId: number,
  fields: GarmentFields,
  fileName: string,
  status: EntryStatus,
  madeBy: WriteOrigin,
  withGarment?: WithGarment,
): Promise<ClaimedGarment | undefined> {
  // The wardrobe's owner owns the row, whoever saves (as replacePhoto).
  // Its bytes are checked before the transaction: storage I/O never runs
  // under the name's lock (#141). Checked early is still true at the
  // insert: a pending photo's bytes are deleted only by whoever took its
  // pending row first (a discard, an eviction, reconciliation, account
  // deletion), and then takePendingPhoto below finds none.
  const photo = await photos.pendingPhotoRow(fileName, ownerId);
  const claimed =
    photo &&
    (await db.transaction(async (tx): Promise<ClaimedGarment | undefined> => {
      // Both accounts first, in id order (lockOwnersAndPhotoName says
      // why): the wardrobe's owner, whose garment and file row this
      // writes, and the uploader, whose pending row it takes (a MANAGE
      // grantee's, #544). Then the take.
      if (!(await lockOwnersAndPhotoName(tx, [ownerId, userId], fileName))) {
        return undefined;
      }
      const taken = await takePendingPhoto(tx, fileName, { userId, ownerId });
      if (!taken) return undefined;
      const photoId = await insertPhotoRow(tx, {
        ...photo,
        ...initialCutoutState(requestedCutout(cutouts)),
      });
      const id = await insertGarment(
        tx,
        ownerId,
        fields,
        photoId,
        status,
        madeBy,
      );
      await withGarment?.(tx, id);
      return { id, draft: taken.draft };
    }));
  if (!claimed) {
    logger.warn(
      `Pending photo ${fileName} could not be claimed by user ${userId}`,
    );
    return undefined;
  }
  logger.info(
    cutouts.enabled
      ? `Garment ${claimed.id} photo ${fileName} (a pending photo) queued for background removal`
      : `Garment ${claimed.id} photo ${fileName} (a pending photo) kept as taken: background removal is off`,
  );
  if (cutouts.enabled) cutouts.wake();
  return claimed;
}

/**
 * Deletes a pending photo the form no longer shows (link import: another
 * photo was picked, or none; a draft's Discard, #200, `draftsOnly`) and
 * answers what it was (a draft with the drafts still waiting). Undefined,
 * deleting nothing, unless it is still pending in `scope` (takePendingPhoto:
 * the user's own, a draft only from its batch's wardrobe) with no `file`
 * row: only a photo of theirs that no garment was saved with goes. Under
 * the name's lock, so a save claiming it at the same moment either wins
 * (nothing is deleted) or finds it gone. The owner locked is the
 * uploader's, whose account deletion deletes the row (lockOwnersAndPhotoName).
 * The bytes go after the commit.
 */
export async function discardPendingPhoto(
  { db, photos, logger }: WardrobeDeps,
  fileName: string,
  scope: PendingScope,
  options: { draftsOnly?: boolean } = {},
): Promise<PendingPhoto | undefined> {
  if (parseStoredName(fileName)?.variant !== 'original') return undefined;
  const discarded = await db.transaction(async (tx) =>
    (await lockOwnersAndPhotoName(tx, [scope.userId], fileName))
      ? takePendingPhoto(tx, fileName, scope, options)
      : undefined,
  );
  if (!discarded) {
    logger.warn(
      `Pending photo ${fileName} not discarded: not pending for user ${scope.userId} in wardrobe ${scope.ownerId}`,
    );
    return undefined;
  }
  await photos.deleteVariants(unkeyedPhoto(fileName));
  logger.info(`Discarded pending photo ${fileName} of user ${scope.userId}`);
  return discarded;
}

/**
 * A copy of `source` in the requester's own wardrobe with the posted fields
 * and its own copy of the photo set (bytes and row), owned by the requester.
 * The copy's cutout starts where the source's is (the bytes are the same);
 * a pending one is queued in its own right. A copy of a wishlist item lands
 * on the requester's wishlist, anything else in their closet (statusOfClone).
 */
export async function cloneGarment(
  deps: WardrobeDeps,
  source: GarmentDetail,
  requesterId: number,
  fields: GarmentFields,
): Promise<number> {
  // copy() is undefined when the source's bytes are gone: a clone without a photo.
  const photo = source.photo
    ? await deps.photos.copy(source.photo, requesterId)
    : undefined;
  const entry = statusOfClone(source.status);
  if (!photo || !source.photo) {
    return insertGarment(deps.db, requesterId, fields, null, entry, BY_PERSON);
  }
  const cutout = source.photo.cutoutStatus;
  const id = await commitWithPhoto(
    deps,
    { ...photo, ...initialCutoutState(cutout) },
    (tx, photoId) =>
      insertGarment(tx, requesterId, fields, photoId, entry, BY_PERSON),
  );
  if (cutout === 'pending') deps.cutouts.wake();
  return id;
}

/**
 * POST /wardrobe/:id/photo: stores the multipart photo, queues its cutout,
 * points the garment at it and removes the photo it replaces (swapPhoto).
 * The new `file` row belongs to the wardrobe's owner, whoever uploads
 * (their account deletion takes it). A 404 when the garment left the
 * wardrobe meanwhile, a 400 without a photo.
 */
export async function replacePhoto(
  deps: WardrobeDeps,
  id: number,
  ownerId: number,
  parts: AsyncIterable<MultipartFile>,
): Promise<SwappedCutout> {
  const photo = await deps.photos.storeUploadParts(parts, ownerId);
  if (!photo) throw new HttpError(400, t('refusal.request.noFile'));
  // The `request` event: every new photo is queued for its cutout.
  return swapPhoto(deps, id, ownerId, photo, requestedCutout(deps.cutouts));
}

/** The rotate buttons' directions, as clockwise degrees. */
const ROTATIONS = {
  left: 270,
  right: 90,
} as const satisfies Record<string, QuarterTurn>;
export type RotateDirection = keyof typeof ROTATIONS;

/**
 * Whether a turned copy made from `source` may still replace the photo,
 * whose row is now `current` (the same file: the caller checks that). The
 * copy is the original's bytes, plus the mask when `maskKept`, so only a
 * mask it would drop refuses it: with the mask, any new version (a second
 * mask saved); without, a mask saved since. A job's result or a retry is
 * not: the rotate queues the turned photo's own cutout (#248, where a
 * double tap during a pending cutout was a 409 error page). An unchanged
 * version always is, even `edited` with the mask's file gone (rotateStored
 * then turns the photo alone).
 */
function rotateStillValid(
  source: Pick<GarmentPhoto, 'version'>,
  current: Pick<CutoutRow, 'status' | 'version'>,
  maskKept: boolean,
): boolean {
  if (current.version === source.version) return true;
  return !maskKept && current.status !== 'edited';
}

/**
 * POST /wardrobe/:id/photo/rotate: the garment's photo turned a quarter as
 * a new photo (Photos.rotateStored; the original is never modified) that
 * replaces it as an upload does (swapPhoto). An edited cutout (a mask)
 * turns with it and stays edited; any other is queued again for the
 * turned photo, as a new upload's is. A 409 when the turned copy would lose
 * something that landed after the photo was read (rotateStillValid): the
 * turned copy is deleted and nothing else is written, so two quick taps
 * never turn a stale photo over a newer one and no saved mask is lost. A
 * cutout job finishing meanwhile is no reason (#248): the rotate requeues
 * the cutout anyway.
 */
export async function rotateGarmentPhoto(
  deps: WardrobeDeps,
  id: number,
  ownerId: number,
  source: GarmentPhoto,
  direction: RotateDirection,
): Promise<SwappedCutout> {
  const photoChanged = () => {
    deps.logger.info(
      `Garment ${id} rotate refused: photo ${source.fileName} changed while it was turned`,
    );
    return new HttpError(409, t('refusal.garment.photoChanged'));
  };
  // With removal off a turned photo is never re-cut, so a cutout the server
  // (or the browser) made turns along with it instead of being dropped.
  const keepMask =
    source.cutoutStatus === 'edited' ||
    (!deps.cutouts.enabled &&
      (source.cutoutStatus === 'ready' || source.cutoutStatus === 'none'));
  const { row, cutoutKept } = await deps.photos
    .rotateStored(source.fileName, ROTATIONS[direction], ownerId, keepMask)
    .catch(async (error: unknown) => {
      // The other tap's swap unlinked the original before this one opened
      // it: its turn landed, this one is stale. A 404 otherwise.
      if (
        error instanceof HttpError &&
        error.statusCode === 404 &&
        (await findGarment(deps.db, id, ownerId))?.photo?.fileName !==
          source.fileName
      ) {
        throw photoChanged();
      }
      throw error;
    });
  const cutout = await swapPhoto(
    deps,
    id,
    ownerId,
    row,
    cutoutKept ? 'edited' : requestedCutout(deps.cutouts),
    async (tx, currentPhotoId) => {
      // After the garment's lock, as every garment write takes them.
      const current = await lockCutoutRow(tx, source.fileName);
      if (
        current?.id !== currentPhotoId ||
        !rotateStillValid(source, current, cutoutKept)
      ) {
        throw photoChanged();
      }
    },
  );
  deps.logger.info(
    `Garment ${id} photo rotated ${direction} by user ${ownerId}${cutoutKept ? ', its edited cutout with it' : ''}`,
  );
  return cutout;
}

/**
 * The cutout state a swapped-in photo starts in: queued (`pending`), a
 * mask turned with it (`edited`), or `none` with background removal off.
 * What the API's photo writes answer.
 */
export type SwappedCutout = 'pending' | 'edited' | 'none';

/**
 * The one way a garment's photo is replaced (an upload, a rotate): the new
 * photo's row inserted with `cutout` as its initial state, the garment
 * locked and pointed at it and the old photo's row deleted, in one
 * transaction; then the queue woken for a pending cutout and the old
 * photo's bytes unlinked after the commit. `check` runs under the
 * garment's lock with its current photo id and refuses by throwing: the
 * new bytes go then, as on any rollback (commitWithPhoto).
 */
async function swapPhoto(
  deps: WardrobeDeps,
  id: number,
  ownerId: number,
  photo: NewPhotoRow,
  cutout: SwappedCutout,
  check?: (tx: Queryable, currentPhotoId: number | null) => Promise<void>,
): Promise<SwappedCutout> {
  const replaced = await commitWithPhoto(
    deps,
    { ...photo, ...initialCutoutState(cutout) },
    async (tx, photoId) => {
      const locked = await lockGarment(tx, id, ownerId);
      if (!locked) throw garmentNotFound();
      await check?.(tx, locked.photoId);
      return replacePhotoRow(tx, id, photoId, locked.photoId);
    },
  );
  if (cutout === 'pending') {
    deps.logger.info(
      `Garment ${id} photo ${photo.fileName} queued for background removal`,
    );
    deps.cutouts.wake();
  } else if (cutout === 'none') {
    deps.logger.info(
      `Garment ${id} photo ${photo.fileName} kept as taken: background removal is off`,
    );
  }
  if (replaced) {
    await deps.photos.deleteVariants(replaced);
    deps.logger.info(
      `Garment ${id} photo replaced: ${replaced.fileName} -> ${photo.fileName}`,
    );
  } else {
    deps.logger.info(`Garment ${id} photo added: ${photo.fileName}`);
  }
  return cutout;
}

/**
 * Deletes the garment and its photo's row, then the photo's bytes; what
 * deleteGarment answered (a suggestion is refused, never deleted).
 */
export async function removeGarment(
  deps: WardrobeDeps,
  id: number,
  ownerId: number,
): Promise<DeleteOutcome> {
  const deleted = await deleteGarment(deps.db, id, ownerId);
  // Only after commit: an unlink cannot be rolled back.
  if (deleted.ok && deleted.photo) {
    await deps.photos.deleteVariants(deleted.photo);
  }
  return deleted;
}
