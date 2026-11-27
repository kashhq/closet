import type { Db } from '../../db/client';
import { selectScalars } from '../../db/select-scalars';
import type { Idea } from '../../wardrobe/generator';
import {
  compareOccasions,
  DAY_OCCASIONS,
  DEFAULT_OCCASION,
  type Occasion,
} from '../../wardrobe/occasions';
import { type IsoDate, todayIn } from '../../calendar-date';
import type { CalendarEntry } from '../calendar/calendar-view';
import { entriesSql } from '../calendar/queries';
import { type AwayTrip, awayTripsSql } from '../trips/away';
import { dailySeed, ideasFor, type IdeasWeather } from '../gallery/ideas';
import {
  closetCanDress,
  type ClosetKind,
  closetKindsSql,
  type PoolGarment,
} from '../gallery/queries';
import {
  readWeatherWithForecast,
  weatherWithForecastSql,
} from '../weather/queries';
import {
  type UserWeather,
  userWeatherFrom,
  type WeatherService,
} from '../weather/service';
import { somethingWornSql } from './queries';
import { type NeedsToDecide, needsToDecideSql } from '../wishlist/inbox';
import { type AgentRound, agentRoundSql } from '../wishlist/rounds';

/**
 * Today (#15; plan section 9): the household's day for one person, as a
 * row per occasion. The page (routes.tsx), the MCP tool get_today and the
 * push reminders (src/web/push/reminders.ts) all read it here, so the
 * three never disagree about what is planned or suggested.
 *
 * - A row per occasion planned today, holding its entries (occasion order).
 * - While nothing that dresses the day is planned (DAY_OCCASIONS: all day,
 *   work, daytime), an all-day row of suggestions first: a page of
 *   TODAY_IDEAS from ideasFor for today's forecast, the day's seed
 *   (dailySeed, as the gallery opens with), so a reload shows the same
 *   three and Refresh walks the pages.
 * - The person's weather (settings and forecast), read once beside the
 *   entries: the page's line and the ideas' matching share it.
 *
 * Whether anything was worn today is read only when asked (`worn`, in the
 * same statement): the page never shows it (#158); get_today asks, and the
 * evening reminder reads it for every evening person at once (eveningDays).
 * So are the agent's needs waiting on the owner's choice (`needs`, #333) and
 * its latest round while any of it waits (#337), which only the page
 * shows, as one card: the round's while it waits, else the needs'. So is
 * the first-run gate (`firstRun`, #666): until the closet can be dressed
 * as an outfit the page leads with adding garments and offers no plan,
 * and no ideas are drawn (none could be).
 */

/** Ideas a suggestions row shows at once. */
export const TODAY_IDEAS = 3;

/** Refresh stops at this page and starts over. */
export const MAX_TODAY_PAGE = 20;

export interface PlannedRow {
  kind: 'planned';
  occasion: Occasion;
  entries: CalendarEntry[];
}

export interface IdeasRow {
  kind: 'ideas';
  occasion: Occasion;
  ideas: Idea<PoolGarment>[];
  /** 1-based page of the day's ideas. */
  page: number;
  /** The page Refresh shows: the next, or the first again after the last. */
  nextPage: number;
  weather: IdeasWeather | null;
}

type TodayRow = PlannedRow | IdeasRow;

/**
 * Where a closet that cannot be dressed yet stands (#666): nothing in it,
 * or garments but not an outfit's worth (no top and bottom, no dress).
 */
export type FirstRun = 'empty' | 'incomplete';

function firstRunOf(kinds: readonly ClosetKind[]): FirstRun | null {
  if (kinds.length === 0) return 'empty';
  return closetCanDress(kinds) ? null : 'incomplete';
}

export interface TodayModel {
  today: IsoDate;
  rows: TodayRow[];
  /** Null with WEATHER_ENABLED=false. */
  weather: UserWeather | null;
  /** Whether anything was worn today (somethingWornSql); read only when asked (`worn`). */
  wornToday?: boolean;
  /** The agent's needs with options to choose (needsToDecideSql); null for none; read only when asked (`needs`). */
  needs?: NeedsToDecide | null;
  /** The agent's latest round while any of it waits (agentRoundSql); null otherwise; read with `needs`. */
  round?: AgentRound | null;
  /** The first-run path's stage; null once the closet can be dressed; read only when asked (`firstRun`). */
  firstRun?: FirstRun | null;
  /** The trips today is a day of (#684): the page says "Away". */
  away: AwayTrip[];
}

