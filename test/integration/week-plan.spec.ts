import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import { createDb, type Db } from '../../src/db/client';
import {
  garment,
  garmentWear,
  outfit,
  outfitCalendar,
  outfitSlot,
  pushReminder,
  userDevice,
  weekPlan,
  weekPlanEntry,
  weekReplan,
  trip,
  tripOutfit,
  weekTemplate,
} from '../../src/db/schema';
import type { Occasion } from '../../src/wardrobe/occasions';
import { addDays, instantAt, type IsoDate } from '../../src/calendar-date';
import { PartialFailure } from '../../src/metrics/partial-failure';
import { insertEntry } from '../../src/web/calendar/queries';
import { dayLabel } from '../../src/web/date-labels';
import { wearIdea } from '../../src/web/today/queries';
import { claimAutoEntries } from '../../src/web/week-plan/queries';
import type { PushPayload } from '../../src/web/push/payload';
import {
  type ReminderDeps,
  type ReminderRun,
  sendDueReminders,
} from '../../src/web/push/reminders';
import { scheduleJob } from '../../src/maintenance/scheduled';
import { tripModel } from '../../src/web/trips/model';
import { addTripOutfit, createTrip } from '../../src/web/trips/queries';
import { REMINDER_WINDOWS } from '../../src/push/reminders';
import {
  devicesOfUsers,
  saveReminderSettings,
} from '../../src/web/push/queries';
import { chosenDevices, type PushSender } from '../../src/web/push/sender';
import { setHome } from '../../src/web/weather/queries';
import type { WeatherService } from '../../src/web/weather/service';
import type { DayForecast } from '../../src/weather/forecast';
import {
  planDays,
  planMyWeek,
  type WeekForecast,
} from '../../src/web/week-plan/plan';
import {
  pruneReplans,
  REPLAN_HOUR,
  type ReplanDeps,
  ReplanRetries,
  replanToday,
  replanWeeks,
  replanWeeksWhole,
} from '../../src/web/week-plan/replan';
import {
  createTestApp,
  recordQueries,
  subscribeAs,
  type TestApp,
  unescapeHtml,
  asFixture,
} from './harness';
import { dayColumns } from './calendar-page';
import { callTool, createAccessToken, tool } from './mcp';
import {
  expectFullPage,
  expectNativePostForms,
  expectNoScriptNavigation,
} from './pages';
import { BY_PERSON } from '../../src/web/write-origin';

/**
 * The weekly auto-plan (#16): the Profile's week template, "Plan my week"
 * (its empty slots filled once, auto entries and their batch, the banner
 * and Undo), editing, wearing or planning an auto entry's outfit again
 * makes it the person's, and picking a planner-made outfit makes the outfit
 * theirs (#77), the daily re-plan (before its hour nothing; once a day per
 * user whatever the minutes, restarts or servers; auto entries only; the
 * weather and what can no longer be worn; a swap pushed to the morning
 * reminder's devices; DST days), the morning reminder after the re-plan
 * (#76), and plan_week. The clock is pinned to Monday 5 October 2026, 08:00
 * in New York, so today's slots are open.
 * The pure rules are src/wardrobe/week-planner.spec.ts's.
 */

type Fields = Record<string, string | string[]>;

const TODAY = '2026-10-05';
const WEEK = planDays(TODAY);

function formPayload(fields: Fields) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of [value].flat()) body.append(name, item);
  }
  return {
    payload: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
}

/** A day at `feelsLike` °C every hour, dry. */
function steadyDay(day: IsoDate, feelsLike: number): DayForecast {
  return {
    day,
    code: 1,
    high: feelsLike,
    low: feelsLike,
    precipitationChance: 0,
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      feelsLike,
      precipitationChance: 0,
      code: 1,
    })),
  };
}

function weekAt(feelsLike: (day: IsoDate) => number): DayForecast[] {
  return WEEK.map((day) => steadyDay(day, feelsLike(day)));
}

/**
 * A weather service that answers `days` for any location (the re-plan's).
 * The week is forecast-only: asking it for climate normals fails the spec.
 */
function fakeWeather(days: () => DayForecast[]): WeatherService {
  return {
    timeZone: 'America/New_York',
    forecastFor: () =>
      Promise.resolve({
        forecast: { timeZone: 'America/New_York', days: days() },
        fetchedAt: new Date(),
      }),
    normalsFor: () =>
      Promise.reject(new Error('The weekly plan never reads normals')),
    searchPlaces: () => Promise.resolve([]),
    settled: () => Promise.resolve(),
  };
}

