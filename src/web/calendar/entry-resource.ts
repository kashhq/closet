import { CloneType, type Static, Type } from '@sinclair/typebox';
import { OCCASIONS } from '../../wardrobe/occasions';
import { PLANNED_BY } from '../../wardrobe/week';
import { literals, withoutNullsDeep } from '../api/resource';
import { MAX_PICKED } from '../gallery/pick';
import { OUTFIT_NAME_MAX, outfitText } from '../outfits/queries';
import {
  OutfitGarmentResource,
  outfitNameNeedsGarments,
  outfitOrGarments,
  outfitGarmentRecord,
} from '../outfits/outfit-resource';
import { IsoDateSchema, RowId } from '../schemas';
import { SelfiePhoto, toSelfiePhoto } from '../selfies/selfie-resource';
import { AgentResource, toAgentResource } from '../write-origin';
import type { CalendarEntry } from './calendar-view';
import {
  type EntryRow,
  MAX_CALENDAR_DAYS,
  type ScheduleOutcome,
} from './queries';
import type { Replaced, ReplacementChoice } from './replace';

/**
 * The API's calendar entry resources and inputs (#193b; docs/plans/
 * 2026-11-12-json-api.md section 2), mapped from what the week page and
 * get_calendar read (entriesSql). A household day is `YYYY-MM-DD`; null
 * fields are left out. Entries are the token's user's own: a share never
 * reaches one.
 */

const Occasion = literals(OCCASIONS);

export const CalendarEntryResource = Type.Object(
  {
    id: Type.Integer(),
    day: IsoDateSchema,
    occasion: Occasion,
    worn: Type.Boolean(),
    plannedBy: CloneType(literals(PLANNED_BY), {
      description:
        "`auto`: Plan my week's pick, which its daily re-plan may swap until you change, wear or plan it yourself; `agent`: your agent's over MCP (see `agent`), which the re-plan never touches; `user`: yours",
    }),
    agent: Type.Optional(AgentResource),
    selfieId: Type.Optional(
      Type.Integer({ description: 'The outfit selfie taken of it' }),
    ),
    selfiePhoto: Type.Optional(SelfiePhoto),
    outfit: Type.Object(
      {
        id: Type.Integer(),
        name: Type.Optional(Type.String()),
        garments: Type.Array(OutfitGarmentResource),
      },
      { title: 'CalendarEntryOutfit' },
    ),
  },
  {
    title: 'CalendarEntry',
    description:
      'An outfit planned on a day for an occasion (a part of the day). A day holds several, one per outfit',
  },
);
type CalendarEntryResource = Static<typeof CalendarEntryResource>;

/**
 * An entry, nulls kept: the API's CalendarEntry (toCalendarEntryResource)
 * and what MCP's get_calendar projects (src/web/mcp/tools/calendar.ts).
 */
export function calendarEntryRecord(entry: CalendarEntry) {
  return {
    id: entry.id,
    day: entry.day,
    occasion: entry.occasion,
    worn: entry.worn,
    plannedBy: entry.plannedBy,
    agent: toAgentResource(entry.agent),
    selfieId: entry.selfie?.id ?? null,
    selfiePhoto: entry.selfie && toSelfiePhoto(entry.selfie.photo),
    outfit: {
      id: entry.outfit.id,
      name: entry.outfit.name,
      garments: entry.outfit.garments.map(outfitGarmentRecord),
    },
  };
}
export type CalendarEntryRecord = ReturnType<typeof calendarEntryRecord>;

export function toCalendarEntryResource(
  entry: CalendarEntry,
): CalendarEntryResource {
  return withoutNullsDeep(calendarEntryRecord(entry));
}

/**
 * The changes feed's calendar entry (#196b-2, GET /changes): its own
 * columns, the outfit by id. No `outfit` name or garments (the outfit's,
 * whose edits never move the entry's revision) and no `selfieId` or
 * `selfiePhoto` (the selfie names its entry, and a selfie removed moves
 * only the selfie).
 */
export const SyncedCalendarEntry = Type.Object(
  {
    id: Type.Integer(),
    day: IsoDateSchema,
    occasion: Occasion,
    worn: Type.Boolean(),
    plannedBy: CalendarEntryResource.properties.plannedBy,
    agent: CalendarEntryResource.properties.agent,
    outfitId: Type.Integer(),
  },
  {
    title: 'SyncedCalendarEntry',
    description:
      'An outfit planned on a day for an occasion: its outfit and its selfie are their own resources',
  },
);

export function toSyncedCalendarEntry(
  entry: EntryRow,
): Static<typeof SyncedCalendarEntry> {
  return {
    id: entry.id,
    day: entry.day,
    occasion: entry.occasion,
    worn: entry.worn,
    plannedBy: entry.plannedBy,
    agent: toAgentResource(entry.agent),
    outfitId: entry.outfitId,
  };
}

/** GET /calendar-entries: a range of days, never paged (it is at most MAX_CALENDAR_DAYS). */
export const CalendarEntryQuery = Type.Object({
  from: Type.Optional(
    CloneType(IsoDateSchema, {
      description:
        'The first day; today unless given, or six days before `to` when only it is sent',
    }),
  ),
  to: Type.Optional(
    CloneType(IsoDateSchema, {
      description: `The last day (inclusive), at most ${MAX_CALENDAR_DAYS} days in all; six days after \`from\` unless given (sent alone, \`from\` is six days before it)`,
    }),
  ),
});

export const CalendarEntryList = Type.Object(
  {
    from: IsoDateSchema,
    to: IsoDateSchema,
    data: Type.Array(CalendarEntryResource),
  },
  {
    title: 'CalendarEntryList',
    description:
      'Your entries from one day to another, by day, then occasion as the calendar stacks them. A range, not pages: ask for the next days',
  },
);

