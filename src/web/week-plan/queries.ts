import {
  and,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lt,
  not,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import {
  garment,
  garmentWear,
  outfit,
  outfitCalendar,
  outfitSlot,
  weekPlan,
  weekPlanEntry,
  weekReplan,
} from '../../db/schema';
import { washLimit } from '../../wardrobe/availability';
import type { Occasion } from '../../wardrobe/occasions';
import { categoryRole, isWarmth } from '../../wardrobe/properties';
import type { PlannedBy } from '../../wardrobe/week';
import type {
  OutfitGarmentState,
  PlannedNeeds,
  WeekEntry,
} from '../../wardrobe/week-planner';
import { type GarmentWeatherFields, matchGarment } from '../../weather/match';
import type { IsoDate } from '../../calendar-date';
import { type OutfitGarment, outfitGarmentsSql } from '../outfits/queries';
import { ONE_OFF_ORIGINS } from '../../wardrobe/outfit-origin';
import { outfitIsHeld } from '../outfits/references';
import { awayOnSql } from '../trips/away';
import { wearsSinceWashSql } from '../wears/queries';

/**
 * The weekly auto-plan's rows (#16): the calendar window the planner reads,
 * the batches ("Plan my week" taps) and what each auto entry was planned
 * for, and the daily re-plan's claims. The signed-in owner's own, like the
 * calendar. The writes here run inside plan.ts's and replan.ts's
 * transactions (under lockOwner), and createOutfit's (adoptOutfit,
 * adopt.ts); calendar entries themselves are only ever written through
 * insertEntry (pickIdea) and removed by removeAutoEntries.
 */

/** A calendar entry in the planner's window: what week-planner.ts reads, and who planned it. */
export interface WindowEntry extends WeekEntry {
  outfitId: number;
  plannedBy: PlannedBy;
}

/** windowEntriesSql's element: an entry, its outfit's garments' weather fields. */
export interface WindowEntryJson extends Omit<WindowEntry, 'garments'> {
  garments: ({ id: number } & GarmentWeatherFields)[];
}

/**
 * The owner's entries from `first` to `last` (inclusive) with their
 * outfits' garments as the planner judges them, as a scalar subquery (a
 * JSON list, readWindowEntries), so the re-plan reads them in the statement
 * that reads its pool (weekSql, plan.ts; #173). Served by the unique
 * (owner_id, day, outfit_id) index.
 */
export function windowEntriesSql(
  ownerId: number,
  first: IsoDate,
  last: IsoDate,
): SQL<WindowEntryJson[]> {
  return sql<WindowEntryJson[]>`(
    select coalesce(json_agg(json_build_object(
      'id', ${outfitCalendar.id},
      'day', ${outfitCalendar.day},
      'occasion', ${outfitCalendar.occasion},
      'worn', ${outfitCalendar.wornAt} is not null,
      'plannedBy', ${outfitCalendar.plannedBy},
      'outfitId', ${outfitCalendar.outfitId},
      'garments', (
        select coalesce(json_agg(json_build_object(
          'id', ${garment.id},
          'category', ${garment.category},
          'type', ${garment.type},
          'fabricWeight', ${garment.fabricWeight},
          'warmth', ${garment.warmth},
          'waterResistant', ${garment.waterResistant}
        ) order by ${outfitSlot.position}), '[]')
        from ${outfitSlot}
        inner join ${garment} on ${garment.id} = ${outfitSlot.garmentId}
        where ${outfitSlot.outfitId} = ${outfitCalendar.outfitId}
      )
    ) order by ${outfitCalendar.day}, ${outfitCalendar.id}), '[]')
    from ${outfitCalendar}
    where ${outfitCalendar.ownerId} = ${ownerId}
      and ${outfitCalendar.day} between ${first} and ${last})`;
}

/** windowEntriesSql's value as the planner's entries (role and weather). */
export function readWindowEntries(
  rows: readonly WindowEntryJson[],
): WindowEntry[] {
  return rows.map(({ garments, ...entry }) => ({
    ...entry,
    garments: garments.map((garment) => ({
      id: garment.id,
      role: categoryRole(garment.category),
      weather: matchGarment(garment),
    })),
  }));
}

/** An entry the planner wrote and still owns, with its batch and what it was planned for. */
export interface AutoEntryRow {
  entryId: number;
  day: IsoDate;
  outfitId: number;
  weekPlanId: number;
  outfitCreated: boolean;
  plannedFor: PlannedNeeds | null;
  /** A trip covers its day (awayOnSql): the re-plan removes it, never judges it (#684). */
  away: boolean;
}

// A type, not an interface: execute's row type needs its implicit index signature.
type EntryRow = Omit<AutoEntryRow, 'plannedFor'> & {
  torso: number | null;
  limbs: number | null;
  layer: boolean | null;
  rain: boolean | null;
  limbsCeiling: number | null;
};

function autoEntryOf(row: EntryRow): AutoEntryRow {
  const { torso, limbs, layer, rain } = row;
  // A column check keeps it 1-5; the guard narrows it for the type.
  const limbsCeiling = isWarmth(row.limbsCeiling) ? row.limbsCeiling : null;
  return {
    entryId: row.entryId,
    day: row.day,
    outfitId: row.outfitId,
    weekPlanId: row.weekPlanId,
    outfitCreated: row.outfitCreated,
    away: row.away,
    // The check constraint keeps the four together.
    plannedFor:
      torso === null || limbs === null || layer === null || rain === null
        ? null
        : { torso, limbs, layer, rain, limbsCeiling },
  };
}

/**
 * The owner's auto entries (planned_by 'auto', not worn) from `day` on,
 * what the re-plan may judge, **and the day's claim**, in one statement
 * (#173; they were two): the insert into week_replan runs only when there
 * is an auto entry (none: nothing claimed, so a week planned later today
 * is judged by a later run), `ON CONFLICT DO NOTHING`. The entries when
 * this call claimed the day; undefined when there was none or the day was
 * claimed already (another run, the morning reminder, a second server),
 * which the caller treats alike: nothing to do. Called inside the
 * re-plan's transaction under lockOwner, so the claim commits with the
 * work (claimAutoEntries' rule). Entries the person has since edited or worn
 * are 'user' and never come back here. Each says whether a trip covers its
 * day (`away`), so the re-plan removes those before it reads the week.
 */
export async function claimAutoEntries(
  tx: Queryable,
  ownerId: number,
  day: IsoDate,
  now: Date,
): Promise<AutoEntryRow[] | undefined> {
  // The casts: an INSERT ... SELECT's parameters are otherwise text.
  const { rows } = await tx.execute<EntryRow & { claimed: boolean }>(sql`
    with auto as (
      select ${weekPlanEntry.entryId} as "entryId",
        ${outfitCalendar.day} as "day",
        ${outfitCalendar.outfitId} as "outfitId",
        ${weekPlanEntry.weekPlanId} as "weekPlanId",
        ${weekPlanEntry.outfitCreated} as "outfitCreated",
        ${weekPlanEntry.torso} as "torso",
        ${weekPlanEntry.limbs} as "limbs",
        ${weekPlanEntry.layer} as "layer",
        ${weekPlanEntry.rain} as "rain",
        ${weekPlanEntry.limbsCeiling} as "limbsCeiling"
      from ${weekPlanEntry}
      inner join ${outfitCalendar} on ${outfitCalendar.id} = ${weekPlanEntry.entryId}
      where ${outfitCalendar.ownerId} = ${ownerId}
        and ${outfitCalendar.plannedBy} = 'auto'
        and ${outfitCalendar.wornAt} is null
        and ${outfitCalendar.day} >= ${day}
    ), claimed as (
      insert into ${weekReplan} (user_id, day, claimed_at)
      select ${ownerId}::int, ${day}::date, ${now}::timestamptz
      where exists (select 1 from auto)
      on conflict (user_id, day) do nothing
      returning user_id
    )
    select auto.*, ${awayOnSql(ownerId, sql`auto."day"`)} as "away",
      exists (select 1 from claimed) as claimed
    from auto
    order by auto.day, auto."entryId"`);
  if (rows.length === 0 || !rows[0].claimed) return undefined;
  return rows.map(autoEntryOf);
}

/** A new batch: one "Plan my week". */
export async function createWeekPlan(
  tx: Queryable,
  ownerId: number,
): Promise<number> {
  const [row] = await tx
    .insert(weekPlan)
    .values({ ownerId })
    .returning({ id: weekPlan.id });
  return row.id;
}

/** Whether batch `id` is the owner's (another's is a miss, like an unknown id). */
export async function weekPlanOf(
  db: Queryable,
  ownerId: number,
  id: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: weekPlan.id })
    .from(weekPlan)
    .where(and(eq(weekPlan.id, id), eq(weekPlan.ownerId, ownerId)));
  return row !== undefined;
}

