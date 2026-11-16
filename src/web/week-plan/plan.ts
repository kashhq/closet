import type { Db, Queryable } from '../../db/client';
import { type ScalarValues, selectScalars } from '../../db/select-scalars';
import type { IdeaProblem } from '../../wardrobe/generator';
import {
  type ActivewearGap,
  lacksActivewear,
  OCCASION_HINTS,
  type Occasion,
} from '../../wardrobe/occasions';
import {
  emptySlots,
  PLAN_DAYS,
  type PlannedNeeds,
  plannedNeeds,
  planWeek,
  type Slot,
  type WeekContext,
  type WeekEntry,
} from '../../wardrobe/week-planner';
import type { TemplateSlot } from '../../wardrobe/week';
import type { DayForecast } from '../../weather/forecast';
import { type MatchGarment, weatherNeeds } from '../../weather/match';
import { ownerTransaction } from '../auth/queries';
import { addDays, hourIn, type IsoDate, todayIn } from '../../calendar-date';
import { entryOf } from '../calendar/queries';
import type { ClosetKind } from '../gallery/queries';
import { pickIdea } from '../outfits/pick';
import { NotFound } from '../refusals';
import type { Actor } from '../sharing/access';
import {
  generatorMemorySql,
  readGeneratorMemory,
  readWeekPool,
  type WeekPoolGarment,
  weekPoolSql,
} from '../gallery/queries';
import type { ReadOptions } from '../weather/location-cache';
import { rainGearFor } from '../weather/queries';
import {
  type UserWeather,
  userWeather,
  type WeatherService,
} from '../weather/service';
import {
  type BatchEntry,
  createWeekPlan,
  deleteEmptyWeekPlan,
  recordAutoEntry,
  removeBatchAutoEntries,
  removeUnheldOutfits,
  readWindowEntries,
  weekPlanOf,
  windowEntriesSql,
} from './queries';
import { type AwayTrip, awayTripsSql, splitAwayDays } from '../trips/away';
import { BY_PERSON } from '../write-origin';
import { inTemplateOrder, weekTemplateSql } from './template';

/**
 * "Plan my week" (#16; plan section 12): the week planner
 * (src/wardrobe/week-planner.ts, pure) fed from the database and the
 * forecast, and its writes. Called by POST /calendar/plan-week (routes.tsx),
 * the MCP tool plan_week and POST /api/v1/week-plans (all three through
 * planMyWeekNow) and the seed; the daily re-plan (replan.ts) shares
 * writeAutoPick and the window's reads.
 *
 * A plan is one transaction under lockOwner: the template, the week's
 * entries and the pool are read after the lock, so a second tap (or a
 * retried plan_week) waits for the first, finds its slots filled and plans
 * nothing. Every outfit is written through pickIdea (the gallery's pick:
 * an outfit of exactly those garments reused, else created and named),
 * planned for its slot with planned_by 'auto', and recorded with its batch
 * and the targets it was planned for.
 */

/** The forecast a week is planned with: days by date, and the person's offset. */
export interface WeekForecast {
  days: ReadonlyMap<IsoDate, DayForecast>;
  offset: number;
}

export const NO_FORECAST: WeekForecast = { days: new Map(), offset: 0 };

/**
 * The person's forecast (a cached read, at most one bounded fetch; nothing
 * without WEATHER_ENABLED or a location). Read before any transaction: a
 * plan never holds the owner lock while Open-Meteo answers. A plan is a
 * decision made once, so "Plan my week" reads `{ fresh: true }` (a stale
 * forecast's refresh awaited, not served around); the daily re-plan takes
 * what its batch's refresh of every candidate's forecast answered
 * (refreshForecastsFor, forecastOf), so one slow location never holds up
 * the rest, and reads `{}` only for a user the batch left out (a failed
 * or overrun refresh) or when the morning reminder runs it.
 */
async function weekForecast(
  deps: { db: Db; weather: WeatherService | undefined },
  userId: number,
  now: Date,
  read: ReadOptions,
): Promise<WeekForecast> {
  if (!deps.weather) return NO_FORECAST;
  return forecastOf(
    await userWeather(deps.db, deps.weather, userId, now, read),
  );
}

/** A user's weather as the week is planned with it. */
export function forecastOf({ settings, cached }: UserWeather): WeekForecast {
  return {
    days: new Map((cached?.forecast.days ?? []).map((day) => [day.day, day])),
    offset: settings.offset,
  };
}

