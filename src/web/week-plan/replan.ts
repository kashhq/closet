import type { Db, Queryable } from '../../db/client';
import { selectScalars } from '../../db/select-scalars';
import type { Logger } from '../../logger';
import { endWhole } from '../../metrics/partial-failure';
import { REMINDER_WINDOWS } from '../../push/reminders';
import { DAY_OCCASIONS } from '../../wardrobe/occasions';
import {
  type NeedsChange,
  type Replan,
  replanWeek,
  type Slot,
  type SwapCause,
  type Unwearable,
  unwearableOn,
} from '../../wardrobe/week-planner';
import { abortedBy } from '../abort';
import { ownerTransaction } from '../auth/queries';
import { OwnerLockTimeout } from '../errors';
import { dayOfWeek, hourIn, type IsoDate, todayIn } from '../../calendar-date';
import { DAY_NAMES, occasionLabel } from '../date-labels';
import { ideaName } from '../gallery/ideas';
import type { WeekPoolGarment } from '../gallery/queries';
import { type DataKey, t, type StringKey } from '../i18n';
import { awayTripsSql, tripsOn } from '../trips/away';
import type { PushPayload } from '../push/payload';
import type { PushSender, SendReport } from '../push/sender';
import {
  refreshForecastsFor,
  type UserWeather,
  userWeatherOrNone,
  type WeatherService,
} from '../weather/service';
import {
  forecastOf,
  NO_FORECAST,
  readWeekColumns,
  type WeekForecast,
  weekRainGear,
  weekSql,
  writeAutoPick,
} from './plan';
import {
  type AutoEntryRow,
  claimAutoEntries,
  claimReplan,
  outfitGarmentStatesSql,
  pruneReplanClaims,
  readOutfitGarmentStates,
  removeAutoEntries,
  replanCandidates,
  type SlotGarment,
  updatePlannedNeeds,
} from './queries';

/**
 * The daily re-plan (#16; plan section 12): each morning the week
 * planner's own entries (planned_by 'auto', not worn, today on) are judged
 * again (replanWeek, src/wardrobe/week-planner.ts): an outfit that can no
 * longer be worn on its day (a garment lent, at repair, archived or
 * deleted, or today without a clean copy: unwearableOn) is swapped for the
 * slot's best idea; one whose forecast changed is kept while it still fits
 * and swapped for a better idea when it does not. One on a day a trip now
 * covers is removed (#684: the planner never dresses a day away). Entries a
 * person planned, edited or wore are 'user' and never read here. What swapped is pushed to
 * the person's devices that take the morning reminder.
 *
 * replanToday is one user's re-plan for the day, once: the minutely run
 * (replanWeeks) calls it for every user due one from REPLAN_HOUR, and the
 * morning reminder (src/web/push/reminders.ts) calls it for its user
 * before describing the day, so a reminder always names the plan after
 * the re-plan, whatever time it is set to (#76). "Once" is week_replan's
 * primary key, claimed inside the work's own transaction under lockOwner
 * (claimAutoEntries): a second caller (another minute, the reminder, a second
 * server in an overlapping deploy) waits on the owner lock and finds the
 * day claimed and the re-plan committed, never half done. server.ts
 * schedules the run, never createApp(), so the integration harness and the
 * CLIs never re-plan on their own (a spec calls it with the instant it
 * wants).
 */

/**
 * The household's hour from which the minutely run re-plans: the earliest
 * a morning reminder can be set to (REMINDER_WINDOWS), so everyone's day is
 * re-planned by the time any reminder could go out, and a swap notice comes
 * before the reminder rather than after it. The reminder does not rely on
 * it (it re-plans its user first); this is for the people without one.
 * Derived, not a second constant: moving the window moves it. On the wall
 * clock (hourIn): the window keeps away from the hours DST skips.
 */
export const REPLAN_HOUR = Math.floor(REMINDER_WINDOWS.morning.from / 60);