/** Records an entry the planner just wrote. */
export async function recordAutoEntry(
  tx: Queryable,
  entry: {
    entryId: number;
    weekPlanId: number;
    outfitCreated: boolean;
    needs: PlannedNeeds | null;
  },
): Promise<void> {
  await tx.insert(weekPlanEntry).values({
    entryId: entry.entryId,
    weekPlanId: entry.weekPlanId,
    outfitCreated: entry.outfitCreated,
    ...needsColumns(entry.needs),
  });
}

/** The re-plan kept an entry under new targets: they are what it is judged against next. */
export async function updatePlannedNeeds(
  tx: Queryable,
  entryId: number,
  needs: PlannedNeeds,
): Promise<void> {
  await tx
    .update(weekPlanEntry)
    .set(needsColumns(needs))
    .where(eq(weekPlanEntry.entryId, entryId));
}

function needsColumns(needs: PlannedNeeds | null) {
  return (
    needs ?? {
      torso: null,
      limbs: null,
      layer: null,
      rain: null,
      limbsCeiling: null,
    }
  );
}

/**
 * Deletes the entries of the owner's batch `weekPlanId` that the planner
 * still owns (planned_by 'auto': one the person took over stays): what Undo
 * takes back. One statement, where reading the batch, then its entries,
 * then deleting them were three (#165). Answers each deleted entry's
 * outfit and whether the planner created it, for removeUnheldOutfits.
 * Nothing for another's batch, a missing one, or one with no auto entry
 * left: the caller tells those apart (weekPlanOf) only then.
 */
