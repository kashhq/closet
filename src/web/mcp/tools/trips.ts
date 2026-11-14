import * as z from 'zod';
import { NORMAL_YEARS } from '../../../weather/normals';
import { todayIn } from '../../../calendar-date';
import { type Projection, project } from '../../api/resource';
import { HttpError } from '../../errors';
import { OUTFIT_NAME_MAX } from '../../outfits/queries';
import { type TripForecast, tripForecast } from '../../trips/forecast';
import { listTrips, type TripSlot } from '../../trips/queries';
import {
  pickIdeaForTrip,
  planTripOutfit,
  requireTripModel,
} from '../../trips/trip-actions';
import {
  tripListRecord,
  type TripListRecord,
  tripRecord,
  type TripRecord,
} from '../../trips/trip-resource';
import { actorOf, defineTool, originOf, type ToolContext } from '../tool';
import { isoDate, occasionInput, rowId } from './common';
import { outfitGarmentForAgent } from './outfits';
import { dayWeather, typicalDayWeather } from '../../weather/weather-resource';

/**
 * Trips (#10): the same model the trip page renders (tripModel: its days
 * and outfits, the derived packing list with its warnings, the extras) and
 * the same writers. The caller's own, like outfits: no ownerId.
 */

/**
 * The trip resources as an agent reads them (#711): the API's records
 * (trip-resource.ts), nulls kept, each level projected; no photo URLs (an
 * agent cannot fetch a signed /file URL), and `agent` the agent's bare
 * name, as every tool's.
 */
export const TRIP_LIST_ITEM_FOR_MCP = {
  id: 'keep',
  name: 'keep',
  destination: 'keep',
  notes: 'omit',
  located: 'keep',
  startsOn: 'keep',
  endsOn: 'keep',
  phase: 'keep',
  // Answered as `outfits` and `extras`, list_trips' names since #10.
  outfitCount: 'omit',
  extraCount: 'omit',
} as const satisfies Projection<TripListRecord>;

export const TRIP_FOR_MCP = {
  id: 'keep',
  name: 'keep',
  destination: 'keep',
  notes: 'keep',
  located: 'keep',
  startsOn: 'keep',
  endsOn: 'keep',
  phase: 'keep',
  days: 'own',
  anyDay: 'own',
  packing: 'own',
  extras: 'keep',
} as const satisfies Projection<TripRecord>;

type TripOutfitRecord = TripRecord['anyDay'][number];
type PackingRecord = TripRecord['packing'];
type PackingGroupRecord = PackingRecord['groups'][number];

export const TRIP_DAY_FOR_MCP = {
  day: 'keep',
  outfits: 'own',
} as const satisfies Projection<TripRecord['days'][number]>;

export const TRIP_OUTFIT_FOR_MCP = {
  // Answered as `tripOutfitId`, get_trip's name since #10.
  id: 'omit',
  outfitId: 'keep',
  name: 'keep',
  day: 'keep',
  occasion: 'keep',
  wornTodayEntryId: 'keep',
  agent: 'own',
  garments: 'own',
} as const satisfies Projection<TripOutfitRecord>;

export const PACKING_FOR_MCP = {
  garments: 'keep',
  packed: 'keep',
  pieces: 'keep',
  warned: 'keep',
  groups: 'own',
} as const satisfies Projection<PackingRecord>;

export const PACKING_GROUP_FOR_MCP = {
  role: 'keep',
  garments: 'own',
} as const satisfies Projection<PackingGroupRecord>;

export const PACKING_GARMENT_FOR_MCP = {
  id: 'keep',
  name: 'keep',
  thumbUrl: 'omit',
  category: 'keep',
  quantity: 'keep',
  outfits: 'keep',
  wears: 'keep',
  copiesNeeded: 'keep',
  pack: 'keep',
  packed: 'keep',
  warnings: 'keep',
} as const satisfies Projection<PackingGroupRecord['garments'][number]>;

