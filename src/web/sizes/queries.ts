import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { lockedOwnerId, ownerLockCte, ownerLocked } from '../../db/owner-lock';
import { isDeletedClientId, isUniqueViolation } from '../../db/errors';
import { selectScalars } from '../../db/select-scalars';
import {
  BRAND_SIZE_UNIQUE,
  bodyMeasurements,
  brandSize,
} from '../../db/schema';
import { brandKey } from '../../wardrobe/brands';
import {
  DEFAULT_LENGTH_UNIT,
  type LengthUnit,
  type Measurement,
  type Measurements,
  NO_MEASUREMENTS,
} from '../../wardrobe/measurements';
import { NotFound } from '../refusals';
import type { Actor } from '../sharing/access';
import type { BrandSizeFields } from './validation';

/**
 * Sizes' reads and their one writer each (#24; plan section 16). The
 * signed-in user's own, like the style profile: every function takes the
 * user whose rows it reads or writes, and callers pass the session's (or a
 * token's) user, never a wardrobe's owner.
 */

/** Each measurement's column, read under the measurement's name. */
const COLUMNS = {
  height: bodyMeasurements.heightCm,
  neck: bodyMeasurements.neckCm,
  shoulders: bodyMeasurements.shouldersCm,
  chest: bodyMeasurements.chestCm,
  sleeve: bodyMeasurements.sleeveCm,
  waist: bodyMeasurements.waistCm,
  hips: bodyMeasurements.hipsCm,
  inseam: bodyMeasurements.inseamCm,
} as const satisfies Record<Measurement, unknown>;

/** Each measurement's property, for the writes. */
const KEYS = {
  height: 'heightCm',
  neck: 'neckCm',
  shoulders: 'shouldersCm',
  chest: 'chestCm',
  sleeve: 'sleeveCm',
  waist: 'waistCm',
  hips: 'hipsCm',
  inseam: 'inseamCm',
} as const satisfies Record<
  Measurement,
  keyof typeof bodyMeasurements.$inferInsert
>;

export interface BodyMeasurements {
  unit: LengthUnit;
  lengths: Measurements;
}

/** The user's measurements and unit; none set and the default unit when never saved. */
export async function findMeasurements(
  db: Queryable,
  userId: number,
): Promise<BodyMeasurements> {
  const [row] = await db
    .select({ unit: bodyMeasurements.unit, ...COLUMNS })
    .from(bodyMeasurements)
    .where(eq(bodyMeasurements.userId, userId));
  if (!row) return { unit: DEFAULT_LENGTH_UNIT, lengths: NO_MEASUREMENTS };
  const { unit, ...lengths } = row;
  return { unit, lengths };
}

/**
 * The measurements of these users (body_measurements is one row per user,
 * keyed by it), in one statement: the changes feed's page
 * (src/web/sync/feed.ts), which read the ids from the owner's own wardrobe
 * in the same snapshot (measurements are owner-only).
 */
export async function measurementsByUserIds(
  db: Queryable,
  userIds: readonly number[],
): Promise<(BodyMeasurements & { userId: number })[]> {
  const rows = await db
    .select({
      userId: bodyMeasurements.userId,
      unit: bodyMeasurements.unit,
      ...COLUMNS,
    })
    .from(bodyMeasurements)
    .where(inArray(bodyMeasurements.userId, [...userIds]));
  return rows.map(({ userId, unit, ...lengths }) => ({
    userId,
    unit,
    lengths,
  }));
}

function lengthColumns(lengths: Measurements) {
  return Object.fromEntries(
    Object.entries(KEYS).map(([m, key]) => [key, lengths[m as Measurement]]),
  ) as Record<(typeof KEYS)[Measurement], number | null>;
}

/** The one writer of the lengths: every measurement, a cleared one null. */
export async function saveMeasurements(
  db: Queryable,
  userId: number,
  lengths: Measurements,
): Promise<void> {
  const values = lengthColumns(lengths);
  const lock = ownerLockCte(db, userId);
  await db
    .with(lock)
    .insert(bodyMeasurements)
    .values({ userId: lockedOwnerId(lock), ...values })
    .onConflictDoUpdate({
      target: bodyMeasurements.userId,
      set: { ...values, updatedAt: sql`now()` },
    });
}

