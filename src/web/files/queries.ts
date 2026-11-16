import { count, eq, type SQL, sql } from 'drizzle-orm';
import { CUTOUT_QUEUED_NOTIFY } from '../../cutout/queries';
import {
  type CutoutStatus,
  type InitialCutoutColumns,
  showsCutout,
} from '../../cutout/state';
import type { Db, Queryable } from '../../db/client';
import { ownersLockCte } from '../../db/owner-lock';
import { file, garment, install, outfit, outfitSlot } from '../../db/schema';
import { currentRequest } from '../../request-context';
import { unkeyedPhoto } from './image-variant';
import type {
  PhotoRefFields,
  PlinthPhoto,
  SignablePhotoRef,
} from './image-url';

/*
 * The photo-ref helpers: the only makers of a SignablePhotoRef, the one
 * type imageUrl signs (#162). Each reads a garment's `file` row (a wardrobe,
 * wishlist or outfit photo) or names a pending photo; an outfit selfie's
 * queries (src/web/selfies) never import them (photo-ref-guard.spec.ts).
 * A signed URL is served without asking the database whether the name is a
 * selfie's, so a new caller that could pass a selfie's row here would serve
 * it to anyone holding the URL.
 */

/**
 * Whether a left-joined `file` row is a photo to show: there is one, and
 * its original or its cutout is in storage (`original_missing_since` unset,
 * #653, #917: a thumb alone is no photo for the garment and share pages).
 * Every helper below answers no photo otherwise, so each page draws the
 * placeholder it draws for a garment without one, never a broken image.
 * Reads only: a write finds its photo by the garment's `photo_id`
 * (STORED_PHOTO_COLUMNS), never through these, so a marked photo is still
 * replaced and deleted with its bytes.
 */
const photoShown = sql`(${file.id} is not null and ${file.originalMissingSince} is null)`;

/**
 * The row's name while photoShown, else null: the first photo field of a
 * positional JSON tuple (the gallery's and Styling's), whose decoders read
 * a null name as no photo. Never `file.fileName` there
 * (photo-ref-guard.spec.ts).
 */
export const shownPhotoName = sql<
  string | null
>`case when ${photoShown} then ${file.fileName} end`;

/**
 * A left-joined `file` row as imageUrl's photo, selected as the row's
 * `photo` or built into a json_agg/json_build_object: the name, the
 * version and the variant key its URL signs; null when the join found no
 * row (a garment without a photo) or nothing of it is stored (photoShown).
 */
export const photoRefJson = sql<SignablePhotoRef | null>`case when not ${photoShown} then null else json_build_object('fileName', ${file.fileName}, 'version', ${file.version}, 'variantKey', ${file.variantKey}) end`;

/** A garment's photo with its cutout state (its page, the export). */
export type PhotoWithCutout = SignablePhotoRef & {
  version: number;
  cutoutStatus: CutoutStatus;
};

/** photoRefJson with the cutout state. */
export const photoWithCutoutJson = sql<PhotoWithCutout | null>`case when not ${photoShown} then null else json_build_object('fileName', ${file.fileName}, 'version', ${file.version}, 'variantKey', ${file.variantKey}, 'cutoutStatus', ${file.cutoutStatus}) end`;

/**
 * The decoder for a garment photo read some other way: a relational
 * query's `with: { photo: PHOTO_REF_RELATION }` (null when nothing of it
 * is stored: its `originalMissingSince`), a JSON array's fields (their
 * name read through shownPhotoName). Its extra fields (a share id) ride
 * along.
 */
export function readPhotoRef<T extends PhotoRefFields>(
  photo: T,
): T & SignablePhotoRef;
export function readPhotoRef<T extends PhotoRefFields>(
  photo: T | null,
): (T & SignablePhotoRef) | null;
export function readPhotoRef<T extends PhotoRefFields>(
  photo: T | null,
): (T & SignablePhotoRef) | null {
  if (!photo || isMissing(photo)) return null;
  return photo as T & SignablePhotoRef;
}

/** A relational query's garment `photo` columns, for readPhotoRef. */
export const PHOTO_REF_RELATION = {
  columns: {
    fileName: true,
    version: true,
    variantKey: true,
    originalMissingSince: true,
  },
} as const;

// A photo read with its `original_missing_since` that has one (#653).
function isMissing(photo: object): boolean {
  return 'originalMissingSince' in photo && photo.originalMissingSince != null;
}