/** How long a push service keeps an undelivered swap: the day's, not the next's. */
const SWAP_TTL_SECONDS = 6 * 60 * 60;
/** A later swap notice replaces an unread one. */
const SWAP_TAG = 'week-replan';

export interface ReplanDeps {
  db: Db;
  /** Undefined without WEATHER_ENABLED: only availability is judged. */
  weather: WeatherService | undefined;
  /** Undefined without PWA_ENABLED: swaps are made, nobody is told. */
  push: PushSender | undefined;
  timeZone: string;
  /** Context `WeekPlan`. */
  logger: Logger;
  /**
   * Bounds a failing person's retries (ReplanRetries). Undefined: a failure
   * claims the day at once, as the one-shot callers (specs) want.
   */
  retries?: ReplanRetries;
}

/** The scheduled jobs that run a re-plan, each reporting its own failures (ReplanRetries). */
export type ReplanJob = 'replan' | 'reminders';

/** Minutes after a failed re-plan before the next try; the failure after the last claims the day. */
export const REPLAN_RETRY_MINUTES = [5, 15, 60] as const;

/**
 * What a failing re-plan has tried today, in process (no table: week_replan
 * is the claim, and a restart or a second server forgetting only retries
 * sooner, which the claim makes harmless). A failed person-day is retried
 * after REPLAN_RETRY_MINUTES, then claimed, so a persistent failure is four
 * attempts a day, not one a minute; and only the first failure of a
 * person-day is `reported` per job (counted into that job's run `failed`, so
 * one failure metric and one error-tracker capture per job and person-day,
 * #687). server.ts holds one for the minutely run and the morning reminder
 * alike: they share the schedule, but each reports its own first failure,
 * or a reminder's would use up the slot the minutely run's PartialFailure
 * needs (#858).
 */
export class ReplanRetries {
  private readonly tries = new Map<
    string,
    { failures: number; nextAt: number; reportedBy: Set<ReplanJob> }
  >();

  private static key(userId: number, day: IsoDate): string {
    return `${userId}:${day}`;
  }

  /** False while a failed person-day waits for its next attempt. */
  isDue(userId: number, day: IsoDate, now: Date): boolean {
    const tried = this.tries.get(ReplanRetries.key(userId, day));
    return !tried || now.getTime() >= tried.nextAt;
  }

  /** Records `job`'s failure: whether it is that job's first of the day and whether it was the last try. */
  failed(
    userId: number,
    day: IsoDate,
    now: Date,
    job: ReplanJob,
  ): { first: boolean; exhausted: boolean } {
    this.forgetBefore(day);
    const key = ReplanRetries.key(userId, day);
    const tried = this.tries.get(key);
    const failures = (tried?.failures ?? 0) + 1;
    const reportedBy = tried?.reportedBy ?? new Set<ReplanJob>();
    const first = !reportedBy.has(job);
    reportedBy.add(job);
    const wait = REPLAN_RETRY_MINUTES[failures - 1];
    if (wait === undefined) {
      this.tries.delete(key);
      return { first, exhausted: true };
    }
    this.tries.set(key, {
      failures,
      nextAt: now.getTime() + wait * 60_000,
      reportedBy,
    });
    return { first, exhausted: false };
  }

  succeeded(userId: number, day: IsoDate): void {
    this.tries.delete(ReplanRetries.key(userId, day));
  }

  private forgetBefore(day: IsoDate): void {
    for (const key of this.tries.keys()) {
      if (key.slice(key.indexOf(':') + 1) < day) this.tries.delete(key);
    }
  }
}

export interface ReplanRun {
  /** Users this run re-planned (claimed), failed ones included. */
  claimed: number;
  swapped: number;
  /** Entries whose targets changed and whose outfit was kept. */
  kept: number;
  failed: number;
  /** Users sent a swap notice. */
  pushed: number;
}

