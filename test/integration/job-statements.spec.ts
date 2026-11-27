import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import webpush from 'web-push';
import { retryFailedCutouts } from '../../src/cutout/queue';
import {
  file,
  garmentWear,
  pushReminder,
  weekReplan,
} from '../../src/db/schema';
import { reconcileStorage } from '../../src/maintenance/reconcile';
import { DEFAULT_REMINDER_TIMES } from '../../src/push/reminders';
import { WEEKDAYS } from '../../src/wardrobe/week';
import type { DayForecast } from '../../src/weather/forecast';
import { instantAt, type IsoDate } from '../../src/calendar-date';
import { saveReminderSettings } from '../../src/web/push/queries';
import {
  pruneReminders,
  type ReminderDeps,
  sendDueReminders,
} from '../../src/web/push/reminders';
import { setHome } from '../../src/web/weather/queries';
import {
  refreshForecastsFor,
  type WeatherService,
} from '../../src/web/weather/service';
import { planDays, planMyWeek } from '../../src/web/week-plan/plan';
import {
  pruneReplans,
  REPLAN_HOUR,
  type ReplanDeps,
  replanWeeks,
} from '../../src/web/week-plan/replan';
import { saveWeekTemplate } from '../../src/web/week-plan/template';
import {
  createTestApp,
  PWA_ENV,
  recordQueries,
  subscribeAs,
  type TestApp,
  userIdOf,
  asFixture,
} from './harness';

/**
 * What each background job sends to the database, and how that scales
 * with the people or rows it serves (#173). Production reaches Postgres
 * over a link where every statement is a round trip (homelab #40, #156),
 * so a job that loops per person multiplies it: each count here is pinned
 * for one person (or row) and for three, so a statement that slips back
 * into a loop fails. Every person has a planned week (auto entries), a
 * home with a forecast and one device taking both reminders; web-push's
 * send is stubbed. Behaviour is each job's own spec's (push-reminders,
 * week-plan, cutout-queue, reconcile, order-mail, the latter also pinning
 * the poll's counts).
 */

const TODAY: IsoDate = '2026-10-05';
const WEEK = planDays(TODAY);
const PEOPLE = 3;

/** A dry week at 24 °C: what the weeks were planned with, so the re-plan keeps every entry. */
const FORECAST: DayForecast[] = WEEK.map((day) => ({
  day,
  code: 1,
  high: 24,
  low: 24,
  precipitationChance: 0,
  hours: Array.from({ length: 24 }, (_, hour) => ({
    hour,
    feelsLike: 24,
    precipitationChance: 0,
    code: 1,
  })),
}));

/** Answers FORECAST for any location, without the database. */
const weather: WeatherService = {
  timeZone: 'America/New_York',
  forecastFor: () =>
    Promise.resolve({
      forecast: { timeZone: 'America/New_York', days: FORECAST },
      fetchedAt: new Date(),
    }),
  normalsFor: () => Promise.reject(new Error('No job here reads normals')),
  searchPlaces: () => Promise.resolve([]),
  settled: () => Promise.resolve(),
};

interface Person {
  id: number;
  deviceId: number;
}