/** A pending photo's thumb, shown to the user who stored it (no row yet). */
export function pendingPhotoRef(fileName: string): SignablePhotoRef {
  return unkeyedPhoto(fileName) as SignablePhotoRef;
}

/**
 * A left-joined `file` row's columns for a photo the plinth draws (the
 * wardrobe grid's tiles, the capsule strips): select them as the row's
 * `photo`, then map it through plinthPhoto.
 */
export const PLINTH_PHOTO_COLUMNS = {
  fileName: file.fileName,
  version: file.version,
  variantKey: file.variantKey,
  cutoutStatus: file.cutoutStatus,
  originalMissingSince: file.originalMissingSince,
};

/**
 * PLINTH_PHOTO_COLUMNS as a JSON object inside a json_agg (the capsule
 * list's strips), for plinthPhoto; null when the join found no `file` row.
 * Every field plinthPhoto reads is here: a JSON missing the variant key
 * would sign `k=undefined`.
 */
export const plinthPhotoJson = sql<
  Parameters<typeof plinthPhoto>[0]
>`case when not ${photoShown} then null else json_build_object('fileName', ${file.fileName}, 'version', ${file.version}, 'variantKey', ${file.variantKey}, 'cutoutStatus', ${file.cutoutStatus}) end`;

/** The plinth's photo, or null (no photo, or nothing of it stored). */
export function plinthPhoto(
  photo: {
    fileName: string;
    version: number;
    variantKey: string | null;
    cutoutStatus: CutoutStatus;
    originalMissingSince?: Date | null;
  } | null,
): PlinthPhoto | null {
  if (!photo || photo.originalMissingSince) return null;
  const { fileName, version, variantKey, cutoutStatus } = photo;
  return {
    ...({ fileName, version, variantKey } as SignablePhotoRef),
    cutout: showsCutout(cutoutStatus),
  };
}

/**
 * A `file` row's StoredPhoto (image-variant.ts): what serving or deleting
 * its bytes needs. Every query that hands a photo to Photos.getVariant,
 * copy or deleteVariants selects these.
 */
export const STORED_PHOTO_COLUMNS = {
  fileName: file.fileName,
  variantKey: file.variantKey,
};

/** The row's variant key; undefined when no row has that name. */
export async function findVariantKey(
  q: Queryable,
  fileName: string,
): Promise<string | null | undefined> {
  const [row] = await q
    .select({ variantKey: file.variantKey })
    .from(file)
    .where(eq(file.fileName, fileName));
  return row?.variantKey;
}

/**
 * A photo's `file` row as Photos returns it after writing the bytes, not yet
 * inserted: the caller commits it in the transaction that also points a
 * garment at it (insertPhotoRow with its tx), and calls deleteVariants if
 * that transaction fails. Version starts at the column default, 1.
 */
export interface NewPhotoRow {
  fileName: string;
  shareableId: string;
  /** ISO timestamp as text, as the column has always held it. */
  createdOn: string;
  createdById: number;
}

/**
 * Inserts the row inside the caller's transaction; returns its id. The
 * cutout columns (initialCutoutState) default to `none`; a pending row
 * notifies the cutout queues on commit, whichever process inserts it.
 */
export async function insertPhotoRow(
  q: Queryable,
  row: NewPhotoRow & Partial<InitialCutoutColumns>,
): Promise<number> {
  const [inserted] = await q
    .insert(file)
    .values({
      ...row,
      // A pending row is queued by whoever inserts it (the job's parent).
      ...(row.cutoutStatus === 'pending' && {
        cutoutRequestId: currentRequest()?.requestId ?? null,
      }),
    })
    .returning({
      id: file.id,
      ...(row.cutoutStatus === 'pending' && { notified: CUTOUT_QUEUED_NOTIFY }),
    });
  return inserted.id;
}

/**
 * The name's lock: serializes every transaction that decides the fate of a
 * stored name that may have no row yet (a pending photo: claimed by a
 * garment's or a look's save, or discarded). A row cannot be locked before
 * it exists, so the name itself is: a transaction-scoped advisory lock,
 * released at commit or rollback. Taken only behind an owner lock
 * (lockOwnersAndPhotoName).
 */
function photoNameLock(fileName: string): SQL<void> {
  return sql<void>`pg_advisory_xact_lock(hashtext(${`closet:photo:${fileName}`}))`;
}