/**
 * The closet's rain gear for the slots being planned or judged, from the
 * one reader every surface uses (rainGearFor): no statement unless a slot's
 * day asks for water resistance. The planner takes it as `rainGear`, so a
 * hat in the wash answers a rainy day here as it does on Today.
 */
export function weekRainGear(
  db: Queryable,
  ownerId: number,
  forecast: WeekForecast,
  slots: readonly Slot[],
): Promise<MatchGarment[]> {
  return rainGearFor(
    db,
    ownerId,
    slots.map(({ day, occasion }) => {
      const found = forecast.days.get(day);
      return found && weatherNeeds(found, occasion, forecast.offset);
    }),
  );
}

/** The days "Plan my week" fills: today and the six after it. */
export function planDays(today: IsoDate): IsoDate[] {
  return Array.from({ length: PLAN_DAYS }, (_, i) => addDays(today, i));
}

/** An entry the planner wrote, as the calendar and plan_week report it. */
export interface PlannedEntry {
  entryId: number;
  day: IsoDate;
  occasion: Occasion;
  outfitId: number;
  outfitName: string | null;
  /** The planner found this outfit already saved and planned it (it created none). */
  alreadySaved: boolean;
  garments: { id: number; name: string | null; category: string }[];
  /** The idea's problems: a near miss the planner took for want of better. */
  problems: IdeaProblem[];
}

export interface WeekPlanResult {
  /** False: the person has no week template, so nothing was planned. */
  templateSet: boolean;
  /** The batch (for Undo); null when nothing was planned. */
  weekPlanId: number | null;
  planned: PlannedEntry[];
  /** Empty slots nothing could fill (nothing clean left for them). */
  unfilled: Slot[];
  /** The days asked that a trip covers (#684): nothing is planned at home on them. */
  away: IsoDate[];
}

export interface PlanWeekInput {
  /** Today in APP_TIMEZONE. */
  today: IsoDate;
  /** Now's hour in APP_TIMEZONE (today's ended slots stay empty). */
  hour: number;
  /** The days to fill: planDays(today); the seed plans the week after its anchor. */
  days: readonly IsoDate[];
  forecast: WeekForecast;
}

/** What planMyWeekNow planned, from which day, with which forecast. */
export interface PlannedNow {
  today: IsoDate;
  forecast: WeekForecast;
  result: WeekPlanResult;
}

/**
 * "Plan my week" as a person asks it, now: the forecast read fresh (outside
 * the lock), then planMyWeek over today and the six days after it, in the
 * household's zone. The calendar's button, plan_week and the API's
 * POST /week-plans each call it and say what it did their own way.
 */
export async function planMyWeekNow(
  deps: { db: Db; weather: WeatherService | undefined; timeZone: string },
  ownerId: number,
  now: Date,
): Promise<PlannedNow> {
  const today = todayIn(deps.timeZone, now);
  const forecast = await weekForecast(deps, ownerId, now, { fresh: true });
  const result = await planMyWeek(deps.db, ownerId, {
    today,
    hour: hourIn(deps.timeZone, now),
    days: planDays(today),
    forecast,
  });
  return { today, forecast, result };
}

/**
 * Fills the week's empty template slots, once (see the module comment),
 * leaving out the days a trip covers (#684: they are planned on the trip).
 */
