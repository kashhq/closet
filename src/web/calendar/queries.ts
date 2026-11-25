import { and, type AnyColumn, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db, Queryable } from '../../db/client';
import {
  file,
  garment,
  outfit,
  outfitCalendar,
  outfitSlot,
} from '../../db/schema';
import { selectScalars } from '../../db/select-scalars';
import { ONE_OFF_ORIGINS } from '../../wardrobe/outfit-origin';
import { removalAsksFirst } from './removal';
import type { Occasion } from '../../wardrobe/occasions';
import type { PlannedBy } from '../../wardrobe/week';
import {
  agentLabelSql,
  type AgentLabel,
  OWNER_READS,
  type WriteOrigin,
} from '../write-origin';
import { ownerTransaction } from '../auth/queries';
import { photoRefJson } from '../files/queries';
import { refuseUnholdable } from '../outfits/gone-garments';
import {
  holdRefusalColumns,
  keptOutfit,
  outfitMayBeHeld,
  type PieceToBuy,
} from '../outfits/references';
import { deleteEntrySelfie, entrySelfieSql } from '../selfies/queries';
import { removeUnheldOutfits } from '../week-plan/queries';
import {
  changeEntryWorn,
  type EntryWornOutcome,
  type LockedEntry,
  dirtyCopiesSql,
} from '../wears/queries';
import type { IsoDate } from '../../calendar-date';
import type { CalendarEntry } from './calendar-view';
import {
  type Chooser,
  chooserOf,
  choiceSet,
  PERSONS_CHOICE_SET,
  takeOverSql,
} from './planned-by';

/**
 * The calendar's reads and writes. Every one is scoped to the signed-in
 * owner: outfits and calendar entries are private whatever wardrobe shares
 * exist. An entry that is not the caller's is a miss, the same as one that
 * does not exist: the route answers 404 either way, so entry ids reveal
 * nothing about other users (WardrobeAccess, src/web/sharing/access.ts).
 * Every write holds the owner lock (ownerTransaction; AGENTS.md, Owner
 * lock): the re-plan and a replace judge several entries at once, and a
 * write that slipped between their read and their write would be lost or
 * would break the unique key.
 */

export type EntryMiss = 'not-found';

/** An agent's entry's agent (#682): planned_by says so even once its token is gone. */
const entryAgentSql = agentLabelSql(
  outfitCalendar.plannedByTokenId,
  OWNER_READS,
  sql`${outfitCalendar.plannedBy} = 'agent'`,
);

/**
 * The owner's entries from `first` to `last` (inclusive), by day then id,
 * each with its selfie and its outfit's garments for the collage (in the
 * order the outfit was built; empty slots have nothing to show); the pages
 * put a day's entries in occasion order (buildCalendarView, Today's
 * todayFor). A scalar subquery (a JSON list), so the week page reads it in
 * one statement with the rest of what it shows (weekContext); findEntries
 * reads it alone. Served by outfit_calendar_owner_id_day_outfit_id_unique
 * (owner_id, day). Every table appears once in each scope, so the columns
 * need no aliases: the selfie's `file` and the garments' are in sibling
 * subqueries.
 *
 * Each garment carries what its collage warns about (#358, entryPieces in
 * calendar-view.ts): its status and away, and on `washOn` (today, where a
 * page draws today's cards) whether it needs a wash, counted only for that
 * day's unworn entries, so the month and past days cost no wear count.
 * Away and the wash are the owner's records: every caller is the owner's
 * own calendar (outfits and entries are never shared).
 */