/** The one writer of the unit: how the lengths are shown and typed. */
export async function setLengthUnit(
  db: Queryable,
  userId: number,
  unit: LengthUnit,
): Promise<void> {
  const lock = ownerLockCte(db, userId);
  await db
    .with(lock)
    .insert(bodyMeasurements)
    .values({ userId: lockedOwnerId(lock), unit })
    .onConflictDoUpdate({
      target: bodyMeasurements.userId,
      set: { unit, updatedAt: sql`now()` },
    });
}

export interface BrandSize extends BrandSizeFields {
  id: number;
}

const BRAND_SIZE = {
  id: brandSize.id,
  brand: brandSize.brand,
  size: brandSize.size,
  note: brandSize.note,
};

/** The user's brand notes, by brand whatever the case. */
export function brandSizesOf(
  db: Queryable,
  userId: number,
): Promise<BrandSize[]> {
  // brand_size_user_id_brand_key_unique serves both the filter and the order.
  return db
    .select(BRAND_SIZE)
    .from(brandSize)
    .where(eq(brandSize.userId, userId))
    .orderBy(asc(brandSize.brandKey));
}

/**
 * The brand notes with these ids, in one statement whatever their owners
 * (the changes feed's page, src/web/sync/feed.ts, which read the ids from
 * the owner's own wardrobe in the same snapshot: sizes are owner-only).
 */
export function brandSizesByIds(
  db: Queryable,
  ids: readonly number[],
): Promise<BrandSize[]> {
  return db
    .select(BRAND_SIZE)
    .from(brandSize)
    .where(inArray(brandSize.id, [...ids]));
}

/**
 * brandSizesOf as a scalar subquery (a JSON array, empty for none), for a
 * page that reads it with its other lists in one statement (the Muse
 * inbox, src/web/wishlist/inbox.ts).
 */
export function brandSizesSql(userId: number): SQL<BrandSize[]> {
  return sql<BrandSize[]>`(
    select coalesce(
      json_agg(
        json_build_object(
          'id', ${brandSize.id},
          'brand', ${brandSize.brand},
          'size', ${brandSize.size},
          'note', ${brandSize.note}
        )
        order by ${brandSize.brandKey}
      ),
      '[]'
    )
    from ${brandSize}
    where ${eq(brandSize.userId, userId)}
  )`;
}

/**
 * One brand's note, however the brand is spelled (null for none), as a
 * scalar subquery: a wishlist item's page reads it with its other lists in
 * one statement (garmentContext, src/web/wardrobe/garment-context.ts).
 * Undefined for a blank brand, which has no note to read: selectScalars
 * leaves such a column out.
 */
export function brandSizeSql(
  userId: number,
  brand: string,
): SQL<BrandSize | null> | undefined {
  const key = brandKey(brand);
  if (!key) return undefined;
  return sql<BrandSize | null>`(
    select json_build_object(
      'id', ${brandSize.id},
      'brand', ${brandSize.brand},
      'size', ${brandSize.size},
      'note', ${brandSize.note}
    )
    from ${brandSize}
    where ${and(eq(brandSize.userId, userId), eq(brandSize.brandKey, key))}
  )`;
}

/** brandSizeSql alone; undefined for none or a blank brand. */
export async function brandSizeFor(
  db: Queryable,
  userId: number,
  brand: string,
): Promise<BrandSize | undefined> {
  const { note } = await selectScalars(db, {
    note: brandSizeSql(userId, brand),
  });
  return note ?? undefined;
}

/**
 * The user's notes by brandKey, for a page that shows several brands (the
 * wishlist): one read, then a lookup per item.
 */
export type BrandSizeLookup = (brand: string | null) => BrandSize | undefined;

export function brandSizeLookup(rows: readonly BrandSize[]): BrandSizeLookup {
  const byKey = new Map(rows.map((row) => [brandKey(row.brand), row]));
  return (brand) => (brand ? byKey.get(brandKey(brand)) : undefined);
}

export const BRAND_TAKEN = 'brand-taken';
type BrandTaken = typeof BRAND_TAKEN;

/**
 * The one writer of a new brand row: its id, or 'brand-taken' when the
 * user has the brand already, in any case. In a savepoint, so a caller's
 * transaction (the seed's) survives the refusal.
 */