/** One swapped slot, for the notice. */
export interface Swap {
  slot: Slot;
  cause: SwapCause;
  /** The garment the cause names ("Bean Boots"); null for the weather or a deleted garment. */
  garment: string | null;
  /** The garments the new outfit brought in, top to toe. */
  swappedIn: string;
}

/** What replanToday did for one user. */
export type ReplanOutcome =
  | {
      kind: 'replanned';
      swaps: Swap[];
      kept: number;
      /** Auto entries removed from days a trip covers (#684). */
      away: number;
      pushed: boolean;
    }
  | NotReplanned;

/**
 * What replanOnce did, before any notice is sent: `notice` is the swaps the
 * swap notice names (all of them, or other days' only with announcesToday).
 * Its callers send the notices (pushSwaps), the minutely run for all its
 * users at once.
 */
type ReplanResult =
  | {
      kind: 'replanned';
      swaps: Swap[];
      kept: number;
      away: number;
      notice: Swap[];
    }
  | NotReplanned;

type NotReplanned =
  /** Nothing to do: re-planned today already (here or elsewhere), or no auto entry. */
  | { kind: 'skipped' }
  /**
   * Logged; the transaction rolled back with its claim, so a later run tries
   * again (ReplanRetries) until the last try claims the day. `reported` is
   * the person-day's first failure: the only one the run counts (#687).
   */
  | { kind: 'failed'; reported: boolean }
  /**
   * Another of the owner's writes held the owner lock past its timeout:
   * nothing judged, logged, the day left unclaimed for the next minute.
   */
  | { kind: 'deferred' };

/** One minute's re-plan. Never throws for a user: each failure is logged and counted (replanWeeksWhole throws for them). */
export async function replanWeeks(
  deps: ReplanDeps,
  now: Date,
): Promise<ReplanRun> {
  const run: ReplanRun = {
    claimed: 0,
    swapped: 0,
    kept: 0,
    failed: 0,
    pushed: 0,
  };
  if (hourIn(deps.timeZone, now) < REPLAN_HOUR) return run;
  const today = todayIn(deps.timeZone, now);
  const candidates = await replanCandidates(deps.db, today);
  const weather = await candidatesWeather(deps, candidates, now);
  const notices: SwapNotice[] = [];
  for (const userId of candidates) {
    const outcome = await replanOnce(deps, userId, now, {
      announcesToday: false,
      job: 'replan',
      listed: true,
      weather: weather.get(userId),
    });
    if (outcome.kind === 'skipped' || outcome.kind === 'deferred') continue;
    run.claimed += 1;
    if (outcome.kind === 'failed') {
      if (outcome.reported) run.failed += 1;
      continue;
    }
    run.swapped += outcome.swaps.length;
    run.kept += outcome.kept;
    if (outcome.notice.length > 0) {
      notices.push({ userId, swaps: outcome.notice });
    }
  }
  // Every notice after every re-plan, in one batch: one read of the
  // devices, not one per person told (#173).
  run.pushed = (await pushSwaps(deps, notices)).size;
  if (run.claimed > 0) {
    deps.logger.info(
      `Week re-plan at ${now.toISOString()}: ${run.claimed} user(s), ${run.swapped} swapped, ${run.kept} kept, ${run.failed} failed, ${run.pushed} notified`,
    );
  }
  return run;
}

/**
 * The scheduled run: replanWeeks, then a PartialFailure when a person's
 * re-plan failed (the others were re-planned first), for `timeJob` to
 * record as `failure` (#687). server.ts only.
 */
export async function replanWeeksWhole(
  deps: ReplanDeps,
  now: Date,
): Promise<ReplanRun> {
  const run = await replanWeeks(deps, now);
  return endWhole('replan', { failed: run.failed }, run);
}

/**
 * The candidates' weather, refreshed together (refreshForecastsFor) and
 * handed on, so no re-plan reads its own again (#165). Empty without
 * WEATHER_ENABLED: the re-plan then judges availability alone.
 */
