import { CloneType, type Static, Type } from '@sinclair/typebox';
import { AWAY_REASONS } from '../../wardrobe/availability';
import { OCCASIONS } from '../../wardrobe/occasions';
import { tripPhase, type TripPhase } from '../../wardrobe/packing';
import { GARMENT_ROLES } from '../../wardrobe/properties';
import { literals, withoutNulls } from '../api/resource';
import { imageUrl } from '../files/image-url';
import { OUTFIT_NAME_MAX } from '../outfits/queries';
import {
  OutfitGarmentResource,
  toOutfitGarment,
} from '../outfits/outfit-resource';
import { IsoDateSchema, RowId } from '../schemas';
import { TEMPERATURE_UNITS } from '../../weather/temperature';
import {
  DayWeather,
  PlaceInput,
  toDayWeather,
  toTypicalDayWeather,
  TypicalDayWeather,
} from '../weather/weather-resource';
import type { TripForecast } from './forecast';
import type { TripModel, TripOutfitView } from './model';
import type { SyncedTripRow, TripRow, TripSummary } from './queries';
import {
  TRIP_DESTINATION_MAX,
  TRIP_ITEM_MAX,
  TRIP_NAME_MAX,
  TRIP_NOTES_MAX,
  type TripField,
} from './validation';
import { AgentResource, toAgentResource } from '../write-origin';

/**
 * The API's trip resources and inputs (#194a; docs/plans/2026-11-12-json-
 * api.md section 2), mapped from what the pages and MCP read: a list's trip
 * (listTrips) and one in full (requireTripModel: get_trip's model, the trip
 * page's one statement). camelCase, null fields left out. The packing list
 * is derived (src/wardrobe/packing.ts), so it is read, never written: a
 * client ticks its garments and extras one at a time.
 */

const TRIP_PHASES = [
  'upcoming',
  'current',
  'past',
] as const satisfies readonly TripPhase[];

/** A trip's own fields: also the changes feed's (SyncedTrip). */
const storedTripFields = {
  id: Type.Integer(),
  name: Type.String(),
  destination: Type.Optional(Type.String()),
  /** The destination was picked from the place search: its weather reaches the trip. */
  located: Type.Boolean(),
  startsOn: IsoDateSchema,
  endsOn: IsoDateSchema,
  notes: Type.Optional(Type.String()),
};

const tripFields = {
  ...storedTripFields,
  phase: CloneType(literals(TRIP_PHASES), {
    description:
      "Where the trip stands on the household's today (GET /me): packing warnings are only for one upcoming or current",
  }),
};

export const TripListItem = Type.Object(
  {
    ...tripFields,
    outfitCount: Type.Integer({ minimum: 0 }),
    extraCount: Type.Integer({ minimum: 0 }),
  },
  {
    title: 'TripListItem',
    description:
      'One of your trips as a list shows it: GET /trips/{id} has its days, outfits, packing list and extras',
  },
);
type TripListItem = Static<typeof TripListItem>;

const TripOutfitResource = Type.Object(
  {
    id: Type.Integer({
      description:
        "This outfit's place on the trip (DELETE /trips/{id}/outfits/{tripOutfitId}); the same outfit may be on several days",
    }),
    outfitId: Type.Integer(),
    name: Type.Optional(Type.String()),
    /** Absent: for any day of the trip. */
    day: Type.Optional(IsoDateSchema),
    occasion: Type.Optional(literals(OCCASIONS)),
    garments: Type.Array(OutfitGarmentResource),
    /** Its calendar entry marked worn today, while the trip is on. */
    wornTodayEntryId: Type.Optional(Type.Integer()),
    agent: Type.Optional(AgentResource),
  },
  { title: 'TripOutfit' },
);