export async function addBrandSize(
  db: Queryable,
  userId: number,
  fields: BrandSizeFields,
): Promise<number | BrandTaken> {
  try {
    return await db.transaction(async (tx) => {
      const lock = ownerLockCte(tx, userId);
      const [row] = await tx
        .with(lock)
        .insert(brandSize)
        .values({
          userId: lockedOwnerId(lock),
          ...fields,
          brandKey: brandKey(fields.brand),
        })
        .returning({ id: brandSize.id });
      return row.id;
    });
  } catch (error) {
    if (isUniqueViolation(error, BRAND_SIZE_UNIQUE)) return BRAND_TAKEN;
    throw error;
  }
}

/**
 * addBrandSize for a create that carries the client's own id (the API's, a
 * retried offline create), stored on the row. A row of that id there
 * already is the answer, `created: false`, whatever this body says (the
 * client may have edited since; the id names the create, not its content).
 * The conflict target is the client id alone, so a different client id for
 * a taken brand is still 'brand-taken', and a concurrent twin waits on the
 * owner lock, then finds the first one's row. 'gone' for the id of a row
 * deleted since (the sync triggers' tombstone, isDeletedClientId).
 */
export async function addBrandSizeOnce(
  db: Queryable,
  userId: number,
  fields: BrandSizeFields,
  clientId: string,
): Promise<{ row: BrandSize; created: boolean } | BrandTaken | 'gone'> {
  try {
    return await db.transaction(async (tx) => {
      const lock = ownerLockCte(tx, userId);
      const [row] = await tx
        .with(lock)
        .insert(brandSize)
        .values({
          userId: lockedOwnerId(lock),
          ...fields,
          brandKey: brandKey(fields.brand),
          clientId,
        })
        .onConflictDoNothing({ target: [brandSize.userId, brandSize.clientId] })
        .returning(BRAND_SIZE);
      if (row) return { row, created: true };
      const [first] = await tx
        .select(BRAND_SIZE)
        .from(brandSize)
        .where(
          and(eq(brandSize.userId, userId), eq(brandSize.clientId, clientId)),
        );
      return { row: first, created: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, BRAND_SIZE_UNIQUE)) return BRAND_TAKEN;
    if (isDeletedClientId(error)) return 'gone';
    throw error;
  }
}

/**
 * Rewrites the actor's row `id`; 'brand-taken' when another of their rows
 * has the brand. Sizes are the actor's own, whatever wardrobe they share:
 * anyone else's row is NotFound('brand'), the 404 of an unknown id.
 */
export async function updateBrandSize(
  db: Queryable,
  actor: Actor,
  id: number,
  fields: BrandSizeFields,
): Promise<'updated' | BrandTaken> {
  let updated: { id: number }[];
  try {
    const lock = ownerLockCte(db, actor.userId);
    updated = await db
      .with(lock)
      .update(brandSize)
      .set({ ...fields, brandKey: brandKey(fields.brand) })
      .where(
        and(
          eq(brandSize.id, id),
          eq(brandSize.userId, actor.userId),
          ownerLocked(db, lock),
        ),
      )
      .returning({ id: brandSize.id });
  } catch (error) {
    if (isUniqueViolation(error, BRAND_SIZE_UNIQUE)) return BRAND_TAKEN;
    throw error;
  }
  if (updated.length === 0) throw brandNotFound(actor, id);
  return 'updated';
}

/** Deletes the actor's row `id` and answers the brand it named; anyone else's is NotFound('brand'). */
export async function deleteBrandSize(
  db: Queryable,
  actor: Actor,
  id: number,
): Promise<string> {
  const lock = ownerLockCte(db, actor.userId);
  const [row] = await db
    .with(lock)
    .delete(brandSize)
    .where(
      and(
        eq(brandSize.id, id),
        eq(brandSize.userId, actor.userId),
        ownerLocked(db, lock),
      ),
    )
    .returning({ brand: brandSize.brand });
  if (!row) throw brandNotFound(actor, id);
  return row.brand;
}

function brandNotFound(actor: Actor, id: number): NotFound {
  return new NotFound('brand', {
    logDetail: `brand size ${id} is not user ${actor.userId}'s`,
  });
}
