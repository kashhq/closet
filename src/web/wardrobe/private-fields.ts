import { type SQL, sql } from 'drizzle-orm';
import { garment } from '../../db/schema';
import { can, type WardrobeRole } from '../sharing/access';

/**
 * A garment's price and notes are the `private` capability's (#680, owner
 * decision 2026-11-25): a VIEW grantee never reads them, on a page, the API,
 * the changes feed or MCP. This is the one file that names their columns
 * (guards.conf `@garment-private`): every reader takes them from here by the
 * reader's role, so a reader without `private` never selects them, and its
 * rows, and every answer made from them, leave them out: absent, never null.
 * Every role with `manage` has `private` (CAPABILITIES), so a write's stored
 * base always holds them and an edit never clears them unseen.
 */

const PRIVATE_COLUMNS = { price: garment.price, notes: garment.notes };
type PrivateColumns = typeof PRIVATE_COLUMNS;

/** The private fields as a reader has them: absent without `private`. */
export interface PrivateFields {
  /** numeric(10, 2) as text, always two decimals ('24.90'). */
  price?: string | null;
  notes?: string | null;
}

/** Whether `role` reads a garment's price and notes; undefined (no role) never. */
export function seesPrivate(role: WardrobeRole | undefined): boolean {
  return role !== undefined && can(role, 'private');
}

/**
 * The private columns for a select: both with `private`, neither without.
 * An owner-only reader (insights, wears, Muse's feedback, the outfits) asks
 * as `'OWN'`, and gets both.
 */
export function privateColumns(role: 'OWN'): PrivateColumns;
export function privateColumns(
  role: WardrobeRole | undefined,
): Partial<PrivateColumns>;
export function privateColumns(
  role: WardrobeRole | undefined,
): Partial<PrivateColumns> {
  return seesPrivate(role) ? PRIVATE_COLUMNS : {};
}

/**
 * The private columns of a batched read across wardrobes (the changes
 * feed's garmentsByIds), each null on a row where `reads` is false: the
 * feed's `managesWardrobeSql`, `private`'s SQL form. The API leaves a null
 * price or notes out (asResource), so it is absent there too.
 */
export function privateColumnsWhere(reads: SQL<boolean>): {
  price: SQL<string | null>;
  notes: SQL<string | null>;
} {
  return {
    price: sql<string | null>`case when ${reads} then ${garment.price} end`,
    notes: sql<string | null>`case when ${reads} then ${garment.notes} end`,
  };
}

/**
 * The price as a `json_build_object` pair with its trailing comma, or
 * nothing without `private`, so the key is absent: written before another
 * pair, `json_build_object('id', …, ${priceJsonPair(role)} 'sourceUrl', …)`.
 */
export function priceJsonPair(role: WardrobeRole | undefined): SQL {
  return seesPrivate(role) ? sql`'price', ${garment.price}::text,` : sql``;
}