export async function removeBatchAutoEntries(
  tx: Queryable,
  ownerId: number,
  weekPlanId: number,
): Promise<{ entryId: number; outfitId: number; outfitCreated: boolean }[]> {
  const { rows } = await tx.execute<{
    entry_id: number;
    outfit_id: number;
    outfit_created: boolean;
  }>(sql`
    delete from ${outfitCalendar}
    using ${weekPlanEntry}, ${weekPlan}
    where ${weekPlanEntry.entryId} = ${outfitCalendar.id}
      and ${weekPlan.id} = ${weekPlanEntry.weekPlanId}
      and ${weekPlan.id} = ${weekPlanId}
      and ${weekPlan.ownerId} = ${ownerId}
      and ${outfitCalendar.ownerId} = ${ownerId}
      and ${outfitCalendar.plannedBy} = 'auto'
    returning ${outfitCalendar.id} as entry_id, ${outfitCalendar.outfitId} as outfit_id,
      ${weekPlanEntry.outfitCreated} as outfit_created`);
  return rows.map((row) => ({
    entryId: row.entry_id,
    outfitId: row.outfit_id,
    outfitCreated: row.outfit_created,
  }));
}

/**
 * Removes the owner's unworn auto entries (only those still 'auto': one the
 * person or an agent took over meanwhile stays), by id (the re-plan's swap
 * and its days away) or every one from `from` to `to` (a trip's days, when
 * it is created or re-dated: trips/queries.ts, #684), and then each outfit
 * the planner created for the ones that went that nothing holds any more
 * (removeUnheldOutfits). An outfit the planner found already saved is the
 * person's and stays. One delete, then the outfits only when one went.
 * Returns what went.
 */
export async function removeAutoEntries(
  tx: Queryable,
  ownerId: number,
  which: { entryIds: readonly number[] } | { from: IsoDate; to: IsoDate },
): Promise<{ entries: number; outfits: number }> {
  if ('entryIds' in which && which.entryIds.length === 0) {
    return { entries: 0, outfits: 0 };
  }
  const chosen =
    'entryIds' in which
      ? inArray(outfitCalendar.id, [...which.entryIds])
      : sql`${outfitCalendar.day} between ${which.from} and ${which.to}`;
  const { rows } = await tx.execute<{
    outfit_id: number;
    outfit_created: boolean;
  }>(sql`
    delete from ${outfitCalendar}
    using ${weekPlanEntry}
    where ${weekPlanEntry.entryId} = ${outfitCalendar.id}
      and ${outfitCalendar.ownerId} = ${ownerId}
      and ${outfitCalendar.plannedBy} = 'auto'
      and ${outfitCalendar.wornAt} is null
      and ${chosen}
    returning ${outfitCalendar.outfitId} as outfit_id,
      ${weekPlanEntry.outfitCreated} as outfit_created`);
  const outfits = await removeUnheldOutfits(
    tx,
    ownerId,
    rows.filter((r) => r.outfit_created).map((r) => r.outfit_id),
  );
  return { entries: rows.length, outfits };
}