async function candidatesWeather(
  deps: ReplanDeps,
  candidates: readonly number[],
  now: Date,
): Promise<ReadonlyMap<number, UserWeather>> {
  if (!deps.weather || candidates.length === 0) return new Map();
  return refreshForecastsFor(
    { db: deps.db, weather: deps.weather, logger: deps.logger },
    candidates,
    now,
  );
}

/**
 * `userId`'s re-plan for today, once a day whoever asks (see the module
 * comment): the judgement and its writes in one transaction with the
 * day's claim, then the swap notice. With `announcesToday` (the morning
 * reminder, which names today's swaps in its own text) the notice leaves
 * today's swaps out and goes only for other days': one push per swap,
 * never two. The returned swaps are all of them, today's included. Never
 * throws: a failure or an owner lock timeout is logged and leaves the day
 * unclaimed (the claim rolled back with the work), so the next minute tries
 * again; a failing person ends the minutely run as a PartialFailure
 * (#687). The morning reminders pass what their
 * batch already knows (`listed`, `weather`), so a person's re-plan reads
 * neither again (#173), and their run's `signal`: an abort is the one
 * thing this throws (its reason), at the next step boundary, the
 * transaction rolled back with its claim when it lands before the commit,
 * so the reminder's run gives its claim back with nothing half done
 * (#920). One after the commit keeps the swaps and skips their notice.
 */
export async function replanToday(
  deps: ReplanDeps,
  userId: number,
  now: Date,
  {
    announcesToday = false,
    job,
    listed = false,
    weather,
    signal,
  }: Pick<ReplanOptions, 'job'> & Partial<ReplanOptions>,
): Promise<ReplanOutcome> {
  const result = await replanOnce(deps, userId, now, {
    announcesToday,
    job,
    listed,
    weather,
    signal,
  });
  if (result.kind !== 'replanned') return result;
  const { notice, ...replanned } = result;
  // A send once started is awaited (web-push takes no signal): never one
  // started after the abort.
  if (signal?.aborted) {
    if (notice.length > 0) {
      deps.logger.warn(
        `Week re-plan for user ${userId}: ${notice.length} swap(s) committed, their notice not sent: shutdown`,
      );
    }
    return { ...replanned, pushed: false };
  }
  const told = await pushSwaps(deps, [{ userId, swaps: notice }]);
  return { ...replanned, pushed: told.has(userId) };
}

interface ReplanOptions {
  announcesToday: boolean;
  /** The job whose run counts this re-plan's failure. */
  job: ReplanJob;
  /**
   * The caller listed the user as due a moment ago (replanCandidates: the
   * minutely run, a minute's morning reminders): not asked again. The
   * claim decides either way.
   */
  listed: boolean;
  /** The caller's batch refresh answered the user's weather (refreshForecastsFor). */
  weather?: UserWeather;
  /** The morning reminder run's (replanToday): checked at each step boundary. */
  signal?: AbortSignal;
}