const PackingWarningResource = Type.Union(
  [
    Type.Object(
      { kind: Type.Literal('too-few'), short: Type.Integer({ minimum: 1 }) },
      { description: 'The trip needs `short` more copies than you own' },
    ),
    Type.Object(
      { kind: Type.Literal('wash'), clean: Type.Integer({ minimum: 0 }) },
      {
        description:
          'Before departure: only `clean` copies are clean now, fewer than to pack',
      },
    ),
    Type.Object(
      { kind: Type.Literal('away'), reason: literals(AWAY_REASONS) },
      { description: 'Lent, or at the repair shop' },
    ),
    Type.Object(
      { kind: Type.Literal('archived') },
      { description: 'No longer in the closet, though an outfit holds it' },
    ),
  ],
  { title: 'PackingWarning' },
);

const PackingGarmentResource = Type.Object(
  {
    id: Type.Integer({
      description: 'The garment: PUT /trips/{id}/packing/{garmentId} ticks it',
    }),
    name: Type.Optional(Type.String()),
    category: Type.String(),
    quantity: Type.Integer({ description: 'Copies owned' }),
    thumbUrl: Type.Optional(Type.String()),
    outfits: Type.Integer({ description: 'Trip outfits that hold it' }),
    wears: Type.Integer({
      description:
        'Its wears on the trip: one per day it is worn, whatever the occasions, and one per outfit for any day',
    }),
    copiesNeeded: Type.Integer({
      description:
        'Nothing is washed on the trip: ceil(wears / its wash limit), one for what is never washed',
    }),
    pack: Type.Integer({
      description: 'Copies to pack: the copies needed, up to those owned',
    }),
    packed: Type.Boolean(),
    warnings: Type.Array(PackingWarningResource),
  },
  { title: 'PackingGarment' },
);

const PackingResource = Type.Object(
  {
    garments: Type.Integer({ description: 'Garments on the list' }),
    packed: Type.Integer({ description: 'Of them, marked packed' }),
    pieces: Type.Integer({
      description: "Pieces to pack: every garment's `pack`",
    }),
    warned: Type.Integer({ description: 'Garments with a warning' }),
    groups: Type.Array(
      Type.Object(
        {
          role: literals(GARMENT_ROLES),
          garments: Type.Array(PackingGarmentResource),
        },
        { title: 'PackingGroup' },
      ),
      { description: 'Top to toe' },
    ),
  },
  {
    title: 'Packing',
    description:
      "The packing list, derived from the trip's outfits: every garment they hold, once",
  },
);

const TripItemResource = Type.Object(
  { id: Type.Integer(), label: Type.String(), packed: Type.Boolean() },
  {
    title: 'TripItem',
    description:
      'An extra to pack (a charger, the passport), in the order added',
  },
);

export const Trip = Type.Object(
  {
    ...tripFields,
    days: Type.Array(
      Type.Object(
        { day: IsoDateSchema, outfits: Type.Array(TripOutfitResource) },
        { title: 'TripDay' },
      ),
      {
        description:
          'Every day of the trip, each with its outfits in occasion order',
      },
    ),
    anyDay: Type.Array(TripOutfitResource, {
      description: 'Outfits for the trip but no day of it',
    }),
    packing: PackingResource,
    extras: Type.Array(TripItemResource),
  },
  {
    title: 'Trip',
    description:
      'One of your trips as its page shows it: its days and their outfits, the packing list and the extras',
  },
);
type Trip = Static<typeof Trip>;

/**
 * The changes feed's trip (#196b-2, GET /changes): its own fields and the
 * rows of its sync children (outfits, extras, packed marks). No `phase`
 * (it moves with the day, not the trip), no `days` or `anyDay` grouping
 * (the outfits' days, flat here), no outfit names or garments (the
 * outfits'), no `wornTodayEntryId` (the calendar's) and no `packing`: the
 * list is derived from the outfits' slots and the garments, whose edits
 * never move the trip's revision; the client derives it as the server does.
 */