describe('the weekly auto-plan', () => {
  let t: TestApp;
  let coat: number;

  const garmentIn = async (
    name: string,
    category: string,
    color: string,
    extra: Fields = {},
  ) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      ...formPayload({
        name,
        category,
        props: '1',
        care: '1',
        formality: '2',
        pattern: 'solid',
        color: [color],
        ...extra,
      }),
    });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  const get = (url: string, headers: Record<string, string> = {}) =>
    t.inject({ method: 'GET', url, headers });
  const post = (url: string, fields: Fields = {}, cookie?: string) =>
    t.inject({
      method: 'POST',
      url,
      ...formPayload(fields),
      ...(cookie
        ? { headers: { ...formPayload(fields).headers, cookie } }
        : {}),
    });

  /** The owner's entries from today on: [day, occasion, planned_by]. */
  const weekEntries = async (ownerId = t.owner.id) =>
    (
      await t.db
        .select({
          id: outfitCalendar.id,
          day: outfitCalendar.day,
          occasion: outfitCalendar.occasion,
          plannedBy: outfitCalendar.plannedBy,
          outfitId: outfitCalendar.outfitId,
        })
        .from(outfitCalendar)
        .where(
          and(
            eq(outfitCalendar.ownerId, ownerId),
            gt(outfitCalendar.day, addDays(TODAY, -1)),
          ),
        )
        .orderBy(asc(outfitCalendar.day), asc(outfitCalendar.id))
    ).map((e) => ({ ...e, slot: `${e.day} ${e.occasion}` }));

  // Every test starts from the closet alone: the planner never repeats a
  // saved outfit, so the last test's outfits would use up its combinations
  // (a plain delete is fine here: the wears it cascades are the last
  // test's too).
  const clearWeek = async () => {
    await asFixture(t.db, (tx) => tx.delete(outfit));
    // A trip's days are skipped by the planner (#684).
    await asFixture(t.db, (tx) => tx.delete(trip));
    await asFixture(t.db, (tx) => tx.delete(weekPlan));
    await t.db.delete(weekReplan);
  };

  /**
   * `outfitId` put on a new trip of the owner's, as the trip page adds a
   * saved outfit; the trip's id. What a planner-made outfit's clean-up must
   * never cascade away (outfitIsHeld).
   */
  const onTrip = async (outfitId: number) => {
    const tripId = await createTrip(t.db, t.owner.id, {
      name: 'Austin',
      destination: null,
      startsOn: WEEK[4],
      endsOn: WEEK[6],
      notes: null,
    });
    expect(
      await addTripOutfit(t.db, {
        tripId,
        ownerId: t.owner.id,
        outfitId,
        madeBy: BY_PERSON,
      }),
    ).toBe('added');
    return tripId;
  };

  /** The trip still holds the outfit, and its garments are on the packing list. */
  const expectTripKeeps = async (tripId: number, outfitId: number) => {
    expect(await t.db.$count(outfit, eq(outfit.id, outfitId))).toBe(1);
    expect(
      await t.db.$count(
        tripOutfit,
        and(eq(tripOutfit.tripId, tripId), eq(tripOutfit.outfitId, outfitId)),
      ),
    ).toBe(1);
    const model = await tripModel(t.db, t.owner.id, tripId, TODAY);
    expect(model!.undated.map((o) => o.outfitId)).toEqual([outfitId]);
    expect(model!.packing.garments).toBeGreaterThan(0);
  };

  /** The garment ids of outfit `outfitId`, in slot order. */
  const garmentsOf = async (outfitId: number) =>
    (
      await t.db
        .select({ garmentId: outfitSlot.garmentId })
        .from(outfitSlot)
        .where(eq(outfitSlot.outfitId, outfitId))
        .orderBy(asc(outfitSlot.position))
    ).map((slot) => slot.garmentId!);

  /** The name of outfit `outfitId`. */
  const nameOf = async (outfitId: number) =>
    (
      await t.db
        .select({ name: outfit.name })
        .from(outfit)
        .where(eq(outfit.id, outfitId))
    )[0].name!;

  /** Every day all day, and an evening on Tuesdays: 8 slots this week. */
  const TEMPLATE: Fields = {
    'day-0': 'all-day',
    'day-1': 'all-day',
    'day-2': 'all-day',
    'around-2': 'evening',
    'day-3': 'all-day',
    'day-4': 'all-day',
    'day-5': 'all-day',
    'day-6': 'all-day',
  };
  const TEMPLATE_SLOTS = [
    ...WEEK.map((day) => `${day} all-day`),
    '2026-10-06 evening',
  ].sort();

  beforeAll(async () => {
    t = await createTestApp();
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date('2026-10-05T12:00:00Z'),
    });
    for (const [i, color] of [
      'white',
      'grey',
      'black',
      'beige',
      'brown',
    ].entries()) {
      await garmentIn(`Tee ${i}`, 'tops', color, { quantity: '3' });
    }
    for (const [i, color] of ['blue', 'black', 'beige'].entries()) {
      await garmentIn(`Trousers ${i}`, 'bottoms', color);
    }
    for (const [i, color] of ['white', 'brown'].entries()) {
      await garmentIn(`Shoes ${i}`, 'footwear', color);
    }
    coat = await garmentIn('Wool coat', 'outerwear', 'black', {
      type: 'coat',
      warmth: '5',
    });
    vi.useRealTimers();
  });

  afterAll(() => t?.cleanup());

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date('2026-10-05T12:00:00Z'),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the week template, on the Profile', () => {
    it('shows an empty week, saves it whole, and shows it again', async () => {
      const blank = await get('/auth/profile');
      expectFullPage(blank);
      expectNativePostForms(blank);
      expect(blank.body).toContain('id="week"');
      expect(blank.body).toContain('action="/auth/profile/week"');

      t.logs.clear();
      const res = await post('/auth/profile/week', TEMPLATE);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/auth/profile?weekSaved=1#week');
      const rows = await t.db
        .select({
          weekday: weekTemplate.weekday,
          occasion: weekTemplate.occasion,
        })
        .from(weekTemplate)
        .where(eq(weekTemplate.userId, t.owner.id))
        .orderBy(asc(weekTemplate.weekday), asc(weekTemplate.occasion));
      expect(rows).toHaveLength(8);
      expect(rows).toContainEqual({ weekday: 2, occasion: 'evening' });
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        `Week template saved by user ${t.owner.id}: 8 slot(s) on 7 day(s)`,
      );

      const page = unescapeHtml((await get('/auth/profile?weekSaved=1')).body);
      expect(page).toContain('Week saved');
      expect(page).toMatch(/name="day-2"[\s\S]*?value="all-day" selected/);
      expect(page).toMatch(/name="around-2" value="evening"[^>]*checked/);
    });

    it('refuses what the week cannot hold: two outfits for one day, an unknown occasion', async () => {
      const refused: Fields[] = [
        { 'around-1': 'work' },
        { 'day-1': 'evening' },
        { 'day-1': 'brunch' },
      ];
      for (const fields of refused) {
        const res = await post('/auth/profile/week', fields);
        expect(res.statusCode).toBe(400);
      }
      expect(
        await t.db.$count(weekTemplate, eq(weekTemplate.userId, t.owner.id)),
      ).toBe(8);
    });

    it('is the user’s own: another user’s profile shows their empty week', async () => {
      const stranger = await t.register('stranger-week@example.com');
      const theirs = unescapeHtml(
        (await get('/auth/profile', { cookie: stranger })).body,
      );
      expect(theirs).not.toMatch(/value="all-day" selected/);
    });
  });

  describe('"Plan my week"', () => {
    beforeEach(clearWeek);

    it('skips the days a trip covers, says so in the banner, and the week shows Away on each (#684)', async () => {
      const made = await post('/trips', {
        name: 'Lisbon long weekend',
        destination: 'Lisbon',
        startsOn: WEEK[2],
        endsOn: WEEK[3],
        notes: '',
      });
      expect(made.statusCode).toBe(303);
      const tripId = Number(
        /^\/trips\/(\d+)/.exec(String(made.headers.location))![1],
      );
      const res = await post('/calendar/plan-week');
      expect(res.statusCode).toBe(303);
      // No home outfit on either trip day; every other slot planned.
      const away = new Set([WEEK[2], WEEK[3]]);
      expect((await weekEntries()).map((e) => e.slot).sort()).toEqual(
        TEMPLATE_SLOTS.filter((slot) => !away.has(slot.slice(0, 10))),
      );

      const banner = unescapeHtml(
        (await get(String(res.headers.location))).body,
      );
      expect(banner).toContain(
        `Not planned while you are away: ${dayLabel(WEEK[2])}, ${dayLabel(WEEK[3])}`,
      );
      // Skipped, not empty.
      expect(banner).not.toContain('data-still-empty');

      // The week (Sunday 4 to Saturday 10 October): Away on the trip's days
      // alone, linking to it, and no open slot there; read with the week in
      // its one statement after the session.
      let week: Awaited<ReturnType<typeof get>> | undefined;
      const read = await recordQueries(async () => {
        week = await get('/calendar');
      });
      expect(read.statements).toBe(2);
      for (const [day, column] of dayColumns(unescapeHtml(week!.body))) {
        if (away.has(day)) {
          expect(column, day).toMatch(
            new RegExp(`href="/trips/${tripId}"[^>]*data-away="${tripId}"`),
          );
          expect(column, day).toContain('Away: Lisbon');
          expect(column, day).not.toContain('data-open-slot');
        } else {
          expect(column, day).not.toContain('data-away');
        }
      }

      // Again: the trip's days are still skipped, so nothing new.
      const again = await post('/calendar/plan-week');
      expect(again.headers.location).toBe('/calendar?planned=none');
    });

    it('sends someone without a week template to set one, and plans nothing', async () => {
      const cookie = await t.register('no-template@example.com');
      const res = await post('/calendar/plan-week', {}, cookie);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/auth/profile#week');
      expect(await t.db.$count(weekPlan)).toBe(0);
    });

    it('fills every empty slot of the next 7 days with an auto entry, once, and says what it planned', async () => {
      const calendar = await get('/calendar');
      expect(calendar.body).toContain('action="/calendar/plan-week"');

      t.logs.clear();
      const res = await post('/calendar/plan-week');
      expect(res.statusCode).toBe(303);
      const planId = Number(
        /^\/calendar\?week=2026-10-04&planned=(\d+)#day-2026-10-05$/.exec(
          String(res.headers.location),
        )![1],
      );
      const entries = await weekEntries();
      expect(entries.map((e) => e.slot).sort()).toEqual(TEMPLATE_SLOTS);
      expect(entries.every((e) => e.plannedBy === 'auto')).toBe(true);
      // No outfit twice in the week; each one new, named after its garments.
      expect(new Set(entries.map((e) => e.outfitId)).size).toBe(entries.length);
      const recorded = await t.db
        .select()
        .from(weekPlanEntry)
        .where(eq(weekPlanEntry.weekPlanId, planId));
      expect(recorded).toHaveLength(8);
      // Planned without weather: no targets recorded.
      expect(recorded.every((r) => r.outfitCreated && r.torso === null)).toBe(
        true,
      );
      expect(
        t.logs
          .messages('info', 'Web')
          .some((m) =>
            m.startsWith(
              `Week planned for user ${t.owner.id} from ${TODAY} (plan ${planId}): 8 outfit(s)`,
            ),
          ),
      ).toBe(true);

      // The banner: what was planned, and Undo. #165: read with the week in
      // one statement after the session (five in parallel before).
      let banner: Awaited<ReturnType<typeof get>> | undefined;
      const bannerRead = await recordQueries(async () => {
        banner = await get(String(res.headers.location));
      });
      expect(bannerRead.statements).toBe(2);
      expectFullPage(banner!);
      expectNativePostForms(banner!);
      expectNoScriptNavigation(banner!);
      const html = unescapeHtml(banner!.body);
      expect(html).toContain('Planned 8 outfits for your week');
      expect(html.match(/data-entry-id="/g)).toHaveLength(8);
      expect(html).toContain(`action="/calendar/plan-week/${planId}/undo"`);
      expect(html).not.toContain('data-still-empty');
      // The week's rows say which are the planner's.
      expect(
        (await get('/calendar')).body.match(/data-auto/g)?.length,
      ).toBeGreaterThanOrEqual(1);

      // Again: every slot is filled, so nothing new. #165: and nothing read
      // that only filling a slot needs (the pool, the generator's memory):
      // the session, then begin, the owner lock, the template with the
      // window's entries and trips (one statement, #684), commit.
      let again: Awaited<ReturnType<typeof post>> | undefined;
      const repeat = await recordQueries(async () => {
        again = await post('/calendar/plan-week');
      });
      expect(repeat.statements).toBe(5);
      expect(again!.headers.location).toBe('/calendar?planned=none');
      expect(await weekEntries()).toHaveLength(8);
      expect(await t.db.$count(weekPlan)).toBe(1);
      expect(
        unescapeHtml((await get('/calendar?planned=none')).body),
      ).toContain('Nothing new to plan');
    });

    it('lands on the week and the day the plan starts, and each banner row links to its day with a thumb (#683)', async () => {
      // Friday noon in New York: the plan starts today, in the shown week.
      vi.setSystemTime(new Date('2026-10-09T16:00:00Z'));
      const friday = await post('/calendar/plan-week');
      expect(friday.statusCode).toBe(303);
      expect(friday.headers.location).toMatch(
        /^\/calendar\?week=2026-10-04&planned=\d+#day-2026-10-09$/,
      );
      const fridayPlan = Number(
        /planned=(\d+)/.exec(String(friday.headers.location))![1],
      );
      await post(`/calendar/plan-week/${fridayPlan}/undo`);
      expect(await weekEntries()).toHaveLength(0);

      // Saturday 23:30: both of Saturday's windows are over, so the plan
      // starts on Sunday, a week the current one does not show.
      vi.setSystemTime(new Date('2026-10-11T03:30:00Z'));
      const res = await post('/calendar/plan-week');
      const location = String(res.headers.location);
      expect(location).toMatch(
        /^\/calendar\?week=2026-10-11&planned=\d+#day-2026-10-11$/,
      );
      const planId = Number(/planned=(\d+)/.exec(location)![1]);

      const shown = unescapeHtml((await get(location)).body);
      const banner = /data-planned-entries[\s\S]*?<\/ul>/.exec(shown)![0];
      expect(banner.match(/<a href="#day-2026-10-\d\d"/g)).toHaveLength(7);
      expect(banner.match(/data-collage="thumb"/g)).toHaveLength(7);

      // Another week's banner: the rows open the week holding their day.
      const elsewhere = unescapeHtml(
        (await get(`/calendar?week=2026-10-04&planned=${planId}`)).body,
      );
      expect(elsewhere).toContain(
        'href="/calendar?week=2026-10-11#day-2026-10-11"',
      );

      // Undo still removes the batch from that page.
      const undo = await post(`/calendar/plan-week/${planId}/undo`);
      expect(undo.headers.location).toBe('/calendar?undone=7');
      expect(await weekEntries()).toHaveLength(0);
    });

    it('leaves slots the person filled, and a day their outfit dresses', async () => {
      await post('/calendar/plan-week');
      const planned = await weekEntries();
      // The outfits stay, saved; the entries go.
      await asFixture(t.db, (tx) => tx.delete(outfitCalendar));
      await asFixture(t.db, (tx) => tx.delete(weekPlan));
      // The person's own all-day outfit on Wednesday, planned for work.
      const theirs = planned.find((e) => e.day === '2026-10-07')!.outfitId;
      await post('/calendar', {
        date: '2026-10-07',
        outfitId: String(theirs),
        occasion: 'work',
      });
      await post('/calendar/plan-week');
      const entries = await weekEntries();
      expect(entries.filter((e) => e.day === '2026-10-07')).toEqual([
        expect.objectContaining({ occasion: 'work', plannedBy: 'user' }),
      ]);
      expect(entries.filter((e) => e.plannedBy === 'auto')).toHaveLength(7);
    });

    it('two taps at once plan each slot once', async () => {
      const [a, b] = await Promise.all([
        post('/calendar/plan-week'),
        post('/calendar/plan-week'),
      ]);
      expect([a.headers.location, b.headers.location]).toContain(
        '/calendar?planned=none',
      );
      const entries = await weekEntries();
      expect(entries.map((e) => e.slot).sort()).toEqual(TEMPLATE_SLOTS);
    });

    it("leaves today's slots whose window has ended", async () => {
      // 23:30 in New York: today's all-day window (8 to 22) is over.
      vi.setSystemTime(new Date('2026-10-06T03:30:00Z'));
      await post('/calendar/plan-week');
      const slots = (await weekEntries()).map((e) => e.slot);
      expect(slots).not.toContain(`${TODAY} all-day`);
      expect(slots).toContain(`${addDays(TODAY, 6)} all-day`);
    });

    it('late on a Tuesday, plans only the six days after it', async () => {
      // 23:30 on Tuesday in New York: both of today's windows (all-day to
      // 22, evening to 23) are over, and the next Tuesday's evening is past
      // the window (today and the six after). The fewest slots this
      // template ever plans: the floor test/week-plan.spec.ts (retired 2026-10-13) asserts.
      vi.setSystemTime(new Date('2026-10-07T03:30:00Z'));
      await post('/calendar/plan-week');
      const slots = (await weekEntries()).map((e) => e.slot).sort();
      expect(slots).toEqual(
        planDays('2026-10-07')
          .slice(0, 6)
          .map((day) => `${day} all-day`),
      );
    });

    it('dresses each slot for its forecast, and records what it was planned for', async () => {
      const warm = weekAt(() => 24);
      warm[2] = steadyDay(WEEK[2], -2);
      const forecast: WeekForecast = {
        days: new Map(warm.map((d) => [d.day, d])),
        offset: 0,
      };
      const result = await planMyWeek(t.db, t.owner.id, {
        today: TODAY,
        hour: 8,
        days: WEEK,
        forecast,
      });
      const cold = result.planned.find(
        (p) => p.day === WEEK[2] && p.occasion === 'all-day',
      )!;
      expect(cold.garments.map((g) => g.id)).toContain(coat);
      const [row] = await t.db
        .select()
        .from(weekPlanEntry)
        .where(eq(weekPlanEntry.entryId, cold.entryId));
      expect(row.torso).toBeGreaterThanOrEqual(7);
      expect(row.layer).toBe(false);
    });

    it('leaves a workout empty without activewear, and the banner says why (#647)', async () => {
      // A Wednesday run beside the week: this closet has no running shoes.
      await post('/auth/profile/week', { ...TEMPLATE, 'around-3': 'workout' });
      try {
        const res = await post('/calendar/plan-week');
        const slots = (await weekEntries()).map((e) => e.slot);
        expect(slots.sort()).toEqual(TEMPLATE_SLOTS);
        const html = unescapeHtml(
          (await get(String(res.headers.location))).body,
        );
        expect(html).toMatch(/data-still-empty[^>]*>[^<]*Workout/);
        expect(html).toContain('data-needs-activewear');
        expect(html).toContain(
          'Your closet has no running shoes and athletic bottoms',
        );
      } finally {
        await post('/auth/profile/week', TEMPLATE);
      }
    });
  });

  describe('an auto entry becomes the person’s', () => {
    beforeEach(clearWeek);

    it('when they edit its outfit, or mark it worn; Undo then leaves it', async () => {
      const res = await post('/calendar/plan-week');
      const planId = Number(
        /planned=(\d+)/.exec(String(res.headers.location))![1],
      );
      const [todays, tomorrows] = await weekEntries();
      // Worn today.
      const worn = await post(`/calendar/${todays.id}/worn`, { worn: '1' });
      expect(worn.statusCode).toBe(303);
      // Tomorrow's outfit edited (the calendar chip's edit link is the outfit form).
      const slots = await t.db.query.outfitSlot.findMany({
        where: (slot, { eq: equals }) =>
          equals(slot.outfitId, tomorrows.outfitId),
      });
      t.logs.clear();
      const edit = await post(`/outfits/${tomorrows.outfitId}`, {
        name: 'My Tuesday',
        category: slots.map((s) => s.category),
        garmentId: slots.map((s) => String(s.garmentId)),
      });
      expect(edit.statusCode).toBe(302);
      expect(
        t.logs
          .messages('info', 'Web')
          .some((m) => m.includes("1 planned entry(ies) now the user's")),
      ).toBe(true);
      const byId = new Map((await weekEntries()).map((e) => [e.id, e]));
      expect(byId.get(todays.id)!.plannedBy).toBe('user');
      expect(byId.get(tomorrows.id)!.plannedBy).toBe('user');

      // Undo removes the rest and the outfits it made for them. #165: in
      // as many statements whatever the batch's size: the session, begin,
      // the owner lock, the batch's auto entries deleted, their outfits
      // locked, the unheld ones deleted, the empty batch, commit (6 outfits
      // were 3 + 4 each through deleteOutfit).
      const outfitsBefore = await t.db.$count(outfit);
      let undo: Awaited<ReturnType<typeof post>> | undefined;
      const undone = await recordQueries(async () => {
        undo = await post(`/calendar/plan-week/${planId}/undo`);
      });
      expect(undone.statements).toBe(8);
      expect(undo!.statusCode).toBe(303);
      expect(undo!.headers.location).toBe('/calendar?undone=6');
      const left = await weekEntries();
      expect(left.map((e) => e.id).sort()).toEqual(
        [todays.id, tomorrows.id].sort(),
      );
      expect(await t.db.$count(outfit)).toBe(outfitsBefore - 6);
      // The batch stays: two of its entries are still on the calendar.
      expect(await t.db.$count(weekPlan)).toBe(1);
      expect(unescapeHtml((await get('/calendar?undone=6')).body)).toContain(
        'Plan undone: 6 removed',
      );
    });

    it('Undo keeps a planner-made outfit a trip holds, with the trip’s packing list', async () => {
      const res = await post('/calendar/plan-week');
      const planId = Number(
        /planned=(\d+)/.exec(String(res.headers.location))![1],
      );
      const [first] = await weekEntries();
      const tripId = await onTrip(first.outfitId);
      const outfitsBefore = await t.db.$count(outfit);

      const undo = await post(`/calendar/plan-week/${planId}/undo`);
      expect(undo.headers.location).toBe('/calendar?undone=8');
      expect(await weekEntries()).toEqual([]);
      // Every other outfit it made went; the trip's stayed, on the trip.
      expect(await t.db.$count(outfit)).toBe(outfitsBefore - 7);
      await expectTripKeeps(tripId, first.outfitId);
    });

    it('when they plan its outfit on its own day again (the card dropdown, POST /calendar); Undo and the re-plan leave it', async () => {
      const res = await post('/calendar/plan-week');
      const planId = Number(
        /planned=(\d+)/.exec(String(res.headers.location))![1],
      );
      const thursday = (await weekEntries()).find((e) => e.day === WEEK[3])!;
      t.logs.clear();
      const again = await post('/calendar', {
        date: WEEK[3],
        outfitId: String(thursday.outfitId),
        occasion: 'all-day',
      });
      expect(again.statusCode).toBe(302);
      expect(t.logs.ops('calendar.entry.planned')).toEqual([
        expect.objectContaining({
          userId: t.owner.id,
          entryId: thursday.id,
          outfitId: thursday.outfitId,
          day: WEEK[3],
          changed: false,
          adopted: true,
        }),
      ]);
      const theirs = (await weekEntries()).find((e) => e.id === thursday.id)!;
      expect(theirs).toMatchObject({
        plannedBy: 'user',
        outfitId: thursday.outfitId,
        occasion: 'all-day',
      });
      // The planner's own write never takes it back.
      expect(
        await insertEntry(t.db, {
          ownerId: t.owner.id,
          outfitId: thursday.outfitId,
          day: WEEK[3],
          occasion: 'all-day',
          chooser: 'planner',
        }),
      ).toEqual({ outcome: 'already-scheduled', adopted: false });
      expect(
        (await weekEntries()).find((e) => e.id === thursday.id)!.plannedBy,
      ).toBe('user');

      const undo = await post(`/calendar/plan-week/${planId}/undo`);
      expect(undo.headers.location).toBe('/calendar?undone=7');
      expect(await weekEntries()).toEqual([theirs]);
      expect(await t.db.$count(outfit, eq(outfit.id, thursday.outfitId))).toBe(
        1,
      );
    });

    it('when a pick of its garments plans it on its day (the gallery, pick_outfit with a date)', async () => {
      await post('/calendar/plan-week');
      const friday = (await weekEntries()).find((e) => e.day === WEEK[4])!;
      t.logs.clear();
      const pick = await post('/outfits/ideas/pick', {
        garmentId: (await garmentsOf(friday.outfitId)).map(String),
        for: `day:${WEEK[4]}`,
        occasion: 'all-day',
      });
      expect(pick.statusCode).toBe(303);
      expect(pick.headers.location).toBe(
        `/calendar?week=${WEEK[4]}&alreadySaved=1`,
      );
      expect(
        (await weekEntries()).find((e) => e.id === friday.id)!.plannedBy,
      ).toBe('user');
      expect(
        t.logs
          .messages('info', 'Web')
          .some((m) =>
            m.endsWith(
              `already outfit ${friday.outfitId}, already-scheduled ${WEEK[4]} (all-day); nothing created; taken over from the week planner`,
            ),
          ),
      ).toBe(true);
    });

    it('a pick of a planner-made outfit’s garments with no day keeps the outfit through Undo', async () => {
      const res = await post('/calendar/plan-week');
      const planId = Number(
        /planned=(\d+)/.exec(String(res.headers.location))![1],
      );
      const saturday = (await weekEntries()).find((e) => e.day === WEEK[5])!;
      // An Ideas card rendered before the plan, or pick_outfit: "Already saved".
      const pick = await post('/outfits/ideas/pick', {
        garmentId: (await garmentsOf(saturday.outfitId)).map(String),
      });
      expect(pick.headers.location).toBe(
        `/outfits/${saturday.outfitId}?alreadySaved=1`,
      );
      const [row] = await t.db
        .select()
        .from(weekPlanEntry)
        .where(eq(weekPlanEntry.entryId, saturday.id));
      expect(row.outfitCreated).toBe(false);
      // The entry is still the planner's: Undo takes it, not the outfit.
      expect(
        (await weekEntries()).find((e) => e.id === saturday.id)!.plannedBy,
      ).toBe('auto');

      const outfitsBefore = await t.db.$count(outfit);
      const undo = await post(`/calendar/plan-week/${planId}/undo`);
      expect(undo.headers.location).toBe('/calendar?undone=8');
      expect(await weekEntries()).toEqual([]);
      expect(await t.db.$count(outfit)).toBe(outfitsBefore - 7);
      expect(await t.db.$count(outfit, eq(outfit.id, saturday.outfitId))).toBe(
        1,
      );
    });

    // #165: Undo deletes first and asks whose the batch is only when that
    // found nothing, so a batch of the person's own with nothing left to
    // take back is not mistaken for another's.
    it('an Undo with every entry taken over removes nothing, and is no 404', async () => {
      const res = await post('/calendar/plan-week');
      const planId = Number(
        /planned=(\d+)/.exec(String(res.headers.location))![1],
      );
      await asFixture(t.db, (tx) =>
        tx.update(outfitCalendar).set({ plannedBy: 'user' }),
      );
      const outfitsBefore = await t.db.$count(outfit);
      const undo = await post(`/calendar/plan-week/${planId}/undo`);
      expect(undo.statusCode).toBe(303);
      expect(undo.headers.location).toBe('/calendar?undone=0');
      expect(await weekEntries()).toHaveLength(8);
      expect(await t.db.$count(outfit)).toBe(outfitsBefore);
      expect(await t.db.$count(weekPlan)).toBe(1);
    });

    it("refuses another user's plan", async () => {
      const res = await post('/calendar/plan-week');
      const planId = Number(
        /planned=(\d+)/.exec(String(res.headers.location))![1],
      );
      const stranger = await t.register('stranger-undo@example.com');
      const undo = await post(
        `/calendar/plan-week/${planId}/undo`,
        {},
        stranger,
      );
      expect(undo.statusCode).toBe(404);
      expect(await weekEntries()).toHaveLength(8);
      // Their calendar shows no banner for it either.
      const banner = await get(`/calendar?planned=${planId}`, {
        cookie: stranger,
      });
      expect(banner.body).not.toContain('id="planned-week"');
    });
  });

  // #659: an outfit's origin and the one list rule of Saved and the pickers.
  describe('the outfits a person kept, and the one-offs', () => {
    beforeEach(clearWeek);

    /** The origin of each of `outfitIds`, by id. */
    const originsOf = async (outfitIds: number[]) =>
      new Map(
        (
          await t.db
            .select({ id: outfit.id, origin: outfit.origin })
            .from(outfit)
            .where(inArray(outfit.id, outfitIds))
        ).map((row) => [row.id, row.origin]),
      );

    /** The outfit ids a page lists: Saved's tiles, or a picker's buttons. */
    const listed = (body: string, attribute: 'data-outfit-id' | 'value') =>
      [...body.matchAll(new RegExp(`${attribute}="(\\d+)"`, 'g'))].map((m) =>
        Number(m[1]),
      );

    it('Saved, the plan page and a trip’s add page list the kept outfits; "Worn and planned" the planner’s; a bad value is the kept list', async () => {
      const [tee] = await t.db
        .select({ id: garment.id })
        .from(garment)
        .where(eq(garment.name, 'Tee 0'));
      const saved = await post('/outfits', {
        name: 'Kept look',
        category: 'tops',
        garmentId: String(tee.id),
      });
      const keptId = Number(
        /\/outfits\/(\d+)/.exec(saved.headers.location!)![1],
      );
      await post('/calendar/plan-week');
      const planner = [
        ...new Set((await weekEntries()).map((e) => e.outfitId)),
      ];
      expect(planner).toHaveLength(8);
      const origins = await originsOf([keptId, ...planner]);
      expect(origins.get(keptId)).toBe('person');
      expect(planner.map((id) => origins.get(id))).toEqual(
        planner.map(() => 'planner'),
      );

      const tripId = await onTrip(keptId);
      const surfaces = [
        { url: '/outfits', attribute: 'data-outfit-id' as const },
        {
          url: `/calendar/plan?for=day:${WEEK[1]}&occasion=evening`,
          attribute: 'value' as const,
        },
        { url: `/trips/${tripId}/outfits/new`, attribute: 'value' as const },
      ];
      for (const { url, attribute } of surfaces) {
        const sep = url.includes('?') ? '&' : '?';
        const kept = await get(url);
        expect(kept.statusCode).toBe(200);
        expect(listed(kept.body, attribute)).toEqual([keptId]);
        expect(unescapeHtml(kept.body)).toContain('Worn and planned');
        const oneOffs = await get(`${url}${sep}show=one-offs`);
        expect(listed(oneOffs.body, attribute).sort()).toEqual(
          [...planner].sort(),
        );
        // Navigation state: an unknown list is the kept one, never a 400.
        const bad = await get(`${url}${sep}show=everything`);
        expect(bad.statusCode).toBe(200);
        expect(listed(bad.body, attribute)).toEqual([keptId]);
      }

      // A rename keeps a one-off: it is the person's now, on Saved.
      const [renamed] = planner;
      const slots = await t.db
        .select()
        .from(outfitSlot)
        .where(eq(outfitSlot.outfitId, renamed));
      await post(`/outfits/${renamed}`, {
        name: 'Tuesday, kept',
        category: slots.map((s) => s.category),
        garmentId: slots.map((s) => String(s.garmentId)),
      });
      expect((await originsOf([renamed])).get(renamed)).toBe('person');
      expect(listed((await get('/outfits')).body, 'data-outfit-id')).toEqual([
        renamed,
        keptId,
      ]);
    });

    it('the calendar’s x takes a planner entry’s outfit once nothing holds it; an adopted, packed or twice-planned one stays', async () => {
      await post('/calendar/plan-week');
      const [plain, adopted, packed, twice] = (await weekEntries()).filter(
        (e) => e.occasion === 'all-day',
      );
      // A pick of its garments with no day: the person's now.
      await post('/outfits/ideas/pick', {
        garmentId: (await garmentsOf(adopted.outfitId)).map(String),
      });
      await onTrip(packed.outfitId);
      // The same planner-made outfit on a second day.
      expect(
        await insertEntry(t.db, {
          ownerId: t.owner.id,
          outfitId: twice.outfitId,
          day: addDays(TODAY, 20),
          occasion: 'evening',
          chooser: BY_PERSON,
        }),
      ).toMatchObject({ outcome: 'scheduled' });

      t.logs.clear();
      for (const entry of [plain, adopted, packed, twice]) {
        const removed = await post(`/calendar/${entry.id}/delete`);
        expect(removed.statusCode).toBe(303);
      }
      const left = await originsOf(
        [plain, adopted, packed, twice].map((e) => e.outfitId),
      );
      expect(left.has(plain.outfitId)).toBe(false);
      expect(left.get(adopted.outfitId)).toBe('person');
      expect(left.get(packed.outfitId)).toBe('planner');
      expect(left.get(twice.outfitId)).toBe('planner');
      const deleted = t.logs.ops('calendar.entry.deleted');
      expect(deleted).toContainEqual(
        expect.objectContaining({
          entryId: plain.id,
          oneOffOutfitRemoved: plain.outfitId,
        }),
      );
      expect(deleted).toContainEqual(
        expect.objectContaining({
          entryId: twice.id,
          oneOffOutfitRemoved: null,
        }),
      );
    });

    it('the calendar’s x takes the one-off its entry created, once nothing holds it, and never a reused one or a person’s or an agent’s outfit (#748)', async () => {
      const made = async (origin: 'person' | 'agent' | 'idea' | 'planner') => {
        const [row] = await asFixture(t.db, (tx) =>
          tx
            .insert(outfit)
            .values({
              shareableId: randomUUID(),
              ownerId: t.owner.id,
              name: origin,
              origin,
            })
            .returning({ id: outfit.id }),
        );
        return row.id;
      };
      /** The entry of `outfitId` on `day`; `created`: its pick made the outfit. */
      const plan = async (outfitId: number, day: IsoDate, created: boolean) => {
        const planned = await insertEntry(t.db, {
          ownerId: t.owner.id,
          outfitId,
          day,
          occasion: 'all-day',
          chooser: BY_PERSON,
          outfitCreated: created,
        });
        expect(planned).toMatchObject({ outcome: 'scheduled' });
        return (await weekEntries()).find((e) => e.day === day)!.id;
      };

      // Created by their entry: only the one-offs go.
      const created = {
        person: await made('person'),
        agent: await made('agent'),
        idea: await made('idea'),
        planner: await made('planner'),
      };
      // Already there before the entry (a Wear this on a known idea outfit,
      // the planner's reuse): kept.
      const reused = {
        idea: await made('idea'),
        planner: await made('planner'),
      };
      const entries = [
        await plan(created.person, WEEK[0], true),
        await plan(created.agent, WEEK[1], true),
        await plan(created.idea, WEEK[2], true),
        await plan(created.planner, WEEK[3], true),
        await plan(reused.idea, WEEK[4], false),
        await plan(reused.planner, WEEK[5], false),
      ];
      for (const entry of entries) {
        expect((await post(`/calendar/${entry}/delete`)).statusCode).toBe(303);
      }
      const left = await originsOf([
        ...Object.values(created),
        ...Object.values(reused),
      ]);
      expect(left.get(created.person)).toBe('person');
      expect(left.get(created.agent)).toBe('agent');
      expect(left.has(created.idea)).toBe(false);
      expect(left.has(created.planner)).toBe(false);
      expect(left.get(reused.idea)).toBe('idea');
      expect(left.get(reused.planner)).toBe('planner');

      // Held by another entry or a trip, a created one stays.
      const twice = await made('idea');
      const first = await plan(twice, WEEK[0], true);
      await plan(twice, WEEK[1], false);
      const packed = await made('idea');
      const only = await plan(packed, WEEK[2], true);
      await onTrip(packed);
      for (const entry of [first, only]) {
        expect((await post(`/calendar/${entry}/delete`)).statusCode).toBe(303);
      }
      const kept = await originsOf([twice, packed]);
      expect(kept.get(twice)).toBe('idea');
      expect(kept.get(packed)).toBe('idea');
    });

    it('Wear this records that its pick made the outfit; a repeat on another day does not (#748)', async () => {
      const [tee] = await t.db
        .select({ id: garment.id })
        .from(garment)
        .where(eq(garment.name, 'Tee 0'));
      const garmentIds = [tee.id];
      const wear = (day: IsoDate) =>
        wearIdea(t.db, t.owner.id, {
          garmentIds,
          occasion: 'all-day',
          day,
          today: TODAY,
          at: new Date(),
        });
      const first = await wear(TODAY);
      const second = await wear(addDays(TODAY, -1));
      expect(first).not.toBe('not-found');
      expect(second).not.toBe('not-found');
      const flags = await t.db
        .select({
          day: outfitCalendar.day,
          created: outfitCalendar.outfitCreated,
        })
        .from(outfitCalendar)
        .where(eq(outfitCalendar.ownerId, t.owner.id))
        .orderBy(asc(outfitCalendar.day));
      expect(flags.map((f) => f.created)).toEqual([false, true]);
    });

    it('an auto entry Changed to an existing idea outfit no longer counts as having created one: x keeps it (#748)', async () => {
      await post('/calendar/plan-week');
      const [auto] = (await weekEntries()).filter(
        (e) => e.occasion === 'all-day',
      );
      const [existing] = await asFixture(t.db, (tx) =>
        tx
          .insert(outfit)
          .values({
            shareableId: randomUUID(),
            ownerId: t.owner.id,
            name: 'known idea',
            origin: 'idea',
          })
          .returning({ id: outfit.id }),
      );
      const changed = await post('/calendar', {
        date: auto.day,
        outfitId: String(existing.id),
        replace: String(auto.id),
      });
      expect(changed.statusCode).toBe(302);
      expect((await post(`/calendar/${auto.id}/delete`)).statusCode).toBe(303);
      expect((await originsOf([existing.id])).get(existing.id)).toBe('idea');
    });
  });

  describe('the daily re-plan', () => {
    let sends: {
      userId: number;
      deviceIds: readonly number[];
      payload: PushPayload;
      ttl: number;
    }[];
    let forecastDays: DayForecast[];
    let deps: ReplanDeps;
    // The real sender's read and choice of devices; each message recorded
    // instead of sent (one that finds no device reaches nobody).
    const push: PushSender = {
      sendToUser: () => Promise.reject(new Error('not used')),
      sendEach: async (messages) => {
        const rows = await devicesOfUsers(
          t.db,
          messages.map((message) => message.userId),
        );
        return messages.map((message) => {
          const deviceIds = chosenDevices(rows, message).map((d) => d.id);
          if (deviceIds.length > 0) {
            sends.push({
              userId: message.userId,
              deviceIds,
              payload: message.payload,
              ttl: message.options.ttlSeconds,
            });
          }
          return {
            devices: deviceIds.length,
            delivered: deviceIds.length,
            pruned: 0,
            failed: 0,
          };
        });
      },
    };
    /** `hour`:01 on `day` in the app's zone. */
    const at = (day: IsoDate, hour: number) =>
      new Date(instantAt(day, hour, t.timeZone).getTime() + 60_000);

    /** "Plan my week" under a warm week, as the person did yesterday. */
    const planWarm = () =>
      planMyWeek(t.db, t.owner.id, {
        today: TODAY,
        hour: 8,
        days: WEEK,
        forecast: {
          days: new Map(weekAt(() => 24).map((d) => [d.day, d])),
          offset: 0,
        },
      });

    beforeAll(async () => {
      await setHome(t.db, t.owner.id, {
        name: 'Fort Greene',
        location: { latitude: 40.69, longitude: -73.98 },
      });
      const deviceId = await subscribeAs(t.db, t.owner.id, {
        endpoint: 'https://fcm.googleapis.com/fcm/send/week-replan',
        keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
      });
      await saveReminderSettings(
        t.db,
        t.owner.id,
        'https://fcm.googleapis.com/fcm/send/week-replan',
        { morning: 450, evening: null, museRounds: false },
        new Date('2020-01-01T00:00:00Z'),
      );
      expect(deviceId).toBeGreaterThan(0);
    });

    beforeEach(async () => {
      await clearWeek();
      sends = [];
      forecastDays = weekAt(() => 24);
      deps = {
        db: t.db,
        weather: fakeWeather(() => forecastDays),
        push,
        timeZone: t.timeZone,
        logger: t.logger.child({ logger: 'WeekPlan' }),
      };
    });

    it('never runs in the harness: createApp schedules nothing', () => {
      expect(
        t.logs.records.some((r) => /Week re-plan runs/.test(r.msg ?? '')),
      ).toBe(false);
    });

    it(`does nothing before ${REPLAN_HOUR}:00, then keeps entries whose targets did not change`, async () => {
      await planWarm();
      expect(await replanWeeks(deps, at(TODAY, REPLAN_HOUR - 1))).toMatchObject(
        { claimed: 0 },
      );
      expect(await t.db.$count(weekReplan)).toBe(0);
      let run: Awaited<ReturnType<typeof replanWeeks>> | undefined;
      // #165: who is due, then every candidate's weather in one statement
      // (the refresh's answer is the re-plan's: not read again), then one
      // transaction: begin, the owner lock, the auto entries with the
      // claim, then the window, the pool, the generator's memory and the
      // outfits' garments in one statement (#173: they were six), commit.
      // The candidate is not asked about again.
      const recorded = await recordQueries(async () => {
        run = await replanWeeks(deps, at(TODAY, REPLAN_HOUR));
      });
      expect(run).toEqual({
        claimed: 1,
        swapped: 0,
        kept: 0,
        failed: 0,
        pushed: 0,
      });
      expect(recorded.statements).toBe(7);
      expect(
        recorded.sql.filter((q) => q.includes('"user_weather"')),
      ).toHaveLength(1);
      expect(sends).toEqual([]);
    });

    it('stores the limb ceiling it planned for, and the re-plan reads it back (#750)', async () => {
      await planWarm();
      // 24 C: the uncapped too-warm bound for legs and feet is 1.
      const rows = await t.db.select().from(weekPlanEntry);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((r) => r.limbsCeiling)).toEqual(rows.map(() => 1));
      const claimed = await t.db.transaction((tx) =>
        claimAutoEntries(tx, t.owner.id, TODAY, at(TODAY, REPLAN_HOUR)),
      );
      expect(claimed).toHaveLength(rows.length);
      expect(claimed!.map((a) => a.plannedFor?.limbsCeiling)).toEqual(
        rows.map(() => 1),
      );
    });

    it('swaps an auto entry the colder forecast finds too light, and tells the morning reminder’s device', async () => {
      await planWarm();
      const before = await weekEntries();
      forecastDays = weekAt((day) => (day === WEEK[3] ? -2 : 24));
      t.logs.clear();
      const run = await replanWeeks(deps, at(TODAY, 7));
      expect(run).toMatchObject({
        claimed: 1,
        swapped: 1,
        failed: 0,
        pushed: 1,
      });
      const after = await weekEntries();
      const thursday = after.filter((e) => e.day === WEEK[3]);
      expect(thursday).toHaveLength(1);
      expect(thursday[0].plannedBy).toBe('auto');
      const oldThursday = before.find((e) => e.day === WEEK[3])!;
      expect(thursday[0].outfitId).not.toBe(oldThursday.outfitId);
      // The planner's old outfit went with its entry; the new one has the coat.
      expect(
        await t.db.$count(outfit, eq(outfit.id, oldThursday.outfitId)),
      ).toBe(0);
      const coatIn = await t.db.query.outfitSlot.findMany({
        where: (slot, { eq: equals }) =>
          equals(slot.outfitId, thursday[0].outfitId),
      });
      expect(coatIn.map((s) => s.garmentId)).toContain(coat);
      // Every other entry is as it was.
      expect(after.filter((e) => e.day !== WEEK[3]).map((e) => e.id)).toEqual(
        before.filter((e) => e.day !== WEEK[3]).map((e) => e.id),
      );
      expect(sends).toHaveLength(1);
      expect(sends[0].payload).toMatchObject({
        title: 'Your week changed',
        url: '/calendar',
        tag: 'week-replan',
      });
      expect(sends[0].payload.body).toMatch(
        /^Thursday turned cold: swapped in Wool coat/,
      );
      expect(sends[0].ttl).toBe(6 * 60 * 60);
      expect(
        t.logs
          .messages('info', 'WeekPlan')
          .some((m) =>
            m.startsWith(
              `Week re-plan for user ${t.owner.id} on ${TODAY}: 1 swapped (${WEEK[3]} all-day colder)`,
            ),
          ),
      ).toBe(true);
    });

    it('a swap keeps a planner-made outfit the person picked meanwhile (#77)', async () => {
      await planWarm();
      const oldThursday = (await weekEntries()).find((e) => e.day === WEEK[3])!;
      const pick = await post('/outfits/ideas/pick', {
        garmentId: (await garmentsOf(oldThursday.outfitId)).map(String),
      });
      expect(pick.statusCode).toBe(303);
      forecastDays = weekAt((day) => (day === WEEK[3] ? -2 : 24));
      const run = await replanWeeks(deps, at(TODAY, 7));
      expect(run).toMatchObject({ claimed: 1, swapped: 1, failed: 0 });
      const thursday = (await weekEntries()).filter((e) => e.day === WEEK[3]);
      expect(thursday).toHaveLength(1);
      expect(thursday[0].outfitId).not.toBe(oldThursday.outfitId);
      // The entry was the planner's to swap; the outfit is the person's.
      expect(
        await t.db.$count(outfit, eq(outfit.id, oldThursday.outfitId)),
      ).toBe(1);
    });

    it('a swap keeps the old planner-made outfit when a trip holds it', async () => {
      await planWarm();
      const oldThursday = (await weekEntries()).find((e) => e.day === WEEK[3])!;
      const tripId = await onTrip(oldThursday.outfitId);
      forecastDays = weekAt((day) => (day === WEEK[3] ? -2 : 24));
      const run = await replanWeeks(deps, at(TODAY, 7));
      expect(run).toMatchObject({ claimed: 1, swapped: 1, failed: 0 });
      const thursday = (await weekEntries()).filter((e) => e.day === WEEK[3]);
      expect(thursday).toHaveLength(1);
      expect(thursday[0].outfitId).not.toBe(oldThursday.outfitId);
      await expectTripKeeps(tripId, oldThursday.outfitId);
    });

    it("removes its own entries from days a trip now covers, with the outfits it made for them, and leaves the person's (#684)", async () => {
      await planWarm();
      const before = await weekEntries();
      const thursday = before.find((e) => e.day === WEEK[3])!;
      const friday = before.find((e) => e.day === WEEK[4])!;
      // Friday's is theirs now.
      await asFixture(t.db, (tx) =>
        tx
          .update(outfitCalendar)
          .set({ plannedBy: 'user' })
          .where(eq(outfitCalendar.id, friday.id)),
      );
      await createTrip(t.db, t.owner.id, {
        name: 'Lisbon long weekend',
        destination: 'Lisbon',
        startsOn: WEEK[3],
        endsOn: WEEK[4],
        notes: null,
      });
      t.logs.clear();
      const run = await replanWeeks(deps, at(TODAY, 7));
      expect(run).toMatchObject({ claimed: 1, swapped: 0, failed: 0 });
      const after = await weekEntries();
      expect(after.filter((e) => e.day === WEEK[3])).toEqual([]);
      expect(after.filter((e) => e.day === WEEK[4]).map((e) => e.id)).toEqual([
        friday.id,
      ]);
      // The other days are as planned.
      expect(after.filter((e) => e.day !== WEEK[3])).toEqual(
        before
          .filter((e) => e.day !== WEEK[3])
          .map((e) => (e.id === friday.id ? { ...e, plannedBy: 'user' } : e)),
      );
      expect(await t.db.$count(outfit, eq(outfit.id, thursday.outfitId))).toBe(
        0,
      );
      expect(t.logs.messages('info', 'WeekPlan')).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Week re-plan for user ${t.owner.id} on ${TODAY}: 0 swapped \\(\\), \\d+ kept, 1 removed from days away in `,
          ),
        ),
      );
      expect(sends).toEqual([]);
    });

    it("a trip created or moved over planned days takes the planner's entries off them from today on, and leaves the person's and the past's (#684)", async () => {
      await planWarm();
      const before = await weekEntries();
      const [tuesday, wednesday, thursday, friday, saturday] = [
        1, 2, 3, 4, 5,
      ].map((i) => before.find((e) => e.day === WEEK[i])!);
      // Friday's is theirs now.
      await asFixture(t.db, (tx) =>
        tx
          .update(outfitCalendar)
          .set({ plannedBy: 'user' })
          .where(eq(outfitCalendar.id, friday.id)),
      );
      // Wednesday, 08:00 in New York: Tuesday's plan is past, still theirs to mark worn.
      vi.setSystemTime(at(WEEK[2], 8));
      const trip = {
        name: 'Lisbon long weekend',
        destination: 'Lisbon',
        startsOn: WEEK[1],
        endsOn: WEEK[3],
      };
      t.logs.clear();
      const created = await post('/trips', trip);
      expect(created.statusCode, created.body).toBe(303);
      const tripId = Number(
        /^\/trips\/(\d+)/.exec(String(created.headers.location))![1],
      );
      const gone = new Set([wednesday.id, thursday.id]);
      const after = await weekEntries();
      expect(after.map((e) => e.id)).toEqual(
        before.filter((e) => !gone.has(e.id)).map((e) => e.id),
      );
      expect(after.map((e) => e.id)).toContain(tuesday.id);
      // The outfit the planner made for Thursday went with its entry.
      expect(await t.db.$count(outfit, eq(outfit.id, thursday.outfitId))).toBe(
        0,
      );
      expect(t.logs.ops('trip.created')).toContainEqual(
        expect.objectContaining({ tripId, autoEntriesRemoved: 2 }),
      );
      // Moved to end on Saturday: Saturday's goes too, Friday's stays.
      const moved = await post(`/trips/${tripId}`, {
        ...trip,
        endsOn: WEEK[5],
      });
      expect(moved.statusCode, moved.body).toBe(303);
      expect((await weekEntries()).map((e) => e.id)).toEqual(
        after.filter((e) => e.id !== saturday.id).map((e) => e.id),
      );
    });

    it("is idempotent: once a day per user, whatever the minutes, and never touches the person's entries", async () => {
      await planWarm();
      const entries = await weekEntries();
      // Thursday's is theirs now (worn is only for today; an edit does it).
      await asFixture(t.db, (tx) =>
        tx
          .update(outfitCalendar)
          .set({ plannedBy: 'user' })
          .where(
            eq(outfitCalendar.id, entries.find((e) => e.day === WEEK[3])!.id),
          ),
      );
      forecastDays = weekAt(() => -2);
      const first = await replanWeeks(deps, at(TODAY, 7));
      expect(first.claimed).toBe(1);
      const after = await weekEntries();
      expect(after.find((e) => e.day === WEEK[3])).toMatchObject({
        id: entries.find((e) => e.day === WEEK[3])!.id,
        plannedBy: 'user',
      });
      const again = await replanWeeks(
        deps,
        new Date(at(TODAY, 7).getTime() + 60_000),
      );
      expect(again).toEqual({
        claimed: 0,
        swapped: 0,
        kept: 0,
        failed: 0,
        pushed: 0,
      });
      expect(await weekEntries()).toEqual(after);
      expect(sends).toHaveLength(1);
      // The next day is a new claim.
      expect((await replanWeeks(deps, at(addDays(TODAY, 1), 7))).claimed).toBe(
        1,
      );
    });

    /**
     * Runs `work` with every calendar insert of the owner failing in the
     * database, which is what a swap writes: a real failure of the person's
     * own work, after the re-plan's claim in the same transaction.
     */
    const withFailingSwaps = async <T>(work: () => Promise<T>): Promise<T> => {
      await t.db.execute(
        sql.raw(`
        create function fail_swap() returns trigger language plpgsql as
        $$ begin raise exception 'injected failure'; end $$;
        create trigger fail_swap before insert on outfit_calendar
          for each row when (new.owner_id = ${t.owner.id})
          execute function fail_swap();`),
      );
      try {
        return await work();
      } finally {
        await t.db.execute(
          sql.raw(
            'drop trigger fail_swap on outfit_calendar; drop function fail_swap();',
          ),
        );
      }
    };

    const minutesAfter = (minutes: number) =>
      new Date(at(TODAY, 7).getTime() + minutes * 60_000);
    const failures = () =>
      t.logs
        .messages('error', 'WeekPlan')
        .filter((m) => m.startsWith(`Week re-plan for user ${t.owner.id}`));

    it('a failing re-plan is tried at 5, 15 and 60 minutes, then claimed; one failure is reported, not four (#687)', async () => {
      await planWarm();
      forecastDays = weekAt(() => -2);
      const retrying: ReplanDeps = { ...deps, retries: new ReplanRetries() };
      t.logs.clear();
      await withFailingSwaps(async () => {
        const first = await replanWeeksWhole(retrying, minutesAfter(0)).catch(
          (error: unknown) => error,
        );
        expect(first).toBeInstanceOf(PartialFailure);
        expect(first).toMatchObject({ job: 'replan', counts: { failed: 1 } });
        expect(await t.db.$count(weekReplan)).toBe(0);

        // Waiting: no attempt, no error line, a success for the run.
        for (const m of [1, 4]) {
          expect(await replanWeeks(retrying, minutesAfter(m))).toMatchObject({
            claimed: 0,
            failed: 0,
          });
        }
        expect(failures()).toHaveLength(1);

        // Retries fail too, but only the day's first failure is reported.
        for (const m of [5, 20]) {
          expect(
            await replanWeeksWhole(retrying, minutesAfter(m)),
          ).toMatchObject({ claimed: 1, failed: 0 });
          expect(await t.db.$count(weekReplan)).toBe(0);
        }
        // 5 + 15 + 60 minutes after the first: the last try claims the day.
        await replanWeeksWhole(retrying, minutesAfter(80));
      });
      expect(failures()).toHaveLength(4);
      expect(failures().at(-1)).toMatch(/claimed for the day$/);
      expect(await t.db.$count(weekReplan)).toBe(1);
      expect(await replanWeeks(retrying, minutesAfter(81))).toMatchObject({
        claimed: 0,
      });
    });

    it('the reminder and the minutely run each report their own first failure (#858)', async () => {
      await planWarm();
      forecastDays = weekAt(() => -2);
      const retrying: ReplanDeps = { ...deps, retries: new ReplanRetries() };
      const reminderAt = at(TODAY, 5);
      await withFailingSwaps(async () => {
        // The reminder's re-plan fails first, and is its job's one report.
        expect(
          await replanToday(retrying, t.owner.id, reminderAt, {
            announcesToday: true,
            job: 'reminders',
          }),
        ).toEqual({ kind: 'failed', reported: true });

        // The minutely run's retry is still its own first: a PartialFailure.
        const run = await replanWeeksWhole(
          retrying,
          new Date(reminderAt.getTime() + 5 * 60_000),
        ).catch((error: unknown) => error);
        expect(run).toBeInstanceOf(PartialFailure);
        expect(run).toMatchObject({ job: 'replan', counts: { failed: 1 } });

        // Neither reports again on a later retry.
        expect(
          await replanToday(
            retrying,
            t.owner.id,
            new Date(reminderAt.getTime() + 20 * 60_000),
            { announcesToday: true, job: 'reminders' },
          ),
        ).toEqual({ kind: 'failed', reported: false });
        expect(
          await replanWeeksWhole(
            retrying,
            new Date(reminderAt.getTime() + 80 * 60_000),
          ),
        ).toMatchObject({ failed: 0 });
      });
    });

    it('a retry that succeeds re-plans the person and claims the day (#687)', async () => {
      await planWarm();
      forecastDays = weekAt(() => -2);
      const retrying: ReplanDeps = { ...deps, retries: new ReplanRetries() };
      await withFailingSwaps(() =>
        replanWeeksWhole(retrying, minutesAfter(0)).catch(() => undefined),
      );
      expect(await t.db.$count(weekReplan)).toBe(0);
      const run = await replanWeeksWhole(retrying, minutesAfter(5));
      expect(run).toMatchObject({ claimed: 1, failed: 0 });
      expect(run.swapped).toBeGreaterThan(0);
      expect(await t.db.$count(weekReplan)).toBe(1);
    });

    it('a forecast fetch that fails with nothing cached is no forecast, not a failed re-plan (#687)', async () => {
      await planWarm();
      const cold: ReplanDeps = {
        ...deps,
        weather: {
          ...fakeWeather(() => forecastDays),
          forecastFor: () => Promise.reject(new Error('Open-Meteo down')),
        },
      };
      const run = await replanWeeksWhole(cold, minutesAfter(0));
      expect(run).toMatchObject({ claimed: 1, failed: 0 });
      expect(await t.db.$count(weekReplan)).toBe(1);
    });

    it('two servers re-planning the same minute claim each user once', async () => {
      await planWarm();
      forecastDays = weekAt(() => -2);
      const logger = t.logger.child({ logger: 'WeekPlan' });
      const other: Db = createDb(t.database, logger);
      try {
        const runs = await Promise.all([
          replanWeeks(deps, at(TODAY, 7)),
          replanWeeks({ ...deps, db: other }, at(TODAY, 7)),
        ]);
        expect(runs.map((r) => r.claimed).sort()).toEqual([0, 1]);
        expect(sends).toHaveLength(1);
        // Each slot still holds one entry.
        expect((await weekEntries()).map((e) => e.slot).sort()).toEqual(
          TEMPLATE_SLOTS,
        );
      } finally {
        await other.$client.end();
      }
    });

    it('runs at its wall-clock hour on the days DST ends and starts', async () => {
      const { weekPlanId } = await planWarm();
      for (const [day, utcOffset] of [
        // 1 Nov 2026: New York falls back, to UTC-5.
        ['2026-11-01', 5],
        // 14 Mar 2027: springs forward, to UTC-4.
        ['2027-03-14', 4],
      ] as const) {
        const utcHour = REPLAN_HOUR + utcOffset;
        // An evening the planner left there, recorded in its batch.
        const [anyOutfit] = await t.db
          .select({ id: outfit.id })
          .from(outfit)
          .limit(1);
        const [entry] = await asFixture(t.db, (tx) =>
          tx
            .insert(outfitCalendar)
            .values({
              ownerId: t.owner.id,
              outfitId: anyOutfit.id,
              day,
              occasion: 'evening',
              plannedBy: 'auto',
            })
            .returning({ id: outfitCalendar.id }),
        );
        await asFixture(t.db, (tx) =>
          tx.insert(weekPlanEntry).values({
            entryId: entry.id,
            weekPlanId: weekPlanId!,
            outfitCreated: false,
          }),
        );
        const early = new Date(
          `${day}T${String(utcHour - 1).padStart(2, '0')}:30:00Z`,
        );
        expect((await replanWeeks(deps, early)).claimed).toBe(0);
        const onTime = new Date(
          `${day}T${String(utcHour).padStart(2, '0')}:00:30Z`,
        );
        expect((await replanWeeks(deps, onTime)).claimed).toBe(1);
      }
    });

    it('runs no later than the earliest morning reminder', () => {
      expect(REPLAN_HOUR * 60).toBeLessThanOrEqual(
        REMINDER_WINDOWS.morning.from,
      );
    });

    describe('an outfit that can no longer be worn', () => {
      /** The entry on `day` and its outfit's garment of `category`. */
      const garmentOn = async (day: IsoDate, category: string) => {
        const entry = (await weekEntries()).find(
          (e) => e.day === day && e.occasion === 'all-day',
        )!;
        const [slot] = await t.db
          .select({ garmentId: outfitSlot.garmentId })
          .from(outfitSlot)
          .where(
            and(
              eq(outfitSlot.outfitId, entry.outfitId),
              eq(outfitSlot.category, category),
            ),
          );
        return { entry, garmentId: slot.garmentId! };
      };

      /** `garmentId`'s name, as the notice says it. */
      const garmentName = async (garmentId: number) =>
        (await t.db.query.garment.findFirst({
          columns: { name: true },
          where: (g, { eq: equals }) => equals(g.id, garmentId),
        }))!.name!;

      it('swaps an auto entry whose garment went to repair, saying so, and never a person’s entry wearing it', async () => {
        await planWarm();
        // Shoes: the other pair never needs a wash, so a swap always exists.
        const { entry, garmentId } = await garmentOn(WEEK[2], 'footwear');
        const name = await garmentName(garmentId);
        // The person also plans that outfit for Thursday evening: theirs.
        await post('/calendar', {
          date: WEEK[3],
          outfitId: String(entry.outfitId),
          occasion: 'evening',
        });
        const before = await weekEntries();
        const theirs = before.find(
          (e) => e.day === WEEK[3] && e.occasion === 'evening',
        )!;
        expect(theirs.plannedBy).toBe('user');
        const away = await post(`/wardrobe/${garmentId}/away`, {
          away: 'repair',
        });
        expect(away.statusCode).toBe(303);
        onTestFinished(async () => {
          await post(`/wardrobe/${garmentId}/away`, { away: '' });
        });

        t.logs.clear();
        // The forecast did not change: only availability moves it.
        const run = await replanWeeks(deps, at(TODAY, 7));
        expect(run).toMatchObject({ claimed: 1, failed: 0 });
        const after = await weekEntries();
        const wednesday = after.find(
          (e) => e.day === WEEK[2] && e.occasion === 'all-day',
        )!;
        expect(wednesday.plannedBy).toBe('auto');
        expect(wednesday.outfitId).not.toBe(entry.outfitId);
        expect(await garmentsOf(wednesday.outfitId)).not.toContain(garmentId);
        // The person's entry and the outfit it holds stay.
        expect(after).toContainEqual(theirs);
        expect(await t.db.$count(outfit, eq(outfit.id, entry.outfitId))).toBe(
          1,
        );
        // One notice, a line per entry that wore the shoes.
        expect(sends).toHaveLength(1);
        expect(sends[0].payload.body.split('\n')).toContainEqual(
          expect.stringMatching(
            new RegExp(`^${name} is at repair: swapped in .+ on Wednesday$`),
          ),
        );
        expect(t.logs.messages('info', 'WeekPlan')).toContainEqual(
          expect.stringMatching(
            new RegExp(
              `^Week re-plan for user ${t.owner.id} on ${TODAY}: ${run.swapped} swapped \\(.*${WEEK[2]} all-day repair garment ${garmentId}.*\\), 0 kept in \\d+ ms$`,
            ),
          ),
        );
      });

      it('swaps one whose garment was archived or deleted, without weather too', async () => {
        const noWeather = { ...deps, weather: undefined };
        await planWarm();
        const archived = await garmentOn(WEEK[1], 'footwear');
        const archivedName = await garmentName(archived.garmentId);
        expect(
          (await post(`/wardrobe/${archived.garmentId}/archive`)).statusCode,
        ).toBeLessThan(400);
        onTestFinished(async () => {
          await post(`/wardrobe/${archived.garmentId}/restore`);
        });
        const run = await replanWeeks(noWeather, at(TODAY, 7));
        expect(run).toMatchObject({ claimed: 1, failed: 0 });
        expect(run.swapped).toBeGreaterThanOrEqual(1);
        expect(sends[0].payload.body).toContain(
          `${archivedName} is archived: swapped in `,
        );
        const tuesday = (await weekEntries()).find(
          (e) => e.day === WEEK[1] && e.occasion === 'all-day',
        )!;
        expect(tuesday.outfitId).not.toBe(archived.entry.outfitId);
        expect(await garmentsOf(tuesday.outfitId)).not.toContain(
          archived.garmentId,
        );

        // The same morning again (its claim cleared): a garment deleted
        // meanwhile empties its slots.
        await t.db.delete(weekReplan);
        sends = [];
        const deleted = await garmentOn(WEEK[4], 'tops');
        const [tee] = await t.db
          .select({ name: garment.name, colors: garment.colors })
          .from(garment)
          .where(eq(garment.id, deleted.garmentId));
        // The closet is every test's: the tee comes back as it was.
        onTestFinished(async () => {
          await garmentIn(tee.name!, 'tops', tee.colors![0], {
            quantity: '3',
          });
        });
        const res = await t.inject({
          method: 'DELETE',
          url: `/wardrobe/${deleted.garmentId}`,
        });
        expect(res.statusCode).toBeLessThan(400);
        const next = await replanWeeks(noWeather, at(TODAY, 8));
        expect(next).toMatchObject({ claimed: 1, failed: 0 });
        expect(sends[0].payload.body).toContain(
          "A garment of Friday's outfit was deleted: swapped in ",
        );
        const friday = (await weekEntries()).find(
          (e) => e.day === WEEK[4] && e.occasion === 'all-day',
        )!;
        expect(friday.outfitId).not.toBe(deleted.entry.outfitId);
      });

      it('counts a garment without a clean copy only on its own day', async () => {
        await planWarm();
        const monday = await garmentOn(TODAY, 'tops');
        const later = await garmentOn(WEEK[2], 'tops');
        const mondayName = await garmentName(monday.garmentId);
        // Worn the three days before: every copy of each tee is dirty.
        onTestFinished(async () => {
          await asFixture(t.db, (tx) => tx.delete(garmentWear));
        });
        for (const garmentId of new Set([monday.garmentId, later.garmentId])) {
          for (const back of [1, 2, 3]) {
            await asFixture(t.db, (tx) =>
              tx.insert(garmentWear).values({
                garmentId,
                ownerId: t.owner.id,
                day: addDays(TODAY, -back),
              }),
            );
          }
        }
        const before = await weekEntries();
        const run = await replanWeeks(deps, at(TODAY, 7));
        expect(run).toMatchObject({ claimed: 1, swapped: 1, failed: 0 });
        const after = await weekEntries();
        const today = after.find((e) => e.day === TODAY)!;
        expect(today.outfitId).not.toBe(monday.entry.outfitId);
        expect(await garmentsOf(today.outfitId)).not.toContain(
          monday.garmentId,
        );
        // Every later day is as it was: a wash is expected by then.
        expect(after.filter((e) => e.day !== TODAY)).toEqual(
          before.filter((e) => e.day !== TODAY),
        );
        expect(sends[0].payload.body).toMatch(
          new RegExp(`^${mondayName} needs a wash: swapped in .+ on Monday$`),
        );
      });
    });

    describe('before the morning reminder (#76)', () => {
      let deviceId: number;
      let reminders: ReminderDeps;

      /** A device of the owner's with the morning reminder at `hour`:00. */
      const remindAt = async (hour: number) => {
        const endpoint = `https://fcm.googleapis.com/fcm/send/morning-${hour}`;
        deviceId = await subscribeAs(t.db, t.owner.id, {
          endpoint,
          keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
        });
        await saveReminderSettings(
          t.db,
          t.owner.id,
          endpoint,
          { morning: hour * 60, evening: null, museRounds: false },
          new Date('2020-01-01T00:00:00Z'),
        );
      };

      const reminderTo = () =>
        sends.filter(
          (s) =>
            s.payload.tag === 'today-morning' && s.deviceIds.includes(deviceId),
        );
      const swapNotices = () =>
        sends.filter((s) => s.payload.tag === 'week-replan');

      beforeEach(async () => {
        await t.db.delete(pushReminder);
        reminders = {
          db: t.db,
          sender: push,
          weather: undefined,
          timeZone: t.timeZone,
          logger: t.logger.child({ logger: 'Push' }),
          replan: deps,
        };
      });

      afterEach(async () => {
        await t.db.delete(userDevice).where(eq(userDevice.id, deviceId));
      });

      it.each([REPLAN_HOUR, REPLAN_HOUR + 1])(
        'a reminder at %i:00 names the outfit the day’s re-plan swapped in, not the one it swapped out',
        async (hour) => {
          await planWarm();
          await remindAt(hour);
          const planned = (await weekEntries()).find((e) => e.day === TODAY)!;
          const oldName = await nameOf(planned.outfitId);
          forecastDays = weekAt((day) => (day === TODAY ? -2 : 24));

          // The reminder's minute, before (or without) the re-plan's own run.
          const run = await sendDueReminders(reminders, at(TODAY, hour));
          expect(run).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
          const today = (await weekEntries()).find((e) => e.day === TODAY)!;
          expect(today.outfitId).not.toBe(planned.outfitId);
          expect(await garmentsOf(today.outfitId)).toContain(coat);
          // One push: the reminder says what swapped, then the day's outfit.
          const [reminder] = reminderTo();
          expect(reminder.payload.body.split('\n')).toEqual([
            expect.stringMatching(/^Swapped in .+: it turned cold$/),
            `All day: ${await nameOf(today.outfitId)}`,
          ]);
          expect(reminder.payload.body).not.toContain(`All day: ${oldName}`);
          expect(sends.map((s) => s.payload.tag)).toEqual(['today-morning']);
          // The day is claimed: the re-plan's own run finds nothing to do.
          expect(await replanWeeks(deps, at(TODAY, hour))).toMatchObject({
            claimed: 0,
          });
          expect(swapNotices()).toEqual([]);
        },
      );

      it('names today’s swap in the reminder and another day’s in one swap notice', async () => {
        await planWarm();
        await remindAt(REPLAN_HOUR);
        forecastDays = weekAt((day) =>
          day === TODAY || day === WEEK[3] ? -2 : 24,
        );
        const run = await sendDueReminders(reminders, at(TODAY, REPLAN_HOUR));
        expect(run).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
        expect(sends.map((s) => s.payload.tag).sort()).toEqual([
          'today-morning',
          'week-replan',
        ]);
        expect(reminderTo()[0].payload.body).toMatch(
          /^Swapped in .+: it turned cold\nAll day: /,
        );
        const [notice] = swapNotices();
        expect(notice.payload.body).toMatch(
          /^Thursday turned cold: swapped in /,
        );
        expect(notice.payload.body).not.toContain('Monday');
      });

      it('a stop while the re-plan is held cancels it, not abandons it: the run waits it out, nothing is swapped or told, the claim is given back (#920)', async () => {
        await planWarm();
        await remindAt(REPLAN_HOUR);
        const planned = (await weekEntries()).find((e) => e.day === TODAY)!;
        forecastDays = weekAt((day) =>
          day === TODAY || day === WEEK[3] ? -2 : 24,
        );
        let fetchStarted!: () => void;
        const started = new Promise<void>(
          (resolve) => (fetchStarted = resolve),
        );
        let letGo!: () => void;
        const hold = new Promise<void>((resolve) => (letGo = resolve));
        // A step the signal cannot cut short (this read ignores it), as a
        // statement in flight is: the run must wait it out.
        const cold = fakeWeather(() => forecastDays);
        const weather: WeatherService = {
          ...cold,
          forecastFor: async (...args) => {
            fetchStarted();
            await hold;
            return cold.forecastFor(...args);
          },
        };
        const held: ReminderDeps = {
          ...reminders,
          replan: { ...deps, weather },
        };
        const now = at(TODAY, REPLAN_HOUR);
        let running: Promise<ReminderRun> | undefined;
        let settled = false;
        const job = scheduleJob({
          name: 'Push reminders',
          logger: reminders.logger,
          now: () => now,
          untilNext: () => 0,
          run: (signal) => {
            running = sendDueReminders(held, now, signal);
            running.then(
              () => (settled = true),
              () => (settled = true),
            );
            return running;
          },
        });
        await started;

        await job.stop();
        // Still waiting on its re-plan: no claim given back under it.
        expect(settled).toBe(false);
        letGo();
        const run = await running!;
        expect(run).toMatchObject({
          claimed: 1,
          sent: 0,
          failed: 0,
          released: 1,
          lost: 0,
          interrupted: true,
        });
        // Rolled back whole: no swap, no claim of the day, nobody told.
        expect(
          (await weekEntries()).find((e) => e.day === TODAY)!.outfitId,
        ).toBe(planned.outfitId);
        expect(await t.db.$count(weekReplan)).toBe(0);
        expect(sends).toEqual([]);
        expect(await t.db.$count(pushReminder)).toBe(0);

        // The next minute re-plans and reminds, once.
        const next = await sendDueReminders(
          reminders,
          new Date(now.getTime() + 60_000),
        );
        expect(next).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
        expect(reminderTo()[0].payload.body).toMatch(/^Swapped in /);
        expect(swapNotices()).toHaveLength(1);
        expect(await t.db.$count(weekReplan)).toBe(1);
      }, 15_000);

      it('two servers running the reminders and the re-plan at the same minute re-plan once and remind once, after the re-plan', async () => {
        const logger = t.logger.child({ logger: 'WeekPlan' });
        const other: Db = createDb(t.database, logger);
        const otherDeps: ReplanDeps = { ...deps, db: other };
        const otherReminders: ReminderDeps = {
          ...reminders,
          db: other,
          replan: otherDeps,
        };
        try {
          await remindAt(REPLAN_HOUR);
          for (let round = 0; round < 5; round += 1) {
            await clearWeek();
            await t.db.delete(pushReminder);
            sends = [];
            forecastDays = weekAt(() => 24);
            await planWarm();
            const planned = (await weekEntries()).find((e) => e.day === TODAY)!;
            forecastDays = weekAt((day) => (day === TODAY ? -2 : 24));
            const now = at(TODAY, REPLAN_HOUR);
            // Each server's two minute timers, in either order.
            await Promise.all(
              round % 2 === 0
                ? [
                    sendDueReminders(reminders, now),
                    replanWeeks(deps, now),
                    replanWeeks(otherDeps, now),
                    sendDueReminders(otherReminders, now),
                  ]
                : [
                    replanWeeks(otherDeps, now),
                    sendDueReminders(otherReminders, now),
                    sendDueReminders(reminders, now),
                    replanWeeks(deps, now),
                  ],
            );
            const today = (await weekEntries()).filter((e) => e.day === TODAY);
            expect(today, `round ${round}`).toHaveLength(1);
            expect(today[0].outfitId).not.toBe(planned.outfitId);
            expect(reminderTo(), `round ${round}`).toHaveLength(1);
            const body = reminderTo()[0].payload.body;
            expect(
              body.endsWith(`All day: ${await nameOf(today[0].outfitId)}`),
            ).toBe(true);
            // Said once: in the reminder when it ran the re-plan, in a swap
            // notice when the minutely run did.
            const inReminder = body.startsWith('Swapped in ') ? 1 : 0;
            expect(swapNotices().length + inReminder, `round ${round}`).toBe(1);
            expect(await t.db.$count(weekReplan)).toBe(1);
            expect((await weekEntries()).map((e) => e.slot).sort()).toEqual(
              TEMPLATE_SLOTS,
            );
          }
        } finally {
          await other.$client.end();
        }
      });

      it('a person whose re-plan and whose send both failed is one failed person (#858)', async () => {
        await planWarm();
        await remindAt(REPLAN_HOUR);
        forecastDays = weekAt(() => -2);
        const down = {
          ...reminders.sender,
          sendEach: () => Promise.reject(new Error('devices unreadable')),
        } as unknown as typeof reminders.sender;
        const run = await withFailingSwaps(() =>
          sendDueReminders(
            { ...reminders, sender: down },
            at(TODAY, REPLAN_HOUR),
          ),
        );
        expect(run).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
        expect([...run.failedUsers]).toEqual([t.owner.id]);
      });

      it('an entry the person took over is named as they left it, and a failed re-plan still lets the reminder go', async () => {
        await planWarm();
        await remindAt(REPLAN_HOUR);
        const planned = (await weekEntries()).find((e) => e.day === TODAY)!;
        await post('/calendar', {
          date: TODAY,
          outfitId: String(planned.outfitId),
          occasion: 'all-day',
        });
        forecastDays = weekAt(() => -2);
        t.logs.clear();
        const run = await withFailingSwaps(() =>
          sendDueReminders(reminders, at(TODAY, REPLAN_HOUR)),
        );
        // Sent anyway, and the reminders job reports the re-plan's failure (#858).
        expect(run).toMatchObject({ claimed: 1, sent: 1, failed: 1 });
        expect(reminderTo()[0].payload.body).toContain(
          await nameOf(planned.outfitId),
        );
        expect(t.logs.messages('error', 'WeekPlan')).toContain(
          `Week re-plan for user ${t.owner.id} on ${TODAY} failed, claimed for the day`,
        );
        // Without ReplanRetries a failure claims the day at once.
        expect(await t.db.$count(weekReplan)).toBe(1);
        expect(await replanWeeks(deps, at(TODAY, 7))).toMatchObject({
          claimed: 0,
        });
        expect(
          (await weekEntries()).find((e) => e.id === planned.id)!.plannedBy,
        ).toBe('user');
      });
    });

    it('prunes the claims of past days', async () => {
      await planWarm();
      await replanWeeks(deps, at(TODAY, 7));
      await pruneReplans(deps, TODAY);
      expect(await t.db.$count(weekReplan)).toBe(1);
      await pruneReplans(deps, addDays(TODAY, 1));
      expect(await t.db.$count(weekReplan)).toBe(0);
    });
  });

  describe('plan_week (MCP)', () => {
    beforeEach(clearWeek);

    it('plans the week as the calendar does, and a retry plans nothing new', async () => {
      const token = await createAccessToken(t);
      const answer = await tool<{
        templateSet: boolean;
        weekPlanId: number;
        planned: { day: string; occasion: Occasion; outfit: { id: number } }[];
        unfilled: unknown[];
      }>(t, token, 'plan_week');
      expect(answer.templateSet).toBe(true);
      expect(
        answer.planned.map((p) => `${p.day} ${p.occasion}`).sort(),
      ).toEqual(TEMPLATE_SLOTS);
      expect(answer.unfilled).toEqual([]);
      const retry = await callTool(t, token, 'plan_week');
      expect(retry.value).toMatchObject({ weekPlanId: null, planned: [] });
      expect(await weekEntries()).toHaveLength(8);
      const calendar = await tool<{ entries: { plannedBy: string }[] }>(
        t,
        token,
        'get_calendar',
        { from: TODAY, to: addDays(TODAY, 6) },
      );
      expect(calendar.entries.every((e) => e.plannedBy === 'auto')).toBe(true);
    });
  });

  it('offers "Plan my week" on Today', async () => {
    const today = await get('/');
    expect(today.body).toContain('action="/calendar/plan-week"');
  });
});