async function replanOnce(
  deps: ReplanDeps,
  userId: number,
  now: Date,
  { announcesToday, job, listed, weather, signal }: ReplanOptions,
): Promise<ReplanResult> {
  const today = todayIn(deps.timeZone, now);
  const started = performance.now();
  // A failed person-day waits for its next try (ReplanRetries).
  if (deps.retries && !deps.retries.isDue(userId, today, now)) {
    return { kind: 'skipped' };
  }
  try {
    signal?.throwIfAborted();
    // A cheap look first: the forecast read below is for users with
    // something to judge. The claim decides.
    if (
      !listed &&
      (await replanCandidates(deps.db, today, [userId])).length === 0
    ) {
      return { kind: 'skipped' };
    }
    const result = await replanUser(deps, userId, now, weather, signal);
    deps.retries?.succeeded(userId, today);
    if (!result) return { kind: 'skipped' };
    const { swaps, kept, away } = result;
    const swapped = swaps
      .map((s) => `${s.slot.day} ${s.slot.occasion} ${causeText(s.cause)}`)
      .join(', ');
    const ms = Math.round(performance.now() - started);
    deps.logger.info(
      `Week re-plan for user ${userId} on ${today}: ${swaps.length} swapped (${swapped}), ${kept} kept${away > 0 ? `, ${away} removed from days away` : ''} in ${ms} ms`,
    );
    const notice = announcesToday
      ? swaps.filter((s) => s.slot.day !== today)
      : swaps;
    return { kind: 'replanned', swaps, kept, away, notice };
  } catch (error) {
    // Shutdown, not this person's failure: nothing to retry or claim.
    if (abortedBy(signal, error)) throw error;
    // Another of the owner's writes held the lock past its timeout: nothing
    // was judged, so the day stays unclaimed and the next minute tries again
    // (claiming it would wait on the same lock).
    if (error instanceof OwnerLockTimeout) {
      deps.logger.warn(
        `Week re-plan for user ${userId} on ${today} deferred: ${error.logDetail}`,
      );
      return { kind: 'deferred' };
    }
    const { first, exhausted } = deps.retries?.failed(
      userId,
      today,
      now,
      job,
    ) ?? {
      first: true,
      exhausted: true,
    };
    deps.logger.error(
      { err: error },
      `Week re-plan for user ${userId} on ${today} failed${exhausted ? ', claimed for the day' : ', to be tried again'}`,
    );
    if (exhausted) await claimAfterFailure(deps, userId, today, now);
    return { kind: 'failed', reported: first };
  }
}

// The failed transaction took its claim with it: claim the day on its own.
async function claimAfterFailure(
  deps: ReplanDeps,
  userId: number,
  today: IsoDate,
  now: Date,
): Promise<void> {
  try {
    await ownerTransaction(deps.db, userId, 'claimAfterFailure', (tx) =>
      claimReplan(tx, userId, today, now),
    );
  } catch (error) {
    deps.logger.error(
      { err: error },
      `Week re-plan for user ${userId} on ${today} could not be claimed after its failure: tried again next minute`,
    );
  }
}

// The person's forecast read here, for a user the caller's batch did not
// answer: none without WEATHER_ENABLED, or when the fetch failed with nothing
// cached (userWeatherOrNone).
async function jobForecast(
  deps: Pick<ReplanDeps, 'db' | 'weather' | 'logger'>,
  userId: number,
  now: Date,
  signal: AbortSignal | undefined,
): Promise<WeekForecast> {
  if (!deps.weather) return NO_FORECAST;
  const weather = await userWeatherOrNone(
    { db: deps.db, weather: deps.weather, logger: deps.logger },
    userId,
    now,
    signal,
  );
  return forecastOf(weather);
}

/**
 * Judges one user's auto entries and applies the verdicts, in one
 * transaction under the owner lock (every calendar write takes it: a
 * "Plan my week", a pick, scheduling, a worn tap, a delete or an outfit
 * edit waits for the re-plan or the re-plan for it, so no entry turns the
 * person's between the judgement and the swap) that also claims the day:
 * undefined when there is no auto entry (nothing claimed: a week planned
 * later today is judged by a later run) or the day was claimed already. A
 * kept entry records its new targets; a swap plans the new idea in the same
 * batch, then removes the old entry (and the outfit the planner made for
 * it, if nothing else holds it). An auto entry on a day a trip covers is
 * removed instead, with the outfit the planner made for it once unheld
 * (removeAutoEntries, Undo's rule; #684). Its forecast is read first,
 * outside the lock. Under the lock, two statements read everything: the
 * auto entries with the claim (claimAutoEntries), then the week, the pool,
 * the generator's memory, the auto outfits' garment states (#173) and the
 * trips over those days. `signal` is checked after the forecast, after the
 * lock and before the commit: an abort throws, rolling it all back.
 */
