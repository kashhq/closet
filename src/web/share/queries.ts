import { randomUUID } from 'node:crypto';
import { asc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import { OWNER_LOCKED, ownerLockSql } from '../../db/owner-lock';
import { garment, outfit, outfitSlot } from '../../db/schema';
import { PHOTO_REF_RELATION, readPhotoRef } from '../files/queries';

/**
 * The public share page's reads: a garment or an outfit by its share id,
 * whoever asks (a share link is a bearer link), with its owner's first name.
 * Never the email: the page is public and link-preview crawlers keep what
 * they read. A row is found only while it is shared (#669): its
 * shareable_id is null otherwise. The watermarked Open Graph image is
 * addressed by the item's own share id too (/file/watermark/:shareableId,
 * findPhotoByShareableId in src/web/files/queries.ts, which repeats
 * findSharedOutfit's preview rule), never by a photo's.
 */

const OWNER_COLUMNS = { columns: { firstName: true } } as const;

const PHOTO_COLUMNS = PHOTO_REF_RELATION;

/** What a public share link addresses, and the table holding its id. */
const SHAREABLE = { garment, outfit } as const;
export type ShareableKind = keyof typeof SHAREABLE;

/** The link's id after a Share (`true`: always one) or a Stop (`false`: none). */
export type ShareableIdAfter<Shared extends boolean> = Shared extends true
  ? string
  : null;

/**
 * The one writer of a garment's or outfit's public link (#669): Share
 * (`shared`) mints its id, Stop sharing nulls it, after which /share and
 * the watermark answer 404 for it. Answers the id after the write, or
 * undefined when `ownerId` has no such row (the caller's 404).
 *
 * Share and Stop serialise under the owner's lock, taken in the same
 * UPDATE ... RETURNING: Share keeps an id already there (`coalesce`, which
 * a second tap waiting on the first re-reads against the row it committed),
 * so two taps racing answer one id, and only a Share after a Stop mints a
 * new one; an old link never comes back.
 */
export async function setPublicShare<Shared extends boolean>(
  db: Queryable,
  kind: ShareableKind,
  id: number,
  ownerId: number,
  shared: Shared,
): Promise<{ shareableId: ShareableIdAfter<Shared> } | undefined> {
  const table = SHAREABLE[kind];
  const value = shared
    ? sql`coalesce(${table.shareableId}, ${randomUUID()}::varchar)`
    : sql`null`;
  const { rows } = await db.execute<{
    shareableId: ShareableIdAfter<Shared>;
  }>(sql`
    with ${ownerLockSql(db, ownerId)}
    update ${table} set ${sql.identifier(table.shareableId.name)} = ${value}
    where ${table.id} = ${id} and ${table.ownerId} = ${ownerId} and ${OWNER_LOCKED}
    returning ${table.shareableId} as "shareableId"`);
  return rows[0];
}

export async function findSharedGarment(db: Db, shareableId: string) {
  const row = await db.query.garment.findFirst({
    columns: { name: true, category: true, brand: true },
    where: eq(garment.shareableId, shareableId),
    with: { owner: OWNER_COLUMNS, photo: PHOTO_COLUMNS },
  });
  return row && { ...row, photo: readPhotoRef(row.photo) };
}

export type SharedGarment = NonNullable<
  Awaited<ReturnType<typeof findSharedGarment>>
>;

/** The outfit with its chosen garments in the order it was built. */
export async function findSharedOutfit(db: Db, shareableId: string) {
  const row = await db.query.outfit.findFirst({
    columns: { name: true, notes: true },
    where: eq(outfit.shareableId, shareableId),
    with: {
      owner: OWNER_COLUMNS,
      slots: {
        columns: {},
        where: isNotNull(outfitSlot.garmentId),
        orderBy: asc(outfitSlot.position),
        with: {
          garment: {
            // The status marks a piece not bought yet (#335): To buy.
            columns: { id: true, name: true, status: true },
            with: { photo: PHOTO_COLUMNS },
          },
        },
      },
    },
  });
  if (!row) return undefined;
  const { slots, ...fields } = row;
  return {
    ...fields,
    garments: slots.flatMap(({ garment: shown }) =>
      shown ? [{ ...shown, photo: readPhotoRef(shown.photo) }] : [],
    ),
  };
}

export type SharedOutfit = NonNullable<
  Awaited<ReturnType<typeof findSharedOutfit>>
>;