export const SyncedTrip = Type.Object(
  {
    ...storedTripFields,
    outfits: Type.Array(
      Type.Object(
        {
          id: TripOutfitResource.properties.id,
          outfitId: Type.Integer(),
          day: Type.Optional(IsoDateSchema),
          occasion: Type.Optional(literals(OCCASIONS)),
          agent: Type.Optional(AgentResource),
        },
        { title: 'SyncedTripOutfit' },
      ),
      { description: 'In the order added; absent `day`: for any day' },
    ),
    extras: Type.Array(TripItemResource),
    packedGarmentIds: Type.Array(Type.Integer(), {
      description:
        'The garments marked packed. A mark whose garment is no longer on the list (its outfit taken off or edited) is ignored, and goes at the next write that prunes it',
    }),
  },
  {
    title: 'SyncedTrip',
    description:
      'One of your trips as stored: its packing list is derived from its outfits’ garments',
  },
);

export function toSyncedTrip(row: SyncedTripRow): Static<typeof SyncedTrip> {
  return {
    id: row.id,
    name: row.name,
    ...withoutNulls({ destination: row.destination, notes: row.notes }),
    located: row.location !== null,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    outfits: row.outfits.map(({ agent, ...outfit }) => ({
      ...withoutNulls(outfit),
      agent: toAgentResource(agent),
    })),
    extras: row.extras,
    packedGarmentIds: row.packedGarmentIds,
  };
}

function toTripFields(trip: TripRow, phase: TripPhase) {
  return {
    id: trip.id,
    name: trip.name,
    ...withoutNulls({ destination: trip.destination, notes: trip.notes }),
    located: trip.location !== null,
    startsOn: trip.startsOn,
    endsOn: trip.endsOn,
    phase,
  };
}

export function toTripListItem(trip: TripSummary, today: string): TripListItem {
  return {
    ...toTripFields(trip, tripPhase(trip, today)),
    outfitCount: trip.outfits,
    extraCount: trip.extras,
  };
}

function toTripOutfit(
  view: TripOutfitView,
  wornToday: ReadonlyMap<number, number>,
) {
  return {
    id: view.id,
    outfitId: view.outfitId,
    ...withoutNulls({
      name: view.name,
      day: view.day,
      occasion: view.occasion,
      wornTodayEntryId: wornToday.get(view.id) ?? null,
    }),
    agent: toAgentResource(view.agent),
    garments: view.garments.map(toOutfitGarment),
  };
}

export function toTripResource(model: TripModel): Trip {
  const { trip, packing, wornToday } = model;
  return {
    ...toTripFields(trip, model.phase),
    days: model.days.map(({ day, outfits }) => ({
      day,
      outfits: outfits.map((view) => toTripOutfit(view, wornToday)),
    })),
    anyDay: model.undated.map((view) => toTripOutfit(view, wornToday)),
    packing: {
      garments: packing.garments,
      packed: packing.packed,
      pieces: packing.pieces,
      warned: packing.warned,
      groups: packing.groups.map(({ role, rows }) => ({
        role,
        garments: rows.map((row) => ({
          id: row.garment.id,
          ...withoutNulls({
            name: row.garment.name,
            thumbUrl: row.garment.photo && imageUrl(row.garment.photo, 'thumb'),
          }),
          category: row.garment.category,
          quantity: row.garment.quantity,
          outfits: row.outfits,
          wears: row.wears,
          copiesNeeded: row.needed,
          pack: row.pack,
          packed: row.packed,
          warnings: row.warnings,
        })),
      })),
    },
    extras: model.items,
  };
}

/** POST /trips and PUT /trips/{id}: the trip form's fields, judged by its rules (readTripForm). */
const tripInputFields = {
  name: Type.String({
    maxLength: TRIP_NAME_MAX,
    description: 'Trimmed; a blank one is a 400 naming `body/name`',
  }),
  destination: Type.Optional(
    Type.String({
      maxLength: TRIP_DESTINATION_MAX,
      description:
        'Where to, as text; a new one forgets the place a search located (its weather)',
    }),
  ),
  startsOn: CloneType(IsoDateSchema, { description: 'The first day' }),
  endsOn: CloneType(IsoDateSchema, {
    description: 'The last day: not before the first, at most 60 days in all',
  }),
  notes: Type.Optional(Type.String({ maxLength: TRIP_NOTES_MAX })),
};