function tripOutfitForAgent(outfit: TripOutfitRecord) {
  return project(outfit, TRIP_OUTFIT_FOR_MCP, {
    tripOutfitId: outfit.id,
    agent: outfit.agent?.name,
    garments: outfit.garments.map(outfitGarmentForAgent),
  });
}

function packingForAgent(packing: PackingRecord) {
  return project(packing, PACKING_FOR_MCP, {
    groups: packing.groups.map((group) =>
      project(group, PACKING_GROUP_FOR_MCP, {
        garments: group.garments.map((row) =>
          project(row, PACKING_GARMENT_FOR_MCP, {}),
        ),
      }),
    ),
  });
}

/** get_trip's weather: none without weather on, else the forecast or why there is none. */
function weatherOut(forecast: TripForecast | null) {
  if (forecast === null) return undefined;
  if (forecast.kind !== 'forecast') return { status: forecast.kind };
  return {
    forecastUnavailable: forecast.unavailable,
    fetchedAt: forecast.fetchedAt?.toISOString() ?? null,
    days: forecast.days.map((day) => dayWeather(day.forecast, day.needs)),
    laterDays: forecast.later && {
      from: forecast.later.day,
      forecastArrives: forecast.later.from,
    },
    typicalDays: forecast.typical.map(typicalDayWeather),
  };
}

/**
 * plan_trip_outfit's write: a saved outfit (planTripOutfit), or an idea's
 * garments made one (pickIdeaForTrip), on the trip; each refuses itself,
 * as the add page and the gallery's pick do.
 */
async function planOnTrip(
  ctx: ToolContext,
  input: {
    tripId: number;
    outfitId: number | undefined;
    garmentIds: number[] | undefined;
    name: string | undefined;
  } & TripSlot,
): Promise<{ outfitId: number; created: boolean; added: boolean }> {
  const { tripId, day, occasion } = input;
  const actor = actorOf(ctx);
  if (input.garmentIds === undefined) {
    const outfitId = input.outfitId!;
    const added = await planTripOutfit(
      ctx.db,
      actor,
      {
        tripId,
        outfitId,
        day,
        occasion,
      },
      originOf(ctx),
    );
    return { outfitId, created: false, added: added === 'added' };
  }
  const picked = await pickIdeaForTrip(ctx.db, actor, {
    tripId,
    garmentIds: input.garmentIds,
    name: input.name,
    day,
    occasion,
    // An idea for the trip: a one-off, whoever picked it (#659).
    origin: 'idea',
    madeBy: originOf(ctx),
  });
  return {
    outfitId: picked.outfit.id,
    created: !picked.outfit.alreadySaved,
    added: picked.added === 'added',
  };
}