export function planMyWeek(
  db: Queryable,
  ownerId: number,
  input: PlanWeekInput,
): Promise<WeekPlanResult> {
  return ownerTransaction(db, ownerId, 'planMyWeek', async (tx) => {
    const { today, hour } = input;
    const asked = { first: input.days[0], last: input.days.at(-1)! };
    // One statement after the lock: the template, the window's entries and
    // its trips (the trip writers take the owner lock too, so a trip saved
    // meanwhile is seen).
    const row = await selectScalars(tx, {
      template: weekTemplateSql(ownerId),
      entries: windowEntriesSql(ownerId, today, asked.last),
      trips: awayTripsSql(ownerId, asked.first, asked.last),
    });
    const template = inTemplateOrder(row.template);
    const { home: days, away } = splitAwayDays(input.days, row.trips);
    const nothing = { weekPlanId: null, planned: [], unfilled: [], away };
    if (template.length === 0) return { templateSet: false, ...nothing };
    const entries = readWindowEntries(row.entries);
    // Every slot filled already (a double tap, a retried plan_week, a week
    // planned by hand, a week away): nothing to plan, so neither the pool
    // nor the generator's memory is read (#165: two round trips). planWeek
    // plans exactly these slots.
    const empty = emptySlots({ today, hour, days, template, entries });
    if (empty.length === 0) return { templateSet: true, ...nothing };
    const plan = planWeek({
      today,
      entries,
      ...(await readGenerator(tx, ownerId, today)),
      hour,
      days,
      template,
      forecast: input.forecast.days,
      offset: input.forecast.offset,
      rainGear: await weekRainGear(tx, ownerId, input.forecast, empty),
    });
    const result: WeekPlanResult = {
      templateSet: true,
      weekPlanId: null,
      planned: [],
      unfilled: plan.unfilled,
      away,
    };
    if (plan.planned.length === 0) return result;
    const weekPlanId = await createWeekPlan(tx, ownerId);
    for (const slot of plan.planned) {
      const written = await writeAutoPick(tx, ownerId, weekPlanId, {
        day: slot.day,
        occasion: slot.occasion,
        garments: slot.idea.garments,
        problems: slot.idea.problems,
        needs: plannedNeeds(slot.needs),
      });
      if (written) result.planned.push(written);
      else result.unfilled.push({ day: slot.day, occasion: slot.occasion });
    }
    if (result.planned.length > 0) result.weekPlanId = weekPlanId;
    else await deleteEmptyWeekPlan(tx, weekPlanId);
    return result;
  });
}

/**
 * What the re-plan judges a week by, as scalar subqueries for one
 * selectScalars inside its locked transaction: the entries from today to
 * `last` and what the generator draws from (generatorSql). The re-plan
 * reads its auto entries' outfit states in the same statement (#173: they
 * were four); readWeekColumns reads them back.
 */
export function weekSql(ownerId: number, today: IsoDate, last: IsoDate) {
  return {
    entries: windowEntriesSql(ownerId, today, last),
    ...generatorSql(ownerId, today),
  };
}

export function readWeekColumns(
  today: IsoDate,
  row: ScalarValues<ReturnType<typeof weekSql>>,
): Omit<WeekContext<WeekPoolGarment>, 'forecast' | 'offset' | 'rainGear'> {
  return {
    today,
    entries: readWindowEntries(row.entries),
    ...readGeneratorColumns(row),
  };
}

/**
 * The pool and the saved outfits with the avoided pairs and the outfit
 * rules: what the planner fills slots from, as scalar subqueries (the
 * generator's own, in src/web/gallery/queries.ts).
 */
function generatorSql(ownerId: number, today: IsoDate) {
  return {
    pool: weekPoolSql(ownerId, today),
    ...generatorMemorySql(ownerId),
  };
}

function readGeneratorColumns(
  row: ScalarValues<ReturnType<typeof generatorSql>>,
): Pick<WeekContext<WeekPoolGarment>, 'pool' | 'saved' | 'avoid' | 'rules'> {
  return { pool: readWeekPool(row.pool), ...readGeneratorMemory(row) };
}

/** generatorSql in one statement: "Plan my week" once it found a slot to fill. */
async function readGenerator(
  tx: Queryable,
  ownerId: number,
  today: IsoDate,
): Promise<
  Pick<WeekContext<WeekPoolGarment>, 'pool' | 'saved' | 'avoid' | 'rules'>
> {
  return readGeneratorColumns(
    await selectScalars(tx, generatorSql(ownerId, today)),
  );
}

/**
 * Writes one of the planner's outfits: pickIdea plans it for the slot as
 * 'auto', and the entry is recorded in the batch with the targets it was
 * planned for. Undefined when the pick could not be the planner's: a
 * garment gone from the closet meanwhile, or the outfit found already on
 * that day (the person's entry, which stays theirs).
 */
export async function writeAutoPick(
  tx: Queryable,
  ownerId: number,
  weekPlanId: number,
  pick: {
    day: IsoDate;
    occasion: Occasion;
    garments: readonly WeekPoolGarment[];
    problems: IdeaProblem[];
    needs: PlannedNeeds | null;
  },
): Promise<PlannedEntry | undefined> {
  const picked = await pickIdea(tx, ownerId, {
    garmentIds: pick.garments.map((g) => g.id),
    plan: { day: pick.day, occasion: pick.occasion },
    origin: 'planner',
    // The planner, whoever pressed the button (plan_week included): its
    // entries are `auto`, its outfits carry no token.
    madeBy: BY_PERSON,
  });
  if (picked === 'not-found' || picked.schedule !== 'scheduled') {
    return undefined;
  }
  // Just planned: its entry is there.
  const entryId = (await entryOf(tx, ownerId, pick.day, picked.id))!.id;
  await recordAutoEntry(tx, {
    entryId,
    weekPlanId,
    outfitCreated: !picked.alreadySaved,
    needs: pick.needs,
  });
  return {
    entryId,
    day: pick.day,
    occasion: pick.occasion,
    outfitId: picked.id,
    outfitName: picked.name,
    alreadySaved: picked.alreadySaved,
    garments: pick.garments.map(({ id, name, category }) => ({
      id,
      name,
      category,
    })),
    problems: pick.problems,
  };
}