export function entriesSql(
  ownerId: number,
  first: IsoDate,
  last: IsoDate,
  { washOn }: { washOn?: IsoDate } = {},
): SQL<CalendarEntry[]> {
  const washDue =
    washOn === undefined
      ? sql`false`
      : // CASE, not AND: Postgres may evaluate AND's operands in any order, and
        // the wear count must run only for today's unworn entries. No clean
        // copy left (availableGarment's rule), not "some copy is dirty".
        sql`(case when ${outfitCalendar.day} = ${washOn} and ${outfitCalendar.wornAt} is null then ${dirtyCopiesSql()} >= ${garment.quantity} else false end)`;
  return sql<CalendarEntry[]>`(
    select coalesce(json_agg(json_build_object(
      'id', ${outfitCalendar.id},
      'day', ${outfitCalendar.day},
      'occasion', ${outfitCalendar.occasion},
      'worn', ${outfitCalendar.wornAt} is not null,
      'plannedBy', ${outfitCalendar.plannedBy},
      'agent', ${entryAgentSql},
      'selfie', ${entrySelfieSql(outfitCalendar.id)},
      'outfit', json_build_object(
        'id', ${outfit.id},
        'name', ${outfit.name},
        'kept', ${keptOutfit()},
        'createdOneOff', coalesce(${outfitCalendar.outfitCreated}, false)
          and ${outfit.origin} in (${sql.join(
            ONE_OFF_ORIGINS.map((o) => sql`${o}`),
            sql`, `,
          )}),
        'garments', (
          select coalesce(json_agg(json_build_object(
            'id', ${garment.id},
            'name', ${garment.name},
            'category', ${garment.category},
            'photo', ${photoRefJson},
            'status', ${garment.status},
            'away', ${garment.away},
            'needsWash', ${washDue}
          ) order by ${outfitSlot.position}), '[]')
          from ${outfitSlot}
          inner join ${garment} on ${garment.id} = ${outfitSlot.garmentId}
          left join ${file} on ${file.id} = ${garment.photoId}
          where ${outfitSlot.outfitId} = ${outfit.id}
        )
      )
    ) order by ${outfitCalendar.day}, ${outfitCalendar.id}), '[]')
    from ${outfitCalendar}
    inner join ${outfit} on ${outfit.id} = ${outfitCalendar.outfitId}
    where ${outfitCalendar.ownerId} = ${ownerId}
      and ${outfitCalendar.day} between ${first} and ${last})`;
}

/**
 * The widest range of days a client reads at once (get_calendar, GET
 * /api/v1/calendar-entries): two months, a planning conversation's horizon.
 */
export const MAX_CALENDAR_DAYS = 62;

/** entriesSql alone: Today, the month, get_calendar, GET /api/v1/calendar-entries. One statement. */
export async function findEntries(
  db: Queryable,
  ownerId: number,
  first: IsoDate,
  last: IsoDate,
): Promise<CalendarEntry[]> {
  const { entries } = await selectScalars(db, {
    entries: entriesSql(ownerId, first, last),
  });
  return entries;
}

/**
 * One of the owner's entries as the week reads it (entriesSql over its day,
 * `washOn` today as the week page passes it), so a row redrawn alone
 * (POST /calendar/:id/worn) carries the marks the page would. One statement.
 */
export async function findEntry(
  db: Queryable,
  ownerId: number,
  entry: { id: number; day: IsoDate },
  today: IsoDate,
): Promise<CalendarEntry | undefined> {
  const { entries } = await selectScalars(db, {
    entries: entriesSql(ownerId, entry.day, entry.day, { washOn: today }),
  });
  return entries.find((candidate) => candidate.id === entry.id);
}

/** An entry of a day as a picker reads it (entriesOfDaySql). */
export interface DayEntry {
  id: number;
  occasion: Occasion;
  outfitId: number;
  outfitName: string | null;
  /** Marked worn (worn_at set). */
  worn: boolean;
}

/**
 * The owner's entries on `day`, bare: which outfits are on it and for which
 * occasion, and each entry's outfit name and worn state. What picking an
 * outfit for the day needs (dayChoice), without findEntries' collages and
 * selfies, which no picker draws (#165). A scalar subquery (a JSON list),
 * so the Saved tab reads it in one statement with its grid (#164,
 * savedContext in src/web/outfits/page-context.ts). `ownerId` may be an
 * outer query's column: the evening reminders read every person's day in
 * one statement (eveningDays, src/web/today/queries.ts; #173).
 */