/**
 * The name's lock (photoNameLock) behind the owner locks of `accountIds`
 * in the same statement (ownersLockCte, src/db/owner-lock.ts): every
 * account whose rows the transaction writes, in id order, then the name,
 * before a claim or a discard takes the pending row. The accounts are the
 * pending row's (its uploader: their account deletion deletes it) and,
 * for a save, the wardrobe's owner (the garment and its `file` row): a
 * MANAGE grantee's save names both (#544). The one way to lock a name, so
 * every taker orders itself against each account's deletion: a taker that
 * held the row and then waited on an account would deadlock with it, and
 * one that never waited would race it (src/db/AGENTS.md). False unless
 * every account was locked: one is gone, and their pending rows or their
 * wardrobe with them. Callers: createGarmentWithPendingPhoto and
 * discardPendingPhoto (src/web/wardrobe/writes.ts),
 * saveInspirationWithPendingPhoto (src/web/inspiration/queries.ts).
 */
export async function lockOwnersAndPhotoName(
  tx: Queryable,
  accountIds: readonly number[],
  fileName: string,
): Promise<boolean> {
  const accounts = [...new Set(accountIds)];
  const lock = ownersLockCte(tx, accounts);
  // One row: the aggregate reads (locks) every owner, then its select
  // list takes the name, once.
  const [locked] = await tx
    .with(lock)
    .select({ owners: count(), name: photoNameLock(fileName) })
    .from(lock);
  return locked.owners === accounts.length;
}

/**
 * Every `file` row's stored name: claimStorage's proof, on an unmarked
 * boot only, that a directory holds this database's photos (a household's
 * few hundred names).
 */
export async function photoRowNames(q: Queryable): Promise<string[]> {
  const rows = await q.select({ fileName: file.fileName }).from(file);
  return rows.map((row) => row.fileName);
}

/** The install id this database is paired with (#833), or undefined before the first claim. */
export async function pairedInstallId(
  q: Queryable,
): Promise<string | undefined> {
  const [row] = await q.select({ installId: install.installId }).from(install);
  return row?.installId;
}

/**
 * Pairs the database with an install id, once, and answers the id it is
 * paired with now: a row already there (another process's claim racing
 * this one) is kept, and its id is the answer.
 */
export async function pairInstallOnce(
  q: Queryable,
  installId: string,
): Promise<string> {
  await q.insert(install).values({ installId }).onConflictDoNothing();
  const paired = await pairedInstallId(q);
  // Only a delete between the two statements; nothing deletes the row.
  if (paired === undefined) throw new Error('The install row vanished');
  return paired;
}

/** Re-pairs the database with the marker an operator vouched for (repairStorageIdentity). */
export async function repairInstallId(
  q: Queryable,
  installId: string,
): Promise<void> {
  await q
    .insert(install)
    .values({ installId })
    .onConflictDoUpdate({
      target: install.singleton,
      set: { installId, pairedAt: sql`now()` },
    });
}

export async function photoRowExists(
  q: Queryable,
  fileName: string,
): Promise<boolean> {
  const [row] = await q
    .select({ id: file.id })
    .from(file)
    .where(eq(file.fileName, fileName))
    .limit(1);
  return row !== undefined;
}

/**
 * The stored name behind a share link's image (the watermark route), by
 * the shared item's own share id (#669), so Stop sharing ends the image
 * with the page and a new Share never revives an old URL: a shared
 * garment's photo first, else a shared outfit's first garment, in slot
 * order, with a photo, which is findSharedOutfit's preview rule
 * (src/web/share/queries.ts; change the two together). Photos come only
 * through garment.photo_id: an outfit selfie (#19) is never public.
 */
export async function findPhotoByShareableId(
  db: Db,
  shareableId: string,
): Promise<string | undefined> {
  const shown = sql`${file.originalMissingSince} is null`;
  const { rows } = await db.execute<{ fileName: string }>(sql`
    (select ${file.fileName} as "fileName", 0 as "kind", 0 as "slot"
      from ${file} join ${garment} on ${garment.photoId} = ${file.id}
      where ${garment.shareableId} = ${shareableId} and ${shown})
    union all
    (select ${file.fileName}, 1, ${outfitSlot.position}
      from ${outfit}
      join ${outfitSlot} on ${outfitSlot.outfitId} = ${outfit.id}
      join ${garment} on ${garment.id} = ${outfitSlot.garmentId}
      join ${file} on ${file.id} = ${garment.photoId}
      where ${outfit.shareableId} = ${shareableId} and ${shown})
    order by "kind", "slot"
    limit 1`);
  return rows[0]?.fileName;
}