/**
 * Undo of one "Plan my week": its entries the planner still owns are
 * removed (removeBatchAutoEntries), with the outfits it created for them
 * that nothing else holds (removeUnheldOutfits); entries the person took
 * over since (edited, worn) stay theirs. The batch goes once it has no
 * entry left. The actor's own batches only (#188): another's, whatever
 * share they hold, is NotFound like an unknown id.
 */
export function undoWeekPlan(
  db: Queryable,
  actor: Actor,
  weekPlanId: number,
): Promise<{ entries: number; outfits: number }> {
  const ownerId = actor.userId;
  return ownerTransaction(db, ownerId, 'undoWeekPlan', async (tx) => {
    const removed = await removeBatchAutoEntries(tx, ownerId, weekPlanId);
    // Nothing removed: an own batch whose entries were all taken over (or
    // undone already), or not the owner's at all. Only then is it asked.
    if (removed.length === 0 && !(await weekPlanOf(tx, ownerId, weekPlanId))) {
      throw new NotFound('weekPlan');
    }
    const outfits = await removeUnheldOutfits(
      tx,
      ownerId,
      removed.filter((e) => e.outfitCreated).map((e) => e.outfitId),
    );
    await deleteEmptyWeekPlan(tx, weekPlanId);
    return { entries: removed.length, outfits };
  });
}

/** What the calendar says after "Plan my week" (`?planned=`). */
export interface PlannedBanner {
  /** Null: nothing new was planned (`?planned=none`). */
  weekPlanId: number | null;
  entries: BatchEntry[];
  /** Template slots of the next 7 days still without an outfit. */
  stillEmpty: Slot[];
  /**
   * Why an empty active slot (a workout) is empty, when it is the closet's
   * activewear (#647): none at all, or none clean and at home. Undefined
   * when no empty slot is active.
   */
  activewearGap: ActivewearGap | undefined;
  /** The next 7 days a trip covers (#684): skipped, not empty. */
  away: IsoDate[];
}

/**
 * The banner's model: the batch's entries still on the calendar, and the
 * template slots of the next 7 days that are still empty (what the plan
 * could not fill, or what was removed since). Undefined for a batch that
 * is not the owner's (the banner is navigation state: no 404). From reads
 * the caller made (weekContext, src/web/calendar/week-context.ts: the
 * batch's entries, the template, and the entries of planDays(today), in
 * the week page's one statement).
 */
export function plannedBanner(
  planned: number | 'none',
  reads: {
    batch: BatchEntry[];
    template: readonly TemplateSlot[];
    window: readonly Pick<WeekEntry, 'day' | 'occasion'>[];
    /** The closet's kinds (closetKindsSql), read for the banner. */
    closetKinds: readonly ClosetKind[];
    /** The trips with a day in the next 7 (awayTripsSql). */
    trips: readonly AwayTrip[];
  },
  now: { today: IsoDate; hour: number },
): PlannedBanner | undefined {
  if (planned !== 'none' && reads.batch.length === 0) return undefined;
  const { home, away } = splitAwayDays(planDays(now.today), reads.trips);
  const stillEmpty = emptySlots({
    today: now.today,
    hour: now.hour,
    days: home,
    template: reads.template,
    entries: reads.window,
  });
  // The banner reads the calendar, not the plan's reasons: an empty active
  // slot is the closet's when it lacks the kinds, else they are out (the
  // planner counts the week's wears and washes day by day).
  const active = stillEmpty
    .map((slot) => OCCASION_HINTS[slot.occasion].active)
    .find((demand) => demand !== undefined);
  return {
    weekPlanId: planned === 'none' ? null : planned,
    entries: reads.batch,
    stillEmpty,
    activewearGap:
      active &&
      (lacksActivewear(active, reads.closetKinds)
        ? 'no-activewear'
        : 'none-available'),
    away,
  };
}
