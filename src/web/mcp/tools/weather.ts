import { t } from '../../i18n';
import * as z from 'zod';
import type { Occasion } from '../../../wardrobe/occasions';
import { FORECAST_DAYS } from '../../../weather/forecast';
import {
  addDays,
  daysBetween,
  type IsoDate,
  todayIn,
} from '../../../calendar-date';
import { HttpError } from '../../errors';
import { rainGearFor } from '../../weather/queries';
import { type MatchGarment, weatherNeeds } from '../../../weather/match';
import { userWeather, type UserWeather } from '../../weather/service';
import { dayWeather, needsWithGear } from '../../weather/weather-resource';
import { defineTool } from '../tool';
import { isoDate, occasionInput } from './common';

/**
 * The weather tools (#14), listed only with WEATHER_ENABLED (mcpTools,
 * ./index.ts). The user's own location and forecast, as on their pages;
 * get_calendar and get_today add the same day summaries (weatherOfDays).
 * A day's shape (dayWeather) is the API's too (weather-resource.ts).
 */

/** The last day the forecast reaches from `today`. */
function horizon(today: IsoDate): IsoDate {
  return addDays(today, FORECAST_DAYS - 1);
}

/** Whether the days `first` to `last` reach into the forecast from `today`. */
export function reachesForecast(
  today: IsoDate,
  first: IsoDate,
  last: IsoDate,
): boolean {
  return last >= today && first <= horizon(today);
}

/** A day's weather for an occasion (dayWeather), or undefined past the forecast. */
export type DayWeatherOf = (
  day: IsoDate,
  occasion: Occasion,
) => ReturnType<typeof dayWeather> | undefined;

/**
 * The weather of each day for get_calendar's entries and get_today, from
 * the user's weather their tool already read in its own statement: null
 * when there is nothing to add (weather off, no location, no answer from
 * Open-Meteo yet).
 */
export function weatherOfDays(
  weather: UserWeather | null | undefined,
  rainGear: readonly MatchGarment[],
): DayWeatherOf | null {
  if (!weather?.cached) return null;
  const { settings, cached } = weather;
  return (day, occasion) => {
    const forecast = cached.forecast.days.find((d) => d.day === day);
    return (
      forecast &&
      dayWeather(
        forecast,
        needsWithGear(forecast, occasion, settings.offset, rainGear),
      )
    );
  };
}

export const weatherTools = [
  defineTool({
    name: 'get_weather',
    title: 'Get my weather',
    description: `The forecast where you are (your home city, or the phone's location while it is fresh), from today up to ${FORECAST_DAYS} days ahead (without dates: this week), and what each day asks of an outfit for an occasion (all-day when omitted): the occasion's hours and their feels-like range (°C, your personal offset included), the torso warmth to reach (top plus layer combined, 1-9, where a garment's warmth is 1-5: a tee 2, a sweater 4, a jacket 3, a parka 5), that warmth without the layer for the warmest hours, the warmth for legs and feet (1-5), whether a layer that comes off is needed, and whether rain asks for a water-resistant layer, footwear or accessory. Temperatures are °C; "unit" is how the user reads them.`,
    input: z.object({
      from: isoDate().optional().describe('First day, YYYY-MM-DD, from today.'),
      to: isoDate()
        .optional()
        .describe(
          `Last day, YYYY-MM-DD, at most ${FORECAST_DAYS - 1} days after today.`,
        ),
      occasion: occasionInput,
    }),
    writes: false,
    async run({ from, to, occasion = 'all-day' }, ctx) {
      // Listed only with a service (mcpTools).
      const service = ctx.weather!;
      const now = new Date();
      const today = todayIn(ctx.timeZone, now);
      const first = from ?? today;
      const last = to ?? addDays(first, 6);
      if (
        first < today ||
        last > horizon(today) ||
        daysBetween(first, last) < 0
      ) {
        throw new HttpError(
          400,
          t('refusal.weather.daysFromTo', { from: today, to: horizon(today) }),
        );
      }
      const { settings, active, cached } = await userWeather(
        ctx.db,
        service,
        ctx.userId,
        now,
      );
      if (!active) {
        return {
          location: null,
          note: 'No location set: the user sets a home city (or uses their location) in the app, under Profile, Weather.',
        };
      }
      const location = { name: active.name, source: active.source };
      if (!cached) {
        return {
          location,
          forecast: null,
          note: 'The forecast is not available right now; try again later.',
        };
      }
      const asked = cached.forecast.days.filter(
        (day) => day.day >= first && day.day <= last,
      );
      const rainGear = await rainGearFor(
        ctx.db,
        ctx.userId,
        asked.map((day) => weatherNeeds(day, occasion, settings.offset)),
      );
      return {
        today,
        location,
        unit: settings.unit,
        temperatureOffsetC: settings.offset,
        fetchedAt: cached.fetchedAt.toISOString(),
        days: asked.map((day) =>
          dayWeather(
            day,
            needsWithGear(day, occasion, settings.offset, rainGear),
          ),
        ),
      };
    },
  }),
];