export function entriesOfDaySql(
  ownerId: number | AnyColumn,
  day: IsoDate,
): SQL<DayEntry[]> {
  return sql<DayEntry[]>`(
    select coalesce(json_agg(json_build_object(
      'id', ${outfitCalendar.id},
      'occasion', ${outfitCalendar.occasion},
      'outfitId', ${outfitCalendar.outfitId},
      'outfitName', ${outfit.name},
      'worn', ${outfitCalendar.wornAt} is not null
    )), '[]')
    from ${outfitCalendar}
    inner join ${outfit} on ${outfit.id} = ${outfitCalendar.outfitId}
    where ${outfitCalendar.ownerId} = ${ownerId}
      and ${outfitCalendar.day} = ${day})`;
}

export type ScheduleOutcome = 'scheduled' | 'already-scheduled';

/** An entry to plan: the owner's outfit on a day, for an occasion. */
export interface NewEntry {
  ownerId: number;
  outfitId: number;
  day: IsoDate;
  occasion: Occasion;
  /** Who chose it (planned-by.ts): the planner, the agent or the person; required, so a new caller says. */
  chooser: Chooser;
  /** The pick that planned it created the outfit (#748): what deleteEntry may prune. Absent: no. */
  outfitCreated?: boolean;
}

/**
 * What insertEntry did: a new entry's id, for a caller that marks it worn
 * (the seed); for one already there, whether the person's write took it
 * over from the week planner (`adopted`).
 */
export type Scheduled =
  | { outcome: 'scheduled'; id: number }
  | { outcome: 'already-scheduled'; adopted: boolean };

/** What scheduleOutfit did, the entry the outfit is on that day included. */
export type ScheduledEntry = Scheduled & {
  entryId: number;
  occasion: Occasion;
};

/**
 * Plans the owner's outfit on `day` for an occasion. Idempotent: planning
 * the same outfit on the same day again inserts nothing (the unique
 * (owner, day, outfit) constraint), whatever the occasion, and reports
 * 'already-scheduled', so a double tap or a replayed form is not an error.
 * The ownership check and the write are one step under the owner lock, so
 * a replace or a re-plan never sees the day half changed. Answers the
 * entry and the occasion the outfit is on that day: the one asked, or the
 * one it kept. The check reads the entry with the outfit (#172:
 * schedule_outfit read the whole day's entries again after the write to
 * say which; the API answers its id), and the lock keeps it true until the
 * insert.
 */
export function scheduleOutfit(
  db: Queryable,
  entry: NewEntry,
): Promise<ScheduledEntry | 'no-such-outfit'> {
  return ownerTransaction(db, entry.ownerId, 'scheduleOutfit', async (tx) => {
    // The outfit is on a day once (the unique owner, day, outfit key): one row.
    const [owned] = await tx
      .select({ entryId: outfitCalendar.id, kept: outfitCalendar.occasion })
      .from(outfit)
      .leftJoin(
        outfitCalendar,
        and(
          eq(outfitCalendar.outfitId, outfit.id),
          eq(outfitCalendar.ownerId, entry.ownerId),
          eq(outfitCalendar.day, entry.day),
        ),
      )
      .where(
        and(eq(outfit.id, entry.outfitId), eq(outfit.ownerId, entry.ownerId)),
      );
    if (!owned) return 'no-such-outfit';
    const scheduled = await insertEntry(tx, entry);
    return {
      ...scheduled,
      // Already scheduled: the entry the check read, which the lock kept.
      entryId:
        scheduled.outcome === 'scheduled' ? scheduled.id : owned.entryId!,
      occasion: owned.kept ?? entry.occasion,
    };
  });
}

/** Whether `outfitId` is the owner's: outfits are private, another's is a miss. */
export async function ownsOutfit(
  db: Queryable,
  ownerId: number,
  outfitId: number,
): Promise<boolean> {
  const [owned] = await db
    .select({ id: outfit.id })
    .from(outfit)
    .where(and(eq(outfit.id, outfitId), eq(outfit.ownerId, ownerId)));
  return owned !== undefined;
}

