import { type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { garment } from '../../db/schema';
import { selectScalars } from '../../db/select-scalars';
import { type CapsuleRef, capsuleNamesSql } from '../capsules/queries';
import { type DraftsWaiting, draftsWaitingSql } from '../files/pending-photos';
import {
  type SharedWardrobe,
  sharedWardrobesSql,
  toSharedWardrobe,
  type WardrobeRole,
} from '../sharing/access';
import { needingWash } from '../wears/queries';
import {
  type FilterOptions,
  filterOptionsSql,
  type GridFilters,
  gridWhere,
  NO_FILTER_OPTIONS,
  readFilterOptions,
  toTagCountSql,
} from './queries';

/**
 * What GET /wardrobe shows around its tiles (wardrobe-page.tsx). Each part
 * exists for one piece of the page:
 * - `count`: the scope row's "N results", over the grid's own filters;
 * - `options`: the filter modal's choices, only values the wardrobe holds;
 * - `capsules`: the scope row's capsule menu, and the lookup that makes a
 *   `?capsule=` or `?pick=` of another wardrobe a 404 and names the picker;
 * - `toTag`: the "N garments need details" prompt (someone who can tag);
 * - `toWash`: the laundry prompt (the owner's own wears);
 * - `drafts`: the "N photos waiting" prompt (#200, someone who can add);
 * - `sharedWardrobes`: the app bar's wardrobe switcher (full pages only).
 */
export interface GridContext {
  count: number;
  options: FilterOptions;
  capsules: CapsuleRef[];
  toTag: number;
  toWash: number;
  drafts: DraftsWaiting | undefined;
  sharedWardrobes: SharedWardrobe[];
}

export type GridContextPart = keyof GridContext;

/** How many garments match `where`, as a scalar subquery. */
function countOf(where: SQL | undefined): SQL<number> {
  return sql<number>`(select count(*)::int from ${garment} where ${where})`;
}

/**
 * The `parts` of the grid's context, in one statement (selectScalars): they
 * share no rows, and each was its own round trip until #159. A part not
 * asked for is empty (0, none), never read: the route asks only for what
 * its answer renders.
 */
export async function gridContext(
  db: Db,
  scope: {
    userId: number;
    ownerId: number;
    role: WardrobeRole;
    filters: GridFilters;
  },
  parts: ReadonlySet<GridContextPart>,
): Promise<GridContext> {
  const { userId, ownerId, role, filters } = scope;
  const wanted = <T>(part: GridContextPart, column: () => SQL<T>) =>
    parts.has(part) ? column() : undefined;
  const row = await selectScalars(db, {
    count: wanted('count', () =>
      countOf(gridWhere({ ownerId, role }, filters)),
    ),
    options: wanted('options', () => filterOptionsSql(ownerId)),
    capsules: wanted('capsules', () => capsuleNamesSql(ownerId)),
    toTag: wanted('toTag', () => toTagCountSql(ownerId)),
    toWash: wanted('toWash', () => countOf(needingWash(ownerId))),
    drafts: wanted('drafts', () => draftsWaitingSql(userId, ownerId)),
    sharedWardrobes: wanted('sharedWardrobes', () =>
      sharedWardrobesSql(userId),
    ),
  });
  return {
    count: row.count ?? 0,
    options: row.options ? readFilterOptions(row.options) : NO_FILTER_OPTIONS,
    capsules: row.capsules ?? [],
    toTag: row.toTag ?? 0,
    toWash: row.toWash ?? 0,
    drafts: row.drafts ?? undefined,
    sharedWardrobes: (row.sharedWardrobes ?? []).map(toSharedWardrobe),
  };
}