/**
 * Deletes each of `outfitIds` (outfits the planner created, which the
 * caller has just taken off their entries) that nothing holds any more
 * (outfitIsHeld: no calendar entry, no trip). One held elsewhere, or one
 * the planner found already saved (never passed here), is the person's and
 * stays. The one rule for Undo, the re-plan's swap (removeAutoEntries) and
 * changing an auto entry's outfit (replaceEntryOutfit, #69). Returns how
 * many went.
 *
 * The outfits are locked (FOR UPDATE, in id order) before the question is
 * asked: a trip or calendar row being added for one meanwhile needs the
 * outfit's key lock for its foreign key, so it either committed before the
 * lock (and is seen here) or waits and then fails on the deleted outfit,
 * never silently cascaded away. So two statements, never one: a delete
 * whose own WHERE asks outfitIsHeld would wait on that row lock and then
 * judge by the snapshot it started with.
 *
 * A plain delete, not deleteOutfit per outfit (#165: four statements
 * each): an unheld outfit has no calendar entry (so no wears or selfies of
 * its entries to keep) and no trip (so no packing list to prune), which is
 * everything deleteOutfit's rules keep; its slots cascade.
 */
export async function removeUnheldOutfits(
  tx: Queryable,
  ownerId: number,
  outfitIds: readonly number[],
): Promise<number> {
  const candidates = [...new Set(outfitIds)];
  if (candidates.length === 0) return 0;
  const locked = await tx
    .select({ id: outfit.id })
    .from(outfit)
    .where(and(inArray(outfit.id, candidates), eq(outfit.ownerId, ownerId)))
    .orderBy(outfit.id)
    .for('update');
  if (locked.length === 0) return 0;
  const deleted = await tx
    .delete(outfit)
    .where(
      and(
        inArray(
          outfit.id,
          locked.map((row) => row.id),
        ),
        not(outfitIsHeld(outfit.id)),
        // A one-off only: an adopted outfit is `person` by then, and an
        // agent's or a person's is never pruned (#748).
        inArray(outfit.origin, [...ONE_OFF_ORIGINS]),
      ),
    )
    .returning({ id: outfit.id });
  return deleted.length;
}

/**
 * Whether the planner created the outfit of auto entry `entryId` ("Plan my
 * week" found none saved of those garments): what makes it the planner's
 * to remove once nothing holds it. Asked only of an entry still 'auto'
 * (AGENTS.md Gotchas: a taken-over entry's week_plan_entry row is
 * provenance, not ownership); false for an entry the planner never wrote.
 */
export async function plannerCreatedOutfit(
  tx: Queryable,
  entryId: number,
): Promise<boolean> {
  const [row] = await tx
    .select({ outfitCreated: weekPlanEntry.outfitCreated })
    .from(weekPlanEntry)
    .where(eq(weekPlanEntry.entryId, entryId));
  return row?.outfitCreated ?? false;
}

/** A garment of an auto entry's outfit, as the re-plan judges and names it. */
export interface SlotGarment extends OutfitGarmentState {
  name: string | null;
  category: string;
}

/** A slot as outfitGarmentStatesSql reads it: its outfit, and its garment or null. */
type SlotStateJson = [
  outfitId: number,
  garment:
    | (Omit<SlotGarment, 'limit'> & { washAfterWears: number | null })
    | null,
];

/**
 * The slots of `outfitIds` in order, each its garment's state today (the
 * garment's status and away, its wash state, whether it was worn today) or
 * null for an empty slot: what unwearableOn judges an auto entry by. A
 * scalar subquery (a JSON list, readOutfitGarmentStates), so the re-plan
 * reads it in the statement that reads its week (#173); the wash counts are
 * wearsSinceWashSql's, the laundry's rule.
 */