/**
 * The one writer of calendar entries, for an outfit the caller has already
 * found to be the owner's: POST /calendar (scheduleOutfit), the outfit
 * form's "Add to calendar", inside its save transaction
 * (src/web/outfits/queries.ts), the gallery's pick (which the week planner,
 * #16, calls with plannedBy 'auto') and the seed's simulated history. An entry
 * starts unworn: setEntryWorn's change (changeEntryWorn, src/web/wears/queries.ts)
 * is the only way to mark one, because its wear rows change with it; "Wearing
 * this" plans through its own form of this insert (planToWear), which takes
 * the entry over as marking it does.
 *
 * The outfit already on that day keeps its entry and its occasion: planning
 * it again for another occasion changes nothing (an edit form re-saved with
 * the occasion picker at its default must not move an evening entry to all
 * day). Different outfits on one day are separate entries; changing the
 * outfit of an entry is setEntryOutfit's, through replaceEntryOutfit (#69).
 *
 * **Choosing what a lower rank chose takes it over** (#77, #682;
 * planned-by.ts's takeOverSql): a person's write that meets an `auto` or
 * `agent` entry of the same outfit on the day makes it `user`, the agent's
 * one meeting an `auto` entry makes it `agent` (and nothing else), so the
 * re-plan and Undo leave the choice just made; the planner's own `auto`
 * write never downgrades anyone's entry, nor the agent's a person's. Both
 * still answer 'already-scheduled'.
 *
 * Under the owner lock (ownerTransaction: a savepoint in the caller's
 * transaction, the lock free when the caller took it already). Without it
 * a take-over could commit between the re-plan's read of the entry as
 * `auto` and its swap, leaving two outfits in one slot (#122).
 *
 * **An outfit that may not be held is refused** (#335, outfitMayBeHeld:
 * one holding a piece not bought yet, OutfitIncomplete, or one of Muse's
 * proposals not the owner's yet, OutfitNotYours; refuseUnholdable), a 409,
 * and nothing is written. The owner lock keeps it true until the
 * commit: a slot write that would add a piece (updateOutfit) takes it too.
 */
export function insertEntry(
  db: Queryable,
  entry: NewEntry,
): Promise<Scheduled> {
  return ownerTransaction(db, entry.ownerId, 'insertEntry', (tx) =>
    upsertEntry(tx, entry),
  );
}

async function upsertEntry(tx: Queryable, entry: NewEntry): Promise<Scheduled> {
  const outfitId = sql`${entry.outfitId}::int`;
  const choice = chooserOf(entry.chooser);
  // A conflict the WHERE refuses returns no row, as does the insert of an
  // outfit that may not be held (outfitMayBeHeld): `toBuy` and `pending`,
  // read in the same snapshot, tell them apart.
  // xmax is 0 on a row this statement inserted and set on one it updated:
  // Postgres' way of telling the two apart in one ON CONFLICT statement.
  const { rows } = await tx.execute<{
    id: number | null;
    inserted: boolean | null;
    toBuy: PieceToBuy[];
    pending: boolean;
  }>(sql`
    with written as (
      insert into ${outfitCalendar} (owner_id, day, outfit_id, occasion, planned_by, planned_by_token_id, outfit_created)
      select ${entry.ownerId}::int, ${entry.day}::date, ${outfitId},
        ${entry.occasion}::text, ${choice.plannedBy}::text, ${choice.plannedByTokenId}::int,
        ${entry.outfitCreated ?? null}::boolean
      where ${outfitMayBeHeld(outfitId)}
      on conflict (owner_id, day, outfit_id) ${takeOverSql}
      returning ${outfitCalendar.id} as id, (xmax = 0) as inserted
    )
    select (select id from written) as id,
      (select inserted from written) as inserted,
      ${holdRefusalColumns(outfitId)}`);
  const [row] = rows;
  refuseUnholdable(entry.outfitId, row);
  if (row.inserted) return { outcome: 'scheduled', id: row.id! };
  return { outcome: 'already-scheduled', adopted: row.id !== null };
}