export const NewTrip = Type.Object(
  {
    ...tripInputFields,
    // Described on the route: PlaceInput is a named schema.
    place: Type.Optional(PlaceInput),
    clientId: Type.Optional(
      Type.String({
        format: 'uuid',
        description:
          'Your id for this create, for retrying it offline: a retry answers the first trip of that id (200), the id of one deleted since is a 410',
      }),
    ),
  },
  { title: 'NewTrip' },
);

export const TripInput = Type.Object(tripInputFields, {
  title: 'TripInput',
  description:
    "The trip's own fields, replaced whole (a field left out is cleared); its outfits and extras stay. Outfits on days the new dates leave out move to any day",
});

/** Where each form field sits in the JSON body (refusedBody). */
export const POINTER_OF_TRIP_FIELD: Record<TripField, string> = {
  name: '/name',
  startsOn: '/startsOn',
  endsOn: '/endsOn',
};

export const TripCreated = Type.Object(
  { id: Type.Integer() },
  { title: 'TripCreated' },
);

export const TripUpdated = Type.Object(
  {
    undated: Type.Integer({
      minimum: 0,
      description: 'Outfits moved to any day, their day outside the new dates',
    }),
    locationCleared: Type.Boolean({
      description:
        'The destination changed: the place it was located at is forgotten',
    }),
  },
  { title: 'TripUpdated' },
);

const TripSlotFields = {
  day: Type.Optional(
    CloneType(IsoDateSchema, {
      description:
        "One of the trip's days (else a 400 naming them); absent, any day",
    }),
  ),
  occasion: Type.Optional(literals(OCCASIONS)),
};

/**
 * POST /trips/{id}/outfits: plan_trip_outfit's two paths, a saved outfit
 * (planTripOutfit) or an idea's garments made one (pickIdeaForTrip).
 * Exactly one of `outfitId` and `garmentIds` (the handler judges it).
 */
export const TripOutfitInput = Type.Object(
  {
    outfitId: Type.Optional(
      CloneType(RowId, { description: 'One of your saved outfits' }),
    ),
    garmentIds: Type.Optional(
      Type.Array(RowId, {
        minItems: 1,
        maxItems: 8,
        description:
          'Garments of your closet, saved as an outfit (or the one you have of exactly these)',
      }),
    ),
    name: Type.Optional(
      Type.String({
        maxLength: OUTFIT_NAME_MAX,
        description: "With `garmentIds`: the new outfit's name",
      }),
    ),
    ...TripSlotFields,
  },
  {
    title: 'TripOutfitInput',
    description:
      'An outfit on the trip, for one of its days and an occasion or for any day: either `outfitId` or `garmentIds`. Once a day: adding it again keeps the first occasion. An outfit with pieces to buy is a 409',
  },
);

export const TripOutfitAddedResource = Type.Object(
  {
    outfitId: Type.Integer(),
    /** `garmentIds` made a new outfit (not one you had). */
    outfitCreated: Type.Boolean(),
    /** False: it was on the trip for that day already. */
    added: Type.Boolean(),
  },
  { title: 'TripOutfitAdded' },
);

export const TripOutfitRemoved = Type.Object(
  {
    outfitId: Type.Integer(),
    unpacked: Type.Integer({
      minimum: 0,
      description:
        'Packed marks removed with garments no other trip outfit holds',
    }),
  },
  { title: 'TripOutfitRemoved' },
);

export const TripOutfitWorn = Type.Object(
  {
    outfitId: Type.Integer(),
    day: CloneType(IsoDateSchema, { description: 'Today' }),
    occasion: literals(OCCASIONS),
    entryId: Type.Integer({ description: 'Its calendar entry today' }),
    /** False: it was marked worn today already. */
    changed: Type.Boolean(),
  },
  { title: 'TripOutfitWorn' },
);

export const PackedInput = Type.Object(
  { packed: Type.Boolean() },
  { title: 'PackedInput' },
);