async function replanUser(
  deps: Pick<ReplanDeps, 'db' | 'weather' | 'timeZone' | 'logger'>,
  userId: number,
  now: Date,
  weather: UserWeather | undefined,
  signal: AbortSignal | undefined,
): Promise<ReplannedUser | undefined> {
  // The batch's answer, else read here, not `fresh`: its callers (the
  // minutely run, the morning reminder) refreshed their batch's forecasts
  // together first (refreshForecastsFor). Before the owner lock: a network
  // wait must never hold it.
  const forecast = weather
    ? forecastOf(weather)
    : await jobForecast(deps, userId, now, signal);
  signal?.throwIfAborted();
  return ownerTransaction(deps.db, userId, 'replanUser', async (tx) => {
    signal?.throwIfAborted();
    const replanned = await judgeAndWrite(deps, tx, userId, now, forecast);
    signal?.throwIfAborted();
    return replanned;
  });
}

interface ReplannedUser {
  swaps: Swap[];
  kept: number;
  away: number;
}

/** replanUser's work under the owner lock: the claim, the judgement, the writes. */
async function judgeAndWrite(
  deps: Pick<ReplanDeps, 'timeZone' | 'logger'>,
  tx: Queryable,
  userId: number,
  now: Date,
  forecast: WeekForecast,
): Promise<ReplannedUser | undefined> {
  const today = todayIn(deps.timeZone, now);
  const claimed = await claimAutoEntries(tx, userId, today, now);
  if (!claimed) return undefined;
  const last = claimed[claimed.length - 1].day;
  const row = await selectScalars(tx, {
    ...weekSql(userId, today, last),
    states: outfitGarmentStatesSql(
      claimed.map((a) => a.outfitId),
      today,
    ),
    trips: awayTripsSql(userId, today, last),
  });
  const onTrip = (a: AutoEntryRow) => tripsOn(row.trips, a.day).length > 0;
  const removed = await removeAutoEntries(tx, userId, {
    entryIds: claimed.filter(onTrip).map((a) => a.entryId),
  });
  const auto = claimed.filter((a) => !onTrip(a));
  const away = removed.entries;
  if (auto.length === 0) return { swaps: [], kept: 0, away };
  const week = readWeekColumns(today, row);
  const outfits = readOutfitGarmentStates(row.states);
  const judged = auto.map((a) => {
    const slots = outfits.get(a.outfitId) ?? [];
    const { day, outfitCreated } = a;
    const unwearable = unwearableOn({ day, outfitCreated, slots }, today);
    return { ...a, slots, unwearable };
  });
  const entryById = new Map(week.entries.map((e) => [e.id, e]));
  const replans = replanWeek({
    ...week,
    forecast: forecast.days,
    offset: forecast.offset,
    rainGear: await weekRainGear(
      tx,
      userId,
      forecast,
      judged.flatMap((a) => entryById.get(a.entryId) ?? []),
    ),
    auto: judged.map(({ entryId, plannedFor, unwearable }) => ({
      entryId,
      plannedFor,
      unwearable,
    })),
  });
  const autoById = new Map(judged.map((a) => [a.entryId, a]));
  const swaps: Swap[] = [];
  let kept = 0;
  for (const replan of replans) {
    const old = autoById.get(replan.entryId)!;
    if (replan.kind !== 'swap' && old.unwearable) {
      deps.logger.info(
        `Week re-plan for user ${userId}: entry ${old.entryId} on ${old.day} cannot be worn (${unwearableText(old.unwearable)}) and nothing else dresses its slot; kept`,
      );
    }
    if (replan.kind === 'unchanged') continue;
    const swap =
      replan.kind === 'swap' &&
      (await applySwap(tx, userId, replan, {
        ...old,
        garments: entryById.get(old.entryId)!.garments,
      }));
    if (swap) {
      swaps.push(swap);
      continue;
    }
    // Kept (or a swap that could not be written): its new targets are
    // what it is judged against next.
    if (replan.needs) {
      await updatePlannedNeeds(tx, replan.entryId, replan.needs);
    }
    kept += 1;
  }
  return { swaps, kept, away };
}