/**
 * The owner's entry for `outfitId` on `day` (an outfit is on a day once, so
 * there is at most one), for a caller that planned it through insertEntry
 * and must act on the entry whether it was new or already there (the week
 * planner), or that must
 * not plan it twice (replaceEntryOutfit, which names the occasion it is
 * on). Served by the unique (owner_id, day, outfit_id) index.
 */
export async function entryOf(
  db: Queryable,
  ownerId: number,
  day: IsoDate,
  outfitId: number,
): Promise<{ id: number; occasion: Occasion } | undefined> {
  const [row] = await db
    .select({ id: outfitCalendar.id, occasion: outfitCalendar.occasion })
    .from(outfitCalendar)
    .where(
      and(
        eq(outfitCalendar.ownerId, ownerId),
        eq(outfitCalendar.day, day),
        eq(outfitCalendar.outfitId, outfitId),
      ),
    );
  return row;
}

/** An entry's own columns: what replaceEntryOutfit locks and the changes feed carries. */
export interface EntryRow {
  id: number;
  day: IsoDate;
  occasion: Occasion;
  outfitId: number;
  worn: boolean;
  plannedBy: PlannedBy;
  agent: AgentLabel | null;
}

/** EntryRow's columns, `worn` as its stamp (readEntryRow). */
const ENTRY_COLUMNS = {
  id: outfitCalendar.id,
  day: outfitCalendar.day,
  occasion: outfitCalendar.occasion,
  outfitId: outfitCalendar.outfitId,
  wornAt: outfitCalendar.wornAt,
  plannedBy: outfitCalendar.plannedBy,
  agent: entryAgentSql,
};

function readEntryRow({
  wornAt,
  ...entry
}: Omit<EntryRow, 'worn'> & { wornAt: Date | null }): EntryRow {
  return { ...entry, worn: wornAt !== null };
}

/**
 * The entries with these ids, in one statement whatever their owners (the
 * changes feed's page, src/web/sync/feed.ts, which read the ids from the
 * owner's own wardrobe in the same snapshot: entries are owner-only).
 */
export async function entriesByIds(
  db: Queryable,
  ids: readonly number[],
): Promise<EntryRow[]> {
  const rows = await db
    .select(ENTRY_COLUMNS)
    .from(outfitCalendar)
    .where(inArray(outfitCalendar.id, [...ids]));
  return rows.map(readEntryRow);
}

/**
 * Locks the owner's entry `entryId` if it is, when given, on `day` and for
 * `occasion` (FOR UPDATE: setEntryWorn and setEntrySelfie lock it too, so a
 * wear marked meanwhile is seen here). Undefined for another's entry, a
 * missing one, or one elsewhere: a `replace=` naming an entry of another
 * day or occasion is a link that does not say what it would change (the
 * pages and MCP name the day; the API names the entry alone).
 */
export async function lockEntryToReplace(
  tx: Queryable,
  ownerId: number,
  target: { entryId: number; day?: IsoDate; occasion?: Occasion },
): Promise<EntryRow | undefined> {
  const [row] = await tx
    .select(ENTRY_COLUMNS)
    .from(outfitCalendar)
    .where(
      and(
        eq(outfitCalendar.id, target.entryId),
        eq(outfitCalendar.ownerId, ownerId),
        target.day === undefined
          ? undefined
          : eq(outfitCalendar.day, target.day),
        target.occasion === undefined
          ? undefined
          : eq(outfitCalendar.occasion, target.occasion),
      ),
    )
    .for('update');
  return row && readEntryRow(row);
}

