import { and, between, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  garment,
  garmentWear,
  outfitCalendar,
  personalAccessToken,
  weekPlanEntry,
} from '../../src/db/schema';
import { addDays, dateParts, type IsoDate } from '../../src/calendar-date';
import { dayOfStamp, dayText } from '../../src/page-day';
import { setTripDestination } from '../../src/web/trips/queries';
import { dayColumns } from './calendar-page';
import { createGarment, createWishlistItem } from './garments';
import {
  createTestApp,
  OWNER_EMAIL,
  type TestApp,
  unescapeHtml,
  userIdOf,
  asFixture,
} from './harness';
import { deviceToken, expectProblem } from './api';
import { createAccessToken, callTool, mintToken, tool } from './mcp';
import { mirrorPhoto, postSelfie } from './selfies';

/**
 * "Today" at the hours where the household's date and UTC's disagree, with
 * the clock pinned there: every route and tool that asks what day it is
 * must answer with APP_TIMEZONE's date. main went red at 00:01 UTC on
 * Sunday 27 Sep 2026, 20:01 on Saturday in New York, because a spec's
 * fixture planned its entry on UTC's Sunday: next week's page, and a day
 * the worn pill refuses (409). These instants fail any UTC "today", in the
 * app or in a spec, on every run instead of an hour a day.
 *
 * Expectations are written out, not computed with todayIn(), so the spec
 * checks the helper as well as its callers. Only Date is faked (timers,
 * the database driver and the rate limits keep running); the owner signs
 * in again under the pinned clock, since a session issued at the real time
 * may not be valid at a pinned one.
 */

interface Instant {
  at: string;
  why: string;
  /** The household's date at `at`, and the Sunday its week starts on. */
  today: IsoDate;
  week: IsoDate;
  /** `today` as the app writes a date (`dateLabel`): no year in its own year. */
  label: string;
}

const ZONES: { zone: string; instants: Instant[] }[] = [
  {
    zone: 'America/New_York',
    instants: [
      {
        at: '2026-09-27T00:30:00Z',
        why: "Sunday in UTC, Saturday evening in New York (main's red run)",
        today: '2026-09-26',
        week: '2026-09-20',
        label: 'Sat, Sep 26',
      },
      {
        at: '2026-10-01T00:30:00Z',
        why: 'UTC midnight on a month boundary: 1 Oct in UTC, 30 Sep in New York',
        today: '2026-09-30',
        week: '2026-09-27',
        label: 'Wed, Sep 30',
      },
      {
        at: '2026-11-01T03:30:00Z',
        why: 'a new month and week in UTC, Halloween night in New York, on the day DST ends',
        today: '2026-10-31',
        week: '2026-10-25',
        label: 'Sat, Oct 31',
      },
      {
        at: '2027-01-01T04:30:00Z',
        why: "New Year's Day in UTC, New Year's Eve in New York",
        today: '2026-12-31',
        week: '2026-12-27',
        label: 'Thu, Dec 31',
      },
    ],
  },
  {
    // Ahead of UTC: the household is already in a day and week UTC has not
    // reached, so a UTC today would refuse the household's own today.
    zone: 'Pacific/Auckland',
    instants: [
      {
        at: '2026-09-26T12:30:00Z',
        why: 'Saturday in UTC, just past midnight on Sunday in Auckland',
        today: '2026-09-27',
        week: '2026-09-27',
        label: 'Sun, Sep 27',
      },
    ],
  },
];

