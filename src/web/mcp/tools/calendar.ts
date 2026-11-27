import { t } from '../../i18n';
import * as z from 'zod';
import { selectScalars } from '../../../db/select-scalars';
import { compareOccasions } from '../../../wardrobe/occasions';
import { addDays, daysBetween, todayIn } from '../../../calendar-date';
import { entriesSql, MAX_CALENDAR_DAYS } from '../../calendar/queries';
import { HttpError } from '../../errors';
import {
  rainGearForDays,
  readWeatherWithForecast,
  weatherWithForecastSql,
} from '../../weather/queries';
import { userWeatherFrom } from '../../weather/service';
import { markEntryWorn } from '../../calendar/entry-actions';
import { laundryList } from '../../wears/queries';
import { washGarments, wearGarment } from '../../wears/wear-actions';
import { actorOf, defineTool, wardrobeFor } from '../tool';
import { isoDate, ownerIdInput, rowId } from './common';
import { type DayWeatherOf, reachesForecast, weatherOfDays } from './weather';
import { type Projection, project } from '../../api/resource';
import type { CalendarEntry } from '../../calendar/calendar-view';
import {
  CalendarEntryResource,
  calendarEntryRecord,
  type CalendarEntryRecord,
} from '../../calendar/entry-resource';
import { outfitGarmentForAgent } from './outfits';

/**
 * A calendar entry as an agent reads it (#711): the API's record
 * (entry-resource.ts), nulls kept; never the selfie itself, and `agent`
 * the agent's bare name, as every tool's.
 */
export const CALENDAR_ENTRY_FOR_MCP = {
  id: 'keep',
  day: 'keep',
  occasion: 'keep',
  worn: 'keep',
  plannedBy: 'keep',
  agent: 'own',
  // Answered as `selfie`: whether a mirror photo was taken (#19).
  selfieId: 'omit',
  selfiePhoto: 'omit',
  outfit: 'own',
} as const satisfies Projection<CalendarEntryRecord>;

export const CALENDAR_ENTRY_OUTFIT_FOR_MCP = {
  id: 'keep',
  name: 'keep',
  garments: 'own',
} as const satisfies Projection<CalendarEntryRecord['outfit']>;

function entryForAgent(
  entry: CalendarEntry,
  weather: ReturnType<DayWeatherOf> | undefined,
) {
  const record = calendarEntryRecord(entry);
  return project(record, CalendarEntryResource, CALENDAR_ENTRY_FOR_MCP, {
    agent: record.agent?.name ?? null,
    outfit: project(
      record.outfit,
      CalendarEntryResource.properties.outfit,
      CALENDAR_ENTRY_OUTFIT_FOR_MCP,
      {
        garments: record.outfit.garments.map(outfitGarmentForAgent),
      },
    ),
    selfie: record.selfieId !== null,
    weather,
  });
}

/**
 * The calendar is the caller's own record: no tool reaches it through a
 * share. The laundry (laundry_status, mark_washed, mark_worn's "Wore
 * today") takes `ownerId` for a wardrobe shared to MANAGE (`launder`,
 * #680), as the pages do; a VIEW share is a 403 (Forbidden), a wardrobe
 * not shared "Wardrobe not found".
 */
