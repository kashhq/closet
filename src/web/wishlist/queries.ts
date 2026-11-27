import { and, asc, desc, eq, ne, or, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db, Queryable } from '../../db/client';
import { file, garment } from '../../db/schema';
import { selectScalars } from '../../db/select-scalars';
import type { Condition } from '../../wardrobe/properties';
import type { GarmentStatus } from '../../wardrobe/status';
import type { SignablePhotoRef } from '../files/image-url';
import { photoRefJson } from '../files/queries';
import { privateColumns } from '../wardrobe/private-fields';
import type { WardrobeRead } from '../wardrobe/queries';
import { inCloset, onWishlist, ownedGarment, wanted } from '../wardrobe/status';

/**
 * The wishlist's reads (#18): wishlist items are garments with status
 * 'wishlist' (src/wardrobe/status.ts), so every write is the wardrobe's
 * (insertGarment, updateGarmentFields, setGarmentStatus). Every query names
 * the wardrobe it reads, as authorizeWardrobe resolved it.
 */

/** A garment another one points at: what a link to it shows. */
export interface GarmentRef {
  id: number;
  name: string | null;
  category: string;
  status: GarmentStatus;
}

/** A card on the Wishlist tab. */
export interface WishlistItem {
  id: number;
  name: string | null;
  brand: string | null;
  category: string;
  /** The listed price; absent without `private` (#680). */
  price?: string | null;
  sourceUrl: string | null;
  photo: SignablePhotoRef | null;
  /** The garment it would replace; null for none (or deleted since). */
  replaces: GarmentRef | null;
}

const replacedGarment = alias(garment, 'replaced');

/**
 * The wardrobe's wishlist, newest first, each item with the garment it
 * replaces, as its reader's role reads it (the price only with `private`).
 * One statement, unpaged: a wishlist is a handful of things being
 * considered, not a closet (the grid's keyset paging is for hundreds).
 */
export async function wishlistItems(
  db: Db,
  { ownerId, role }: WardrobeRead,
): Promise<WishlistItem[]> {
  const { price } = privateColumns(role);
  const rows = await db
    .select({
      id: garment.id,
      name: garment.name,
      brand: garment.brand,
      category: garment.category,
      ...(price && { price }),
      sourceUrl: garment.sourceUrl,
      photo: photoRefJson,
      replaces: {
        id: replacedGarment.id,
        name: replacedGarment.name,
        category: replacedGarment.category,
        status: replacedGarment.status,
      },
    })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .leftJoin(
      replacedGarment,
      eq(replacedGarment.id, garment.replacesGarmentId),
    )
    .where(and(eq(garment.ownerId, ownerId), wanted()))
    .orderBy(desc(garment.id));
  return rows;
}

/**
 * The garment `id` of `ownerId`'s wardrobe as a link shows it (null when
 * it is not there), as a scalar subquery: the garment page reads what it
 * replaces with its other lists in one statement (garmentContext,
 * src/web/wardrobe/garment-context.ts).
 */
export function garmentRefSql(
  id: number,
  ownerId: number,
): SQL<GarmentRef | null> {
  return sql<GarmentRef | null>`(
    select json_build_object(
      'id', ${garment.id},
      'name', ${garment.name},
      'category', ${garment.category},
      'status', ${garment.status}
    )
    from ${garment}
    where ${and(eq(garment.id, id), eq(garment.ownerId, ownerId))}
  )`;
}

/** garmentRefSql alone, or undefined: "Bought it"'s replaced garment. */
export async function garmentRef(
  db: Queryable,
  id: number,
  ownerId: number,
): Promise<GarmentRef | undefined> {
  const { ref } = await selectScalars(db, { ref: garmentRefSql(id, ownerId) });
  return ref ?? undefined;
}

/** A wishlist item that would replace a closet garment. */
export interface Replacement {
  id: number;
  name: string | null;
  category: string;
}

/**
 * The wishlist items that would replace garment `id` (its page's "On the
 * wishlist"), newest first, as a scalar subquery (a JSON array, empty for
 * none) for garmentContext.
 */
export function replacementsOfSql(
  id: number,
  ownerId: number,
): SQL<Replacement[]> {
  return sql<Replacement[]>`(
    select coalesce(
      json_agg(
        json_build_object(
          'id', ${garment.id},
          'name', ${garment.name},
          'category', ${garment.category}
        )
        order by ${garment.id} desc
      ),
      '[]'
    )
    from ${garment}
    where ${and(
      eq(garment.ownerId, ownerId),
      eq(garment.replacesGarmentId, id),
      onWishlist(),
    )}
  )`;
}

/** A choice in a wishlist form's "Replaces". */
export interface ReplaceableGarment {
  id: number;
  name: string | null;
  category: string;
  condition: Condition;
}

/**
 * What a wishlist item can say it replaces: the closet's garments, those
 * whose condition is not good first (what "replace soon" is for), then by
 * category and name; and `chosen`, the one an edited item already names,
 * when it has left the closet since (archived after the item was added),
 * so saving the form keeps it. A scalar subquery (a JSON array): the
 * wishlist form reads it with its other lists in one statement
 * (formContext, src/web/wardrobe/form-context.ts).
 */
export function replaceableGarmentsSql(
  ownerId: number,
  chosen: number | undefined,
): SQL<ReplaceableGarment[]> {
  return sql<ReplaceableGarment[]>`(
    select coalesce(
      json_agg(
        json_build_object(
          'id', ${garment.id},
          'name', ${garment.name},
          'category', ${garment.category},
          'condition', ${garment.condition}
        )
        order by ${sql.join(
          [
            desc(ne(garment.condition, 'good')),
            asc(garment.category),
            asc(sql`lower(${garment.name})`),
            asc(garment.id),
          ],
          sql`, `,
        )}
      ),
      '[]'
    )
    from ${garment}
    where ${and(
      eq(garment.ownerId, ownerId),
      chosen === undefined
        ? inCloset()
        : or(inCloset(), and(eq(garment.id, chosen), ownedGarment())),
    )}
  )`;
}