/**
 * Puts another outfit on an entry, keeping its day and occasion. Only
 * replaceEntryOutfit (src/web/calendar/replace.ts) calls it, under the
 * owner lock, having locked the entry, refused a worn one and checked the
 * outfit is not on the day already (the unique key). The choice is the
 * chooser's from now on (the person's, or the agent's with its token over
 * MCP, #682; planned-by.ts), so the week's re-plan and Undo leave it alone
 * (#16). `outfitCreated` is required (#883): the flag describes the outfit
 * the entry holds, and kept from the old one it would let a later removal
 * prune an outfit this entry never made. An outfit that may not be held is
 * refused (refuseUnholdable), the entry unchanged. The same outfit chosen
 * again is takeOverEntry.
 */
export async function setEntryOutfit(
  tx: Queryable,
  entryId: number,
  outfitId: number,
  origin: WriteOrigin,
  /** Whether the pick created `outfitId` (#748). */
  outfitCreated: boolean,
): Promise<void> {
  const outfit = sql`${outfitId}::int`;
  const { rows } = await tx.execute<{
    toBuy: PieceToBuy[];
    pending: boolean;
  }>(sql`
    with written as (
      update ${outfitCalendar}
      set outfit_id = ${outfit}, ${choiceSet(chooserOf(origin))},
        outfit_created = ${outfitCreated}::boolean
      where ${outfitCalendar.id} = ${entryId} and ${outfitMayBeHeld(outfit)}
    )
    select ${holdRefusalColumns(outfit)}`);
  refuseUnholdable(outfitId, rows[0]);
}

/**
 * The outfit an entry already holds chosen again (replaceEntryOutfit, under
 * the owner lock, the entry locked): the choice becomes the chooser's
 * (choosing what the planner chose takes it over, #16) and nothing else
 * changes, its outfit's `outfit_created` included. The caller asks
 * `takesOver` first: an agent never takes a person's entry.
 */
export async function takeOverEntry(
  tx: Queryable,
  entryId: number,
  origin: WriteOrigin,
): Promise<void> {
  await tx.execute(sql`
    update ${outfitCalendar} set ${choiceSet(chooserOf(origin))}
    where ${outfitCalendar.id} = ${entryId}`);
}

/** What wearOutfitOn did: the entry, whether it was new, and its worn change. */
export interface WornOutfit {
  entryId: number;
  scheduled: ScheduleOutcome;
  worn: Exclude<EntryWornOutcome, 'not-found' | 'future'>;
}

/**
 * "Wearing this" for an outfit the caller found to be the owner's: planned
 * on `day` for `occasion` (insertEntry: the outfit already on the day keeps
 * its entry and its occasion) and that entry marked worn (setEntryWorn), in
 * one transaction, so the calendar stays the one history of which outfit
 * was worn when (plan section 1). Today's "Wear this" (wearIdea, after
 * pickIdea) and a trip's "Wore it" (#10, src/web/trips). Safe
 * to repeat: a second call finds the entry (a concurrent one waits on the
 * owner lock, then reads it) and changeEntryWorn finds it worn
 * (`changed` false). 'future' for a day after `today`, before anything is
 * written.
 *
 * Two statements under the owner lock (#166; production pays a round trip
 * per statement): planning the entry locks and reads it (planToWear), and
 * marking it is setEntryWorn's own change (changeEntryWorn), not run at all
 * when it is worn already.
 */
export function wearOutfitOn(
  db: Queryable,
  input: {
    ownerId: number;
    outfitId: number;
    day: IsoDate;
    occasion: Occasion;
    at: Date;
    today: IsoDate;
    /** The pick just before created the outfit (wearIdea): see NewEntry. */
    outfitCreated?: boolean;
  },
): Promise<WornOutfit | 'future'> {
  const { ownerId, outfitId, day, occasion, outfitCreated } = input;
  if (day > input.today) return Promise.resolve('future');
  return ownerTransaction(db, ownerId, 'wearOutfitOn', async (tx) => {
    const { inserted, ...entry } = await planToWear(tx, {
      ownerId,
      outfitId,
      day,
      occasion,
      outfitCreated,
    });
    const worn = await changeEntryWorn(tx, entry, {
      ownerId,
      worn: true,
      at: input.at,
      today: input.today,
    });
    // Cannot happen: the day is not ahead of today.
    if (worn === 'future') {
      throw new Error(`Entry ${entry.id} on ${day} could not be marked worn`);
    }
    return {
      entryId: entry.id,
      scheduled: inserted ? 'scheduled' : 'already-scheduled',
      worn,
    };
  });
}