export const calendarTools = [
  defineTool({
    name: 'get_calendar',
    title: 'Get my calendar',
    description: `Your calendar from one day to another (inclusive, at most ${MAX_CALENDAR_DAYS} days): each entry's id, day, occasion (the part of the day: a day can hold several outfits, listed in occasion order), outfit (its id, name and garments), whether it was worn, whether you took an outfit selfie of it (a mirror photo; the photo itself is never given), and who planned it (plannedBy: user; auto for "Plan my week"'s picks, which its daily re-plan may swap until you edit or wear them; or agent for what an agent planned through these tools, with agent naming its token). Without dates: this week, from today. Days are the household's (its time zone). With weather on and a location set, an entry within the forecast also has the day's weather and what it asks of that occasion's outfit (as get_weather gives it).`,
    input: z.object({
      from: isoDate().optional().describe('First day, YYYY-MM-DD.'),
      to: isoDate().optional().describe('Last day, YYYY-MM-DD.'),
    }),
    writes: false,
    async run({ from, to }, ctx) {
      const now = new Date();
      const today = todayIn(ctx.timeZone, now);
      const first = from ?? today;
      const last = to ?? addDays(first, 6);
      const days = daysBetween(first, last) + 1;
      if (days < 1 || days > MAX_CALENDAR_DAYS) {
        throw new HttpError(
          400,
          t('api.DAY_RANGE', { max: MAX_CALENDAR_DAYS }),
        );
      }
      // The entries and, when the range reaches the forecast, the settings
      // with their forecast row: one statement (#172; it was two in turn).
      const { weather } = ctx;
      const read = await selectScalars(ctx.db, {
        entries: entriesSql(ctx.userId, first, last),
        weather:
          weather && reachesForecast(today, first, last)
            ? weatherWithForecastSql(ctx.userId, now, weather.timeZone)
            : undefined,
      });
      const { entries } = read;
      // Only entries carry weather: an empty range never fetches a forecast.
      let weatherOf: DayWeatherOf | null = null;
      if (weather && read.weather !== undefined && entries.length > 0) {
        const own = await userWeatherFrom(
          weather,
          readWeatherWithForecast(read.weather, now),
          now,
        );
        // The closet's rain gear, read only when an entry's day asks for it.
        const rainGear = await rainGearForDays(
          ctx.db,
          ctx.userId,
          own,
          entries,
        );
        weatherOf = weatherOfDays(own, rainGear);
      }
      return {
        today,
        from: first,
        to: last,
        // By day (as read), then occasion, as the calendar page stacks them.
        entries: entries
          .sort(
            (a, b) =>
              a.day.localeCompare(b.day) ||
              compareOccasions(a.occasion, b.occasion),
          )
          .map((entry) =>
            entryForAgent(entry, weatherOf?.(entry.day, entry.occasion)),
          ),
      };
    },
  }),

  defineTool({
    name: 'laundry_status',
    title: 'What needs a wash',
    description:
      'The garments worn since their last wash that can get dirty, in the closet: those needing a wash first (dirty copies of how many), then those worn but not due yet. Your own, or with ownerId a wardrobe shared with you to MANAGE.',
    input: z.object({ ownerId: ownerIdInput }),
    writes: false,
    async run({ ownerId }, ctx) {
      const access = await wardrobeFor(ctx, ownerId, 'launder');
      const items = await laundryList(ctx.db, access.ownerId);
      return {
        garments: items.map(({ id, name, category, quantity, dirty }) => ({
          id,
          name,
          category,
          quantity,
          dirtyCopies: dirty,
          needsWash: dirty > 0,
        })),
      };
    },
  }),

  defineTool({
    name: 'mark_worn',
    title: 'Mark worn',
    description:
      'WRITES: records a wear. With entryId: marks that calendar entry worn, which records each of its outfit’s garments as worn that day (not for a future day; your own calendar only). With garmentId: "Wore today", one garment worn today on its own, in your own wardrobe or with ownerId one shared with you to MANAGE (the wear is the owner’s).',
    input: z
      .object({
        entryId: rowId().optional().describe('A calendar entry id.'),
        garmentId: rowId().optional().describe('One of your garments.'),
        ownerId: ownerIdInput,
      })
      .refine(
        (args) =>
          (args.entryId === undefined) !== (args.garmentId === undefined),
        {
          message: 'Give either entryId or garmentId',
        },
      ),
    writes: true,
    idempotent: true,
    async run({ entryId, garmentId, ownerId }, ctx) {
      const now = new Date();
      const today = todayIn(ctx.timeZone, now);
      if (entryId !== undefined) {
        const deps = { db: ctx.db, logger: ctx.webLogger };
        const outcome = await markEntryWorn(deps, actorOf(ctx), {
          entryId,
          worn: true,
          at: now,
          today,
        });
        if (outcome === 'future') {
          throw new HttpError(400, t('refusal.day.futureNotWorn'));
        }
        return { entryId, worn: true, garmentsRecorded: outcome.wears };
      }
      // As the garment page's Wore today: the owner's or a MANAGE partner's.
      await wearGarment(
        { db: ctx.db, logger: ctx.webLogger },
        actorOf(ctx),
        { id: garmentId!, ownerId, unseen: 'wardrobe' },
        // Now is on today: today is its date.
        { day: today, worn: true, wornAt: now },
      );
      return { garmentId, day: today };
    },
  }),

  defineTool({
    name: 'mark_washed',
    title: 'Mark washed',
    description:
      'WRITES: marks garments washed today (every copy, like laundry day); wears today count as before the wash. Your own, or with ownerId a wardrobe shared with you to MANAGE; ids that are not that wardrobe’s garments are ignored.',
    input: z.object({
      garmentIds: z.array(rowId()).min(1).max(500),
      ownerId: ownerIdInput,
    }),
    writes: true,
    idempotent: true,
    async run({ garmentIds, ownerId }, ctx) {
      const now = new Date();
      const today = todayIn(ctx.timeZone, now);
      const { washed } = await washGarments(
        { db: ctx.db, logger: ctx.webLogger },
        actorOf(ctx),
        ownerId,
        garmentIds,
        { day: today, at: now },
      );
      return { washed: washed.map((row) => row.id), day: today };
    },
  }),
];