describe.each(ZONES)('"today" in $zone', ({ zone, instants }) => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ APP_TIMEZONE: zone });
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  describe.each(instants)('at $at: $why', ({ at, today, week, label }) => {
    let cookie: string;
    const tomorrow = addDays(today, 1);

    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(at) });
      cookie = await t.login(OWNER_EMAIL);
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    const get = (url: string) =>
      t.inject({ method: 'GET', url, headers: { cookie } });
    const post = (
      url: string,
      payload: Record<string, string | string[]> = {},
    ) => t.inject({ method: 'POST', url, payload, headers: { cookie } });

    /** An outfit of one new garment; the ids of both. */
    const newOutfit = async (name: string) => {
      const garmentId = await createGarment(t, { name, cookie });
      const res = await post('/outfits', {
        name,
        category: 'shirt',
        garmentId: String(garmentId),
      });
      expect(res.statusCode).toBe(302);
      const outfitId = Number(
        /^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1],
      );
      return { garmentId, outfitId };
    };

    /** Plans the outfit on `day` through POST /calendar; the entry's id. */
    const plan = async (outfitId: number, day: IsoDate) => {
      const res = await post('/calendar', {
        date: day,
        outfitId: String(outfitId),
      });
      expect(res.statusCode).toBe(302);
      const [entry] = await t.db
        .select({ id: outfitCalendar.id })
        .from(outfitCalendar)
        .where(
          and(
            eq(outfitCalendar.outfitId, outfitId),
            eq(outfitCalendar.day, day),
          ),
        );
      return entry.id;
    };

    const wearDays = (garmentId: number) =>
      t.db
        .select({ day: garmentWear.day })
        .from(garmentWear)
        .where(eq(garmentWear.garmentId, garmentId));

    const lastWashedOn = async (garmentId: number) => {
      const [row] = await t.db
        .select({ day: garment.lastWashedOn })
        .from(garment)
        .where(eq(garment.id, garmentId));
      return row.day;
    };

    it("the harness's t.today() is the household's date", () => {
      expect(t.today()).toBe(today);
    });

    it("/calendar opens today's week, highlights today and offers today's pill", async () => {
      const { outfitId } = await newOutfit(`Calendar ${at}`);
      const entry = await plan(outfitId, today);

      const res = await get('/calendar');
      expect(res.statusCode).toBe(200);
      const html = unescapeHtml(res.body);
      const columns = dayColumns(html);
      expect([...columns.keys()]).toEqual(
        [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(week, i)),
      );
      // The week strip marks today, and today's block says so.
      expect(html).toMatch(
        new RegExp(
          `href="#day-${today}"[^>]*aria-current="date"[^>]*>[\\s\\S]*?>\\s*${dateParts(today).day}\\s*<`,
        ),
      );
      expect(html.match(/aria-current="date"/g)).toHaveLength(1);
      const column = columns.get(today)!;
      expect(column).toContain(`/styling?outfit=${outfitId}&returnTo=`);
      expect(column).toContain(`/calendar/${entry}/worn`);
    });

    it('the plan page plans today when no day is given', async () => {
      const res = await get('/calendar/plan');
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(`name="date" value="${today}"`);
    });

    it('"Bought it" prefills today as the purchase day', async () => {
      const item = await createWishlistItem(t, {
        name: `Wishlist ${at}`,
        cookie,
      });
      const res = await get(`/wardrobe/${item}/bought`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(
        new RegExp(`name="acquiredOn"[^>]*value="${today}"`),
      );
    });

    it("today's entry can be marked worn, tomorrow's cannot (409)", async () => {
      const { garmentId, outfitId } = await newOutfit(`Worn ${at}`);
      const worn = await post(`/calendar/${await plan(outfitId, today)}/worn`, {
        worn: '1',
      });
      expect(worn.statusCode).toBe(303);
      expect(await wearDays(garmentId)).toEqual([{ day: today }]);

      const ahead = await post(
        `/calendar/${await plan(outfitId, tomorrow)}/worn`,
        { worn: '1' },
      );
      expect(ahead.statusCode).toBe(409);
      expect(await wearDays(garmentId)).toEqual([{ day: today }]);
    });

    it("a selfie can be taken for today's entry, not tomorrow's (409), and wears today (#19)", async () => {
      const { garmentId, outfitId } = await newOutfit(`Selfie ${at}`);
      const photo = { data: await mirrorPhoto() };
      const taken = await postSelfie(t, await plan(outfitId, today), photo, {
        cookie,
      });
      expect(taken.statusCode).toBe(303);
      expect(taken.headers.location).toBe(`/calendar?week=${today}`);
      expect(await wearDays(garmentId)).toEqual([{ day: today }]);

      const ahead = await postSelfie(t, await plan(outfitId, tomorrow), photo, {
        cookie,
      });
      expect(ahead.statusCode).toBe(409);
      expect(await wearDays(garmentId)).toEqual([{ day: today }]);
    });

    it('Wore today, Washed and the laundry batch record today', async () => {
      const worn = await createGarment(t, { name: `Wore ${at}`, cookie });
      expect(
        (await post(`/wardrobe/${worn}/wear`, { worn: '1' })).statusCode,
      ).toBe(303);
      expect(await wearDays(worn)).toEqual([{ day: today }]);

      expect((await post(`/wardrobe/${worn}/washed`)).statusCode).toBe(303);
      expect(await lastWashedOn(worn)).toBe(today);

      const hamper = await createGarment(t, { name: `Hamper ${at}`, cookie });
      expect(
        (await post('/laundry', { ids: [String(hamper)] })).statusCode,
      ).toBe(303);
      expect(await lastWashedOn(hamper)).toBe(today);
    });

    // The page's script words it against the copy's stamp (#708,
    // src/page-day.ts): the household's date of that instant, not UTC's.
    it("the garment page's acquired date reads in the stamp's household year, without the year", async () => {
      const id = await createGarment(t, { name: `Acquired ${at}`, cookie });
      await asFixture(t.db, (tx) =>
        tx.update(garment).set({ acquiredOn: today }).where(eq(garment.id, id)),
      );
      const page = unescapeHtml((await get(`/wardrobe/${id}`)).body);
      expect(page).toContain(
        `<time datetime="${today}" data-day-label="date">`,
      );
      const pageDay = dayOfStamp(String(Date.now()), t.timeZone);
      expect(pageDay).toBe(today);
      expect(dayText(today, pageDay!, 'date', 'en')).toBe(label);
    });

    it('insights count days from today: a wear today was 0 days ago', async () => {
      const worn = await createGarment(t, { name: `Insight ${at}`, cookie });
      expect(
        (await post(`/wardrobe/${worn}/wear`, { worn: '1' })).statusCode,
      ).toBe(303);
      const token = await createAccessToken(t, {
        cookie,
        name: `Insights ${at}`,
      });
      const stats = await tool<{
        today: IsoDate;
        unworn: { garments: { id: number }[] };
      }>(t, token, 'wardrobe_stats', { unwornDays: 30 });
      expect(stats.today).toBe(today);
      expect(stats.unworn.garments.map((g) => g.id)).not.toContain(worn);
      // The page, whose "last worn" reads against the same today.
      const page = await get('/wardrobe/insights');
      expect(page.statusCode).toBe(200);
    });

    it("the year in review (#26) is the household's year, run to today", async () => {
      // On New Year's Eve in New York the year is still the old one, though
      // UTC is in January.
      const page = await get('/wardrobe/recap');
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain(`data-year="${today.slice(0, 4)}"`);
      expect(page.body).toContain(`data-to="${today}"`);
    });

    it("the API's insights and year in review (#588) count to today, the household's", async () => {
      const worn = await createGarment(t, {
        name: `API insight ${at}`,
        cookie,
      });
      expect(
        (await post(`/wardrobe/${worn}/wear`, { worn: '1' })).statusCode,
      ).toBe(303);
      const { token } = await deviceToken(t);
      const insights = await t.api(token, {
        method: 'GET',
        url: '/api/v1/insights?unwornDays=30',
      });
      expect(insights.statusCode, insights.body).toBe(200);
      const model = insights.json<{
        today: IsoDate;
        unworn: { garments: { id: number }[] };
      }>();
      expect(model.today).toBe(today);
      expect(model.unworn.garments.map((g) => g.id)).not.toContain(worn);
      const year = Number(today.slice(0, 4));
      const recap = await t.api(token, {
        method: 'GET',
        url: '/api/v1/insights/recap',
      });
      expect(recap.json()).toMatchObject({
        year,
        from: `${year}-01-01`,
        to: today,
        complete: false,
      });
      // Data, not the page's navigation state: next year is a 400.
      expectProblem(
        await t.api(token, {
          method: 'GET',
          url: `/api/v1/insights/recap?year=${year + 1}`,
        }),
        400,
        'validation',
      );
    });

    it('GET /api/v1/me (#530) answers the household day', async () => {
      const { token } = await deviceToken(t);
      const res = await t.api(token, { method: 'GET', url: '/api/v1/me' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ today: IsoDate }>().today).toBe(today);
    });

    it("GET /api/v1/today (#195a) is the household's day and its plan", async () => {
      const { token } = await deviceToken(t);
      const { outfitId } = await newOutfit(`API today ${at}`);
      const entry = await plan(outfitId, today);
      await plan(outfitId, tomorrow);
      const res = await t.api(token, { method: 'GET', url: '/api/v1/today' });
      expect(res.statusCode, res.body).toBe(200);
      const model = res.json<{
        today: IsoDate;
        rows: { entries?: { id: number; day: IsoDate }[] }[];
      }>();
      expect(model.today).toBe(today);
      const entries = model.rows.flatMap((row) => row.entries ?? []);
      expect(entries).toContainEqual(
        expect.objectContaining({ id: entry, day: today }),
      );
      expect(entries.every((e) => e.day === today)).toBe(true);
    });

    it("the API's calendar (#193b): this week from today, today's entry worn and tomorrow's refused, Wear this today, the week planned from today", async () => {
      const { token } = await deviceToken(t);
      const api = (
        method: 'GET' | 'POST' | 'PUT',
        url: string,
        payload?: object,
      ) => t.api(token, { method, url: `/api/v1${url}`, payload });
      const { outfitId } = await newOutfit(`API ${at}`);
      const entry = await plan(outfitId, today);
      const ahead = await plan(outfitId, tomorrow);

      expect((await api('GET', '/calendar-entries')).json()).toMatchObject({
        from: today,
        to: addDays(today, 6),
      });
      expect(
        (await api('PUT', `/calendar-entries/${entry}/worn`, { worn: true }))
          .statusCode,
      ).toBe(200);
      expect(
        (await api('PUT', `/calendar-entries/${ahead}/worn`, { worn: true }))
          .statusCode,
      ).toBe(409);

      const top = await createGarment(t, { name: `API wear ${at}`, cookie });
      const wear = (day: IsoDate) =>
        api('POST', '/outfit-wears', {
          garmentIds: [top],
          occasion: 'evening',
          day,
        });
      expect((await wear(tomorrow)).statusCode).toBe(409);
      expect((await wear(today)).statusCode).toBe(200);
      expect(await wearDays(top)).toEqual([{ day: today }]);

      // As someone with no week template: the owner's slots stay for the
      // "Plan my week" row of a later instant (one app per zone).
      const email = `api-week-${at.replace(/\W/g, '')}@example.com`;
      await t.register(email);
      const planner = (await deviceToken(t, { email })).token;
      const planned = await t.api(planner, {
        method: 'POST',
        url: '/api/v1/week-plans',
      });
      expect(planned.json<{ from: IsoDate }>().from).toBe(today);
    });

    it('MCP: get_calendar starts today; mark_worn and mark_washed record today', async () => {
      const token = await createAccessToken(t, {
        cookie,
        name: `Today ${at}`,
      });
      const { garmentId, outfitId } = await newOutfit(`MCP ${at}`);
      const entry = await plan(outfitId, today);
      const ahead = await plan(outfitId, tomorrow);

      const calendar = await tool<{
        today: IsoDate;
        from: IsoDate;
        to: IsoDate;
      }>(t, token, 'get_calendar');
      expect(calendar).toMatchObject({
        today,
        from: today,
        to: addDays(today, 6),
      });

      await tool(t, token, 'mark_worn', { entryId: entry });
      expect(await wearDays(garmentId)).toEqual([{ day: today }]);
      expect(
        (await callTool(t, token, 'mark_worn', { entryId: ahead })).isError,
      ).toBe(true);

      const single = await createGarment(t, { name: `MCP wore ${at}`, cookie });
      expect(await tool(t, token, 'mark_worn', { garmentId: single })).toEqual({
        garmentId: single,
        day: today,
      });
      expect(await wearDays(single)).toEqual([{ day: today }]);

      expect(
        await tool(t, token, 'mark_washed', { garmentIds: [single] }),
      ).toEqual({ washed: [single], day: today });
      expect(await lastWashedOn(single)).toBe(today);
    });

    it('the gallery dresses for today, and counts a garment worn today as rested 0 days', async () => {
      const [, , boots] = await Promise.all(
        (['tops', 'bottoms', 'footwear'] as const).map((category) =>
          createGarment(t, {
            name: `Gallery ${category} ${at}`,
            category,
            cookie,
          }),
        ),
      );
      // Boots never need a wash: worn today, still drawn.
      expect(
        (await post(`/wardrobe/${boots}/wear`, { worn: '1' })).statusCode,
      ).toBe(303);
      const token = await createAccessToken(t, {
        cookie,
        name: `Gallery ${at}`,
      });
      const ideas = await tool<{
        day: IsoDate;
        ideas: { garments: { id: number; daysUnworn: number | null }[] }[];
      }>(t, token, 'suggest_outfits', { withGarmentId: boots, limit: 12 });
      expect(ideas.day).toBe(today);
      const worn = ideas.ideas
        .flatMap((idea) => idea.garments)
        .find((g) => g.id === boots);
      expect(worn?.daysUnworn).toBe(0);
      expect((await get('/outfits/ideas')).statusCode).toBe(200);
    });

    it('Today (#15) is today: its plan, and "Wear this" plans and wears today', async () => {
      const { outfitId } = await newOutfit(`Today ${at}`);
      const entry = await plan(outfitId, today);
      await plan(outfitId, tomorrow);
      const page = unescapeHtml((await get('/')).body);
      expect(page).toContain(`data-entry="${entry}"`);
      expect(page).toContain(`/calendar/plan?for=day:${today}`);

      const [top, bottom] = await Promise.all(
        (['tops', 'bottoms'] as const).map((category) =>
          createGarment(t, {
            name: `Wear ${category} ${at}`,
            category,
            cookie,
          }),
        ),
      );
      const wear = await post('/today/wear', {
        garmentId: [String(top), String(bottom)],
        occasion: 'evening',
      });
      expect(wear.statusCode).toBe(303);
      expect(await wearDays(top)).toEqual([{ day: today }]);

      const token = await createAccessToken(t, {
        cookie,
        name: `Today tool ${at}`,
      });
      expect(
        await tool<{ day: IsoDate; wornToday: boolean }>(t, token, 'get_today'),
      ).toMatchObject({ day: today, wornToday: true });
    });

    it('"Plan my week" (#16) plans today and the six days after it', async () => {
      // A night out every day: its window (21 to 24) is still open at each
      // instant, so today is planned too.
      const aroundAll = Object.fromEntries(
        [0, 1, 2, 3, 4, 5, 6].map((weekday) => [
          `around-${weekday}`,
          'night-out',
        ]),
      );
      expect((await post('/auth/profile/week', aroundAll)).statusCode).toBe(
        303,
      );
      for (const [category, count] of [
        ['tops', 7],
        ['bottoms', 3],
      ] as const) {
        for (let i = 0; i < count; i += 1) {
          await createGarment(t, {
            name: `Week ${category} ${i} ${at}`,
            category,
            cookie,
          });
        }
      }
      const res = await post('/calendar/plan-week');
      expect(res.statusCode).toBe(303);
      const planId = Number(
        /planned=(\d+)/.exec(String(res.headers.location))![1],
      );
      const planned = await t.db
        .select({ day: outfitCalendar.day })
        .from(weekPlanEntry)
        .innerJoin(outfitCalendar, eq(outfitCalendar.id, weekPlanEntry.entryId))
        .where(eq(weekPlanEntry.weekPlanId, planId));
      const last = addDays(today, 6);
      expect(planned.every(({ day }) => day >= today && day <= last)).toBe(
        true,
      );
      const nights = await t.db
        .selectDistinct({ day: outfitCalendar.day })
        .from(outfitCalendar)
        .where(
          and(
            eq(outfitCalendar.occasion, 'night-out'),
            between(outfitCalendar.day, today, last),
          ),
        );
      expect(nights).toHaveLength(7);
    });

    it('a trip (#10) to Tokyo that starts today is on: "Wore it" wears home\'s today, the day after is refused (#678)', async () => {
      const { garmentId, outfitId } = await newOutfit(`Trip ${at}`);
      const created = await post('/trips', {
        name: `Trip ${at}`,
        startsOn: today,
        endsOn: tomorrow,
      });
      expect(created.statusCode).toBe(303);
      const tripId = Number(
        /^\/trips\/(\d+)/.exec(String(created.headers.location))![1],
      );
      // The destination's zone dresses its days; "today" stays the
      // household's, whatever the day already is in Tokyo (the known limit).
      await asFixture(t.db, async (tx) =>
        setTripDestination(tx, tripId, await userIdOf(t, OWNER_EMAIL), {
          name: 'Tokyo, Japan',
          location: {
            latitude: 35.69,
            longitude: 139.69,
            timeZone: 'Asia/Tokyo',
          },
        }),
      );
      expect(
        (
          await post(`/trips/${tripId}/outfits`, {
            outfitId: String(outfitId),
            day: today,
          })
        ).statusCode,
      ).toBe(303);
      const page = unescapeHtml((await get(`/trips/${tripId}`)).body);
      expect(page).toContain(`data-trip-day="${today}"`);
      expect(page).toMatch(/\/outfits\/\d+\/wear"/);
      const [{ tripOutfitId }] = [
        ...page.matchAll(/data-trip-outfit="(?<tripOutfitId>\d+)"/g),
      ].map((m) => m.groups!);
      expect(
        (await post(`/trips/${tripId}/outfits/${tripOutfitId}/wear`))
          .statusCode,
      ).toBe(303);
      expect(await wearDays(garmentId)).toEqual([{ day: today }]);
      // A trip that starts tomorrow is not on yet.
      const later = await post('/trips', {
        name: `Later ${at}`,
        startsOn: tomorrow,
        endsOn: tomorrow,
      });
      const laterId = Number(
        /^\/trips\/(\d+)/.exec(String(later.headers.location))![1],
      );
      await post(`/trips/${laterId}/outfits`, { outfitId: String(outfitId) });
      const laterPage = unescapeHtml((await get(`/trips/${laterId}`)).body);
      expect(laterPage).not.toMatch(/\/wear"/);
      const [{ laterOutfit }] = [
        ...laterPage.matchAll(/data-trip-outfit="(?<laterOutfit>\d+)"/g),
      ].map((m) => m.groups!);
      expect(
        (await post(`/trips/${laterId}/outfits/${laterOutfit}/wear`))
          .statusCode,
      ).toBe(409);
    });

    it("Profile's Devices (#189) writes a device's last use as the household's day", async () => {
      const minted = await mintToken(
        t,
        await userIdOf(t, OWNER_EMAIL),
        `Phone ${at}`,
        'device',
      );
      if (!minted.created) throw new Error('no device token');
      await t.db
        .update(personalAccessToken)
        .set({ lastUsedAt: new Date(at) })
        .where(eq(personalAccessToken.id, minted.id));
      const page = unescapeHtml((await get('/auth/profile')).body);
      expect(page).toContain(`last used ${today}`);
    });
  });
});
