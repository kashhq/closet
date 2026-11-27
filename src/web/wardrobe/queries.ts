import {
  and,
  arrayContains,
  type Column,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  not,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { alias, type PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { CutoutStatus } from '../../cutout/state';
import type { Db, Queryable } from '../../db/client';
import {
  lockedOwnerId,
  ownerLockCte,
  ownerLocked,
  type OwnerLockCte,
} from '../../db/owner-lock';
import { file, garment } from '../../db/schema';
import type { AwayReason } from '../../wardrobe/availability';
import type { CareLabel, CareWash } from '../../wardrobe/care';
import type { EntryStatus, GarmentStatus } from '../../wardrobe/status';
import { inCapsule } from '../capsules/queries';
import { managesWardrobeSql, type WardrobeRole } from '../sharing/access';
import type { SignablePhotoRef, PlinthPhoto } from '../files/image-url';
import type { StoredPhoto } from '../files/image-variant';
import {
  type PhotoWithCutout,
  photoWithCutoutJson,
  PLINTH_PHOTO_COLUMNS,
  plinthPhoto,
  STORED_PHOTO_COLUMNS,
} from '../files/queries';
import { dirtyCopiesSql, needsWash } from '../wears/queries';
import { compareSizes } from './garment';
import { GRID_PAGE_SIZE } from './grid-page-size';
import type { GridCursor } from './grid-cursor';
import {
  type KeywordRank,
  keywordMatch,
  keywordRank,
  keywordTokens,
} from './keyword-search';
import {
  type PrivateFields,
  privateColumns,
  privateColumnsWhere,
  seesPrivate,
} from './private-fields';
import { type RepairEntry, repairLogSql } from './repairs';
import {
  type GarmentScope,
  inCloset,
  inScope,
  onWishlist,
  ownedGarment,
} from './status';
import {
  type Condition,
  type Formality,
  GarmentCategory,
  type GarmentColor,
  type Material,
  MATERIALS,
  propertyApplies,
  storedSet,
  typesOf,
  type Warmth,
} from '../../wardrobe/properties';
import type { BulkChange } from './grid-schemas';
import type {
  CareFields,
  ConditionFields,
  GarmentFields,
  GarmentPropertyFields,
  ProductFields,
} from './garment-input';
import {
  type AgentLabel,
  agentLabelSql,
  type AgentViewer,
  type WriteOrigin,
} from '../write-origin';

/**
 * Garments' reads and writes. Every query names the wardrobe (owner) it
 * reads or writes, as resolveWardrobeAccess (src/web/sharing/access.ts)
 * decided it: a garment outside that wardrobe is a miss like a missing one,
 * and the routes answer 404 either way. Reads return plain rows shaped for
 * the page, never whole entities.
 */

/**
 * The wardrobe a read is of, and the reader's role there, which decides
 * whether it reads the price and notes and searches the notes
 * (privateColumns, private-fields.ts). A WardrobeAccess is one; an
 * internal check that shows neither field passes no role.
 */
export interface WardrobeRead {
  ownerId: number;
  role: WardrobeRole | undefined;
}

/** The grid's filters, as the query string gives them (already validated). */
export interface GridFilters {
  keyword?: string;
  category?: string;
  color?: GarmentColor;
  size?: string;
  /** A type of `category` (the route drops one that is not). */
  type?: string;
  warmth?: Warmth;
  formality?: Formality;
  /** Garments made (partly) of this material. */
  material?: Material;
  /** Garments whose care label says to wash them this way (#23). */
  wash?: CareWash;
  /**
   * Which garments: the closet, the closet and the archive (the modal's
   * "Include archived"), or the wishlist.
   */
  scope: GarmentScope;
  /** Members of this capsule only (inCapsule). */
  capsule?: number;
  /** A copy needs a wash (the owner's own wardrobe only; the route decides). */
  needsWash: boolean;
  /** Condition not good: needs repair or replacing soon. */
  attention: boolean;
  /**
   * Tagging mode's queue only (needsTags: closet garments missing their
   * type, warmth or formality); search_garments' needsTagging.
   */
  needsTags?: boolean;
}

/** A grid tile: what the card shows and links to. */
export interface GarmentTile {
  id: number;
  name: string | null;
  category: string;
  status: GarmentStatus;
  photo: PlinthPhoto | null;
  /** The "x3" badge. */
  quantity: number;
  condition: Condition;
  /** The owner's own records; absent on a shared wardrobe's grid. */
  care?: { dirty: number; away: AwayReason | null };
  /** In the capsule picker only: a member of the capsule being picked. */
  member?: boolean;
}

export interface GridPage {
  tiles: GarmentTile[];
  /** Where the last tile left off when there are more (gridOrder). */
  before: GridCursor | undefined;
}

export function gridWhere(
  { ownerId, role }: WardrobeRead,
  filters: GridFilters,
): SQL | undefined {
  const conditions: (SQL | undefined)[] = [
    eq(garment.ownerId, ownerId),
    ...propertyConditions(filters),
  ];
  conditions.push(inScope(filters.scope));
  if (filters.category) {
    conditions.push(eq(garment.category, filters.category));
  }
  if (filters.capsule) conditions.push(inCapsule(filters.capsule));
  if (filters.needsWash) conditions.push(needsWash());
  if (filters.attention) conditions.push(ne(garment.condition, 'good'));
  if (filters.needsTags) conditions.push(needsTags(ownerId));
  if (filters.size) conditions.push(eq(garment.size, filters.size));
  if (filters.color) {
    conditions.push(arrayContains(garment.colors, [filters.color]));
  }
  const tokens = keywordTokens(filters.keyword);
  // A reader without `private` never finds a garment by its notes (#680):
  // the match would tell what they say.
  if (tokens.length > 0) {
    conditions.push(keywordMatch(garment, tokens, privateColumns(role).notes));
  }
  return and(...conditions);
}

/**
 * The grid's order and keyset, shared by gridPage and garmentSummaries:
 * newest first, `id < before.id` for the next page. A keyword search sorts
 * by keywordRank first (a notes-only match after the rest), newest first
 * within each rank, so the next page is "a later rank, or the same rank and
 * an older id", the rank the one the cursor carries (GridCursor: never read
 * from the cursor's row). `rank` is selected beside each row for the next
 * cursor; 0 without a keyword, whose order ignores a cursor's rank, and
 * for a reader without `private`, whose search skips the notes, so every
 * match ranks 0.
 */
function gridOrder(
  role: WardrobeRole | undefined,
  filters: GridFilters,
  before: GridCursor | undefined,
): { rank: SQL<KeywordRank>; after: SQL | undefined; orderBy: SQL[] } {
  const tokens = keywordTokens(filters.keyword);
  if (tokens.length === 0 || !seesPrivate(role)) {
    return {
      rank: sql<KeywordRank>`0`,
      after: before === undefined ? undefined : lt(garment.id, before.id),
      orderBy: [desc(garment.id)],
    };
  }
  const rank = keywordRank(garment, tokens);
  return {
    rank,
    after:
      before === undefined
        ? undefined
        : or(
            sql`${rank} > ${before.rank}`,
            and(sql`${rank} = ${before.rank}`, lt(garment.id, before.id)),
          ),
    orderBy: [rank, desc(garment.id)],
  };
}

/**
 * A page of gridOrder's rows (`size` of them, fetched with one more to tell
 * whether there are more): each without the `rank` selected beside it, and
 * the cursor of the last when there are more.
 */
function keysetPage<Row extends { id: number; rank: KeywordRank }>(
  fetched: Row[],
  size: number,
): {
  rows: (Omit<Row, 'rank' | 'id'> & { id: number })[];
  before?: GridCursor;
} {
  const page = fetched.slice(0, size).map(({ rank, id, ...row }) => ({
    row: { id, ...row },
    cursor: { rank, id },
  }));
  return {
    rows: page.map(({ row }) => row),
    before: fetched.length > size ? page.at(-1)!.cursor : undefined,
  };
}

/** The property filters (#12) as conditions. */
function propertyConditions(filters: GridFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.type) conditions.push(eq(garment.type, filters.type));
  if (filters.warmth) conditions.push(eq(garment.warmth, filters.warmth));
  if (filters.formality) {
    conditions.push(eq(garment.formality, filters.formality));
  }
  if (filters.material) {
    conditions.push(arrayContains(garment.materials, [filters.material]));
  }
  if (filters.wash) conditions.push(eq(garment.careWash, filters.wash));
  return conditions;
}

const tileColumns = {
  id: garment.id,
  name: garment.name,
  category: garment.category,
  status: garment.status,
  photo: PLINTH_PHOTO_COLUMNS,
  quantity: garment.quantity,
  condition: garment.condition,
};

/**
 * One page of the grid, newest first: `before` is the id the previous page
 * ended at (keyset, so a page costs the same however deep it is and a
 * garment added meanwhile never shifts one onto the next). One statement,
 * one row per tile, served by garment_owner_id_status_id_index (or the
 * category one) in index order. `ownerView` adds the owner's own records to
 * each tile (dirty copies, away), which a share never shows. `pick` (the
 * capsule picker) marks each tile a member of that capsule or not, in the
 * same statement: inCapsule matches nothing for another wardrobe's capsule.
 */
export async function gridPage(
  db: Db,
  wardrobe: WardrobeRead,
  filters: GridFilters,
  options: { before?: GridCursor; ownerView: boolean; pick?: number },
): Promise<GridPage> {
  const { before, ownerView, pick } = options;
  // Not computed at all for a share. Each is a correlated count of the
  // garment's wears since its wash (garment_wear_garment_id_day_index), run
  // only for tiles with a wash limit: about 0.03 ms a tile in the demo's
  // plan (#159), so a set-based rewrite would buy nothing.
  const own = ownerView
    ? { dirty: dirtyCopiesSql(), away: sql<AwayReason | null>`${garment.away}` }
    : { dirty: sql<number>`0`, away: sql<AwayReason | null>`null` };
  const member = sql<
    boolean | null
  >`${pick === undefined ? sql`null` : inCapsule(pick)}`;
  const { rank, after, orderBy } = gridOrder(wardrobe.role, filters, before);
  const rows = await db
    .select({ ...tileColumns, ...own, member, rank })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(and(gridWhere(wardrobe, filters), after))
    .orderBy(...orderBy)
    .limit(GRID_PAGE_SIZE + 1);
  const { rows: page, before: next } = keysetPage(rows, GRID_PAGE_SIZE);
  const tiles = page.map(
    ({ dirty, away, member, photo, ...row }): GarmentTile => ({
      ...row,
      photo: plinthPhoto(photo),
      ...(ownerView && { care: { dirty, away } }),
      ...(member !== null && { member }),
    }),
  );
  return { tiles, before: next };
}

/** No filter: the closet (inCloset). */
export const CLOSET_FILTERS: GridFilters = {
  scope: 'closet',
  needsWash: false,
  attention: false,
};

/**
 * A garment as a list shows what it is: the MCP tools' search, capsule and
 * comparison answers (which leave the photo out: an agent reads, it asks
 * get_garment_photo to see) and the API's GET /garments (#192a), whose
 * client draws the photo. The photo is the one the garment page reads.
 */
export interface GarmentSummary {
  id: number;
  name: string | null;
  category: string;
  type: string | null;
  brand: string | null;
  /** A set in GARMENT_COLORS order; null for none. */
  colors: GarmentColor[] | null;
  materials: Material[] | null;
  size: string | null;
  warmth: Warmth | null;
  formality: Formality | null;
  quantity: number;
  condition: Condition;
  /** Absent for a reader without `private` (privateColumns). */
  price?: string | null;
  sourceUrl: string | null;
  status: GarmentStatus;
  photo: PhotoWithCutout | null;
  /** Its photo's original_missing_since (#653): `photo` is null then. */
  photoMissingSince: Date | null;
}

/**
 * The grid's query with a summary per garment instead of a tile: the same
 * filters (gridWhere), order and keyset (`before`), `limit` a page.
 */
export async function garmentSummaries(
  db: Db,
  wardrobe: WardrobeRead,
  filters: GridFilters,
  options: { before?: GridCursor; limit: number },
): Promise<{ garments: GarmentSummary[]; before: GridCursor | undefined }>;
/** Without a `limit`: every match, no page and so no `before`. */
export async function garmentSummaries(
  db: Db,
  wardrobe: WardrobeRead,
  filters: GridFilters,
): Promise<{ garments: GarmentSummary[] }>;
export async function garmentSummaries(
  db: Db,
  wardrobe: WardrobeRead,
  filters: GridFilters,
  options: { before?: GridCursor; limit?: number } = {},
): Promise<{ garments: GarmentSummary[]; before?: GridCursor }> {
  const { before, limit } = options;
  const { rank, after, orderBy } = gridOrder(wardrobe.role, filters, before);
  const { price } = privateColumns(wardrobe.role);
  const query = db
    .select({
      id: garment.id,
      name: garment.name,
      category: garment.category,
      type: garment.type,
      brand: garment.brand,
      colors: garment.colors,
      materials: garment.materials,
      size: garment.size,
      warmth: garment.warmth,
      formality: garment.formality,
      quantity: garment.quantity,
      condition: garment.condition,
      ...(price && { price }),
      sourceUrl: garment.sourceUrl,
      status: garment.status,
      photo: photoWithCutoutJson,
      photoMissingSince: file.originalMissingSince,
      rank,
    })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(and(gridWhere(wardrobe, filters), after))
    .orderBy(...orderBy)
    .$dynamic();
  if (limit === undefined) {
    return { garments: keysetPage(await query, Infinity).rows };
  }
  const page = keysetPage(await query.limit(limit + 1), limit);
  return { garments: page.rows, before: page.before };
}

/**
 * Every garment the filters match, by id: select mode's "Select all N"
 * (#677), which posts the grid's filters rather than its ids, resolved
 * through gridWhere, the grid's own predicate, so "all" is exactly what
 * the grid and its count show.
 */
export async function gridIds(
  db: Db,
  wardrobe: WardrobeRead,
  filters: GridFilters,
): Promise<number[]> {
  const rows = await db
    .select({ id: garment.id })
    .from(garment)
    .where(gridWhere(wardrobe, filters))
    .orderBy(garment.id);
  return rows.map((row) => row.id);
}

/** How many garments match the filters (the grid's result count). */
export function gridCount(
  db: Db,
  wardrobe: WardrobeRead,
  filters: GridFilters,
): Promise<number> {
  return db.$count(garment, gridWhere(wardrobe, filters));
}

/**
 * The values the filter modal offers: only what the wardrobe holds
 * (archived garments included, wishlist items not: the grid never shows
 * them), so no choice finds nothing.
 */
export interface FilterOptions {
  categories: string[];
  sizes: string[];
  types: string[];
  warmths: Warmth[];
  formalities: Formality[];
  materials: Material[];
  washes: CareWash[];
}

/** No values: the filter modal's options where the page renders no modal. */
export const NO_FILTER_OPTIONS: FilterOptions = {
  categories: [],
  sizes: [],
  types: [],
  warmths: [],
  formalities: [],
  materials: [],
  washes: [],
};

/** Every distinct non-null value of `column` in the scan, as an array. */
function distinctValues(column: Column): SQL {
  return sql`coalesce(array_agg(distinct ${column}) filter (where ${column} is not null), '{}')`;
}

/**
 * The wardrobe's distinct categories, sizes, types, warmths, formalities,
 * care labels' washes and materials as one JSON object, a scalar subquery
 * (materials through a subquery over their unnested arrays), so the grid
 * reads it with its counts (gridContext, grid-context.ts). Put in the
 * modal's order by readFilterOptions. There is no brand filter in the UI,
 * so no brand list.
 */
export function filterOptionsSql(ownerId: number): SQL<FilterOptions> {
  // The materials are their own scan of the wardrobe, deliberately
  // uncorrelated: unnesting in the outer query would multiply its rows
  // (harmless to the distinct aggregates, but a trap for anything added).
  return sql<FilterOptions>`(
    select json_build_object(
      'categories', ${distinctValues(garment.category)},
      'sizes', ${distinctValues(garment.size)},
      'types', ${distinctValues(garment.type)},
      'warmths', ${distinctValues(garment.warmth)},
      'formalities', ${distinctValues(garment.formality)},
      'washes', ${distinctValues(garment.careWash)},
      'materials', (
        select coalesce(array_agg(distinct worn.material), '{}')
        from garment owned cross join lateral unnest(owned.materials) as worn(material)
        where owned.owner_id = ${ownerId} and owned.status <> 'wishlist'
      )
    )
    from ${garment}
    where ${and(eq(garment.ownerId, ownerId), ownedGarment())}
  )`;
}

/** filterOptionsSql's values in the modal's order: sizes in wearing order. */
export function readFilterOptions(values: FilterOptions): FilterOptions {
  return {
    ...values,
    categories: [...values.categories].sort(),
    sizes: [...values.sizes].sort(compareSizes),
    warmths: [...values.warmths].sort(),
    formalities: [...values.formalities].sort(),
  };
}

/**
 * The wardrobe's distinct categories, a scalar subquery: the garment
 * form's suggestions (formContext, form-context.ts), which need none of
 * filterOptionsSql's other lists (#161). Unsorted: categorySuggestions
 * orders them.
 */
export function wardrobeCategoriesSql(ownerId: number): SQL<string[]> {
  return sql<string[]>`(
    select ${distinctValues(garment.category)}
    from ${garment}
    where ${and(eq(garment.ownerId, ownerId), ownedGarment())}
  )`;
}

/** A garment's photo on its page: the cutout's state decides what shows. */
export interface GarmentPhoto extends SignablePhotoRef {
  /** Always read (detailColumns): rotateGarmentPhoto's check compares it. */
  version: number;
  cutoutStatus: CutoutStatus;
}

/** A garment as its page and its forms show it, every property included. */
export interface GarmentDetail
  extends
    Omit<
      GarmentFields,
      | keyof GarmentPropertyFields
      | keyof CareLabel
      | keyof ProductFields
      | keyof CareFields
      | keyof PrivateFields
    >,
    GarmentPropertyFields,
    CareLabel,
    Omit<ProductFields, keyof PrivateFields>,
    CareFields,
    // Absent for a reader without `private` (#680, privateColumns).
    PrivateFields {
  id: number;
  /** The public link's id (/share), null while not shared (#669). */
  shareableId: string | null;
  status: GarmentStatus;
  /** A wishlist item's (or a bought one's) garment it replaces. */
  replacesGarmentId: number | null;
  photo: GarmentPhoto | null;
  /** Its photo's original_missing_since (#653): `photo` is null then. */
  photoMissingSince: Date | null;
  // The owner's own records (src/web/wears): the page shows them to the
  // owner alone.
  lastWashedOn: string | null;
  /** That wash's instant, when known (#676). */
  washedAt: Date | null;
  away: AwayReason | null;
  awayNote: string | null;
  /**
   * Muse's suggestion (#333): set when it is one, so its page shows where
   * it stands (src/web/wishlist/suggestion-section.tsx). The rest is read
   * with the garment's context (garmentContext's `suggestion`).
   */
  suggestedAt: Date | null;
  suggestionGroupId: number | null;
  dismissedAt: Date | null;
  /**
   * An agent made it over MCP (#682). Never its name: that depends on who
   * reads it, so it is read with the viewer (garmentAgentSql, garmentsByIds).
   */
  madeByAgent: boolean;
}

const detailColumns = {
  id: garment.id,
  shareableId: garment.shareableId,
  name: garment.name,
  category: garment.category,
  brand: garment.brand,
  colors: garment.colors,
  size: garment.size,
  washingDetails: garment.washingDetails,
  acquiredOn: garment.acquiredOn,
  status: garment.status,
  replacesGarmentId: garment.replacesGarmentId,
  type: garment.type,
  warmth: garment.warmth,
  formality: garment.formality,
  materials: garment.materials,
  pattern: garment.pattern,
  fit: garment.fit,
  sleeve: garment.sleeve,
  length: garment.length,
  fabricWeight: garment.fabricWeight,
  waterResistant: garment.waterResistant,
  careWash: garment.careWash,
  careBleach: garment.careBleach,
  careDry: garment.careDry,
  careIron: garment.careIron,
  careDryClean: garment.careDryClean,
  sourceUrl: garment.sourceUrl,
  quantity: garment.quantity,
  washAfterWears: garment.washAfterWears,
  condition: garment.condition,
  conditionNote: garment.conditionNote,
  lastWashedOn: garment.lastWashedOn,
  washedAt: garment.washedAt,
  away: garment.away,
  awayNote: garment.awayNote,
  suggestedAt: garment.suggestedAt,
  suggestionGroupId: garment.suggestionGroupId,
  dismissedAt: garment.dismissedAt,
  madeByAgent: sql<boolean>`${garment.addedByTokenId} is not null`,
  photo: photoWithCutoutJson,
  photoMissingSince: file.originalMissingSince,
};

/**
 * A garment's columns as `role` reads them: everything stored on it, the
 * price and notes only with `private` (privateColumns).
 */
function detailColumnsFor(role: WardrobeRole | undefined) {
  return { ...detailColumns, ...privateColumns(role) };
}

/** The garment in the wardrobe, as its role reads it, or undefined. */
export async function findGarment(
  db: Db,
  id: number,
  { ownerId, role }: WardrobeRead,
): Promise<GarmentDetail | undefined> {
  const [row] = await db
    .select(detailColumnsFor(role))
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(and(eq(garment.id, id), eq(garment.ownerId, ownerId)));
  return row;
}

/** A garment as the changes feed reads it (garmentsByIds). */
export interface SyncedGarmentRow extends GarmentDetail {
  /** The agent that made it, as `viewerId` may see it (agentLabelSql). */
  agent: AgentLabel | null;
  /** The owner's repair log; null on a wardrobe the viewer does not own. */
  repairs: RepairEntry[] | null;
  /**
   * The viewer owns its wardrobe or holds a MANAGE share: only they are
   * shown its public link, as its page shows it (#959), and its price and
   * notes (`private`: null to anyone else, so absent from the API).
   */
  viewerManages: boolean;
}

/**
 * The garments with these ids, in one statement whatever their owners (the
 * changes feed's page, src/web/sync/feed.ts, which read the ids from the
 * wardrobes `viewerId` may see, in the same snapshot). The repair log is
 * the owner's own record: read only where `viewerId` owns the garment; the
 * public link, the price and the notes only where they may manage it.
 */
export function garmentsByIds(
  db: Queryable,
  viewerId: number,
  ids: readonly number[],
): Promise<SyncedGarmentRow[]> {
  return db
    .select({
      ...detailColumns,
      ...privateColumnsWhere(managesWardrobeSql(garment.ownerId, viewerId)),
      agent: agentLabelSql(garment.addedByTokenId, {
        viewerId,
        ownsWardrobe: sql`${garment.ownerId} = ${viewerId}::int`,
      }),
      repairs: sql<
        RepairEntry[] | null
      >`case when ${garment.ownerId} = ${viewerId} then ${repairLogSql(garment.id)} end`,
      viewerManages: managesWardrobeSql(garment.ownerId, viewerId),
    })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(inArray(garment.id, [...ids]));
}

/**
 * Garment `id`'s agent as `viewer` may see it (agentLabelSql), as a scalar
 * subquery for a statement of the garment's other reads (garmentContext,
 * get_garment's): findGarment reads only whether an agent made it.
 */
export function garmentAgentSql(
  id: number,
  viewer: AgentViewer,
): SQL<AgentLabel | null> {
  return sql<AgentLabel | null>`(
    select ${agentLabelSql(garment.addedByTokenId, viewer)}
    from ${garment} where ${garment.id} = ${id}
  )`;
}

/**
 * The garment's photo row id inside a write transaction, the owner then the
 * garment locked in one statement (the owner lock first, as every synced
 * write takes it: src/db/owner-lock.ts), so two writes to one garment take
 * turns (not the `file` row: a
 * cutout swap may hold it, so its variant key comes from the delete that
 * waits for it, deletePhotoRow). Undefined when the garment is not in
 * `ownerId`'s wardrobe (any more), or, given `status`, no longer has it: a
 * lock that waited on another transaction's status change judges the row
 * as that transaction committed it.
 */
export async function lockGarment(
  tx: Queryable,
  id: number,
  ownerId: number,
  status?: GarmentStatus,
): Promise<{ photoId: number | null } | undefined> {
  const lock = ownerLockCte(tx, ownerId);
  const [row] = await lockGarmentQuery(tx, lock, id, ownerId, status);
  return row;
}

/** lockGarment's statement, exported for owner-lock.spec.ts, which EXPLAINs it. */
export function lockGarmentQuery(
  tx: Queryable,
  lock: OwnerLockCte,
  id: number,
  ownerId: number,
  status?: GarmentStatus,
) {
  return tx
    .with(lock)
    .select({ photoId: garment.photoId })
    .from(garment)
    .where(
      and(
        eq(garment.id, id),
        eq(garment.ownerId, ownerId),
        status && eq(garment.status, status),
        ownerLocked(tx, lock),
      ),
    )
    .for('update', { of: garment });
}

const replaced = alias(garment, 'replaced');

/**
 * The garment a wishlist item may say it replaces, as the value to store:
 * `requested` when it is a garment of `ownerId`, owned now or once (not a
 * wishlist item) and not the garment itself (`selfId`), else null. A
 * subquery of the statement that stores it, so the rule and the write are
 * one step: the same-owner rule for replaces_garment_id lives here and
 * nowhere else (the column's own checks cover only itself).
 */
function replacementOf(
  db: Queryable,
  ownerId: number,
  requested: number | null,
  selfId?: number,
): SQL<number | null> | null {
  if (requested === null) return null;
  const candidate = db
    .select({ id: replaced.id })
    .from(replaced)
    .where(
      and(
        eq(replaced.id, requested),
        eq(replaced.ownerId, ownerId),
        ne(replaced.status, 'wishlist'),
        selfId === undefined ? undefined : ne(replaced.id, selfId),
      ),
    );
  return sql<number | null>`(${candidate})`;
}

/** The fields as stored, the replaced garment through replacementOf. */
function storedFields<Fields extends Partial<GarmentFields>>(
  db: Queryable,
  ownerId: number,
  { replacesGarmentId, ...fields }: Fields,
  selfId?: number,
) {
  return {
    ...fields,
    ...(replacesGarmentId !== undefined && {
      replacesGarmentId: replacementOf(db, ownerId, replacesGarmentId, selfId),
    }),
  };
}

/**
 * Inserts a garment into `ownerId`'s wardrobe, in the closet or on the
 * wishlist (the only statuses a garment starts in; setGarmentStatus moves
 * it after); returns its id. `clientId` is an API create's (#563): see
 * insertGarmentOnce.
 */
export async function insertGarment(
  tx: Queryable,
  ownerId: number,
  fields: GarmentFields,
  photoId: number | null,
  status: EntryStatus,
  madeBy: WriteOrigin,
): Promise<number> {
  const lock = ownerLockCte(tx, ownerId);
  const [row] = await tx
    .with(lock)
    .insert(garment)
    .values({
      ...newGarment(tx, ownerId, fields, photoId, status, lock),
      // The agent's token when an MCP tool made it (#682, write-origin.ts).
      addedByTokenId: madeBy.agentTokenId,
    })
    .returning({ id: garment.id });
  return row.id;
}

function newGarment(
  tx: Queryable,
  ownerId: number,
  fields: GarmentFields,
  photoId: number | null,
  status: EntryStatus,
  lock: OwnerLockCte,
) {
  return {
    ...storedFields(tx, ownerId, fields),
    status,
    // No public link until Share is tapped (#669, setPublicShare): a new
    // garment and a clone start unshared.
    ownerId: lockedOwnerId(lock),
    photoId,
  };
}

/**
 * insertGarment for a create that carries the client's own id (the API's,
 * a retried offline create): null when the owner's row of that id exists
 * already (nothing written; `garmentIdByClientId` finds it). The conflict
 * target is the client id alone, so a concurrent twin waits on the owner
 * lock, then finds the first one's row. Raises CL410 (isDeletedClientId)
 * for the id of a deleted garment.
 */
export async function insertGarmentOnce(
  tx: Queryable,
  ownerId: number,
  fields: GarmentFields,
  status: EntryStatus,
  clientId: string,
): Promise<number | null> {
  const lock = ownerLockCte(tx, ownerId);
  const [row] = await tx
    .with(lock)
    .insert(garment)
    .values({
      ...newGarment(tx, ownerId, fields, null, status, lock),
      clientId,
    })
    .onConflictDoNothing({ target: [garment.ownerId, garment.clientId] })
    .returning({ id: garment.id });
  return row?.id ?? null;
}

/** The owner's garment a client id was stored on, or null (deleted since). */
export async function garmentIdByClientId(
  tx: Queryable,
  ownerId: number,
  clientId: string,
): Promise<number | null> {
  const [row] = await tx
    .select({ id: garment.id })
    .from(garment)
    .where(and(eq(garment.ownerId, ownerId), eq(garment.clientId, clientId)));
  return row?.id ?? null;
}

/**
 * The one update of a garment by id within `ownerId`'s wardrobe, for the
 * writers below that differ only in what they set: false when it is not
 * there (another's, deleted, unknown).
 */
async function updateOwnedGarment(
  db: Db,
  id: number,
  ownerId: number,
  values: PgUpdateSetSource<typeof garment>,
): Promise<boolean> {
  const lock = ownerLockCte(db, ownerId);
  const updated = await db
    .with(lock)
    .update(garment)
    .set(values)
    .where(
      and(
        eq(garment.id, id),
        eq(garment.ownerId, ownerId),
        ownerLocked(db, lock),
      ),
    )
    .returning({ id: garment.id });
  return updated.length > 0;
}

/**
 * Writes the given form fields (the edit form's post: every one;
 * update_garment's: only those that changed); false when the garment is
 * not in `ownerId`'s wardrobe. At least one field.
 */
export function updateGarmentFields(
  db: Db,
  id: number,
  ownerId: number,
  fields: Partial<GarmentFields>,
): Promise<boolean> {
  return updateOwnedGarment(
    db,
    id,
    ownerId,
    storedFields(db, ownerId, fields, id),
  );
}

/**
 * Points the (locked) garment at its new photo and drops the old photo's
 * row; returns the old photo's files for the caller to unlink after commit.
 */
export async function replacePhotoRow(
  tx: Queryable,
  id: number,
  photoId: number,
  previousPhotoId: number | null,
): Promise<StoredPhoto | null> {
  await tx.update(garment).set({ photoId }).where(eq(garment.id, id));
  return deletePhotoRow(tx, previousPhotoId);
}

/**
 * Deletes a garment's `file` row and answers its files as the row was when
 * deleted: the delete waits for a cutout swap holding the row, so a key
 * read earlier (unlocked) could name the set the swap just replaced and
 * leave the new one unlinked.
 */
async function deletePhotoRow(
  tx: Queryable,
  photoId: number | null,
): Promise<StoredPhoto | null> {
  if (photoId === null) return null;
  const [deleted] = await tx
    .delete(file)
    .where(eq(file.id, photoId))
    .returning(STORED_PHOTO_COLUMNS);
  return deleted ?? null;
}

/** What deleteGarment did: the status and photo files of what it deleted, or why not. */
export type DeleteOutcome =
  | { ok: true; status: GarmentStatus; photo: StoredPhoto | null }
  /** Not in `ownerId`'s wardrobe, or not (any more) in the status asked. */
  | { ok: false; reason: 'not-found' }
  /** A suggestion (#333): feedback to the agent, set aside, never deleted. */
  | { ok: false; reason: 'suggestion' };

/**
 * Deletes the garment and its photo's row together; answers the status it
 * had and the photo's files (for the caller to unlink after commit), null
 * without one. Nothing is deleted when the garment is not in `ownerId`'s
 * wardrobe, or not (any more) in `status` when one is given (buyCandidate's
 * clean-up of other candidates deletes only what is still on the wishlist,
 * so a candidate bought meanwhile is kept), or is a suggestion still on the
 * wishlist: those are set aside through decide (src/web/wishlist/decisions.ts), never deleted,
 * the one place that rule lives. The DELETE locks the row and judges its
 * conditions as a transaction it waited on committed them, as lockGarment
 * would, without a statement of its own (#161); only a refusal reads the
 * row again, to say which. Outfit slots that wore it are emptied by their
 * foreign key.
 */
// Only while it is still wanted or set aside: a bought pick is an ordinary
// owned garment, deleted like any (its group's undo copes with a nulled
// resolved_garment_id).
const isSuggestionOnWishlist = sql<boolean>`(${isNotNull(garment.suggestedAt)} and ${onWishlist()})`;

export function deleteGarment(
  db: Queryable,
  id: number,
  ownerId: number,
  status?: GarmentStatus,
): Promise<DeleteOutcome> {
  return db.transaction(async (tx): Promise<DeleteOutcome> => {
    const lock = ownerLockCte(tx, ownerId);
    const [deleted] = await tx
      .with(lock)
      .delete(garment)
      .where(
        and(
          eq(garment.id, id),
          eq(garment.ownerId, ownerId),
          status && eq(garment.status, status),
          not(isSuggestionOnWishlist),
          ownerLocked(tx, lock),
        ),
      )
      .returning({ photoId: garment.photoId, status: garment.status });
    if (deleted) {
      return {
        ok: true,
        status: deleted.status,
        photo: await deletePhotoRow(tx, deleted.photoId),
      };
    }
    const [kept] = await tx
      .select({ suggested: isSuggestionOnWishlist })
      .from(garment)
      .where(
        and(
          eq(garment.id, id),
          eq(garment.ownerId, ownerId),
          status && eq(garment.status, status),
        ),
      );
    return { ok: false, reason: kept?.suggested ? 'suggestion' : 'not-found' };
  });
}

/**
 * Sets one property on every listed garment of `ownerId`'s wardrobe whose
 * role has it (propertyApplies: a sleeve is never set on shoes), in one
 * transaction with the rows locked. Ids outside the wardrobe are ignored,
 * like an unknown id. Materials add one to each garment's set; every other
 * property is replaced (null clears it). Returns how many were set and how
 * many were skipped for their role.
 */
export function bulkSetProperty(
  db: Db,
  ownerId: number,
  ids: number[],
  change: BulkChange,
): Promise<{ updated: number; skipped: number }> {
  return db.transaction(async (tx) => {
    const lock = ownerLockCte(tx, ownerId);
    const rows = await tx
      .with(lock)
      .select({
        id: garment.id,
        category: garment.category,
        materials: garment.materials,
      })
      .from(garment)
      .where(
        and(
          eq(garment.ownerId, ownerId),
          inArray(garment.id, ids),
          ownerLocked(tx, lock),
        ),
      )
      // Id order, as a pick locks them (pickedGarments): two multi-row
      // lockers taking rows in different orders can deadlock.
      .orderBy(garment.id)
      .for('update');
    const applicable = rows.filter((row) => bulkApplies(change, row.category));
    if (change.property === 'materials') {
      await addMaterial(tx, applicable, change.value);
    } else if (applicable.length > 0) {
      await tx
        .update(garment)
        .set(
          change.property === 'condition'
            ? conditionSet(change.value)
            : bulkSet(change),
        )
        .where(
          inArray(
            garment.id,
            applicable.map((row) => row.id),
          ),
        );
    }
    return {
      updated: applicable.length,
      skipped: rows.length - applicable.length,
    };
  });
}

/**
 * Adds `material` to each (locked) garment's set, stored through storedSet
 * as the garment form stores it (MATERIALS order, each once), so a garment
 * that has it keeps its set. One statement per distinct resulting set: a
 * selection is mostly a few shapes of set.
 */
async function addMaterial(
  tx: Queryable,
  rows: { id: number; materials: Material[] | null }[],
  material: Material,
): Promise<void> {
  const bySet = new Map<string, { materials: Material[]; ids: number[] }>();
  for (const row of rows) {
    // Never null: `material` itself is in MATERIALS.
    const materials = storedSet(MATERIALS, [
      ...(row.materials ?? []),
      material,
    ])!;
    const key = materials.join(',');
    const group = bySet.get(key) ?? { materials, ids: [] };
    group.ids.push(row.id);
    bySet.set(key, group);
  }
  for (const { materials, ids } of bySet.values()) {
    await tx.update(garment).set({ materials }).where(inArray(garment.id, ids));
  }
}

/** Condition belongs to every role; the rest are propertyApplies'. */
function bulkApplies(change: BulkChange, category: string): boolean {
  return (
    change.property === 'condition' ||
    propertyApplies(change.property, category)
  );
}

/**
 * A bulk condition. A note says what is wrong: good has none (the column's
 * check); a problem keeps the one already written.
 */
function conditionSet(condition: Condition) {
  return condition === 'good'
    ? { condition, conditionNote: null }
    : { condition };
}

function bulkSet(
  change: Exclude<BulkChange, { property: 'condition' | 'materials' }>,
) {
  switch (change.property) {
    case 'warmth':
      return { warmth: change.value };
    case 'formality':
      return { formality: change.value };
    case 'pattern':
      return { pattern: change.value };
    case 'fit':
      return { fit: change.value };
    case 'sleeve':
      return { sleeve: change.value };
    case 'length':
      return { length: change.value };
    case 'waterResistant':
      return { waterResistant: change.value };
  }
}

// The built-in categories with types, and those whose role has no warmth
// (bags): what "needs tags" asks of each (a custom category has warmth and
// formality but no types).
const BUILT_IN = Object.values(GarmentCategory);
const TYPED_CATEGORIES = BUILT_IN.filter((c) => typesOf(c).length > 0);
const NO_WARMTH = BUILT_IN.filter((c) => !propertyApplies('warmth', c));

/**
 * A garment still missing what the outfit generator and the weather will
 * read: its type (where its category has types), warmth (where its role
 * has one) or formality. Closet garments only (inCloset): an archived one
 * is done with, and a wishlist item is tagged when it is bought. The one
 * definition: tagging mode's card and count, and search_garments'
 * needsTagging (GridFilters.needsTags).
 */
function needsTags(ownerId: number): SQL | undefined {
  return and(
    eq(garment.ownerId, ownerId),
    inCloset(),
    or(
      isNull(garment.formality),
      and(isNull(garment.warmth), notInArray(garment.category, NO_WARMTH)),
      and(isNull(garment.type), inArray(garment.category, TYPED_CATEGORIES)),
    ),
  );
}

/** How many of `ownerId`'s garments still need tags (search_garments' total, the specs). */
export function countToTag(db: Db, ownerId: number): Promise<number> {
  return db.$count(garment, needsTags(ownerId));
}

/**
 * countToTag as a scalar subquery, for a statement that reads it with
 * something else (the grid's prompt, a tagging tap's answer). Its own FROM
 * hides an outer query's `garment`, so the columns inside name its rows.
 */
export function toTagCountSql(ownerId: number): SQL<number> {
  return sql<number>`(select count(*)::int from ${garment} where ${needsTags(ownerId)})`;
}

/** A tap's answer on the tagging card: the garment as saved and the count left, in one statement. */
export async function taggedGarment(
  db: Db,
  id: number,
  ownerId: number,
): Promise<{ garment: GarmentDetail; left: number } | undefined> {
  const [row] = await db
    .select({ ...detailColumns, left: toTagCountSql(ownerId) })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(and(eq(garment.id, id), eq(garment.ownerId, ownerId)));
  if (!row) return undefined;
  const { left, ...tagged } = row;
  return { garment: tagged, left };
}

/** Tagging mode's card: the next garment to tag, and how many still need tags. */
export interface TagQueue {
  /** Undefined past the queue's oldest garment. */
  garment: GarmentDetail | undefined;
  /** Every garment still needing tags, `before` or not (countToTag). */
  left: number;
}

/**
 * The next garment to tag, newest first, below `before` when given: the
 * tagging mode's cursor, so a skipped garment does not come back until the
 * next pass. One statement with the count left: the whole queue is the
 * match, so the window counts it before the limit, and the garments below
 * `before` sort first; when none is, the one row left is above the cursor
 * and no card (a pass that skipped some ends on "N still need details").
 */
export async function nextToTag(
  db: Db,
  ownerId: number,
  before?: number,
): Promise<TagQueue> {
  const belowCursor =
    before === undefined ? [] : [sql`${garment.id} < ${before} desc`];
  const [row] = await db
    .select({
      ...detailColumns,
      left: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(needsTags(ownerId))
    .orderBy(...belowCursor, desc(garment.id))
    .limit(1);
  if (!row) return { garment: undefined, left: 0 };
  const { left, ...next } = row;
  const onCard = before === undefined || next.id < before;
  return { garment: onCard ? next : undefined, left };
}

/** Writes the given properties; false when the garment is not in `ownerId`'s wardrobe. */
export function updateGarmentProperties(
  db: Db,
  id: number,
  ownerId: number,
  fields: Partial<GarmentPropertyFields & CareLabel>,
): Promise<boolean> {
  return updateOwnedGarment(db, id, ownerId, fields);
}

/**
 * The garment page's condition control: sets the condition and its note;
 * false when the garment is not in `ownerId`'s wardrobe.
 */
export function setCondition(
  db: Db,
  id: number,
  ownerId: number,
  fields: ConditionFields,
): Promise<boolean> {
  return updateOwnedGarment(db, id, ownerId, fields);
}