export const tripTools = [
  defineTool({
    name: 'list_trips',
    title: 'List my trips',
    description:
      'Your trips: upcoming and current first (soonest first), then past ones, each with its dates, destination, phase (upcoming, current, past) and how many outfits and extras it holds. get_trip has the outfits and the packing list.',
    input: z.object({}),
    writes: false,
    async run(_args, ctx) {
      const today = todayIn(ctx.timeZone, new Date());
      const trips = await listTrips(ctx.db, ctx.userId, today);
      return {
        today,
        trips: trips.map((trip) => {
          const record = tripListRecord(trip, today);
          return project(record, TRIP_LIST_ITEM_FOR_MCP, {
            outfits: record.outfitCount,
            extras: record.extraCount,
          });
        }),
      };
    },
  }),

  defineTool({
    name: 'get_trip',
    title: 'Get a trip',
    description: `One of your trips as its page shows it: the days with their outfits (each for a day and an occasion, or for any day), and the packing list, derived from those outfits: every garment grouped by role, how many outfits hold it, its wears on the trip (one per day it is worn, whatever the occasions, plus one per outfit without a day), the copies needed (with a wash limit k, ceil(wears / k) since nothing is washed on the trip; one for what is never washed), the copies to pack (up to the quantity owned), whether it is marked packed, and warnings: too-few (you own fewer than the trip needs), wash (before departure, fewer clean copies now than to pack), away (lent or at the repair shop), archived. A finished trip's list has no warnings. Then the extras (charger, toiletries...) packed or not. With weather on and the destination located in the app, the destination's forecast for the trip's days within the 16-day forecast (forecastUnavailable when Open-Meteo has none for the place yet: typicalDays still come), from when the later days' forecast arrives, and meanwhile those later days' typical weather (typicalDays, each marked typical: the average of the last ${NORMAL_YEARS} years' days around that date at the destination, never a forecast: highs and lows, the feels-like range, the share of days with rain, and what such a day asks of an all-day outfit).`,
    input: z.object({ tripId: rowId().describe('The trip, from list_trips.') }),
    writes: false,
    async run({ tripId }, ctx) {
      const today = todayIn(ctx.timeZone, new Date());
      const model = await requireTripModel(ctx.db, actorOf(ctx), tripId, today);
      const { trip } = model;
      const forecast = ctx.weather
        ? await tripForecast(
            { db: ctx.db, weather: ctx.weather },
            ctx.userId,
            trip,
            today,
          )
        : null;
      const record = tripRecord(model);
      return project(record, TRIP_FOR_MCP, {
        days: record.days.map((day) =>
          project(day, TRIP_DAY_FOR_MCP, {
            outfits: day.outfits.map(tripOutfitForAgent),
          }),
        ),
        anyDay: record.anyDay.map(tripOutfitForAgent),
        packing: packingForAgent(record.packing),
        today,
        weather: weatherOut(forecast),
      });
    },
  }),

  defineTool({
    name: 'plan_trip_outfit',
    title: 'Add an outfit to a trip',
    description:
      'WRITES: adds an outfit to one of your trips, optionally for one of its days (date) and an occasion: either a saved outfit (outfitId, from list_outfits) or an idea from suggest_outfits (garmentIds: saved as an outfit named after its garments unless you give a name, or reused when you already have one of exactly these garments). Exactly one of the two. An incomplete outfit (toBuy in list_outfits) is refused until its pieces are bought. The packing list (get_trip) follows. Safe to retry: the same outfit on the same day (or without a day) is on the trip once, and keeps the occasion it has.',
    input: z.object({
      tripId: rowId().describe('The trip, from list_trips.'),
      outfitId: rowId().optional().describe('A saved outfit of yours.'),
      garmentIds: z
        .array(rowId())
        .min(1)
        .max(8)
        .optional()
        .describe("An idea's garmentIds, from suggest_outfits."),
      date: isoDate()
        .optional()
        .describe('One of the trip days (YYYY-MM-DD). Omit for any day.'),
      occasion: occasionInput.describe(
        'The part of the day it is for. Omit when it does not matter.',
      ),
      name: z.string().trim().min(1).max(OUTFIT_NAME_MAX).optional(),
    }),
    writes: true,
    idempotent: true,
    async run({ tripId, outfitId, garmentIds, date, occasion, name }, ctx) {
      if ((outfitId === undefined) === (garmentIds === undefined)) {
        throw new HttpError(400, 'Give either outfitId or garmentIds');
      }
      const planned = await planOnTrip(ctx, {
        tripId,
        outfitId,
        garmentIds,
        name,
        day: date,
        occasion,
      });
      ctx.webLogger.info(
        `Outfit ${planned.outfitId} ${planned.added ? 'added to' : 'already on'} trip ${tripId} by user ${ctx.userId} (MCP; ${date ?? 'any day'}${occasion ? `, ${occasion}` : ''})`,
      );
      return {
        tripId,
        outfitId: planned.outfitId,
        outfitCreated: planned.created,
        added: planned.added,
        day: date ?? null,
        occasion: occasion ?? null,
      };
    },
  }),
];
