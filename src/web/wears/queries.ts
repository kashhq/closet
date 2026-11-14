import { and, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import {
  OWNER_LOCKED,
  ownerLockCte,
  ownerLocked,
  ownerLockSql,
} from '../../db/owner-lock';
import { isDeletedClientId, isUniqueViolation } from '../../db/errors';
import { selectScalars } from '../../db/select-scalars';
import {
  file,
  garment,
  GARMENT_WEAR_CLIENT_ID_UNIQUE,
  garmentWear,
  outfitCalendar,
  outfitSlot,
} from '../../db/schema';
import {
  type AwayReason,
  defaultWashAfterByCategory,
  NEVER_WASH,
} from '../../wardrobe/availability';
import { ownerTransaction } from '../auth/queries';
import type { IsoDate } from '../../calendar-date';
import { instantOnDay, type TapInstant } from '../../offline-writes';
import type { SignablePhotoRef } from '../files/image-url';
import { photoRefJson } from '../files/queries';
import type { GarmentDetail } from '../wardrobe/queries';
import { repairCostSql } from '../wardrobe/repairs';
import { inCloset, onWishlist, ownedGarment } from '../wardrobe/status';
import { PERSONS_CHOICE_SET } from '../calendar/planned-by';

/**
 * Wears, washes and away: the owner's own records about their garments
 * (docs/plans/2026-09-26-wardrobe-features.md, section 1). The one writer of
 * each: `garment_wear` rows (setEntryWorn, setWoreToday), last_washed_on
 * (markWashed), away (setAway). Private like outfits and the calendar:
 * every function is scoped to the owner, and the routes never reach them
 * through a share (src/web/wears/routes.tsx).
 *
 * The wash rules as query conditions live here too, built from
 * src/wardrobe/availability.ts's constants so the two cannot drift
 * (test/integration/wears.spec.ts compares them on the same garments).
 * Every expression below is correlated with an unaliased `garment` in the
 * outer query.
 */

// A built-in category's default limit, from the pure table. The values are
// the code's own constants (category names and small integers), inlined
// because a CASE's parameters would be typed text.
const defaultLimit = sql`case ${garment.category} ${sql.raw(
  defaultWashAfterByCategory()
    .map(([category, limit]) => `when '${category}' then ${limit}`)
    .join(' '),
)} end`;

/** washLimit() in SQL: the garment's setting, else its role's; null for never. */
const washLimit = sql<
  number | null
>`(case when ${garment.washAfterWears} = ${sql.raw(
  String(NEVER_WASH),
)} then null else coalesce(${garment.washAfterWears}, ${defaultLimit}) end)`;

/**
 * wearsSinceWash()'s condition on a `garment_wear` row: after the wash's
 * day, or on it with both instants known and the wear later (#676). Plain
 * comparisons: a null instant makes the last term null, which a filter
 * reads as false (the day rule).
 */
const wornSinceWash = sql`(${garment.lastWashedOn} is null or ${garmentWear.day} > ${garment.lastWashedOn} or (${garmentWear.day} = ${garment.lastWashedOn} and ${garmentWear.wornAt} > ${garment.washedAt}))`;

/** wearsSinceWash() in SQL: distinct days worn since the wash. */
export function wearsSinceWashSql(): SQL<number> {
  return sql<number>`(select count(distinct ${garmentWear.day})::int from ${garmentWear} where ${garmentWear.garmentId} = ${garment.id} and ${wornSinceWash})`;
}

/**
 * dirtyCopies() in SQL: floor(wears / limit) (integer division) capped at
 * the quantity; 0 without a limit. The CASE is not a coalesce around
 * least(): Postgres' least() ignores a NULL argument, so a garment that
 * never needs a wash would come out all dirty.
 */
export function dirtyCopiesSql(): SQL<number> {
  return sql<number>`(case when ${washLimit} is null then 0 else least(${garment.quantity}, ${wearsSinceWashSql()} / ${washLimit}) end)::int`;
}

/** needsWash() as a condition: at least one copy needs a wash. */
export function needsWash(): SQL {
  return sql`${dirtyCopiesSql()} > 0`;
}

/**
 * The generator-facing "available" rule as a query condition (isAvailable in
 * src/wardrobe/availability.ts): in the closet (inCloset: not a wishlist
 * item, not archived), not away, with a clean copy left. For the outfit gallery (#9) and the packing list
 * (#10): add it to the pool's where clause. Condition never counts.
 */
export function availableGarment(): SQL {
  return and(
    inCloset(),
    isNull(garment.away),
    sql`${dirtyCopiesSql()} < ${garment.quantity}`,
  )!;
}

/** The garment page's wear line: "Worn 12 times · 2 since washed · last worn yesterday". */
export interface WearSummary {
  /** Days worn, ever. */
  worn: number;
  sinceWash: number;
  lastWorn: IsoDate | null;
  /**
   * How it was worn on `lastWorn`: by "Wore today" (undoable; it wins when
   * both), through a worn calendar entry, or null, never worn. No "worn
   * today": the page's script judges that against the page's day (#708,
   * views/assets/page-day.ts), so the page reads the same tomorrow.
   */
  lastWornBy: 'single' | 'entry' | null;
  /** Its repairs' costs summed (repairCostSql), for the wear line's cost per wear. */
  repairCost: string | null;
}

/**
 * The garment's wear counts and what its repairs cost, as a scalar
 * subquery (a JSON object), so a page reads it with the rest in one
 * statement: the garment page (garmentContext,
 * src/web/wardrobe/garment-context.ts) and the wear routes' answer
 * (wearStatusOf). The owner's own records: the caller is the owner and has
 * found the garment in their wardrobe, so its row (grouped with none or
 * more wears) is there. A column of selectScalars, never of a Drizzle
 * select from one table (see wearStatusOf).
 */
export function wearSummarySql(
  garmentId: number,
  today: IsoDate,
): SQL<WearSummary> {
  // The last day's wears, a single one first: one aggregate, no subquery.
  const lastWornBy = sql`(array_agg(
    case when ${garmentWear.outfitCalendarId} is null then 'single' else 'entry' end
    order by ${garmentWear.day} desc, ${garmentWear.outfitCalendarId} desc nulls first
  ) filter (where ${garmentWear.day} is not null))[1]`;
  return sql<WearSummary>`(
    select json_build_object(
      'worn', count(distinct ${garmentWear.day})::int,
      'sinceWash', (count(distinct ${garmentWear.day}) filter (where ${wornSinceWash}))::int,
      'lastWorn', max(${garmentWear.day})::text,
      'lastWornBy', ${lastWornBy},
      'repairCost', ${repairCostSql(garment.id, today)}
    )
    from ${garment}
    left join ${garmentWear} on ${eq(garmentWear.garmentId, garment.id)}
    where ${eq(garment.id, garmentId)}
    group by ${garment.id}
  )`;
}

/**
 * Every garment of the owner's wears in one grouped read: the days worn
 * (distinct days, as WearSummary.worn) and the last (WearSummary.lastWorn),
 * keyed by garment id. A garment never worn has no entry. get_wardrobe
 * (src/web/mcp/tools/garments.ts) reads it instead of a wearSummarySql per
 * garment; insights' insightGarments counts the same way.
 */
export async function wearCountsByGarment(
  db: Queryable,
  ownerId: number,
): Promise<Map<number, Pick<WearSummary, 'worn' | 'lastWorn'>>> {
  const rows = await db
    .select({
      garmentId: garmentWear.garmentId,
      worn: sql<number>`count(distinct ${garmentWear.day})::int`,
      lastWorn: sql<IsoDate | null>`max(${garmentWear.day})::text`,
    })
    .from(garmentWear)
    .where(eq(garmentWear.ownerId, ownerId))
    .groupBy(garmentWear.garmentId);
  return new Map(rows.map(({ garmentId, ...counts }) => [garmentId, counts]));
}

/** A garment as the wear line reads it (WearStatus, wear-section.tsx). */
export type WearGarment = Pick<
  GarmentDetail,
  | 'id'
  | 'name'
  | 'status'
  | 'category'
  | 'quantity'
  | 'price'
  | 'washAfterWears'
  | 'lastWashedOn'
>;

/**
 * What Wore today and Washed answer (WearStatus, wear-section.tsx): the
 * owner's garment as the wear line reads it, and its wear summary, in one
 * statement. Undefined when it is not the owner's. Through selectScalars,
 * not a select from garment with the summary as a column: Drizzle writes a
 * single-table select's columns unqualified, the subquery's included, and
 * its `garment` and `garment_wear` then both answer to "id".
 */
export async function wearStatusOf(
  db: Queryable,
  garmentId: number,
  ownerId: number,
  today: IsoDate,
): Promise<{ garment: WearGarment; summary: WearSummary } | undefined> {
  const { shown, summary } = await selectScalars(db, {
    shown: sql<WearGarment | null>`(
      select json_build_object(
        'id', ${garment.id},
        'name', ${garment.name},
        'status', ${garment.status},
        'category', ${garment.category},
        'quantity', ${garment.quantity},
        'price', ${garment.price}::text,
        'washAfterWears', ${garment.washAfterWears},
        'lastWashedOn', ${garment.lastWashedOn}
      )
      from ${garment}
      where ${and(eq(garment.id, garmentId), eq(garment.ownerId, ownerId))}
    )`,
    summary: wearSummarySql(garmentId, today),
  });
  return shown ? { garment: shown, summary } : undefined;
}

/** A garment on the laundry page. */
export interface LaundryItem {
  id: number;
  name: string | null;
  category: string;
  photo: SignablePhotoRef | null;
  quantity: number;
  /** Copies that need a wash; 0 for one worn but not due yet. */
  dirty: number;
}

/**
 * The owner's garments worn since their last wash that can get dirty (a
 * limit), in the closet (inCloset) and not away: those needing a wash
 * first, most copies first, then those worn but not due yet, newest first.
 */
export async function laundryList(
  db: Db,
  ownerId: number,
): Promise<LaundryItem[]> {
  return db
    .select({
      id: garment.id,
      name: garment.name,
      category: garment.category,
      photo: photoRefJson,
      quantity: garment.quantity,
      dirty: dirtyCopiesSql(),
    })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(
      and(
        eq(garment.ownerId, ownerId),
        inCloset(),
        isNull(garment.away),
        sql`${washLimit} is not null`,
        sql`${wearsSinceWashSql()} > 0`,
      ),
    )
    .orderBy(desc(dirtyCopiesSql()), desc(garment.id));
}

/**
 * The owner's garments in the closet, not away, with a copy that needs a
 * wash: the wardrobe's laundry prompt counts them (gridContext,
 * src/web/wardrobe/grid-context.ts).
 */
export function needingWash(ownerId: number): SQL {
  return and(
    eq(garment.ownerId, ownerId),
    inCloset(),
    isNull(garment.away),
    needsWash(),
  )!;
}

/** How many of the owner's garments need a wash (needingWash). */
export function countNeedingWash(db: Db, ownerId: number): Promise<number> {
  return db.$count(garment, needingWash(ownerId));
}

export type EntryWornOutcome =
  | {
      worn: boolean;
      changed: boolean;
      wears: number;
      /** The entry's day: the selfie that marked it is filed under it. */
      day: IsoDate;
    }
  | 'not-found'
  | 'future';

/**
 * Marks the owner's calendar entry worn or not, and its wears with it, in
 * one transaction (the entry locked, so two taps take turns): marking
 * snapshots the outfit's garments as they are now into `garment_wear`, one
 * row per garment on the entry's day, so editing the outfit later never
 * changes this history; unmarking deletes exactly the entry's rows
 * (deleting the entry does the same, by its foreign key). `worn` undefined
 * toggles (the pill posted by a page cached before it said which).
 * Either way a week planner's entry becomes the person's (planned_by
 * 'user', #16): they have acted on it, so its re-plan never swaps it.
 * Idempotent: an entry already so is left alone. A day after `today` is
 * never marked worn ('future'). `at` is when it was worn (the tap; the seed's
 * evening). Used by POST /calendar/:id/worn and the seed. Under the owner
 * lock like every calendar write (src/web/calendar/AGENTS.md): the re-plan
 * must see the entry as the person's before it judges it, not swap it
 * while the tap commits.
 *
 * Three statements in its transaction (#165; production pays a ~114 ms
 * round trip per statement): the owner lock, the entry locked and read,
 * then the change and its wears together (markWorn, unmarkWorn).
 */
export function setEntryWorn(
  db: Queryable,
  input: {
    entryId: number;
    ownerId: number;
    worn: boolean | undefined;
    at: Date;
    today: IsoDate;
    tap?: TapInstant | null;
  },
): Promise<EntryWornOutcome> {
  return ownerTransaction(db, input.ownerId, 'setEntryWorn', async (tx) => {
    const [entry] = await tx
      .select({
        id: outfitCalendar.id,
        day: outfitCalendar.day,
        outfitId: outfitCalendar.outfitId,
        wornAt: outfitCalendar.wornAt,
      })
      .from(outfitCalendar)
      .where(
        and(
          eq(outfitCalendar.id, input.entryId),
          eq(outfitCalendar.ownerId, input.ownerId),
        ),
      )
      .for('update');
    if (!entry) return 'not-found';
    return changeEntryWorn(tx, entry, input);
  });
}

/** An entry of the owner's as marking it worn reads it, locked by the caller. */
export interface LockedEntry {
  id: number;
  day: IsoDate;
  outfitId: number;
  wornAt: Date | null;
}

/**
 * setEntryWorn's change, on an entry its caller holds locked under the
 * owner lock: setEntryWorn (which locks it by id) and wearOutfitOn
 * (src/web/calendar/queries.ts, whose planning statement locks and reads
 * it, #166). The one place the worn rule is decided: idempotent, a day
 * after `today` is never marked ('future'), and the wears change with it.
 */
export async function changeEntryWorn(
  tx: Queryable,
  entry: LockedEntry,
  input: {
    ownerId: number;
    worn: boolean | undefined;
    /** When the mark is made: the entry's `worn_at` and the wears' `created_at`. */
    at: Date;
    today: IsoDate;
    /**
     * When the outfit was worn, for its wears' `worn_at` (#676): the tap's
     * (requestTap: a replay's posted instant, null for a replay without
     * one). Undefined is the mark itself, `at` on `today`.
     */
    tap?: TapInstant | null;
  },
): Promise<Exclude<EntryWornOutcome, 'not-found'>> {
  const { day } = entry;
  const was = entry.wornAt !== null;
  const worn = input.worn ?? !was;
  if (worn === was) return { worn, changed: false, wears: 0, day };
  if (!worn) {
    const wears = await unmarkWorn(tx, entry.id);
    return { worn, changed: true, wears, day };
  }
  if (day > input.today) return 'future';
  // The tap's instant is the wear's only on the entry's own day (#676): a
  // past day's "Worn?" is a backfill, and the day rule judges it.
  const tap =
    input.tap === undefined ? { at: input.at, day: input.today } : input.tap;
  const wears = await markWorn(
    tx,
    { ...entry, ownerId: input.ownerId },
    input.at,
    instantOnDay(tap, day),
  );
  return { worn, changed: true, wears, day };
}

/**
 * The entry worn at `at` (and the person's), and one wear per garment of its
 * outfit on its day, `wornAt` its instant when known on that day: the outfit's garments as they are now, so a later edit
 * of the outfit never changes this history. One statement; data-modifying
 * CTEs run to completion whether or not the final select reads them.
 * Answers how many garments were recorded. A slot only ever names a garment
 * of the outfit's owner (the outfit form's rule); the join keeps it so here
 * too.
 */
async function markWorn(
  tx: Queryable,
  entry: { id: number; day: IsoDate; outfitId: number; ownerId: number },
  at: Date,
  wornAt: Date | null,
): Promise<number> {
  const { rows } = await tx.execute<{ wears: number }>(sql`
    with marked as (
      update ${outfitCalendar} set worn_at = ${at}, ${PERSONS_CHOICE_SET}
      where ${outfitCalendar.id} = ${entry.id}
    ), worn as (
      select distinct ${garment.id} as garment_id
      from ${outfitSlot} inner join ${garment} on ${garment.id} = ${outfitSlot.garmentId}
      where ${outfitSlot.outfitId} = ${entry.outfitId} and ${garment.ownerId} = ${entry.ownerId}
    ), logged as (
      insert into ${garmentWear} (garment_id, owner_id, day, outfit_calendar_id, worn_at, created_at)
      select garment_id, ${entry.ownerId}::integer, ${entry.day}::date, ${entry.id}::integer, ${wornAt}::timestamptz, ${at}::timestamptz
      from worn
      on conflict do nothing
    )
    select count(*)::int as wears from worn`);
  return rows[0].wears;
}

/**
 * The entry no longer worn (and the person's), and exactly its wears gone,
 * in one statement. Answers how many wears went.
 */
async function unmarkWorn(tx: Queryable, entryId: number): Promise<number> {
  const { rows } = await tx.execute<{ wears: number }>(sql`
    with unmarked as (
      update ${outfitCalendar} set worn_at = null, ${PERSONS_CHOICE_SET}
      where ${outfitCalendar.id} = ${entryId}
    ), removed as (
      delete from ${garmentWear} where ${garmentWear.outfitCalendarId} = ${entryId}
      returning 1
    )
    select count(*)::int as wears from removed`);
  return rows[0].wears;
}

/**
 * An insert's conflict with the garment's day-level wear of that day
 * (garment_wear_garment_id_day_single_unique): the wear stays, with the
 * later known instant of the two (#676: a known one beats null, so a wear
 * after the day's wash is never dropped to the day rule), and is updated
 * only when that moves, so a repeat bumps no revision and answers no row.
 * Used by setWoreToday and detachOutfitWears.
 */
const ON_DAY_WEAR_KEEP_LATER_INSTANT = sql`on conflict (garment_id, day) where outfit_calendar_id is null do update
  set worn_at = excluded.worn_at
  where excluded.worn_at is not null
    and (${garmentWear.wornAt} is null or excluded.worn_at > ${garmentWear.wornAt})`;

/**
 * Keeps the wears of an outfit's calendar entries when the outfit is about
 * to be deleted (its entries cascade with it, and their wears would with
 * them): each becomes a day-level wear, the shape "Wore today" writes
 * (outfit_calendar_id null, the garment, owner, day, worn_at and created_at
 * kept). Where the garment already has a day-level wear that day, that one
 * stays, taking the entry wear's instant when it is the later known one,
 * and the entry's row goes with the entry (distinct days count once
 * anyway). Run inside the deleting transaction, before the delete; the
 * entries are locked first, so a worn pill tapped meanwhile waits and then
 * finds its entry gone. Returns the wears kept.
 *
 * One statement, whether the outfit has entries or not (#164; up to three
 * before): the entries locked, the copies inserted, the entry wears
 * deleted. The insert and the delete read the same snapshot, so the
 * insert copies the rows the delete removes, and the copies (no entry)
 * are not among them. No other writer of these wears can run meanwhile:
 * they all hold the owner lock, which the caller holds.
 *
 * Used by deleteOutfit (src/web/outfits/queries.ts) only. Deleting one
 * calendar entry (deleteEntry) still removes its wears: that is the user
 * saying the entry was wrong, and the issue's rule. Deleting the outfit is
 * tidying the outfit list; the days it was worn stay history.
 */
export async function detachOutfitWears(
  tx: Queryable,
  outfitId: number,
  ownerId: number,
): Promise<number> {
  const entries = tx
    .select({ id: outfitCalendar.id })
    .from(outfitCalendar)
    .where(
      and(
        eq(outfitCalendar.outfitId, outfitId),
        eq(outfitCalendar.ownerId, ownerId),
      ),
    )
    .for('update');
  const ofEntries = sql`${garmentWear.outfitCalendarId} in (select id from entries)`;
  // An existing day-level wear stays, with the later known instant
  // (ON_DAY_WEAR_KEEP_LATER_INSTANT), so the day's wears since its wash
  // stay as they were. An outfit has one entry a day at most, so the select itself
  // holds no two rows for one key. `kept` counts the inserted copies alone
  // (xmax = 0). The final select counts the entries so they are locked even
  // when no wear needs them read.
  const { rows } = await tx.execute<{ kept: number }>(sql`
    with entries as materialized (${entries}),
    kept as (
      insert into ${garmentWear} (garment_id, owner_id, day, outfit_calendar_id, worn_at, created_at)
      select ${garmentWear.garmentId}, ${garmentWear.ownerId}, ${garmentWear.day}, null, ${garmentWear.wornAt}, ${garmentWear.createdAt}
      from ${garmentWear}
      where ${ofEntries}
      ${ON_DAY_WEAR_KEEP_LATER_INSTANT}
      returning xmax = 0 as inserted
    ),
    moved as (delete from ${garmentWear} where ${ofEntries})
    select (select count(*)::int from kept where inserted) as kept, (select count(*) from entries) as entries`);
  return rows[0].kept;
}

/**
 * "Wore today" on the garment page: one wear of the garment alone on `day`,
 * at most one a day (garment_wear_garment_id_day_single_unique), or its
 * undo, which removes only that row (a worn calendar entry's stay).
 * 'not-found' when the garment is not the owner's, 'wishlist' when it is a
 * wishlist item (not owned yet, so not worn), and nothing written for
 * either; 'unchanged' when it already was so (a replayed tap, #178).
 * `day` is today, or a queued tap's own day. One statement: the lookup is
 * a CTE the write reads, so the garment page's tap costs one round trip,
 * not two (#160), the owner lock its first CTE (src/db/owner-lock.ts).
 *
 * `clientId` is a queued wear's (the outbox record's, #196a), stored on the
 * row it creates. A wear already there for (garment, day) is kept with its
 * own client id, whatever this one says: the retry is 'unchanged'. Refused
 * without writing: 'gone' when the client id's wear was deleted since (its
 * tombstone; the sync triggers refuse it), 'client-id-taken' when it names
 * another wear (a reused id).
 */
export async function setWoreToday(
  db: Queryable,
  input: {
    garmentId: number;
    ownerId: number;
    day: IsoDate;
    worn: boolean;
    /** The wear's instant on its day, or null (instantOnDay, #676). */
    wornAt: Date | null;
    clientId?: string;
  },
): Promise<
  | 'changed'
  | 'unchanged'
  | 'not-found'
  | 'wishlist'
  | 'gone'
  | 'client-id-taken'
> {
  // The conflict target is the day's single wear alone: a client id taken
  // by another wear is a unique violation, never a silent no-op. A wear
  // already there keeps its id and takes this one's instant when later
  // (an older outbox's timeless replay, then the tap that knows it).
  const write = input.worn
    ? sql`insert into ${garmentWear} (garment_id, owner_id, day, worn_at, client_id)
        select id, owner_id, ${input.day}::date, ${input.wornAt}::timestamptz, ${input.clientId ?? null}::uuid
        from owned where not wishlist
        ${ON_DAY_WEAR_KEEP_LATER_INSTANT}
        returning 1`
    : sql`delete from ${garmentWear}
        where ${and(
          eq(garmentWear.garmentId, input.garmentId),
          eq(garmentWear.day, input.day),
          isNull(garmentWear.outfitCalendarId),
        )}
        and exists (select 1 from owned where not wishlist)
        returning 1`;
  let written;
  try {
    written = await db.execute<{ wishlist: boolean; changed: boolean }>(sql`
    with ${ownerLockSql(db, input.ownerId)},
    owned as (
      select ${garment.id} as id, ${garment.ownerId} as owner_id,
        ${onWishlist()} as wishlist
      from ${garment}
      where ${and(eq(garment.id, input.garmentId), eq(garment.ownerId, input.ownerId))}
        and ${OWNER_LOCKED}
    ),
    written as (${write})
    select wishlist, exists (select 1 from written) as changed from owned`);
  } catch (error) {
    if (isDeletedClientId(error)) return 'gone';
    if (isUniqueViolation(error, GARMENT_WEAR_CLIENT_ID_UNIQUE)) {
      return 'client-id-taken';
    }
    throw error;
  }
  const [owned] = written.rows;
  if (!owned) return 'not-found';
  if (owned.wishlist) return 'wishlist';
  return owned.changed ? 'changed' : 'unchanged';
}

/**
 * Washes the listed garments of the owner on `day` (every copy: laundry
 * day) at `at`, its instant on that day or null (instantOnDay, #676); the
 * ids of others and of wishlist items ignored like unknown ones. Returns
 * the garments washed, each with whether its wash moved. Monotone: a wash
 * never moves back, so a queued wash replayed after a later one (#178)
 * changes nothing; washed has no undo. On the same day only a later known
 * instant moves it: a timeless wash never erases a known one (an old
 * client's replay must not uncount the evening's wear), and a known one
 * replaces a timeless one. A later day takes its own instant, null or not.
 * The garment page's Washed, the laundry page's batch, the API, MCP's
 * mark_washed and the seed's Sundays.
 *
 * An archived garment may be washed (its own page offers Washed, e.g. before
 * it is stored away), so the writer accepts it; a batch acting on "what the
 * grid shows" passes `closetOnly` so a Select all over the archive does not
 * wash what the user did not mean to (#816).
 *
 * One statement: the owner lock, the garments named (owned), and the
 * update of only those whose wash moves, so a repeat tap writes no row
 * and sends no revision to the changes feed.
 */
export async function markWashed(
  db: Queryable,
  ownerId: number,
  ids: number[],
  day: IsoDate,
  at: Date | null,
  { closetOnly = false }: { closetOnly?: boolean } = {},
): Promise<{ id: number; changed: boolean }[]> {
  if (ids.length === 0) return [];
  const laterDay = sql`(${garment.lastWashedOn} is null or ${day}::date > ${garment.lastWashedOn})`;
  const laterInstant = sql`(${day}::date = ${garment.lastWashedOn} and ${at}::timestamptz is not null and (${garment.washedAt} is null or ${at}::timestamptz > ${garment.washedAt}))`;
  const { rows } = await db.execute<{ id: number; changed: boolean }>(sql`
    with ${ownerLockSql(db, ownerId)},
    named as (
      select ${garment.id} as id from ${garment}
      where ${and(eq(garment.ownerId, ownerId), inArray(garment.id, ids), closetOnly ? inCloset() : ownedGarment())}
        and ${OWNER_LOCKED}
    ),
    moved as (
      update ${garment}
      set last_washed_on = ${day}::date, washed_at = ${at}::timestamptz
      where ${garment.id} in (select id from named) and ${OWNER_LOCKED}
        and (${laterDay} or ${laterInstant})
      returning ${garment.id} as id
    )
    select named.id, moved.id is not null as changed
    from named left join moved on moved.id = named.id`);
  return rows;
}

/**
 * Puts the owner's garment away (lent, at the repair shop) with a note, or
 * back in the closet (null, which clears the note). False when it is not
 * the owner's, or a wishlist item (nothing to lend yet).
 */
export async function setAway(
  db: Queryable,
  ownerId: number,
  garmentId: number,
  away: { reason: AwayReason; note: string | null } | null,
): Promise<boolean> {
  const lock = ownerLockCte(db, ownerId);
  const updated = await db
    .with(lock)
    .update(garment)
    .set({ away: away?.reason ?? null, awayNote: away?.note ?? null })
    .where(
      and(
        eq(garment.id, garmentId),
        eq(garment.ownerId, ownerId),
        ownedGarment(),
        ownerLocked(db, lock),
      ),
    )
    .returning({ id: garment.id });
  return updated.length > 0;
}

/** A wear as the changes feed carries it (wearsByIds, wear-resource.ts). */
export interface WearRow {
  id: number;
  garmentId: number;
  day: string;
  /** The calendar entry it was logged from; null for a single "Wore today". */
  outfitCalendarId: number | null;
  /** Its instant on its day, when known (#676). */
  wornAt: Date | null;
}

/**
 * The wears with these ids, in one statement (the changes feed's page,
 * src/web/sync/feed.ts, which read the ids from the owner's own wardrobe
 * in the same snapshot: a grantee's feed never carries a wear).
 */
export function wearsByIds(
  db: Queryable,
  ids: readonly number[],
): Promise<WearRow[]> {
  return db
    .select({
      id: garmentWear.id,
      garmentId: garmentWear.garmentId,
      day: garmentWear.day,
      outfitCalendarId: garmentWear.outfitCalendarId,
      wornAt: garmentWear.wornAt,
    })
    .from(garmentWear)
    .where(inArray(garmentWear.id, [...ids]));
}
