import { sql, type SQL } from 'drizzle-orm';
import { outfitCalendar } from '../../db/schema';
import { PLANNED_BY, type PlannedBy } from '../../wardrobe/week';
import type { WriteOrigin } from '../write-origin';

/**
 * Who owns a calendar entry's choice, as SQL: the one place the writers of
 * `outfit_calendar.planned_by` and `planned_by_token_id` get their values
 * (#16, #682; the ranks are src/wardrobe/week.ts's PLANNED_BY, with
 * `replannable`).
 *
 * - The planner writes `auto` (pickIdea's `chooser: 'planner'`); only those
 *   entries are ever re-planned or undone (the week plan's `= 'auto'`
 *   filters), so an agent's entry is as safe from it as a person's.
 * - The agent over MCP writes `agent` with its token; the person `user`
 *   with none (`chooserOf`).
 * - A write choosing the outfit already on the day takes the entry over
 *   only from a lower rank (`takeOverSql`): the person from the agent or the
 *   planner, the agent from the planner, never back.
 * - Changing an entry's outfit (replaceEntryOutfit) makes it the chooser's,
 *   whoever had it; marking it worn, editing its outfit and "Wearing this"
 *   make it the person's (`PERSONS_CHOICE`): the wear is their record.
 */

/** Who chose: the person or the agent (a WriteOrigin), or the week planner. */
export type Chooser = WriteOrigin | 'planner';

export interface EntryChoice {
  plannedBy: PlannedBy;
  plannedByTokenId: number | null;
}

export function chooserOf(chooser: Chooser): EntryChoice {
  if (chooser === 'planner')
    return { plannedBy: 'auto', plannedByTokenId: null };
  return chooser.agentTokenId === null
    ? PERSONS_CHOICE
    : { plannedBy: 'agent', plannedByTokenId: chooser.agentTokenId };
}

/** The entry is the person's: what every edit by them sets (Drizzle `.set()`). */
export const PERSONS_CHOICE: EntryChoice = Object.freeze({
  plannedBy: 'user',
  plannedByTokenId: null,
});

/** PERSONS_CHOICE as an UPDATE's SET list, for the hand-written statements. */
export const PERSONS_CHOICE_SET = sql`planned_by = 'user', planned_by_token_id = null`;

/** The choice as an UPDATE's SET list (setEntryOutfit, takeOverEntry). */
export function choiceSet(choice: EntryChoice): SQL {
  return sql`planned_by = ${choice.plannedBy}::text, planned_by_token_id = ${choice.plannedByTokenId}::int`;
}

const RANK = sql`array[${sql.join(
  PLANNED_BY.map((p) => sql`${p}`),
  sql`, `,
)}]::text[]`;

/**
 * insertEntry's ON CONFLICT: the incoming choice (`excluded`) takes the
 * entry over only from a lower rank (PLANNED_BY's order). A
 * conflict it refuses returns no row, which upsertEntry reads as "already
 * scheduled, not adopted".
 */
export const takeOverSql = sql`do update set
    planned_by = excluded.planned_by,
    planned_by_token_id = excluded.planned_by_token_id
  where array_position(${RANK}, ${outfitCalendar.plannedBy}) < array_position(${RANK}, excluded.planned_by)`;