export function outfitGarmentStatesSql(
  outfitIds: readonly number[],
  today: IsoDate,
): SQL<SlotStateJson[]> {
  return sql<SlotStateJson[]>`(
    select coalesce(json_agg(json_build_array(
      ${outfitSlot.outfitId},
      case when ${garment.id} is null then null else json_build_object(
        'id', ${garment.id},
        'name', ${garment.name},
        'category', ${garment.category},
        'status', ${garment.status},
        'away', ${garment.away},
        'quantity', ${garment.quantity},
        'washAfterWears', ${garment.washAfterWears},
        'wearsSinceWash', ${wearsSinceWashSql()},
        -- "Wore today" or a worn entry (the ledger's idleDays === 0).
        'wornToday', exists (
          select 1 from ${garmentWear}
          where ${garmentWear.garmentId} = ${garment.id}
            and ${garmentWear.day} = ${today}
        )
      ) end
    ) order by ${outfitSlot.outfitId}, ${outfitSlot.position}), '[]')
    from ${outfitSlot}
    left join ${garment} on ${garment.id} = ${outfitSlot.garmentId}
    where ${inArray(outfitSlot.outfitId, [...new Set(outfitIds)])}
  )`;
}

/** outfitGarmentStatesSql's value, by outfit. */
export function readOutfitGarmentStates(
  rows: readonly SlotStateJson[],
): Map<number, (SlotGarment | null)[]> {
  const outfits = new Map<number, (SlotGarment | null)[]>();
  for (const [outfitId, slot] of rows) {
    const slots = outfits.get(outfitId) ?? [];
    if (slot === null) {
      slots.push(null);
    } else {
      const { washAfterWears, ...state } = slot;
      slots.push({
        ...state,
        limit: washLimit(state.category, washAfterWears),
      });
    }
    outfits.set(outfitId, slots);
  }
  return outfits;
}

/** Deletes batch `id` once none of its entries is left (all undone or deleted). */
export async function deleteEmptyWeekPlan(
  tx: Queryable,
  id: number,
): Promise<void> {
  await tx
    .delete(weekPlan)
    .where(
      and(
        eq(weekPlan.id, id),
        sql`not exists (select 1 from ${weekPlanEntry} where ${weekPlanEntry.weekPlanId} = ${weekPlan.id})`,
      ),
    );
}

/** An entry of a batch as the calendar's banner lists it. */
export interface BatchEntry {
  entryId: number;
  day: IsoDate;
  occasion: Occasion;
  plannedBy: PlannedBy;
  outfitName: string | null;
  /** The outfit's garments, for the banner row's collage thumb. */
  garments: OutfitGarment[];
}

/**
 * Batch `id`'s entries still on the calendar (auto or taken over), by day,
 * as a scalar subquery (a JSON list): the calendar's banner after "Plan my
 * week", read in the week's one statement (weekContext).
 */
export function batchEntriesSql(
  ownerId: number,
  id: number,
): SQL<BatchEntry[]> {
  return sql<BatchEntry[]>`(
    select coalesce(json_agg(json_build_object(
      'entryId', ${outfitCalendar.id},
      'day', ${outfitCalendar.day},
      'occasion', ${outfitCalendar.occasion},
      'plannedBy', ${outfitCalendar.plannedBy},
      'outfitName', ${outfit.name},
      'garments', ${outfitGarmentsSql()}
    ) order by ${outfitCalendar.day}, ${outfitCalendar.id}), '[]')
    from ${weekPlanEntry}
    inner join ${outfitCalendar} on ${outfitCalendar.id} = ${weekPlanEntry.entryId}
    inner join ${outfit} on ${outfit.id} = ${outfitCalendar.outfitId}
    where ${weekPlanEntry.weekPlanId} = ${id}
      and ${outfitCalendar.ownerId} = ${ownerId})`;
}

/**
 * The day and occasion of each of the owner's entries from `first` to
 * `last`, as a scalar subquery (a JSON list): all emptySlots needs of them,
 * for the banner's slots still empty (weekContext).
 */
export function entrySlotsSql(
  ownerId: number,
  first: IsoDate,
  last: IsoDate,
): SQL<Pick<WeekEntry, 'day' | 'occasion'>[]> {
  return sql<Pick<WeekEntry, 'day' | 'occasion'>[]>`(
    select coalesce(json_agg(json_build_object(
      'day', ${outfitCalendar.day},
      'occasion', ${outfitCalendar.occasion}
    )), '[]')
    from ${outfitCalendar}
    where ${outfitCalendar.ownerId} = ${ownerId}
      and ${outfitCalendar.day} between ${first} and ${last})`;
}