export const GarmentPacked = Type.Object(
  {
    garmentId: Type.Integer(),
    packed: Type.Boolean(),
    /** False when it already was so: a retry. */
    changed: Type.Boolean(),
  },
  { title: 'TripGarmentPacked' },
);

export const ItemPacked = Type.Object(
  {
    ...TripItemResource.properties,
    /** False when it already was so: a retry. */
    changed: Type.Boolean(),
  },
  { title: 'TripItemPacked' },
);

export const NewTripItem = Type.Object(
  {
    label: Type.String({
      minLength: 1,
      maxLength: TRIP_ITEM_MAX,
      pattern: '\\S',
      description:
        'Trimmed; a label the trip has already, in any case, adds nothing',
    }),
  },
  { title: 'NewTripItem' },
);

export const TripItemAdded = Type.Object(
  {
    /** False: the trip had that label already. */
    added: Type.Boolean(),
  },
  { title: 'TripItemAdded' },
);

export const TripItemsCopy = Type.Object(
  {
    fromTripId: CloneType(RowId, {
      description:
        "Another trip of yours, whose extras' labels are copied unpacked",
    }),
  },
  { title: 'TripItemsCopy' },
);

export const TripItemsCopied = Type.Object(
  {
    added: Type.Integer({
      minimum: 0,
      description:
        'Extras added: labels the trip has already are skipped, so a retry adds none',
    }),
  },
  { title: 'TripItemsCopied' },
);

const TripLaterDays = Type.Object(
  {
    from: CloneType(IsoDateSchema, {
      description: 'The first trip day past the forecast',
    }),
    forecastArrives: CloneType(IsoDateSchema, {
      description: "The day that day's forecast arrives: ask again then",
    }),
  },
  { title: 'TripLaterDays' },
);

/** GET /trips/{id}/weather: tripForecast, as the trip page's fragment and get_trip read it. */
export const TripWeather = Type.Object(
  {
    status: CloneType(literals(['forecast', 'no-location', 'over'] as const), {
      description:
        '`no-location`: the destination is not located (PUT /trips/{id}/destination); `over`: the trip has ended. Neither fetches anything',
    }),
    unit: Type.Optional(
      CloneType(literals(TEMPERATURE_UNITS), {
        description: 'How you read temperatures: display only',
      }),
    ),
    temperatureOffset: Type.Optional(
      Type.Number({ description: "°C, in each day's `outfit` already" }),
    ),
    fetchedAt: Type.Optional(
      Type.String({
        format: 'date-time',
        description:
          'When the forecast was fetched; absent when no day is within it',
      }),
    ),
    forecastUnavailable: Type.Optional(
      Type.Boolean({
        description:
          'Some trip days are within the forecast, but there is none for the place right now (`days` is empty)',
      }),
    ),
    days: Type.Array(DayWeather, {
      description:
        "The trip's days from today the forecast reaches, each with what it asks of an all-day outfit",
    }),
    later: Type.Optional(TripLaterDays),
    typicalDays: Type.Array(TypicalDayWeather, {
      description:
        "The days past the forecast, with the place's typical weather (never a forecast)",
    }),
  },
  {
    title: 'TripWeather',
    description:
      "The destination's weather for the trip's days: the forecast for those within its 16 days of today, the typical weather past them",
  },
);
type TripWeather = Static<typeof TripWeather>;

export function toTripWeather(forecast: TripForecast): TripWeather {
  if (forecast.kind !== 'forecast') {
    return { status: forecast.kind, days: [], typicalDays: [] };
  }
  return {
    status: forecast.kind,
    unit: forecast.unit,
    temperatureOffset: forecast.offset,
    ...(forecast.fetchedAt && { fetchedAt: forecast.fetchedAt.toISOString() }),
    forecastUnavailable: forecast.unavailable,
    days: forecast.days.map((day) => toDayWeather(day.forecast, day.needs)),
    ...(forecast.later && {
      later: { from: forecast.later.day, forecastArrives: forecast.later.from },
    }),
    typicalDays: forecast.typical.map(toTypicalDayWeather),
  };
}