/** POST /calendar-entries. */
export const NewCalendarEntry = Type.Object(
  {
    outfitId: CloneType(RowId, {
      description:
        'One of your outfits; one with pieces still to buy (its `toBuy`) is a 409',
    }),
    day: IsoDateSchema,
    occasion: Type.Optional(
      CloneType(Occasion, { description: 'All day unless given' }),
    ),
    clientId: Type.Optional(
      Type.String({
        format: 'uuid',
        description:
          'Your id for this entry, for retrying it offline: accepted, not yet stored (an outfit is on a day once anyway)',
      }),
    ),
  },
  {
    title: 'NewCalendarEntry',
    description:
      'Plans an outfit on a day. Once a day per outfit: planning it again is that entry, its occasion kept',
  },
);

const SCHEDULE_OUTCOMES = [
  'scheduled',
  'already-scheduled',
] as const satisfies readonly ScheduleOutcome[];

export const CalendarEntryScheduled = Type.Object(
  {
    id: Type.Integer({ description: 'The entry' }),
    outcome: literals(SCHEDULE_OUTCOMES),
    occasion: CloneType(Occasion, {
      description: 'The one asked, or the one it kept when already planned',
    }),
    adopted: Type.Optional(
      Type.Boolean({
        description:
          "Already planned by Plan my week: it is yours now, out of the re-plan's reach",
      }),
    ),
  },
  { title: 'CalendarEntryScheduled' },
);

/**
 * PUT /calendar-entries/{id}/outfit: exactly one of the two (the handler
 * says so, entryOutfitChoice; a union of objects would let ajv's
 * removeAdditional strip one branch's fields while trying the other).
 */
export const EntryOutfitInput = Type.Object(
  {
    outfitId: Type.Optional(
      CloneType(RowId, {
        description:
          'One of your outfits, not on that day already (a 409) and with no piece to buy',
      }),
    ),
    garmentIds: Type.Optional(
      Type.Array(RowId, {
        minItems: 1,
        maxItems: MAX_PICKED,
        description:
          "An idea's garments, of your closet: the outfit they are, or a new one of them. One not in your closet refuses it, nothing written: a 404 when any is not yours, else a 409 naming them",
      }),
    ),
    name: Type.Optional(
      Type.String({
        maxLength: OUTFIT_NAME_MAX,
        description:
          "With `garmentIds`, a new outfit's name: the idea's (its garments) unless sent",
      }),
    ),
  },
  {
    title: 'CalendarEntryOutfitInput',
    description: 'The outfit the entry holds now: `outfitId` or `garmentIds`',
  },
);

/**
 * The choice an EntryOutfitInput names. Each fault is a 400 `validation` at
 * its own field: both or neither of `outfitId`/`garmentIds` at `outfitId`, a
 * `name` beside `outfitId` alone at `name`.
 */
export function entryOutfitChoice(
  input: Static<typeof EntryOutfitInput>,
): ReplacementChoice {
  const { outfitId, garmentIds, name } = input;
  if (outfitId !== undefined && garmentIds === undefined) {
    if (name !== undefined) throw outfitNameNeedsGarments();
    return { outfitId };
  }
  if (outfitId === undefined && garmentIds !== undefined) {
    // An idea's garments for the entry's day: a one-off (#659).
    return { garmentIds, name: outfitText(name) ?? undefined, origin: 'idea' };
  }
  throw outfitOrGarments();
}

const REPLACE_OUTCOMES = [
  'replaced',
  'unchanged',
] as const satisfies readonly Replaced['outcome'][];

export const EntryOutfitChanged = Type.Object(
  {
    outcome: CloneType(literals(REPLACE_OUTCOMES), {
      description: '`unchanged`: it held that outfit already (a retry)',
    }),
    day: IsoDateSchema,
    occasion: Occasion,
    outfitId: Type.Integer(),
    previousOutfitId: Type.Integer(),
    alreadySaved: Type.Optional(
      Type.Boolean({
        description:
          'With `garmentIds`: they were an outfit of yours already; false, a new one was saved',
      }),
    ),
    selfieKeptAsLook: Type.Boolean({
      description:
        'Its selfie stays on the day as a look: it shows the old outfit',
    }),
    plannerOutfitRemoved: Type.Boolean({
      description:
        'The outfit Plan my week had made for it, held by nothing else, is gone',
    }),
  },
  { title: 'CalendarEntryOutfitChanged' },
);

export function toEntryOutfitChanged(
  replaced: Replaced,
  choice: ReplacementChoice,
): Static<typeof EntryOutfitChanged> {
  return {
    outcome: replaced.outcome,
    day: replaced.day,
    occasion: replaced.occasion,
    outfitId: replaced.outfitId,
    previousOutfitId: replaced.previousOutfitId,
    ...('garmentIds' in choice && { alreadySaved: replaced.alreadySaved }),
    selfieKeptAsLook: replaced.selfieDetached !== undefined,
    plannerOutfitRemoved: replaced.outfitsRemoved > 0,
  };
}

/** PUT /calendar-entries/{id}/worn. */
export const EntryWornInput = Type.Object(
  { worn: Type.Boolean() },
  {
    title: 'CalendarEntryWornInput',
    description:
      'Worn (each of its garments worn that day) or not (those wears gone)',
  },
);

export const EntryWorn = Type.Object(
  {
    day: IsoDateSchema,
    worn: Type.Boolean(),
    /** False when it already was so: a retry. */
    changed: Type.Boolean(),
    wears: Type.Integer({
      minimum: 0,
      description: 'Garment wears logged or removed by this change',
    }),
  },
  { title: 'CalendarEntryWorn' },
);