// ---- The daily re-plan's claims ---------------------------------------------

/**
 * Who is due today's re-plan: an auto entry (unworn, recorded in a batch:
 * what claimAutoEntries reads) from `day` on and no claim for the day.
 * `userIds` asks about those only (a minute's morning reminders, which
 * re-plan their people first: one statement for all of them, #173);
 * without it, every user (the minutely run). A read only: the claim itself
 * is claimAutoEntries', inside the work's transaction, so a user listed
 * here may still turn out to be re-planned by another run.
 */
export async function replanCandidates(
  db: Queryable,
  day: IsoDate,
  userIds?: readonly number[],
): Promise<number[]> {
  if (userIds?.length === 0) return [];
  const rows = await db
    .selectDistinct({ userId: outfitCalendar.ownerId })
    .from(outfitCalendar)
    .innerJoin(weekPlanEntry, eq(weekPlanEntry.entryId, outfitCalendar.id))
    .where(
      and(
        userIds === undefined
          ? undefined
          : inArray(outfitCalendar.ownerId, [...new Set(userIds)]),
        eq(outfitCalendar.plannedBy, 'auto'),
        isNull(outfitCalendar.wornAt),
        gte(outfitCalendar.day, day),
        not(
          exists(
            db
              .select({ one: sql`1` })
              .from(weekReplan)
              .where(
                and(
                  eq(weekReplan.userId, outfitCalendar.ownerId),
                  eq(weekReplan.day, day),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(outfitCalendar.ownerId);
  return rows.map((row) => row.userId);
}

/**
 * Claims `userId`'s re-plan for `day` on its own, in a transaction of its
 * own (under the owner lock): true when this call inserted the (user, day)
 * row. The re-plan claims inside its own transaction with its read
 * (claimAutoEntries); this is for a person whose re-plan failed through
 * every retry (ReplanRetries), so they are tried no more that day.
 */
export async function claimReplan(
  db: Queryable,
  userId: number,
  day: IsoDate,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .insert(weekReplan)
    .values({ userId, day, claimedAt: now })
    .onConflictDoNothing({ target: [weekReplan.userId, weekReplan.day] })
    .returning({ userId: weekReplan.userId });
  return rows.length > 0;
}

/** A "Plan my week" batch as the changes feed carries it (weekPlansByIds, week-plan-resource.ts). */
export interface WeekPlanRow {
  id: number;
  createdAt: Date;
  entries: { entryId: number; outfitCreated: boolean }[];
}

/**
 * The batches with these ids and their entries, in one statement whatever
 * their owners (the changes feed's page, src/web/sync/feed.ts, which read
 * the ids from the owner's own wardrobe in the same snapshot: the weekly
 * plan is owner-only). week_plan_entry is the batch's sync child, so an
 * entry deleted (Undo, Change, a swap) resends the batch.
 */
export function weekPlansByIds(
  db: Queryable,
  ids: readonly number[],
): Promise<WeekPlanRow[]> {
  return db
    .select({
      id: weekPlan.id,
      createdAt: weekPlan.createdAt,
      entries: sql<WeekPlanRow['entries']>`(
        select coalesce(json_agg(json_build_object(
          'entryId', ${weekPlanEntry.entryId},
          'outfitCreated', ${weekPlanEntry.outfitCreated}
        ) order by ${weekPlanEntry.entryId}), '[]')
        from ${weekPlanEntry} where ${weekPlanEntry.weekPlanId} = ${weekPlan.id}
      )`,
    })
    .from(weekPlan)
    .where(inArray(weekPlan.id, [...ids]));
}

/**
 * Removes claims of days before `before`: a claim only ever guards its own
 * day. Every owner's at once, without the owner lock: no writer judges a
 * past day's claim (the exemption in src/web/calendar/AGENTS.md, Owner lock).
 */
export async function pruneReplanClaims(
  db: Queryable,
  before: IsoDate,
): Promise<number> {
  const deleted = await db
    .delete(weekReplan)
    .where(lt(weekReplan.day, before))
    .returning({ userId: weekReplan.userId });
  return deleted.length;
}