/**
 * insertEntry for an entry about to be marked worn (wearOutfitOn): the
 * same insert, and the outfit already on the day keeps its entry and its
 * occasion, but a conflict always takes the entry over (planned_by 'user',
 * as marking it worn does anyway), so the statement locks and returns the
 * entry, new or not. One round trip where insertEntry, entryOf and
 * setEntryWorn's lock were three. The caller holds the owner lock.
 */
async function planToWear(
  tx: Queryable,
  entry: Omit<NewEntry, 'chooser'>,
): Promise<LockedEntry & { inserted: boolean }> {
  const outfitId = sql`${entry.outfitId}::int`;
  // As in upsertEntry: xmax is 0 on a row this statement inserted, and the
  // insert of an outfit that may not be held returns no row (refused by
  // its `toBuy` and `pending`).
  const { rows } = await tx.execute<{
    entry: (Omit<LockedEntry, 'wornAt'> & { wornAt: string | null }) | null;
    inserted: boolean | null;
    toBuy: PieceToBuy[];
    pending: boolean;
  }>(sql`
    with written as (
      insert into ${outfitCalendar} (owner_id, day, outfit_id, occasion, outfit_created)
      select ${entry.ownerId}::int, ${entry.day}::date, ${outfitId},
        ${entry.occasion}::text, ${entry.outfitCreated ?? null}::boolean
      where ${outfitMayBeHeld(outfitId)}
      on conflict (owner_id, day, outfit_id) do update set ${PERSONS_CHOICE_SET}
      returning json_build_object(
        'id', ${outfitCalendar.id},
        'day', ${outfitCalendar.day},
        'outfitId', ${outfitCalendar.outfitId},
        'wornAt', ${outfitCalendar.wornAt}
      ) as entry, (xmax = 0) as inserted
    )
    select (select entry from written) as entry,
      (select inserted from written) as inserted,
      ${holdRefusalColumns(outfitId)}`);
  const [row] = rows;
  refuseUnholdable(entry.outfitId, row);
  const { wornAt, ...planned } = row.entry!;
  return {
    ...planned,
    wornAt: wornAt === null ? null : new Date(wornAt),
    inserted: row.inserted!,
  };
}

/** The day of the owner's entry; undefined when it is not theirs. */
export async function ownEntryDay(
  db: Db,
  id: number,
  ownerId: number,
): Promise<IsoDate | undefined> {
  const [row] = await db
    .select({ day: outfitCalendar.day })
    .from(outfitCalendar)
    .where(and(eq(outfitCalendar.id, id), eq(outfitCalendar.ownerId, ownerId)));
  return row?.day;
}

/** What deleteEntry removed: the entry as it stood (what Undo restores) and what went with it. */
export interface DeletedEntry {
  selfies: string[];
  oneOffRemoved: number | null;
  entry: {
    outfitId: number;
    day: IsoDate;
    occasion: Occasion;
    plannedBy: PlannedBy;
    worn: boolean;
  };
}

