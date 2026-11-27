import { eq } from 'drizzle-orm';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
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
import webpush, { type PushSubscription } from 'web-push';
import { createDb, type Db } from '../../src/db/client';
import { pushReminder, userDevice } from '../../src/db/schema';
import { type MinuteOfDay } from '../../src/push/reminders';
import { addDays, instantAt, type IsoDate } from '../../src/calendar-date';
import { parsePushPayload, type PushPayload } from '../../src/web/push/payload';
import {
  revokeDevices,
  saveReminderSettings,
} from '../../src/web/push/queries';
import {
  JobInterrupted,
  PartialFailure,
} from '../../src/metrics/partial-failure';
import { setHome } from '../../src/web/weather/queries';
import type { WeatherService } from '../../src/web/weather/service';
import {
  type ReminderDeps,
  pruneReminders,
  sendDueReminders,
  sendDueRemindersWhole,
} from '../../src/web/push/reminders';
import { scheduleJob } from '../../src/maintenance/scheduled';
import { waitUnlessAborted } from '../../src/web/abort';
import { createPushSender } from '../../src/web/push/sender';
import { createGarment } from './garments';
import {
  createTestApp,
  PWA_ENV,
  subscribeAs,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { expectFragment, HX_FRAGMENT } from './pages';

/**
 * The push reminders (#15): each device's settings on the profile, and the
 * scheduler's run (sendDueReminders) at pinned instants: the morning
 * "Today's outfit" and the evening "What did you wear?", both linking to
 * Today, the evening one skipped once something is worn; once per device
 * and day, even with two servers claiming at the same moment; the time a
 * wall-clock time on DST days; a device set after its time waits a day.
 * web-push's sendNotification is stubbed: nothing leaves the process, and
 * each call's plaintext payload is what the device would receive.
 */

interface Sent {
  endpoint: string;
  payload: PushPayload;
  ttl: number | undefined;
}

function subscription(endpoint = newEndpoint()) {
  return {
    endpoint,
    keys: {
      p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

function newEndpoint(): string {
  return `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
}

const minute = (hour: number, min = 0): MinuteOfDay => hour * 60 + min;

describe('push reminders', () => {
  let t: TestApp;
  let deps: ReminderDeps;
  let sent: Sent[];

  /** A second past `hour:min` on `day`, in the app's zone. */
  const onTheMinute = (day: IsoDate, hour: number, min = 0) =>
    new Date(instantAt(day, hour, t.timeZone, min).getTime() + 1_000);

  const subscribe = async (cookie?: string) => {
    const sub = subscription();
    const res = await t.inject({
      method: 'POST',
      url: '/push/subscribe',
      payload: sub,
      headers: cookie ? { cookie } : {},
    });
    expect(res.statusCode).toBe(204);
    return sub.endpoint;
  };

  /** Saves a device's reminders as of `setAt` (the route stamps the real now). */
  const remind = (
    userId: number,
    endpoint: string,
    settings: { morning?: MinuteOfDay; evening?: MinuteOfDay },
    setAt = new Date('2020-01-01T00:00:00Z'),
  ) =>
    saveReminderSettings(
      t.db,
      userId,
      endpoint,
      {
        morning: settings.morning ?? null,
        evening: settings.evening ?? null,
        agentRounds: false,
      },
      setAt,
    );

  const sentTo = (endpoint: string) =>
    sent.filter((s) => s.endpoint === endpoint);

  beforeAll(async () => {
    t = await createTestApp(PWA_ENV);
    deps = {
      db: t.db,
      sender: t.push!,
      weather: undefined,
      timeZone: t.timeZone,
      logger: t.logger.child({ logger: 'Push' }),
      // Nobody here has an auto entry: the morning's re-plan first finds
      // nothing (week-plan.spec.ts covers it).
      replan: {
        db: t.db,
        weather: undefined,
        push: t.push,
        timeZone: t.timeZone,
        logger: t.logger.child({ logger: 'WeekPlan' }),
      },
    };
  });

  afterAll(() => t?.cleanup());

  beforeEach(() => {
    sent = [];
    vi.spyOn(webpush, 'sendNotification').mockImplementation(
      (target: PushSubscription, payload, options) => {
        sent.push({
          endpoint: target.endpoint,
          payload: parsePushPayload(JSON.parse(String(payload)))!,
          ttl: options?.TTL,
        });
        return Promise.resolve({ statusCode: 201, body: '', headers: {} });
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never runs in the harness: createApp schedules nothing', () => {
    expect(t.push).toBeDefined();
    expect(
      t.logs.records.some((r) => /Push reminders runs/.test(r.msg ?? '')),
    ).toBe(false);
  });

  describe('the settings, per device', () => {
    const form = (endpoint: string, cookie?: string) =>
      t.inject({
        method: 'POST',
        url: '/push/reminders/form',
        payload: { endpoint },
        headers: { ...HX_FRAGMENT, ...(cookie ? { cookie } : {}) },
      });
    const save = (fields: Record<string, string>, cookie?: string) =>
      t.inject({
        method: 'POST',
        url: '/push/reminders',
        payload: fields,
        headers: { ...HX_FRAGMENT, ...(cookie ? { cookie } : {}) },
      });
    const deviceAt = async (endpoint: string) =>
      (
        await t.db
          .select()
          .from(userDevice)
          .where(eq(userDevice.pushEndpoint, endpoint))
      )[0];

    it('asks to turn notifications on for a device that has none', async () => {
      const res = await form(newEndpoint());
      expect(res.statusCode).toBe(200);
      expectFragment(res);
      expect(res.body).toContain('Turn notifications on for this device');
    });

    it('starts off, and saves a time with its toggle; both are off by default', async () => {
      const endpoint = await subscribe();
      const blank = unescapeHtml((await form(endpoint)).body);
      expect(blank).toContain('hx-post="/push/reminders"');
      // An AutosaveForm: saves go out in order and answer the status line
      // only (src/web/autosave.tsx).
      expect(blank).toContain('hx-sync="closest form:queue last"');
      expect(blank).toContain('hx-target="find [data-autosave-status]"');
      expect(blank).toContain('data-autosave=""');
      // In the slot push.js loads it into, which keeps its id.
      expect(blank).toContain('<div id="push-reminders" data-show="on"');
      expect(blank).toContain(`name="endpoint" value="${endpoint}"`);
      expect(blank).not.toMatch(/name="(morning|evening)On" value="1" checked/);
      // The defaults are selected, ready for the toggle.
      expect(blank).toMatch(/value="450" selected[^>]*>07:30/);

      t.logs.clear();
      const res = await save({
        endpoint,
        morningOn: '1',
        morning: '420',
        evening: '1260',
      });
      expect(res.statusCode).toBe(200);
      // Only the status line: the controls stay as the person left them.
      // A time turned on: it may start tomorrow, and the line says so.
      expect(res.body).toContain(
        'Saved. A time already past today starts tomorrow.',
      );
      expect(res.body).not.toContain('<form');
      // Read again, the form shows what was saved.
      expect(unescapeHtml((await form(endpoint)).body)).toMatch(
        /name="morningOn" value="1" checked/,
      );
      const row = await deviceAt(endpoint);
      expect(row).toMatchObject({
        morningReminder: 420,
        eveningReminder: null,
      });
      expect(row.remindersSetAt).not.toBeNull();
      // Named by device id, never by its endpoint.
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        `User ${t.owner.id} set reminders on push device ${row.id}: morning 420, evening off (minutes after midnight), the agent’s rounds off`,
      );
      expect(t.logs.text()).not.toContain(endpoint);
      // The same times again with the agent's toggle: no time changed, no word
      // about tomorrow.
      const again = await save({
        endpoint,
        morningOn: '1',
        morning: '420',
        evening: '1260',
        agentRoundsOn: '1',
      });
      expect(again.body).toContain('Saved.');
      expect(again.body).not.toContain('starts tomorrow');
    });

    it('keeps the rounds toggle on from a page that still posts museRoundsOn (#1297)', async () => {
      const endpoint = await subscribe();
      const res = await save({ endpoint, museRoundsOn: '1' });
      expect(res.body).toContain('Saved.');
      expect(await deviceAt(endpoint)).toMatchObject({ agentRounds: true });
    });

    it('refuses a time off the choices (400)', async () => {
      const endpoint = await subscribe();
      for (const [kind, value] of [
        ['morning', '425'],
        ['morning', '720'],
        ['evening', '420'],
        ['evening', 'late'],
      ]) {
        const res = await save({ endpoint, [`${kind}On`]: '1', [kind]: value });
        expect(res.statusCode, `${kind} ${value}`).toBe(400);
      }
      expect(await deviceAt(endpoint)).toMatchObject({
        morningReminder: null,
        eveningReminder: null,
      });
    });

    it('never touches another account’s device', async () => {
      const cookie = await t.register('reminders-other@example.com');
      const theirs = await subscribe(cookie);
      const res = await save({
        endpoint: theirs,
        morningOn: '1',
        morning: '450',
      });
      expect(res.body).toContain('Turn notifications on for this device');
      expect(await deviceAt(theirs)).toMatchObject({ morningReminder: null });
      expect((await form(theirs)).body).toContain('Turn notifications on');
    });

    it('turns reminders off when the browser signs in as someone else', async () => {
      const endpoint = await subscribe();
      await save({ endpoint, eveningOn: '1', evening: '1260' });
      // The same subscription, sent again by the owner: kept.
      await t.inject({
        method: 'POST',
        url: '/push/subscribe',
        payload: { ...subscription(endpoint) },
      });
      expect(await deviceAt(endpoint)).toMatchObject({ eveningReminder: 1260 });
      const cookie = await t.register('reminders-next@example.com');
      await t.inject({
        method: 'POST',
        url: '/push/subscribe',
        payload: subscription(endpoint),
        headers: { cookie },
      });
      expect(await deviceAt(endpoint)).toMatchObject({
        userId: await userIdOf(t, 'reminders-next@example.com'),
        morningReminder: null,
        eveningReminder: null,
        remindersSetAt: null,
      });
    });

    it('needs a session (401 to a fetch)', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/push/reminders',
        payload: { endpoint: newEndpoint() },
        headers: HX_FRAGMENT,
        anonymous: true,
      });
      expect(res.statusCode).toBe(401);
    });

    it('Profile › Notifications holds the slot push.js fills once the device is on', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/auth/profile/notifications',
      });
      expect(res.body).toContain('id="push-reminders" data-show="on" hidden');
    });
  });

  describe('a run', () => {
    // A day of its own per test (claims are per day), never today's real
    // one unless the test marks something worn.
    const DAY = '2030-01-15';

    it('sends the morning reminder at its minute, to the devices that chose it, opening Today', async () => {
      const cookie = await t.register('morning@example.com');
      const userId = await userIdOf(t, 'morning@example.com');
      const [phone, laptop] = [
        await subscribe(cookie),
        await subscribe(cookie),
      ];
      await remind(userId, phone, { morning: minute(7, 30) });
      await remind(userId, laptop, { evening: minute(21) });

      // Every device in the database is the run's: assert on these two.
      await sendDueReminders(deps, onTheMinute(DAY, 7, 29));
      expect(sentTo(phone)).toEqual([]);
      const run = await sendDueReminders(deps, onTheMinute(DAY, 7, 30));
      expect(run.failed).toBe(0);
      expect(sentTo(laptop)).toEqual([]);
      expect(sentTo(phone)).toEqual([
        {
          endpoint: phone,
          payload: {
            title: "Today's outfit",
            body: 'Nothing planned yet. Open Today for ideas.',
            url: '/',
            tag: 'today-morning',
          },
          ttl: 3 * 60 * 60,
        },
      ]);
      expect(t.logs.messages('info', 'Push')).toContainEqual(
        expect.stringMatching(
          /^Reminders at 2030-01-15T12:30:01\.000Z: \d+ claimed of \d+ due, \d+ sent, 0 skipped, 0 failed$/,
        ),
      );
    });

    it('goes out once a device and day: the next minutes and a second run find it claimed', async () => {
      const cookie = await t.register('once@example.com');
      const userId = await userIdOf(t, 'once@example.com');
      const phone = await subscribe(cookie);
      await remind(userId, phone, { morning: minute(8) });
      const day = addDays(DAY, 1);
      for (const [hour, min] of [
        [8, 0],
        [8, 0],
        [8, 1],
        [8, 29],
      ]) {
        await sendDueReminders(deps, onTheMinute(day, hour, min));
      }
      expect(sentTo(phone)).toHaveLength(1);
      // The next day, again once.
      await sendDueReminders(deps, onTheMinute(addDays(day, 1), 8));
      expect(sentTo(phone)).toHaveLength(2);
    });

    it('names the day’s plan and, with nothing that dresses the day, the top idea', async () => {
      const cookie = await t.register('planned@example.com');
      const userId = await userIdOf(t, 'planned@example.com');
      const phone = await subscribe(cookie);
      await remind(userId, phone, { morning: minute(7), evening: minute(21) });
      const garments = await Promise.all(
        (['tops', 'bottoms', 'footwear'] as const).map((category) =>
          createGarment(t, { name: `Planned ${category}`, category, cookie }),
        ),
      );
      const outfit = await t.inject({
        method: 'POST',
        url: '/outfits',
        payload: {
          name: 'Dinner',
          category: ['tops', 'bottoms', 'footwear'],
          garmentId: garments.map(String),
        },
        headers: { cookie },
      });
      const outfitId = /\/outfits\/(\d+)/.exec(
        String(outfit.headers.location),
      )![1];
      const day = addDays(DAY, 5);
      await t.inject({
        method: 'POST',
        url: '/calendar',
        payload: { date: day, outfitId, occasion: 'evening' },
        headers: { cookie },
      });

      await sendDueReminders(deps, onTheMinute(day, 7));
      const [morning] = sentTo(phone);
      // Only three garments, all in the saved dinner: no idea to add.
      expect(morning.payload.body).toBe('Evening: Dinner');

      await sendDueReminders(deps, onTheMinute(day, 21));
      expect(sentTo(phone)[1].payload).toEqual({
        title: 'What did you wear?',
        body: 'Planned: Evening: Dinner. Tap to mark what you wore.',
        url: '/',
        tag: 'today-evening',
      });
      expect(sentTo(phone)[1].ttl).toBe(60 * 60);
    });

    it('skips the evening reminder once something is marked worn today', async () => {
      const cookie = await t.register('worn@example.com');
      const userId = await userIdOf(t, 'worn@example.com');
      const phone = await subscribe(cookie);
      await remind(userId, phone, { evening: minute(22) });
      const today = t.today();
      const tee = await createGarment(t, { name: 'Worn tee', cookie });
      // "Wore today" on the garment page counts as much as an entry.
      await t.inject({
        method: 'POST',
        url: `/wardrobe/${tee}/wear`,
        payload: { worn: '1' },
        headers: { cookie },
      });
      t.logs.clear();
      const run = await sendDueReminders(deps, onTheMinute(today, 22));
      expect(run).toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
      expect(sentTo(phone)).toEqual([]);
      expect(t.logs.messages('info', 'Push')).toContain(
        `Evening reminder for user ${userId} skipped: something is marked worn today`,
      );
      // Claimed all the same: undoing the wear later sends nothing today.
      await t.inject({
        method: 'POST',
        url: `/wardrobe/${tee}/wear`,
        payload: { worn: '0' },
        headers: { cookie },
      });
      await sendDueReminders(deps, onTheMinute(today, 22, 5));
      expect(sentTo(phone)).toEqual([]);
    });

    it('waits for tomorrow when the device chose a time already past today', async () => {
      const cookie = await t.register('late@example.com');
      const userId = await userIdOf(t, 'late@example.com');
      const phone = await subscribe(cookie);
      const day = addDays(DAY, 10);
      // Turned on at 08:10 for 08:00.
      await remind(
        userId,
        phone,
        { morning: minute(8) },
        instantAt(day, 8, t.timeZone, 10),
      );
      await sendDueReminders(deps, onTheMinute(day, 8, 10));
      await sendDueReminders(deps, onTheMinute(day, 8, 11));
      expect(sentTo(phone)).toEqual([]);
      await sendDueReminders(deps, onTheMinute(addDays(day, 1), 8));
      expect(sentTo(phone)).toHaveLength(1);
    });

    it('sends at the wall-clock time on both DST days', async () => {
      const cookie = await t.register('dst@example.com');
      const userId = await userIdOf(t, 'dst@example.com');
      const phone = await subscribe(cookie);
      await remind(userId, phone, { morning: minute(7, 30) });
      // 2030's US changes: 10 March (spring forward), 3 November (back).
      for (const [day, early, due] of [
        ['2030-03-10', '2030-03-10T10:30:01Z', '2030-03-10T11:30:01Z'],
        ['2030-11-03', '2030-11-03T11:30:01Z', '2030-11-03T12:30:01Z'],
      ]) {
        const before = sentTo(phone).length;
        expect(onTheMinute(day, 7, 30).toISOString()).toBe(
          new Date(due).toISOString(),
        );
        await sendDueReminders(deps, new Date(early));
        expect(sentTo(phone)).toHaveLength(before);
        await sendDueReminders(deps, new Date(due));
        expect(sentTo(phone)).toHaveLength(before + 1);
      }
    });

    it('two servers running the same minute send each reminder once', async () => {
      // A second server of an overlapping deploy: its own pool and sender.
      const logger = t.logger.child({ logger: 'Push' });
      const other: Db = createDb(t.database, logger);
      const otherDeps: ReminderDeps = {
        ...deps,
        db: other,
        replan: { ...deps.replan, db: other },
        sender: createPushSender({
          db: other,
          logger,
          metrics: t.metrics,
          vapid: {
            subject: PWA_ENV.SITE_URL,
            publicKey: PWA_ENV.PUBLIC_VAPID_KEY,
            privateKey: PWA_ENV.PRIVATE_VAPID_KEY,
          },
        }),
      };
      try {
        const cookie = await t.register('overlap@example.com');
        const userId = await userIdOf(t, 'overlap@example.com');
        const phones = [
          await subscribe(cookie),
          await subscribe(cookie),
          await subscribe(cookie),
        ];
        for (const phone of phones) {
          await remind(userId, phone, {
            morning: minute(6),
            evening: minute(18),
          });
        }
        const start = '2031-02-01';
        for (let n = 0; n < 10; n += 1) {
          const day = addDays(start, n);
          for (const hour of [6, 18]) {
            const now = onTheMinute(day, hour);
            const runs = await Promise.all([
              sendDueReminders(deps, now),
              sendDueReminders(otherDeps, now),
            ]);
            expect(runs[0].claimed + runs[1].claimed).toBe(phones.length);
          }
        }
        for (const phone of phones) {
          expect(sentTo(phone)).toHaveLength(20);
        }
      } finally {
        await other.$client.end();
      }
    });

    it('loses no reminder to a minute a slow run overran: the next run sends it', async () => {
      const cookie = await t.register('overran@example.com');
      const userId = await userIdOf(t, 'overran@example.com');
      const phone = await subscribe(cookie);
      await remind(userId, phone, { morning: minute(9) });
      const day = addDays(DAY, 5);
      await sendDueReminders(deps, onTheMinute(day, 8, 59));
      // 09:00 and 09:01 were skipped (the minutely timer skips a minute a
      // run overran); 09:02's run finds it due and unclaimed.
      await sendDueReminders(deps, onTheMinute(day, 9, 2));
      expect(sentTo(phone)).toHaveLength(1);
      await sendDueReminders(deps, onTheMinute(day, 9, 3));
      expect(sentTo(phone)).toHaveLength(1);
    });

    it("refreshes the morning's forecasts once per place, together, before anyone's reminder reads them", async () => {
      const day = addDays(DAY, 6);
      const people: { userId: number; phone: string }[] = [];
      for (const n of [1, 2, 3]) {
        const email = `batch-${n}@example.com`;
        const cookie = await t.register(email);
        const userId = await userIdOf(t, email);
        const phone = await subscribe(cookie);
        await remind(userId, phone, { morning: minute(6, 15) });
        // People 1 and 2 share a place; 3 lives elsewhere.
        await setHome(t.db, userId, {
          name: `Place ${n}`,
          location: { latitude: n === 3 ? 41 : 40, longitude: -74 },
        });
        people.push({ userId, phone });
      }
      const asked: { latitude: number; fresh: boolean }[] = [];
      const weather: WeatherService = {
        timeZone: 'America/New_York',
        forecastFor: (location, read) => {
          asked.push({
            latitude: location.latitude,
            fresh: read?.fresh ?? false,
          });
          return Promise.resolve(null);
        },
        normalsFor: () => Promise.reject(new Error('never asked')),
        searchPlaces: () => Promise.resolve([]),
        settled: () => Promise.resolve(),
      };
      const run = await sendDueReminders(
        { ...deps, weather, replan: { ...deps.replan, weather } },
        onTheMinute(day, 6, 15),
      );
      expect(run.failed).toBe(0);
      for (const { phone } of people) expect(sentTo(phone)).toHaveLength(1);
      // The batch's fresh reads first, one per place; every later read (each
      // person's weather line) serves what the batch left, never waits.
      const fresh = asked.filter((a) => a.fresh).map((a) => a.latitude);
      expect(fresh.sort()).toEqual([40, 41]);
      expect(asked.slice(0, 2).every((a) => a.fresh)).toBe(true);
      expect(asked.slice(2).some((a) => a.fresh)).toBe(false);
    });

    // The minute's messages are sent in one batch whose devices are read
    // once, after the claim (#173). These wrap the app's real sender to act
    // in that window: between the claim and that read.
    const senderThat = (
      before: () => Promise<void>,
    ): ReminderDeps['sender'] => ({
      ...t.push!,
      sendEach: async (messages) => {
        await before();
        return t.push!.sendEach(messages);
      },
    });

    const twoMorningPeople = async (tag: string) => {
      const phones: string[] = [];
      for (const n of [1, 2]) {
        const email = `${tag}-${n}@example.com`;
        const cookie = await t.register(email);
        const userId = await userIdOf(t, email);
        const phone = await subscribe(cookie);
        await remind(userId, phone, { morning: minute(6, 15) });
        phones.push(phone);
      }
      return phones;
    };

    it('a batch whose devices cannot be read ends the scheduled run as one recorded failure, claims given back (#687)', async () => {
      const day = addDays(DAY, 30);
      const phones = await twoMorningPeople('send-down');
      const down = senderThat(() =>
        Promise.reject(new Error('Connection terminated unexpectedly')),
      );
      const scheduled = t.metrics.timeJob('reminders', (now: Date) =>
        sendDueRemindersWhole({ ...deps, sender: down }, now),
      );

      const failure = await scheduled(onTheMinute(day, 6, 15)).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PartialFailure);
      expect(failure).toMatchObject({ job: 'reminders' });
      // Everyone due this minute (earlier specs' devices too), people-many.
      expect((failure as PartialFailure).counts.failed).toBeGreaterThanOrEqual(
        2,
      );
      expect(phones.flatMap(sentTo)).toEqual([]);
      const { body } = await t.metrics.exposition();
      expect(body).toMatch(
        /^job_duration_seconds_count\{name="reminders",outcome="failure"\} 1$/m,
      );

      // The next minute sends both, and ends as a success.
      await t.metrics.timeJob('reminders', (now: Date) =>
        sendDueRemindersWhole(deps, now),
      )(onTheMinute(day, 6, 16));
      expect(phones.flatMap(sentTo)).toHaveLength(2);
      expect((await t.metrics.exposition()).body).toMatch(
        /^job_duration_seconds_count\{name="reminders",outcome="success"\} 1$/m,
      );
    });

    it("one person's refused send fails the run once and the other's reminder is sent (#687)", async () => {
      const day = addDays(DAY, 32);
      const [refused, fine] = await twoMorningPeople('refused');
      const record = vi
        .mocked(webpush.sendNotification)
        .getMockImplementation()!;
      vi.mocked(webpush.sendNotification).mockImplementation(
        (target, payload, options) =>
          target.endpoint === refused
            ? Promise.reject(new Error('push service answered 500'))
            : record(target, payload, options),
      );
      const failures = async () =>
        Number(
          /^job_duration_seconds_count\{name="reminders",outcome="failure"\} (\d+)$/m.exec(
            (await t.metrics.exposition()).body,
          )?.[1] ?? 0,
        );
      const before = await failures();
      const scheduled = t.metrics.timeJob('reminders', (now: Date) =>
        sendDueRemindersWhole(deps, now),
      );

      const failure = await scheduled(onTheMinute(day, 6, 15)).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PartialFailure);
      expect(failure).toMatchObject({
        job: 'reminders',
        counts: { failed: 1 },
      });
      expect(sentTo(refused)).toEqual([]);
      expect(sentTo(fine)).toHaveLength(1);
      expect(await failures()).toBe(before + 1);
    });

    it("a stop that gives up on a send still out gives back that reminder's claim, never the sent one's (#696)", async () => {
      const day = addDays(DAY, 33);
      const [held, fine] = await twoMorningPeople('shutdown');
      const record = vi
        .mocked(webpush.sendNotification)
        .getMockImplementation()!;
      let sendStarted!: () => void;
      const started = new Promise<void>((resolve) => (sendStarted = resolve));
      let letGo!: () => void;
      const hold = new Promise<void>((resolve) => (letGo = resolve));
      vi.mocked(webpush.sendNotification).mockImplementation(
        async (target, payload, options) => {
          if (target.endpoint !== held) return record(target, payload, options);
          sendStarted();
          await hold;
          throw new Error('socket closed');
        },
      );
      const claimed = async (endpoint: string) => {
        const [device] = await t.db
          .select({ id: userDevice.id })
          .from(userDevice)
          .where(eq(userDevice.pushEndpoint, endpoint));
        return (
          await t.db
            .select()
            .from(pushReminder)
            .where(eq(pushReminder.deviceId, device.id))
        ).filter((row) => row.day === day);
      };

      const job = scheduleJob({
        name: 'Push reminders',
        logger: deps.logger,
        now: () => onTheMinute(day, 6, 15),
        untilNext: () => 0,
        run: (signal) =>
          sendDueReminders(deps, onTheMinute(day, 6, 15), signal),
      });
      await started;
      expect(await claimed(held)).toHaveLength(1);

      // The send never settles: stop waits out its bound, aborts the run,
      // and the run puts the unsent claim back inside the grace.
      await job.stop();
      expect(await claimed(held)).toEqual([]);
      expect(await claimed(fine)).toHaveLength(1);
      expect(sentTo(fine)).toHaveLength(1);

      // The next minute's run finds the given-back reminder due and sends it.
      vi.mocked(webpush.sendNotification).mockImplementation(record);
      letGo();
      await sendDueReminders(deps, onTheMinute(day, 6, 16));
      expect(sentTo(held)).toHaveLength(1);
    }, 15_000);

    const claimsOn = async (endpoint: string, day: IsoDate) => {
      const [device] = await t.db
        .select({ id: userDevice.id })
        .from(userDevice)
        .where(eq(userDevice.pushEndpoint, endpoint));
      return (
        await t.db
          .select()
          .from(pushReminder)
          .where(eq(pushReminder.deviceId, device.id))
      ).filter((row) => row.day === day);
    };

    it('a stop while the run is still composing cancels the forecast wait, gives every claim back, sends nothing and ends interrupted (#914, #920)', async () => {
      const day = addDays(DAY, 40);
      const email = 'composing@example.com';
      const cookie = await t.register(email);
      const userId = await userIdOf(t, email);
      const phone = await subscribe(cookie);
      await remind(userId, phone, { morning: minute(6, 15) });
      await setHome(t.db, userId, {
        name: 'Held',
        location: { latitude: 42, longitude: -74 },
      });
      let fetchStarted!: () => void;
      const started = new Promise<void>((resolve) => (fetchStarted = resolve));
      let letGo!: () => void;
      const hold = new Promise<void>((resolve) => (letGo = resolve));
      // Held as the real cache holds a refresh: the ask stops waiting at
      // the run's abort (ReadOptions.signal), the fetch is the cache's.
      const weather: WeatherService = {
        timeZone: 'America/New_York',
        forecastFor: (_location, read) => {
          fetchStarted();
          return waitUnlessAborted(
            hold.then(() => null),
            read?.signal,
          );
        },
        normalsFor: () => Promise.reject(new Error('never asked')),
        searchPlaces: () => Promise.resolve([]),
        settled: () => Promise.resolve(),
      };
      const at = onTheMinute(day, 6, 15);
      const held = { ...deps, weather, replan: { ...deps.replan, weather } };
      let running: Promise<unknown> | undefined;
      const timed = t.metrics.timeJob('reminders', (signal: AbortSignal) =>
        sendDueRemindersWhole(held, at, signal),
      );
      const job = scheduleJob({
        name: 'Push reminders',
        logger: deps.logger,
        now: () => at,
        untilNext: () => 0,
        run: (signal) => (running = timed(signal)),
      });
      await started;
      expect(await claimsOn(phone, day)).toHaveLength(1);

      await job.stop();
      // Settled, not abandoned: nothing of it runs on into the next run.
      await expect(running).rejects.toBeInstanceOf(JobInterrupted);
      expect(await claimsOn(phone, day)).toEqual([]);
      expect(sentTo(phone)).toEqual([]);
      const { body } = await t.metrics.exposition();
      expect(body).toMatch(
        /^job_duration_seconds_count\{name="reminders",outcome="interrupted"\} 1$/m,
      );

      letGo();
      await sendDueReminders(deps, onTheMinute(day, 6, 16));
      expect(sentTo(phone)).toHaveLength(1);
    }, 15_000);

    it('a run aborted before its send starts sends nothing and gives every claim back (#914)', async () => {
      const day = addDays(DAY, 41);
      const email = 'before-send@example.com';
      const cookie = await t.register(email);
      const userId = await userIdOf(t, email);
      const phone = await subscribe(cookie);
      await remind(userId, phone, { evening: minute(22) });
      const sendEach = vi.fn<ReminderDeps['sender']['sendEach']>(
        (messages, options) => t.push!.sendEach(messages, options),
      );
      const watched = { ...deps, sender: { ...t.push!, sendEach } };
      const stop = new AbortController();
      stop.abort();

      const failure = await sendDueRemindersWhole(
        watched,
        onTheMinute(day, 22),
        stop.signal,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(JobInterrupted);
      expect(sendEach).not.toHaveBeenCalled();
      expect(sentTo(phone)).toEqual([]);
      expect(await claimsOn(phone, day)).toEqual([]);

      await sendDueReminders(deps, onTheMinute(day, 22, 1));
      expect(sentTo(phone)).toHaveLength(1);
    });

    it('a shutdown whose give-back fails is a failure, captured once, never interrupted (#920)', async () => {
      const day = addDays(DAY, 42);
      const email = 'give-back-down@example.com';
      const cookie = await t.register(email);
      const userId = await userIdOf(t, email);
      const phone = await subscribe(cookie);
      await remind(userId, phone, { evening: minute(21, 30) });
      const releaseClaims = vi.fn<NonNullable<ReminderDeps['releaseClaims']>>(
        () => Promise.reject(new Error('Connection terminated unexpectedly')),
      );
      const capture = vi.spyOn(t.errors, 'captureException');
      const outcomes = async (outcome: string) =>
        Number(
          new RegExp(
            `^job_duration_seconds_count\\{name="reminders",outcome="${outcome}"\\} (\\d+)$`,
            'm',
          ).exec((await t.metrics.exposition()).body)?.[1] ?? 0,
        );
      const [failures, interruptions] = [
        await outcomes('failure'),
        await outcomes('interrupted'),
      ];
      const stop = new AbortController();
      stop.abort();

      const failure = await t.metrics
        .timeJob('reminders', (now: Date) =>
          sendDueRemindersWhole({ ...deps, releaseClaims }, now, stop.signal),
        )(onTheMinute(day, 21, 30))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PartialFailure);
      expect(failure).toMatchObject({ counts: { lost: 1 } });
      expect(releaseClaims).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(await outcomes('failure')).toBe(failures + 1);
      expect(await outcomes('interrupted')).toBe(interruptions);
      // The claim stayed: that reminder is lost, as the failure says.
      expect(await claimsOn(phone, day)).toHaveLength(1);
      expect(sentTo(phone)).toEqual([]);
    });

    it('a forecast fetch that fails with nothing cached is no forecast, not a failed reminder (#687)', async () => {
      const day = addDays(DAY, 31);
      const [phone] = await twoMorningPeople('blip');
      const email = 'blip-1@example.com';
      await setHome(t.db, await userIdOf(t, email), {
        name: 'Nowhere',
        location: { latitude: 13, longitude: -74 },
      });
      const weather: WeatherService = {
        timeZone: 'America/New_York',
        forecastFor: () => Promise.reject(new Error('Open-Meteo down')),
        normalsFor: () => Promise.reject(new Error('never asked')),
        searchPlaces: () => Promise.resolve([]),
        settled: () => Promise.resolve(),
      };
      const run = await sendDueRemindersWhole(
        { ...deps, weather },
        onTheMinute(day, 6, 15),
      );
      expect(run.failed).toBe(0);
      expect(sentTo(phone)).toHaveLength(1);
    });

    it('gives back the claims when the batch cannot read its devices, and the next run sends them', async () => {
      const cookie = await t.register('release@example.com');
      const userId = await userIdOf(t, 'release@example.com');
      const phone = await subscribe(cookie);
      await remind(userId, phone, { morning: minute(10, 45) });
      const day = addDays(DAY, 20);
      let failures = 0;
      const flaky = senderThat(() => {
        if (failures > 0) return Promise.resolve();
        failures += 1;
        return Promise.reject(new Error('Connection terminated unexpectedly'));
      });
      t.logs.clear();

      const failed = await sendDueReminders(
        { ...deps, sender: flaky },
        onTheMinute(day, 10, 45),
      );
      expect(failed).toMatchObject({ failed: failed.claimed, sent: 0 });
      expect(failed.released).toBe(failed.claimed);
      expect(sentTo(phone)).toEqual([]);
      const [device] = await t.db
        .select({ id: userDevice.id })
        .from(userDevice)
        .where(eq(userDevice.pushEndpoint, phone));
      expect(
        await t.db.$count(pushReminder, eq(pushReminder.deviceId, device.id)),
      ).toBe(0);
      expect(t.logs.messages('warn', 'Push')).toContainEqual(
        expect.stringMatching(/^Released \d+ reminder claim\(s\)/),
      );

      // The next minute finds it due and unclaimed, and it goes out, once.
      const next = await sendDueReminders(
        { ...deps, sender: flaky },
        onTheMinute(day, 10, 46),
      );
      expect(next.failed).toBe(0);
      expect(sentTo(phone)).toHaveLength(1);
      await sendDueReminders(deps, onTheMinute(day, 10, 47));
      expect(sentTo(phone)).toHaveLength(1);
    });

    it('sends nothing to a device signed in as someone else between the claim and the send', async () => {
      const cookie = await t.register('moved-from@example.com');
      const userId = await userIdOf(t, 'moved-from@example.com');
      await t.register('moved-to@example.com');
      const otherId = await userIdOf(t, 'moved-to@example.com');
      const phone = await subscribe(cookie);
      await remind(userId, phone, { evening: minute(22, 15) });
      const day = addDays(DAY, 21);
      // The same browser signs in as the other account: its row moves
      // (upsertDevice), its reminders cleared.
      const moving = senderThat(async () => {
        await subscribeAs(t.db, otherId, subscription(phone));
      });

      const run = await sendDueReminders(
        { ...deps, sender: moving },
        onTheMinute(day, 22, 15),
      );
      // Claimed and composed (the message went to the send), yet no device
      // of this user was left to receive it.
      expect(run).toMatchObject({ failed: 0, skipped: 0 });
      expect(run.sent).toBeGreaterThan(0);
      expect(sentTo(phone)).toEqual([]);
      const [row] = await t.db
        .select({ userId: userDevice.userId })
        .from(userDevice)
        .where(eq(userDevice.pushEndpoint, phone));
      expect(row.userId).toBe(otherId);
    });

    it('sends nothing to a device revoked between the claim and the send', async () => {
      const cookie = await t.register('revoked@example.com');
      const userId = await userIdOf(t, 'revoked@example.com');
      const phone = await subscribe(cookie);
      await remind(userId, phone, { evening: minute(22, 45) });
      const day = addDays(DAY, 22);
      // A new password (or push:revoke-all) removes the account's devices.
      const revoking = senderThat(async () => {
        await revokeDevices(t.db, userId);
      });

      const run = await sendDueReminders(
        { ...deps, sender: revoking },
        onTheMinute(day, 22, 45),
      );
      expect(run).toMatchObject({ failed: 0, skipped: 0 });
      expect(run.sent).toBeGreaterThan(0);
      expect(sentTo(phone)).toEqual([]);
      expect(
        await t.db.$count(userDevice, eq(userDevice.pushEndpoint, phone)),
      ).toBe(0);
    });

    it('prunes the claims of past days', async () => {
      const before = await t.db.$count(pushReminder);
      expect(before).toBeGreaterThan(0);
      await pruneReminders(deps, '2100-01-01');
      expect(await t.db.$count(pushReminder)).toBe(0);
      expect(t.logs.messages('info', 'Push')).toContain(
        `Pruned ${before} reminder claim(s) before 2100-01-01`,
      );
    });
  });
});