/**
 * Plans the swap's idea in the old entry's batch, then removes the old
 * entry (and the outfit the planner made for it, if nothing else holds
 * it). The new outfit first: undefined when it cannot be planned (a garment
 * gone from the closet meanwhile), and the old entry stays.
 */
async function applySwap(
  tx: Queryable,
  userId: number,
  replan: Extract<Replan<WeekPoolGarment>, { kind: 'swap' }>,
  old: AutoEntryRow & {
    garments: readonly { id: number }[];
    slots: readonly (SlotGarment | null)[];
  },
): Promise<Swap | undefined> {
  const written = await writeAutoPick(tx, userId, old.weekPlanId, {
    ...replan.slot,
    garments: replan.idea.garments,
    problems: replan.idea.problems,
    needs: replan.needs,
  });
  if (!written) return undefined;
  await removeAutoEntries(tx, userId, { entryIds: [old.entryId] });
  const before = new Set(old.garments.map((g) => g.id));
  const brought = replan.idea.garments.filter((g) => !before.has(g.id));
  return {
    slot: replan.slot,
    cause: replan.cause,
    garment: causeGarment(replan.cause, old.slots),
    swappedIn: ideaName(brought.length > 0 ? brought : replan.idea.garments),
  };
}

// The garment an unwearable outfit's cause names, by name or category, as
// the outfit's own name would ("Bean Boots", "Boots").
function causeGarment(
  cause: SwapCause,
  slots: readonly (SlotGarment | null)[],
): string | null {
  if (cause.kind !== 'unwearable' || cause.unwearable.reason === 'deleted') {
    return null;
  }
  const { garmentId } = cause.unwearable;
  const garment = slots.find((g) => g?.id === garmentId);
  return garment ? ideaName([garment]) : null;
}

// For the log: "colder", "repair garment 12", "deleted".
function causeText(cause: SwapCause): string {
  return cause.kind === 'weather'
    ? cause.change
    : unwearableText(cause.unwearable);
}

function unwearableText(unwearable: Unwearable): string {
  return unwearable.reason === 'deleted'
    ? 'deleted'
    : `${unwearable.reason} garment ${unwearable.garmentId}`;
}

const CHANGE_LINES: Readonly<Record<NeedsChange, DataKey>> = {
  forecast: 'weekPlan.push.FORECAST',
  rain: 'weekPlan.push.RAIN',
  colder: 'weekPlan.push.COLDER',
  warmer: 'weekPlan.push.WARMER',
  dry: 'weekPlan.push.DRY',
  swing: 'weekPlan.push.SWING',
};

// Why a swap happened, for a line that names the slot elsewhere: the
// morning reminder's "Swapped in Chelsea boots: Bean Boots is at repair".
const CHANGE_WHY: Readonly<Record<NeedsChange, StringKey>> = {
  forecast: 'weekPlan.why.FORECAST',
  rain: 'weekPlan.why.RAIN',
  colder: 'weekPlan.why.COLDER',
  warmer: 'weekPlan.why.WARMER',
  dry: 'weekPlan.why.DRY',
  swing: 'weekPlan.why.SWING',
};

const UNWEARABLE_WHY: Readonly<Record<Unwearable['reason'], DataKey>> = {
  lent: 'weekPlan.why.LENT',
  repair: 'weekPlan.why.REPAIR',
  archived: 'weekPlan.why.ARCHIVED',
  wishlist: 'weekPlan.why.WISHLIST',
  dirty: 'weekPlan.why.DIRTY',
  deleted: 'weekPlan.why.DELETED',
};

/**
 * Today's swap as the morning reminder says it, before the day's outfits
 * (src/web/push/reminders.ts): "Swapped in Wool coat: it turned cold".
 */
export function reminderSwapLine(swap: Swap): string {
  const why =
    swap.cause.kind === 'weather'
      ? t(CHANGE_WHY[swap.cause.change])
      : t(UNWEARABLE_WHY[swap.cause.unwearable.reason], {
          garment: swap.garment ?? '',
        });
  return t('today.push.SWAPPED', { garments: swap.swappedIn, why });
}