describe('background jobs: statements per run (#173)', () => {
  let t: TestApp;
  let people: Person[];
  let replan: ReplanDeps;
  let reminders: ReminderDeps;

  /** A second past `minuteOfDay` on TODAY, in the app's zone. */
  const at = (minuteOfDay: number) =>
    new Date(
      instantAt(
        TODAY,
        Math.floor(minuteOfDay / 60),
        t.timeZone,
        minuteOfDay % 60,
      ).getTime() + 1_000,
    );

  const garmentIn = async (
    cookie: string,
    name: string,
    category: string,
    color: string,
  ) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        name,
        category,
        props: '1',
        formality: '2',
        pattern: 'solid',
        color,
      }).toString(),
    });
    expect(res.statusCode).toBe(302);
  };

  /** A person with a closet, a week planned all day, a home and one device. */
  const person = async (i: number): Promise<Person> => {
    const email = `jobs-${i}@example.com`;
    const cookie = await t.register(email);
    const id = await userIdOf(t, email);
    for (const [n, color] of ['white', 'grey', 'black'].entries()) {
      await garmentIn(cookie, `Tee ${n}`, 'tops', color);
    }
    for (const [n, color] of ['blue', 'beige'].entries()) {
      await garmentIn(cookie, `Trousers ${n}`, 'bottoms', color);
    }
    await garmentIn(cookie, 'Shoes', 'footwear', 'white');
    await saveWeekTemplate(
      t.db,
      id,
      WEEKDAYS.map((weekday) => ({ weekday, occasion: 'all-day' })),
    );
    const planned = await planMyWeek(t.db, id, {
      today: TODAY,
      hour: 0,
      days: WEEK,
      forecast: { days: new Map(FORECAST.map((d) => [d.day, d])), offset: 0 },
    });
    expect(planned.planned.length).toBeGreaterThan(0);
    await setHome(t.db, id, {
      name: 'Fort Greene',
      location: { latitude: 40.69, longitude: -73.98 },
    });
    const endpoint = `https://fcm.googleapis.com/fcm/send/jobs-${i}`;
    const deviceId = await subscribeAs(t.db, id, {
      endpoint,
      keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
    });
    await saveReminderSettings(
      t.db,
      id,
      endpoint,
      {
        morning: DEFAULT_REMINDER_TIMES.morning,
        evening: DEFAULT_REMINDER_TIMES.evening,
        agentRounds: false,
      },
      new Date('2020-01-01T00:00:00Z'),
    );
    return { id, deviceId };
  };

  /** Only `due` are served: the others' day (re-plan) or reminder is claimed already. */
  const serveOnly = async (
    due: readonly Person[],
    kind?: 'morning' | 'evening',
  ) => {
    await t.db.delete(weekReplan);
    await t.db.delete(pushReminder);
    const others = people.filter((p) => !due.includes(p));
    if (others.length === 0) return;
    await t.db
      .insert(weekReplan)
      .values(others.map((p) => ({ userId: p.id, day: TODAY })));
    if (kind) {
      await t.db
        .insert(pushReminder)
        .values(
          others.map((p) => ({ deviceId: p.deviceId, kind, day: TODAY })),
        );
    }
  };

  beforeAll(async () => {
    t = await createTestApp(PWA_ENV);
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date('2026-10-05T12:00:00Z'),
    });
    people = [];
    for (let i = 0; i < PEOPLE; i += 1) people.push(await person(i));
    vi.useRealTimers();
    replan = {
      db: t.db,
      weather,
      push: t.push,
      timeZone: t.timeZone,
      logger: t.logger.child({ logger: 'WeekPlan' }),
    };
    reminders = {
      db: t.db,
      sender: t.push!,
      weather,
      timeZone: t.timeZone,
      logger: t.logger.child({ logger: 'Push' }),
      replan,
    };
  });

  afterAll(() => t?.cleanup());

  beforeEach(() => {
    vi.spyOn(webpush, 'sendNotification').mockResolvedValue({
      statusCode: 201,
      body: '',
      headers: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('the week re-plan', () => {
    // Who is due and everyone's weather, once; then per person one
    // transaction: begin, the owner lock, the auto entries with the day's
    // claim, the week with the pool, the memory and the outfits' garments,
    // commit. It was 2 + 9 per person.
    it.each([
      [1, 7],
      [PEOPLE, 17],
    ])('re-plans %i person(s) in %i statements', async (count, statements) => {
      await serveOnly(people.slice(0, count));
      let run: Awaited<ReturnType<typeof replanWeeks>> | undefined;
      const recorded = await recordQueries(async () => {
        run = await replanWeeks(replan, at(REPLAN_HOUR * 60));
      });
      expect(run).toMatchObject({ claimed: count, swapped: 0, failed: 0 });
      expect(recorded.statements).toBe(statements);
    });

    it('costs one statement once everyone is done today, and one to prune', async () => {
      // Everyone's day claimed already.
      await serveOnly([]);
      const done = await recordQueries(() =>
        replanWeeks(replan, at(REPLAN_HOUR * 60)),
      );
      expect(done.statements).toBe(1);
      const prune = await recordQueries(() => pruneReplans(replan, TODAY));
      expect(prune.statements).toBe(1);
    });
  });

  describe('the reminders', () => {
    const { morning, evening } = DEFAULT_REMINDER_TIMES;

    // The devices, the claim, the mornings' weather and who of them is due
    // a re-plan, and at the end every device to send to: five for the
    // minute. Per person the re-plan's transaction (five) and Today's
    // entries (the day is planned, so no ideas): six. It was 3 + 15.
    it.each([
      [1, 11],
      [PEOPLE, 23],
    ])(
      'sends %i morning reminder(s), each after its re-plan, in %i statements',
      async (count, statements) => {
        await serveOnly(people.slice(0, count), 'morning');
        let run: Awaited<ReturnType<typeof sendDueReminders>> | undefined;
        const recorded = await recordQueries(async () => {
          run = await sendDueReminders(reminders, at(morning));
        });
        expect(run).toMatchObject({ claimed: count, sent: count, failed: 0 });
        expect(webpush.sendNotification).toHaveBeenCalledTimes(count);
        expect(recorded.statements).toBe(statements);
      },
    );

    // The devices, the claim, every evening person's day (worn and the
    // planned entries) in one statement, the devices to send to: four
    // whoever and however many. It was 3 per person, and Today's model
    // (weather and ideas included) for each one not worn.
    it.each([1, PEOPLE])(
      'sends %i evening reminder(s) in four statements',
      async (count) => {
        await serveOnly(people.slice(0, count), 'evening');
        let run: Awaited<ReturnType<typeof sendDueReminders>> | undefined;
        const recorded = await recordQueries(async () => {
          run = await sendDueReminders(reminders, at(evening));
        });
        expect(run).toMatchObject({ claimed: count, sent: count, failed: 0 });
        expect(recorded.statements).toBe(4);
        // The evening names the plan; it reads neither weather nor a pool.
        expect(recorded.sql.join('\n')).not.toMatch(/"user_weather"/);
      },
    );

    it('skips everyone who wore something today in three statements, and sends nothing', async () => {
      await serveOnly(people, 'evening');
      const garmentIds = await t.db.query.garment.findMany({
        columns: { id: true, ownerId: true },
        where: (g, { inArray: within }) =>
          within(
            g.ownerId,
            people.map((p) => p.id),
          ),
      });
      const worn = people.map(
        (p) => garmentIds.find((g) => g.ownerId === p.id)!,
      );
      await asFixture(t.db, (tx) =>
        tx.insert(garmentWear).values(
          worn.map((g) => ({
            garmentId: g.id,
            ownerId: g.ownerId,
            day: TODAY,
          })),
        ),
      );
      try {
        let run: Awaited<ReturnType<typeof sendDueReminders>> | undefined;
        const recorded = await recordQueries(async () => {
          run = await sendDueReminders(reminders, at(evening));
        });
        expect(run).toMatchObject({
          claimed: PEOPLE,
          sent: 0,
          skipped: PEOPLE,
        });
        expect(recorded.statements).toBe(3);
        expect(webpush.sendNotification).not.toHaveBeenCalled();
      } finally {
        await asFixture(t.db, (tx) =>
          tx.delete(garmentWear).where(
            inArray(
              garmentWear.garmentId,
              worn.map((g) => g.id),
            ),
          ),
        );
      }
    });

    it('costs one statement when nothing is due, and one to prune', async () => {
      const idle = await recordQueries(() =>
        sendDueReminders(reminders, at(3 * 60)),
      );
      expect(idle.statements).toBe(1);
      const prune = await recordQueries(() => pruneReminders(reminders, TODAY));
      expect(prune.statements).toBe(1);
    });
  });

  it.each([1, PEOPLE])(
    "refreshes %i person(s)' forecasts in one statement",
    async (count) => {
      const recorded = await recordQueries(() =>
        refreshForecastsFor(
          { db: t.db, weather, logger: t.logger },
          people.slice(0, count).map((p) => p.id),
          at(REPLAN_HOUR * 60),
        ),
      );
      expect(recorded.statements).toBe(1);
    },
  );

  describe('the nightly cutout retry', () => {
    /** `count` photos whose cutout failed once, as rows only (no job runs here). */
    const failed = async (count: number) =>
      count === 0
        ? []
        : asFixture(t.db, (tx) =>
            tx
              .insert(file)
              .values(
                Array.from({ length: count }, () => ({
                  shareableId: randomUUID(),
                  fileName: `${randomUUID()}.jpg`,
                  createdOn: new Date().toISOString(),
                  createdById: people[0].id,
                  cutoutStatus: 'failed' as const,
                  cutoutAttempts: 1,
                })),
              )
              .returning({ id: file.id }),
          );

    // Nothing failed (the usual night): the look alone. Else the look,
    // then one transaction whatever the count: begin, the rows locked, the
    // machine's verdicts in one update, commit. It was 1 + 4 per photo.
    it.each([
      [0, 1],
      [1, 5],
      [PEOPLE, 5],
    ])(
      'requeues %i failed photo(s) in %i statement(s)',
      async (count, statements) => {
        const rows = await failed(count);
        try {
          let requeued: number | undefined;
          const recorded = await recordQueries(async () => {
            requeued = await retryFailedCutouts(t.db, t.logger);
          });
          expect(requeued).toBe(count);
          expect(recorded.statements).toBe(statements);
          if (count > 0) {
            const after = await t.db.query.file.findMany({
              columns: { cutoutStatus: true, cutoutRequestedAt: true },
              where: (f, { inArray: within }) =>
                within(
                  f.id,
                  rows.map((r) => r.id),
                ),
            });
            expect(after.every((r) => r.cutoutStatus === 'pending')).toBe(true);
            expect(after.every((r) => r.cutoutRequestedAt !== null)).toBe(true);
          }
        } finally {
          if (rows.length > 0) {
            await asFixture(t.db, (tx) =>
              tx.delete(file).where(
                inArray(
                  file.id,
                  rows.map((r) => r.id),
                ),
              ),
            );
          }
        }
      },
    );
  });

  // The pending photos, the aged ones' delete and the file table, read
  // whole (production adds the install pairing's row, #833): reconciliation
  // compares storage with every row, so its scans are the job. Per row only
  // for what it finds to delete (orphans, each in its own statement so one
  // bad row cannot cancel the sweep).
  it('reconciles storage in three statements when there is nothing to delete', async () => {
    const recorded = await recordQueries(() =>
      reconcileStorage({
        db: t.db,
        photos: t.photos,
        timeZone: t.timeZone,
        logger: t.logger.child({ logger: 'Reconciliation' }),
      }),
    );
    expect(recorded.statements).toBe(3);
  });
});