/**
 * Deletes the owner's entry, the user saying it was wrong: its wears go
 * with it (garment_wear's foreign key) and so does its selfie, row here
 * (deleteEntrySelfie) and bytes after commit: the answer is the photo
 * names for the caller to unlink (removeEntry, writes.ts). Deleting the
 * outfit is different: its entries' wears and selfies are kept
 * (deleteOutfit, src/web/outfits/queries.ts). Under the owner lock: a
 * re-plan must not swap in an outfit for the entry the person just took
 * off the day.
 *
 * Undo's rule applies to the one-off this entry created (#659, #748): an
 * entry whose outfit is origin `idea` ("Wear this", a day's pick) or
 * `planner` takes that outfit with it once nothing else holds it
 * (removeUnheldOutfits: another day's entry or a trip keeps it), but only
 * when the entry's own pick created it: `outfit_calendar.outfit_created`,
 * the one marker (the planner's picks write it too; every change of the
 * entry's outfit rewrites it). An outfit that existed before the
 * entry, one the planner reused, and any `person` or `agent` outfit stay,
 * as in Change.
 *
 * `asksFirst`: a delete Undo could not restore (worn, an agent's, a one-off it
 * created) rolls back and answers 'needs-confirmation' until the caller
 * confirmed (removeEntry).
 *
 * Two statements inside the lock, no look-up first (#165): the selfie's
 * delete is scoped to the owner, so for another's or a missing entry it
 * finds nothing, and the entry's own delete (which locks its row) answers
 * whether there was one, whose outfit it held and whether the entry
 * created that one-off (read in the RETURNING). The selfie goes first, while the entry still points at
 * it. Two more only for a one-off.
 */
export async function deleteEntry(
  db: Queryable,
  id: number,
  ownerId: number,
  { asksFirst = false }: { asksFirst?: boolean } = {},
): Promise<DeletedEntry | EntryMiss | 'needs-confirmation'> {
  try {
    return await deleteEntryAsking(db, id, ownerId, asksFirst);
  } catch (error) {
    if (error instanceof NeedsConfirmation) return 'needs-confirmation';
    throw error;
  }
}

/** Thrown inside deleteEntry's transaction to roll the delete back: Undo could not restore this one. */
class NeedsConfirmation extends Error {}

function deleteEntryAsking(
  db: Queryable,
  id: number,
  ownerId: number,
  asksFirst: boolean,
) {
  return ownerTransaction(db, ownerId, 'deleteEntry', async (tx) => {
    const selfies = await deleteEntrySelfie(tx, id, ownerId);
    // The target aliased and every column qualified: the RETURNING's
    // subquery reads outfit, so a bare `id` or `origin` must
    // never be left to name resolution. An alias renders as its name
    // alone in sql``, so each table is named before it.
    const entry = alias(outfitCalendar, 'deleted_entry');
    const held = alias(outfit, 'entry_outfit');
    const {
      rows: [deleted],
    } = await tx.execute<{
      outfit_id: number;
      day: IsoDate;
      occasion: Occasion;
      planned_by: PlannedBy;
      worn: boolean;
      created: boolean;
      one_off: boolean;
    }>(sql`
      delete from ${outfitCalendar} as ${entry}
      where ${entry.id} = ${id} and ${entry.ownerId} = ${ownerId}
      returning ${entry.outfitId} as outfit_id, ${entry.day}::text as day,
        ${entry.occasion} as occasion, ${entry.plannedBy} as planned_by,
        ${entry.wornAt} is not null as worn,
        coalesce(${entry.outfitCreated}, false) as created,
        coalesce((select ${held.origin} in (${sql.join(
          ONE_OFF_ORIGINS.map((o) => sql`${o}`),
          sql`, `,
        )}) from ${outfit} as ${held} where ${held.id} = ${entry.outfitId}), false) as one_off`);
    if (!deleted) return 'not-found';
    // The server, not the page the tap came from, decides whether this goes
    // without asking (#686): the row may have been worn or become a one-off
    // since. Rolled back, so nothing (not even the selfie row) is gone.
    const takesOutfit = deleted.created && deleted.one_off;
    if (
      asksFirst &&
      removalAsksFirst({
        worn: deleted.worn,
        plannedBy: deleted.planned_by,
        takesOutfit,
      })
    ) {
      throw new NeedsConfirmation();
    }
    const removed =
      takesOutfit &&
      (await removeUnheldOutfits(tx, ownerId, [deleted.outfit_id])) > 0;
    return {
      selfies,
      oneOffRemoved: removed ? deleted.outfit_id : null,
      entry: {
        outfitId: deleted.outfit_id,
        day: deleted.day,
        occasion: deleted.occasion,
        plannedBy: deleted.planned_by,
        worn: deleted.worn,
      },
    };
  });
}