const UNWEARABLE_LINES: Readonly<Record<Unwearable['reason'], DataKey>> = {
  lent: 'weekPlan.push.LENT',
  repair: 'weekPlan.push.REPAIR',
  archived: 'weekPlan.push.ARCHIVED',
  wishlist: 'weekPlan.push.WISHLIST',
  dirty: 'weekPlan.push.DIRTY',
  deleted: 'weekPlan.push.DELETED',
};

/** "Thursday", or "Thursday evening" for an occasion around the day's outfit. */
export function slotLabel(slot: Slot): string {
  const day = t(DAY_NAMES[dayOfWeek(slot.day)]);
  return DAY_OCCASIONS.includes(slot.occasion)
    ? day
    : t('weekPlan.SLOT', { day, occasion: occasionLabel(slot.occasion) });
}

/**
 * The notice: one line per swap, saying why ("Thursday turned cold:
 * swapped in Wool coat", "Bean Boots is at repair: swapped in Chelsea
 * boots on Thursday").
 */
export function swapPayload(swaps: readonly Swap[]): PushPayload {
  return {
    title: t('weekPlan.push.TITLE'),
    body: swaps.map(swapLine).join('\n'),
    url: '/calendar',
    tag: SWAP_TAG,
  };
}

function swapLine(swap: Swap): string {
  const params = { slot: slotLabel(swap.slot), garments: swap.swappedIn };
  if (swap.cause.kind === 'weather') {
    return t(CHANGE_LINES[swap.cause.change], params);
  }
  return t(UNWEARABLE_LINES[swap.cause.unwearable.reason], {
    ...params,
    garment: swap.garment ?? '',
  });
}

/** A person's swap notice: what their re-plan swapped that they are to be told. */
interface SwapNotice {
  userId: number;
  swaps: readonly Swap[];
}

/**
 * Tells each person what swapped, on the devices that take the morning
 * reminder: the swap notice is about what to wear, the reminder's
 * subject, and a device that asked for it is one that wants to hear about
 * the day's outfit. No new setting: a device without it hears nothing (the
 * calendar still shows the swap). One batch (PushSender.sendEach: the
 * devices of everyone told read in one statement). The users told. Never
 * throws: the swaps are committed whatever becomes of their notice, so a
 * failed send is logged, not the re-plan's failure.
 */
async function pushSwaps(
  deps: ReplanDeps,
  notices: readonly SwapNotice[],
): Promise<Set<number>> {
  const told = new Set<number>();
  const sent = notices.filter((notice) => notice.swaps.length > 0);
  if (!deps.push || sent.length === 0) return told;
  let reports: SendReport[];
  try {
    reports = await deps.push.sendEach(
      sent.map(({ userId, swaps }) => ({
        userId,
        devices: 'morning-reminder',
        payload: swapPayload(swaps),
        options: { ttlSeconds: SWAP_TTL_SECONDS },
      })),
    );
  } catch (error) {
    deps.logger.error(
      { err: error },
      `Week re-plan: the swap notices for user(s) ${sent.map((n) => n.userId).join(', ')} failed`,
    );
    return told;
  }
  reports.forEach((report, index) => {
    const { userId } = sent[index];
    if (report.devices > 0) {
      told.add(userId);
      return;
    }
    deps.logger.info(
      `Week re-plan for user ${userId}: no device takes the morning reminder, nobody told`,
    );
  });
  return told;
}

/** Removes the claims of days before `before`; server.ts calls it nightly with yesterday. */
export async function pruneReplans(
  deps: Pick<ReplanDeps, 'db' | 'logger'>,
  before: string,
): Promise<void> {
  const pruned = await pruneReplanClaims(deps.db, before);
  if (pruned > 0) {
    deps.logger.info(`Pruned ${pruned} re-plan claim(s) before ${before}`);
  }
}