export interface TodayOptions {
  /**
   * The person's weather when the caller read it already (the morning
   * reminders' batch refresh, refreshForecastsFor, #173); else read here.
   */
  ownWeather?: UserWeather;
  /** Also read whether anything was worn today (get_today; the page never shows it). */
  worn?: boolean;
  /** Also read the agent's needs and latest round waiting on the owner (the page's card). */
  needs?: boolean;
  /** Also read the first-run gate over the closet's kinds (the page). */
  firstRun?: boolean;
}

export interface TodayDeps {
  db: Db;
  weather: WeatherService | undefined;
  timeZone: string;
}

/**
 * The day's entries, the person's settings with their forecast row, and
 * (when asked) whether anything was worn, the agent's needs waiting on a
 * choice and the closet's kinds (the first-run gate, #666), in one
 * statement (#172; the
 * entries and the weather were two, in parallel), so the ideas start with
 * the weather in hand. Only a forecast that must be fetched reads again
 * (userWeatherFrom).
 */
async function readDay(
  deps: TodayDeps,
  ownerId: number,
  today: IsoDate,
  now: Date,
  { ownWeather, worn, needs, firstRun }: TodayOptions,
) {
  const read = await selectScalars(deps.db, {
    entries: entriesSql(ownerId, today, today, { washOn: today }),
    weather:
      ownWeather || !deps.weather
        ? undefined
        : weatherWithForecastSql(ownerId, now, deps.weather.timeZone),
    worn: worn ? somethingWornSql(ownerId, today) : undefined,
    needs: needs ? needsToDecideSql(ownerId) : undefined,
    round: needs ? agentRoundSql(ownerId) : undefined,
    closet: firstRun ? closetKindsSql(ownerId) : undefined,
    away: awayTripsSql(ownerId, today, today),
  });
  const weather =
    ownWeather ??
    (deps.weather &&
      (await userWeatherFrom(
        deps.weather,
        readWeatherWithForecast(read.weather ?? null, now),
        now,
      )));
  return {
    entries: read.entries,
    weather,
    worn: read.worn,
    needs: read.needs,
    round: read.round,
    closet: read.closet,
    away: read.away,
  };
}

export async function todayFor(
  deps: TodayDeps,
  ownerId: number,
  now: Date,
  options: TodayOptions = {},
): Promise<TodayModel> {
  const today = todayIn(deps.timeZone, now);
  const { entries, weather, worn, needs, round, closet, away } = await readDay(
    deps,
    ownerId,
    today,
    now,
    options,
  );
  const firstRun = closet && firstRunOf(closet);
  // Occasion order, the calendar's; a stable sort keeps the planned first.
  entries.sort((a, b) => compareOccasions(a.occasion, b.occasion));
  const rows: TodayRow[] = [];
  for (const entry of entries) {
    const last = rows.at(-1);
    if (last?.kind === 'planned' && last.occasion === entry.occasion) {
      last.entries.push(entry);
    } else {
      rows.push({
        kind: 'planned',
        occasion: entry.occasion,
        entries: [entry],
      });
    }
  }
  const dressed = entries.some((e) => DAY_OCCASIONS.includes(e.occasion));
  // A closet that cannot be dressed draws no idea: the statement is saved.
  if (!dressed && !firstRun) {
    // All day sorts first among occasions, so it opens the list.
    rows.unshift(
      await todayIdeas(deps, ownerId, now, DEFAULT_OCCASION, 1, weather),
    );
  }
  return {
    today,
    rows,
    weather: weather ?? null,
    wornToday: worn,
    needs,
    round,
    firstRun,
    away,
  };
}

/**
 * A page of today's ideas for `occasion` (Refresh's fragment asks for the
 * next). A page past the end (the closet changed since the page was drawn)
 * starts over at the first. `ownWeather`: the person's weather when the
 * caller read it already (todayFor); else ideasFor reads it.
 */
export async function todayIdeas(
  deps: TodayDeps,
  ownerId: number,
  now: Date,
  occasion: Occasion,
  page: number,
  ownWeather?: UserWeather,
): Promise<IdeasRow> {
  const today = todayIn(deps.timeZone, now);
  const ask = (asked: number) =>
    ideasFor(
      { db: deps.db, weather: deps.weather },
      ownerId,
      {
        today,
        day: today,
        occasion,
        seed: dailySeed(today),
        offset: (asked - 1) * TODAY_IDEAS,
        limit: TODAY_IDEAS,
        ownWeather,
      },
      now,
    );
  let shown = page;
  let result = await ask(shown);
  if (result.ideas.length === 0 && shown > 1) {
    shown = 1;
    result = await ask(shown);
  }
  return {
    kind: 'ideas',
    occasion,
    ideas: result.ideas,
    page: shown,
    nextPage: result.more && shown < MAX_TODAY_PAGE ? shown + 1 : 1,
    weather: result.weather,
  };
}
