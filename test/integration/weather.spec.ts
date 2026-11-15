import { eq, inArray } from 'drizzle-orm';
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
import {
  garment,
  user,
  userWeather,
  weatherForecast,
} from '../../src/db/schema';
import { DEFAULT_OCCASION } from '../../src/wardrobe/occasions';
import { assessOutfit, weatherNeeds } from '../../src/weather/match';
import { createGarment } from './garments';
import { t as text } from '../../src/web/i18n';
import { forecastDayOf, weatherFor } from '../../src/seed/weather';
import { displayTemperature } from '../../src/weather/temperature';
import { createOutfit } from '../../src/web/outfits/queries';
import {
  createTestApp,
  hasText,
  recordQueries,
  type TestApp,
  unescapeHtml,
  asFixture,
} from './harness';
import { deviceToken, expectProblem } from './api';
import { callTool, createAccessToken, mcpRequest, tool } from './mcp';
import {
  expectAutosaveControls,
  expectFragment,
  expectFullPage,
  HX_FRAGMENT,
} from './pages';
import { startWeatherStub, type WeatherStub } from '../support/weather-stub';
import { BY_PERSON } from '../../src/web/write-origin';

/**
 * Weather (#14): the settings a user keeps, the forecast the server fetches
 * and caches for their rounded location, and what the pages load. Open-Meteo
 * is the stand-in (test/support/weather-stub.ts), reached through the real
 * outbound fetcher, so every request the app sends is in `stub.hits`.
 *
 * The clock is pinned (Date only; timers stay real) to 00:30 UTC on Sunday
 * 27 September 2026, which is still Saturday the 26th, 8:30 pm, in New York
 * (APP_TIMEZONE): every day and hour below is the household's.
 */

const NOW = new Date('2026-09-27T00:30:00Z');
const TODAY = '2026-09-26';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Fort Greene Park, precisely, as a phone or a geocoder would give it.
const PRECISE = { latitude: '40.689167', longitude: '-73.975556' };
const ROUNDED = { latitude: 40.69, longitude: -73.98 };

function forecastHits(stub: WeatherStub): URLSearchParams[] {
  return stub.hits
    .filter((hit) => hit.startsWith('/v1/forecast?'))
    .map((hit) => new URLSearchParams(hit.slice(hit.indexOf('?') + 1)));
}

function at(offsetMs: number): void {
  vi.setSystemTime(new Date(NOW.getTime() + offsetMs));
}

/**
 * Waits for the background refresh (#114) an ask started at `offsetMs`, and
 * checks it recorded that instant: a stale forecast is served at once and
 * refreshed after the answer, so a spec that counts fetches or reads the
 * next answer waits for the refresh first, through the service's own
 * signal (the app's close awaits it too), never a poll.
 */
async function refreshed(t: TestApp, offsetMs: number): Promise<void> {
  if (!t.weather) throw new Error('refreshed() needs WEATHER_ENABLED');
  await t.weather.settled();
  const [row] = await t.db
    .select({ attemptedAt: weatherForecast.attemptedAt })
    .from(weatherForecast)
    .where(eq(weatherForecast.latitude, ROUNDED.latitude));
  expect(row.attemptedAt).toEqual(new Date(NOW.getTime() + offsetMs));
}

async function toolNamesOf(t: TestApp, token: string): Promise<string[]> {
  const res = await mcpRequest(t, token, 'tools/list');
  return res
    .json<{ result: { tools: { name: string }[] } }>()
    .result.tools.map((listed) => listed.name);
}

const form = (fields: Record<string, string>) => ({
  headers: {
    ...HX_FRAGMENT,
    'content-type': 'application/x-www-form-urlencoded',
  },
  payload: new URLSearchParams(fields).toString(),
});

describe('weather', () => {
  let stub: WeatherStub;
  let t: TestApp;

  beforeAll(async () => {
    stub = await startWeatherStub();
    t = await createTestApp(
      { WEATHER_ENABLED: 'true' },
      { weather: stub.options },
    );
  });

  afterAll(async () => {
    await t.cleanup();
    await stub.close();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    stub.fail(false);
    stub.hold(false);
  });

  const summary = (query = '') =>
    t.inject({
      method: 'GET',
      url: `/weather/summary${query}`,
      headers: HX_FRAGMENT,
    });

  describe('before a location is set', () => {
    it('asks for one instead of fetching', async () => {
      const res = await summary();
      expect(res.statusCode).toBe(200);
      expectFragment(res);
      expect(res.body).toContain('href="/auth/profile/weather"');
      expect(stub.hits).toEqual([]);
    });

    it('offers the settings on their own page, a row on Profile (#728)', async () => {
      const profile = await t.inject({ method: 'GET', url: '/auth/profile' });
      expect(profile.body).toContain(
        '<li id="weather"><a href="/auth/profile/weather"',
      );
      expect(profile.body).toContain('No home city yet');
      expect(profile.body).not.toContain('hx-get="/weather/places"');
      const res = await t.inject({
        method: 'GET',
        url: '/auth/profile/weather',
      });
      expectFullPage(res);
      expectAutosaveControls(res);
      expect(res.body).toMatch(
        /<a href="\/auth\/profile#weather" class="btn[^"]*" aria-label="Back"/,
      );
      expect(res.body).toContain('hx-get="/weather/places"');
      expect(res.body).toContain("import { initLocate } from 'locate'");
    });
  });

  describe('the city search', () => {
    it('answers places, rounded, and logs neither the query nor the user', async () => {
      t.logs.clear();
      const res = await t.inject({
        method: 'GET',
        url: '/weather/places?q=Brooklyn',
        headers: HX_FRAGMENT,
      });
      expect(res.statusCode).toBe(200);
      expectFragment(res);
      const body = unescapeHtml(res.body);
      expect(body).toContain('Brooklyn, New York, United States');
      expect(body).toContain('name="latitude" value="40.65"');
      expect(body).toContain('name="longitude" value="-73.95"');
      expect(stub.hits.at(-1)).toMatch(/^\/v1\/search\?name=Brooklyn&/);
      expect(t.logs.messages('info', 'Weather')).toEqual([
        expect.stringMatching(/^Place search: 1 result\(s\) in \d+ ms$/),
      ]);
      // The request line names the route, not the typed city.
      expect(t.logs.text()).not.toMatch(/brooklyn/i);
    });

    it('says so when nothing matches, or the search fails', async () => {
      const none = await t.inject({
        method: 'GET',
        url: '/weather/places?q=Atlantis',
        headers: HX_FRAGMENT,
      });
      expect(none.body).toContain('No place by that name.');
      stub.fail(true);
      const failed = await t.inject({
        method: 'GET',
        url: '/weather/places?q=Brooklyn',
        headers: HX_FRAGMENT,
      });
      expect(failed.statusCode).toBe(200);
      expect(failed.body).toContain('The search did not work just now.');
    });

    it('refuses a query too short or too long', async () => {
      for (const q of ['B', 'x'.repeat(101)]) {
        const res = await t.inject({
          method: 'GET',
          url: `/weather/places?q=${q}`,
          headers: HX_FRAGMENT,
        });
        expect(res.statusCode).toBe(400);
      }
    });
  });

  describe('with a home city', () => {
    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      at(0);
      const res = await t.inject({
        method: 'POST',
        url: '/weather/home',
        ...form({ name: 'Fort Greene, New York, United States', ...PRECISE }),
      });
      expect(res.statusCode).toBe(200);
      vi.useRealTimers();
    });

    it('stores it rounded, and answers the section', async () => {
      const [row] = await t.db
        .select()
        .from(userWeather)
        .where(eq(userWeather.userId, t.owner.id));
      expect(row).toMatchObject({
        homeName: 'Fort Greene, New York, United States',
        homeLatitude: ROUNDED.latitude,
        homeLongitude: ROUNDED.longitude,
        hereLatitude: null,
      });
      for (const url of ['/auth/profile', '/auth/profile/weather']) {
        const res = await t.inject({ method: 'GET', url });
        expect(res.body).toContain(
          'Home: Fort Greene, New York, United States',
        );
      }
    });

    it("shows today's weather, New York's today, fetched with the rounded location only", async () => {
      t.logs.clear();
      const before = forecastHits(stub).length;
      const res = await summary();
      expect(res.statusCode).toBe(200);
      expectFragment(res);

      const [sent] = forecastHits(stub).slice(before);
      expect([...sent.keys()].sort()).toEqual([
        'daily',
        'forecast_days',
        'hourly',
        'latitude',
        'longitude',
        'timezone',
      ]);
      expect(sent.get('latitude')).toBe('40.69');
      expect(sent.get('longitude')).toBe('-73.98');
      expect(sent.get('timezone')).toBe('America/New_York');
      expect(sent.get('forecast_days')).toBe('16');

      const day = forecastDayOf('demo', weatherFor('demo', TODAY, 1)[0]);
      const body = unescapeHtml(res.body);
      expect(body).toContain('id="weather-line"');
      expect(body).toContain(
        // No unit chosen: the default, °F.
        `${displayTemperature(day.low, 'fahrenheit')}–${displayTemperature(day.high, 'fahrenheit')} °F`,
      );
      expect(body).toContain('Fort Greene · as of 8:30 PM');
      expect(body).toContain('Weather data by Open-Meteo.com');

      // The log names the rounded location, never the user; the fetcher's
      // line names the host, never the query.
      expect(t.logs.messages('info', 'Weather')).toEqual([
        'Forecast for 40.69,-73.98 America/New_York: refreshing; none kept, the ask waits',
        expect.stringMatching(
          /^Forecast for 40\.69,-73\.98 America\/New_York: 16 days in \d+ ms$/,
        ),
      ]);
      expect(t.logs.messages('info', 'OutboundFetch')).toEqual([
        expect.stringMatching(
          /^Fetched json from 127\.0\.0\.2 over http\/1\.1: \d+ bytes/,
        ),
      ]);
      const text = t.logs.text();
      expect(text).not.toContain('latitude=');
      expect(text).not.toContain('40.689');
      for (const record of t.logs.records) {
        if (record.msg.includes('40.69')) {
          expect(record.msg).not.toMatch(/user|owner@/i);
        }
      }

      const [cached] = await t.db.select().from(weatherForecast);
      expect(cached).toMatchObject({
        latitude: 40.69,
        longitude: -73.98,
        fetchedAt: NOW,
        attemptedAt: NOW,
      });
      expect(cached.forecast?.days[0].day).toBe(TODAY);
      expect(cached.forecast?.days).toHaveLength(16);
    });

    it('fetches once an hour per location, in the background, once for simultaneous asks', async () => {
      const before = forecastHits(stub).length;
      at(59 * MINUTE);
      await summary();
      expect(forecastHits(stub)).toHaveLength(before);

      // An hour old: every ask is served the cached forecast at once, and
      // one refresh runs behind them. Open-Meteo's answer is held until the
      // pages are in, so the refresh is still running for all three: on a
      // loaded machine one ask can reach the cache only after the refresh
      // saved, and is rightly served the new forecast (#184).
      t.logs.clear();
      at(61 * MINUTE);
      stub.hold(true);
      const answers = await Promise.all([summary(), summary(), summary()]);
      expect(answers.map((res) => res.statusCode)).toEqual([200, 200, 200]);
      for (const res of answers) {
        expect(res.body).toContain('as of 8:30 PM');
      }
      stub.hold(false);
      await refreshed(t, 61 * MINUTE);
      expect(forecastHits(stub)).toHaveLength(before + 1);
      expect(t.logs.messages('info', 'Weather')).toEqual([
        'Forecast for 40.69,-73.98 America/New_York: refreshing; the one from 2026-09-27T00:30:00.000Z kept meanwhile',
        expect.stringMatching(
          /^Forecast for 40\.69,-73\.98 America\/New_York: 16 days in \d+ ms$/,
        ),
      ]);

      // The next ask gets the refreshed forecast, and fetches nothing.
      const next = await summary();
      expect(next.body).toContain('as of 9:31 PM');
      expect(forecastHits(stub)).toHaveLength(before + 1);
    });

    it('keeps the last good forecast when Open-Meteo fails, and waits before asking again', async () => {
      stub.fail(true);
      t.logs.clear();
      const before = forecastHits(stub).length;
      at(3 * HOUR);
      const res = await summary();
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('as of 9:31 PM');
      await refreshed(t, 3 * HOUR);
      expect(forecastHits(stub)).toHaveLength(before + 1);
      expect(t.logs.messages('warn', 'Weather')).toEqual([
        expect.stringMatching(
          /^Forecast for 40\.69,-73\.98 America\/New_York failed \(http-status\) after \d+ ms; serving the one from 2026-09-27T01:31:00\.000Z$/,
        ),
      ]);

      // The failed refresh changed nothing the page shows.
      expect((await summary()).body).toBe(res.body);

      at(3 * HOUR + 9 * MINUTE);
      await summary();
      expect(forecastHits(stub)).toHaveLength(before + 1);

      stub.fail(false);
      at(3 * HOUR + 11 * MINUTE);
      const stale = await summary();
      expect(stale.body).toContain('as of 9:31 PM');
      await refreshed(t, 3 * HOUR + 11 * MINUTE);
      expect(forecastHits(stub)).toHaveLength(before + 2);
      expect((await summary()).body).toContain('as of 11:41 PM');
    });

    it("gives the calendar's days their chips, from the household's today", async () => {
      // The week of the 20th: only Saturday the 26th is in the forecast,
      // though it is the 27th in UTC.
      const past = unescapeHtml(
        (await summary('?from=2026-09-20&to=2026-09-26')).body,
      );
      expect(past).toContain('id="weather-line"');
      expect(past.match(/id="weather-day-[\d-]+"/g)).toEqual([
        'id="weather-day-2026-09-26"',
      ]);
      expect(past).toContain('hx-swap-oob="true"');

      const next = unescapeHtml(
        (await summary('?from=2026-09-27&to=2026-10-03')).body,
      );
      expect(next.match(/id="weather-day-[\d-]+"/g)).toHaveLength(7);

      // Sixteen days from the 26th end on 11 October.
      const far = unescapeHtml(
        (await summary('?from=2026-10-11&to=2026-10-17')).body,
      );
      expect(far.match(/id="weather-day-[\d-]+"/g)).toEqual([
        'id="weather-day-2026-10-11"',
      ]);
    });

    it("gives the month grid compact chips from the week's forecast, and asks Open-Meteo for nothing more (#201)", async () => {
      // An account at a place of its own: its forecast row starts cold here
      // and goes stale below without moving the owner's, which the specs
      // after this one read.
      const cookie = await t.register('month-grid@example.com');
      const post = form({
        name: 'Chicago',
        latitude: '41.88',
        longitude: '-87.63',
      });
      const home = await t.inject({
        method: 'POST',
        url: '/weather/home',
        headers: { ...post.headers, cookie },
        payload: post.payload,
      });
      expect(home.statusCode).toBe(200);
      const ask = (query: string) =>
        t.inject({
          method: 'GET',
          url: `/weather/summary${query}`,
          headers: { ...HX_FRAGMENT, cookie },
        });
      const chicagoHits = () =>
        forecastHits(stub).filter((hit) => hit.get('latitude') === '41.88');
      const WEEK = '?from=2026-09-20&to=2026-09-26';
      // What GET /calendar/month asks for September: its forecast days.
      const MONTH = '?from=2026-09-26&to=2026-09-30&view=month';

      // The week, then the month: the month is served the week's forecast.
      await ask(WEEK);
      await t.weather!.settled();
      expect(chicagoHits()).toHaveLength(1);
      const afterWeek = stub.hits.length;
      const month = unescapeHtml((await ask(MONTH)).body);
      await t.weather!.settled();
      expect(stub.hits).toHaveLength(afterWeek);

      // The cells' chips alone: no line, icon and high only.
      expect(month).not.toContain('id="weather-line"');
      expect(month.match(/data-weather-day="[\d-]+"/g)).toEqual([
        'data-weather-day="2026-09-26"',
        'data-weather-day="2026-09-27"',
        'data-weather-day="2026-09-28"',
        'data-weather-day="2026-09-29"',
        'data-weather-day="2026-09-30"',
      ]);
      const today = forecastDayOf('demo', weatherFor('demo', TODAY, 1)[0]);
      const chip = month
        .split('<span id="weather-day-')
        .find((part) => part.startsWith('2026-09-26"'))!;
      expect(chip).toContain('hx-swap-oob="true"');
      expect(chip).toContain(
        `${displayTemperature(today.high, 'fahrenheit')}°</span>`,
      );
      expect(chip).not.toContain('–');

      // Once the forecast is stale, the week and the month asking together
      // cost the one refresh the week alone would.
      at(61 * MINUTE);
      stub.hold(true);
      const both = await Promise.all([ask(WEEK), ask(MONTH)]);
      stub.hold(false);
      expect(both.map((res) => res.statusCode)).toEqual([200, 200]);
      await t.weather!.settled();
      expect(chicagoHits()).toHaveLength(2);
      // The calendar never asks for climate normals.
      expect(stub.hits.filter((hit) => hit.startsWith('/v1/archive'))).toEqual(
        [],
      );
    });

    it('refuses a malformed range', async () => {
      for (const query of [
        '?from=2026-09-20',
        '?from=2026-09-27&to=2026-09-20',
        '?from=2026-09-01&to=2026-12-01',
        '?from=2026-02-30&to=2026-03-01',
        '?from=2026-09-26&to=2026-09-30&view=week',
      ]) {
        expect((await summary(query)).statusCode).toBe(400);
      }
    });

    it('puts the slots on the wardrobe and the calendar, never in the pages themselves', async () => {
      const calendar = await t.inject({
        method: 'GET',
        url: '/calendar?week=2026-09-20',
      });
      expectFullPage(calendar);
      const body = unescapeHtml(calendar.body);
      expect(body).toContain(
        'hx-get="/weather/summary?from=2026-09-20&to=2026-09-26"',
      );
      expect(body).toContain('id="weather-day-2026-09-20"');
      expect(body).not.toContain('°C');

      // The month (#201): one hidden load for the days the forecast reaches,
      // each of them with room for its chip; no line, and nothing for a
      // month the forecast does not reach.
      const hits = stub.hits.length;
      const september = await t.inject({
        method: 'GET',
        url: '/calendar/month?month=2026-09',
      });
      expectFullPage(september);
      const grid = unescapeHtml(september.body);
      expect(grid).toMatch(
        /<div id="weather-month" hidden="" hx-get="\/weather\/summary\?from=2026-09-26&to=2026-09-30&view=month" hx-trigger="load" hx-swap="none"/,
      );
      expect(grid).not.toContain('id="weather-line"');
      expect(grid.match(/<span id="weather-day-[\d-]+"/g)).toEqual(
        ['26', '27', '28', '29', '30'].map(
          (day) => `<span id="weather-day-2026-09-${day}"`,
        ),
      );
      expect(grid).toContain('aria-describedby="weather-day-2026-09-26"');
      expect(grid).not.toContain('°');
      for (const month of ['2026-08', '2026-11']) {
        const outside = await t.inject({
          method: 'GET',
          url: `/calendar/month?month=${month}`,
        });
        expect(outside.body).not.toContain('/weather/');
        expect(outside.body).not.toContain('id="weather');
      }
      expect(stub.hits).toHaveLength(hits);

      const wardrobe = await t.inject({ method: 'GET', url: '/wardrobe' });
      expectFullPage(wardrobe);
      // The catalog has no weather line (#732).
      expect(wardrobe.body).not.toContain('/weather/summary');
    });

    // #158: Today is the day's own data (network first, not a byte-stable
    // tab root), so it renders the line itself from the weather read its
    // ideas are matched with: no second request, no second read.
    it('Today renders the line in the page, the one the summary answers, from one read', async () => {
      // An outfit's worth of closet: an empty one is Today's first-run
      // path (#666), with no ideas and the city only after a garment.
      const outfit = [
        await createGarment(t, { name: 'Tee', category: 'tops' }),
        await createGarment(t, { name: 'Jeans', category: 'bottoms' }),
      ];
      const hits = stub.hits.length;
      const today = await t.inject({ method: 'GET', url: '/' });
      expectFullPage(today);
      const page = unescapeHtml(today.body);
      expect(page).not.toContain('/weather/summary');
      const line = unescapeHtml((await summary()).body);
      expect(line).toContain('id="weather-line"');
      expect(page).toContain(line);

      // The session; the entries with the settings and forecast in one
      // statement (#172; two before, in parallel); the pool and the
      // generator's memory in one (#168; Today hands ideasFor the weather
      // it read).
      const page158 = await recordQueries(() =>
        t.inject({ method: 'GET', url: '/' }),
      );
      expect(page158.statements).toBe(3);
      // The session, then the settings and forecast together.
      expect((await recordQueries(() => summary())).statements).toBe(2);
      expect(stub.hits).toHaveLength(hits);
      for (const id of outfit) {
        const removed = await t.inject({
          method: 'DELETE',
          url: `/wardrobe/${id}`,
        });
        expect(removed.statusCode).toBeLessThan(400);
      }
    });

    it('reads in °F when the user asks', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/weather/unit',
        ...form({ unit: 'fahrenheit' }),
      });
      expect(res.statusCode).toBe(200);
      // The unit's status line and the offset, which reads in the unit, out
      // of band; never the unit's own form (src/web/autosave.tsx).
      expect(hasText(res.body, 'Saved')).toBe(true);
      expect(res.body).toMatch(/id="weather-offset"[^>]*hx-swap-oob="true"/);
      expect(res.body).not.toContain('name="unit"');
      const profile = await t.inject({
        method: 'GET',
        url: '/auth/profile/weather',
      });
      expect(profile.body).toMatch(/value="fahrenheit"[^>]*\schecked/);
      const day = forecastDayOf('demo', weatherFor('demo', TODAY, 1)[0]);
      expect(unescapeHtml((await summary()).body)).toContain(
        `${displayTemperature(day.low, 'fahrenheit')}–${displayTemperature(day.high, 'fahrenheit')} °F`,
      );
      await t.inject({
        method: 'POST',
        url: '/weather/unit',
        ...form({ unit: 'celsius' }),
      });
    });

    // Styling's fit line (#468b): the rows' outfit against the aimed day's
    // weather, in the gallery's words, loaded after the page.
    describe("Styling's fit line", () => {
      let jumper: number;
      let parka: number;
      let viewer: string;
      let stranger: string;

      const fitUrl = (
        rows: [role: string, garmentId: number | null][],
        extra = '',
      ) => {
        const query = new URLSearchParams();
        for (const [role, garmentId] of rows) {
          query.append('role', role);
          query.append(
            'garmentId',
            garmentId === null ? '' : String(garmentId),
          );
          query.append('lock', '');
        }
        return `/styling/fit?${query.toString()}${extra}`;
      };
      const fit = (url: string, cookie?: string) =>
        t.inject({
          method: 'GET',
          url,
          headers: { ...HX_FRAGMENT, ...(cookie ? { cookie } : {}) },
        });

      beforeAll(async () => {
        jumper = await createGarment(t, {
          name: 'Wool jumper',
          category: 'tops',
        });
        parka = await createGarment(t, {
          name: 'Parka',
          category: 'outerwear',
        });
        await asFixture(t.db, (tx) =>
          tx
            .update(garment)
            .set({ warmth: 5 })
            .where(inArray(garment.id, [jumper, parka])),
        );
        viewer = await t.register('viewer-fit@example.com');
        stranger = await t.register('stranger-fit@example.com');
        const invite = await t.inject({
          method: 'POST',
          url: '/wardrobe-share/create-invite-link',
          payload: { permission: 'VIEW' },
          headers: HX_FRAGMENT,
        });
        const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
          invite.body,
        )![1];
        const accepted = await t.inject({
          method: 'POST',
          url: `/wardrobe-share/invite/${token}/accept`,
          payload: {},
          headers: { cookie: viewer },
        });
        expect(accepted.statusCode).toBeLessThan(400);
      });

      it("names what is wrong in the gallery's words, from the cached forecast in one statement", async () => {
        const hits = stub.hits.length;
        const url = fitUrl([
          ['layer', parka],
          ['top', jumper],
          ['bottom', null],
        ]);
        const res = await fit(url);
        expect(res.statusCode).toBe(200);
        expectFragment(res);
        // Today, all day, at home: what ideasFor would match an idea to.
        const needs = weatherNeeds(
          forecastDayOf('demo', weatherFor('demo', TODAY, 1)[0]),
          DEFAULT_OCCASION,
          0,
        )!;
        const { problems } = assessOutfit(needs, [
          { role: 'layer', warmth: 5, waterResistant: false, rainGear: false },
          { role: 'top', warmth: 5, waterResistant: false, rainGear: false },
        ]);
        expect(problems).toContain('too-warm');
        const chips = [
          ...unescapeHtml(res.body).matchAll(/<li[^>]*>([^<]+)</g),
        ];
        expect(chips.map((chip) => chip[1])).toEqual(
          problems.map((problem) => text(`gallery.problem.${problem}`)),
        );
        expect(res.body).not.toContain('Fits the weather');
        // The session, then the garments with the settings and forecast row.
        expect((await recordQueries(() => fit(url))).statements).toBe(2);
        expect(stub.hits).toHaveLength(hits);
      });

      it('says nothing without a garment, over a shared wardrobe, or for a past day', async () => {
        const none = await fit(fitUrl([['top', null]]));
        expect(none.statusCode).toBe(200);
        expect(none.body).toBe('');
        // A grantee: nothing of the owner's weather, nothing read.
        const shared = fitUrl([['top', jumper]], `&ownerId=${t.owner.id}`);
        const browsed = await fit(shared, viewer);
        expect(browsed.statusCode).toBe(200);
        expect(browsed.body).toBe('');
        expect(
          (await recordQueries(() => fit(shared, viewer))).statements,
        ).toBe(1);
        expect((await fit(shared, stranger)).statusCode).toBe(404);
        // Another's garment in one's own rows is not judged.
        expect((await fit(fitUrl([['top', jumper]]), viewer)).body).toBe('');
        const past = await fit(
          fitUrl([['top', jumper]], '&for=day:2026-09-20&occasion=all-day'),
        );
        expect(past.statusCode).toBe(200);
        expect(past.body).toBe('');
      });

      it('refuses rows that do not line up, or are not rows', async () => {
        for (const url of [
          `/styling/fit?role=top&garmentId=${jumper}`,
          '/styling/fit?role=top&garmentId=jumper&lock=',
          '/styling/fit?role=hat&garmentId=&lock=',
        ]) {
          expect((await fit(url)).statusCode).toBe(400);
        }
      });

      it('leaves the page byte-stable: an empty slot it loads after drawing, again with each rows answer', async () => {
        const page = await t.inject({ method: 'GET', url: '/styling' });
        expectFullPage(page);
        const body = unescapeHtml(page.body);
        expect(body).toMatch(
          /<div id="styling-fit-line" [^>]*hx-get="\/styling\/fit" hx-include="#styling-form" hx-trigger="intersect once, styling:outfit-changed delay:500ms"[^>]*><\/div>/,
        );
        expect(body).not.toContain('Fits the weather');
        expect(body).not.toContain('May be too');
        at(2 * HOUR);
        expect((await t.inject({ method: 'GET', url: '/styling' })).body).toBe(
          page.body,
        );
        await t.weather!.settled();
        const shuffled = await fit(
          fitUrl([['top', jumper]]).replace('/fit', '/shuffle'),
        );
        expect(shuffled.body).toMatch(
          /<div id="styling-fit" hx-swap-oob="true"/,
        );
        const shared = await t.inject({
          method: 'GET',
          url: `/styling?ownerId=${t.owner.id}`,
          headers: { cookie: viewer },
        });
        expect(shared.statusCode).toBe(200);
        expect(shared.body).not.toContain('styling-fit');
      });
    });
  });

  describe("the phone's location", () => {
    it('stands in for home, rounded, for twelve hours', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/weather/here',
        ...form({ latitude: '40.712776', longitude: '-74.005974' }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Using your location from 8:30 PM');
      // The location part only: the section holds the unit's autosave form,
      // which no other answer may replace (src/web/autosave.tsx).
      expect(res.body).toContain('id="weather-location"');
      expect(res.body).not.toContain('name="unit"');
      const [row] = await t.db
        .select()
        .from(userWeather)
        .where(eq(userWeather.userId, t.owner.id));
      expect(row).toMatchObject({
        hereLatitude: 40.71,
        hereLongitude: -74.01,
        hereLocatedAt: NOW,
      });

      const line = unescapeHtml((await summary()).body);
      expect(line).toContain('Near you');
      expect(forecastHits(stub).at(-1)?.get('latitude')).toBe('40.71');

      // Home's forecast is stale by now: served, and refreshed behind it.
      at(13 * HOUR);
      const later = unescapeHtml((await summary()).body);
      expect(later).toContain('Fort Greene');
      await refreshed(t, 13 * HOUR);
      expect(forecastHits(stub).at(-1)?.get('latitude')).toBe('40.69');
    });

    it('refuses a position off the globe and stores nothing', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/weather/here',
        ...form({ latitude: '91', longitude: '0' }),
      });
      expect(res.statusCode).toBe(400);
      const [row] = await t.db
        .select()
        .from(userWeather)
        .where(eq(userWeather.userId, t.owner.id));
      expect(row.hereLatitude).toBe(40.71);
    });

    it('is forgotten on Stop', async () => {
      await t.inject({
        method: 'POST',
        url: '/weather/here/clear',
        ...form({}),
      });
      const [row] = await t.db
        .select()
        .from(userWeather)
        .where(eq(userWeather.userId, t.owner.id));
      expect(row).toMatchObject({
        hereLatitude: null,
        hereLongitude: null,
        hereLocatedAt: null,
        homeLatitude: 40.69,
      });
    });
  });

  describe('the personal offset', () => {
    const feedback = (feeling: string) =>
      t.inject({
        method: 'POST',
        url: '/weather/feedback',
        ...form({ feeling }),
      });
    const offset = async () =>
      (
        await t.db
          .select()
          .from(userWeather)
          .where(eq(userWeather.userId, t.owner.id))
      )[0].temperatureOffset;

    it('moves half a degree per feedback, capped at ±5', async () => {
      const cold = await feedback('too-cold');
      expect(cold.body).toContain(
        'You run cold: outfits are matched as if it were 0.5° colder.',
      );
      // The offset part only, never the unit's autosave form.
      expect(cold.body).toContain('id="weather-offset"');
      expect(cold.body).not.toContain('name="unit"');
      expect(await offset()).toBe(-0.5);
      await Promise.all(Array.from({ length: 12 }, () => feedback('too-warm')));
      expect(await offset()).toBe(5);
      const capped = await feedback('too-warm');
      expect(capped.body).toContain('as if it were 5° warmer');
      expect(await offset()).toBe(5);
      await t.inject({
        method: 'POST',
        url: '/weather/offset/reset',
        ...form({}),
      });
      expect(await offset()).toBe(0);
    });

    it('refuses any other feeling', async () => {
      expect((await feedback('just-right')).statusCode).toBe(400);
    });

    it('answers a plain post with the settings page', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/weather/feedback',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'feeling=too-warm',
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/auth/profile/weather');
    });
  });

  describe('MCP', () => {
    let token: string;

    beforeAll(async () => {
      token = await createAccessToken(t);
    });

    // The next morning: the clock only moves forward from the specs above.
    beforeEach(() => {
      at(14 * HOUR);
    });

    it('lists get_weather and answers the forecast with what it asks of an outfit', async () => {
      expect(await toolNamesOf(t, token)).toContain('get_weather');

      const answer = await tool<{
        today: string;
        location: { name: string; source: string };
        days: {
          day: string;
          outfit: { occasion: string; hours: object; torsoWarmth: number };
        }[];
      }>(t, token, 'get_weather', { occasion: 'evening' });
      expect(answer.today).toBe('2026-09-27');
      expect(answer.location).toEqual({
        name: 'Fort Greene, New York, United States',
        source: 'home',
      });
      expect(answer.days.map((d) => d.day)).toEqual([
        '2026-09-27',
        '2026-09-28',
        '2026-09-29',
        '2026-09-30',
        '2026-10-01',
        '2026-10-02',
        '2026-10-03',
      ]);
      expect(answer.days[0].outfit).toMatchObject({
        occasion: 'evening',
        hours: { from: 18, to: 23 },
      });
      expect(answer.days[0].outfit.torsoWarmth).toBeGreaterThanOrEqual(1);
    });

    it('refuses days outside the forecast', async () => {
      for (const args of [
        { from: '2026-09-26', to: '2026-09-27' },
        { from: '2026-10-11', to: '2026-10-13' },
      ]) {
        const answer = await callTool(t, token, 'get_weather', args);
        expect(answer.isError).toBe(true);
        expect(answer.value.error).toBe(
          'Ask for days from 2026-09-27 to 2026-10-12, from before to',
        );
      }
    });

    it("adds each entry's weather to get_calendar within the forecast", async () => {
      const { id } = await createOutfit(t.db, t.owner.id, {
        name: 'Evening out',
        slots: [],
        plan: { day: '2026-09-28', occasion: 'evening' },
        origin: 'person',
        madeBy: BY_PERSON,
      });
      await createOutfit(t.db, t.owner.id, {
        name: 'Far ahead',
        slots: [],
        plan: { day: '2026-10-20', occasion: 'all-day' },
        origin: 'person',
        madeBy: BY_PERSON,
      });
      const calendar = await tool<{
        entries: {
          day: string;
          outfit: { id: number };
          weather?: { day: string; outfit: { occasion: string } };
        }[];
      }>(t, token, 'get_calendar', { from: '2026-09-27', to: '2026-10-25' });
      const evening = calendar.entries.find((e) => e.outfit.id === id)!;
      expect(evening.weather).toMatchObject({
        day: '2026-09-28',
        outfit: { occasion: 'evening' },
      });
      const far = calendar.entries.find((e) => e.day === '2026-10-20')!;
      expect(far.weather).toBeUndefined();
    });
  });

  it('limits how many locations one account can set a minute: each is a fetch and a cached row', async () => {
    const cookie = await t.register('wanderer@example.com');
    const here = (latitude: number) =>
      t.inject({
        method: 'POST',
        url: '/weather/here',
        ...form({ latitude: String(latitude), longitude: '-73.98' }),
        headers: { ...form({}).headers, cookie },
      });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await here(40 + i / 10)).statusCode);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    expect(t.logs.messages('warn', 'Web')).toContainEqual(
      expect.stringMatching(
        /^Rate limit reached: POST \/weather\/here for user \d+$/,
      ),
    );
    // Home counts on its own, and someone else's count is their own.
    const home = await t.inject({
      method: 'POST',
      url: '/weather/home',
      ...form({ name: 'Fort Greene', ...PRECISE }),
      headers: { ...form({}).headers, cookie },
    });
    expect(home.statusCode).toBe(200);
    const neighbour = await t.register('stayer@example.com');
    const theirs = await t.inject({
      method: 'POST',
      url: '/weather/here',
      ...form({ latitude: '40.5', longitude: '-73.98' }),
      headers: { ...form({}).headers, cookie: neighbour },
    });
    expect(theirs.statusCode).toBe(200);
  });

  it('is the signed-in user’s own: another account starts with nothing', async () => {
    const cookie = await t.register('neighbour@example.com');
    const res = await t.inject({
      method: 'GET',
      url: '/weather/summary',
      headers: { ...HX_FRAGMENT, cookie },
    });
    expect(res.body).toContain('Add your city for the weather');
  });

  it('goes with the account', async () => {
    const cookie = await t.register('leaving@example.com');
    await t.inject({
      method: 'POST',
      url: '/weather/home',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ name: 'Brooklyn', ...PRECISE }).toString(),
    });
    const [{ id }] = await t.db
      .select({ id: userWeather.userId })
      .from(userWeather)
      .where(eq(userWeather.homeName, 'Brooklyn'));
    // The row cascades with the user, whichever path deletes it.
    await t.db.delete(user).where(eq(user.id, id));
    expect(
      await t.db.select().from(userWeather).where(eq(userWeather.userId, id)),
    ).toEqual([]);
  });
});

describe('weather off (WEATHER_ENABLED=false)', () => {
  let stub: WeatherStub;
  let t: TestApp;

  beforeAll(async () => {
    stub = await startWeatherStub();
    // The stand-in is wired, so a fetch would show in its hits.
    t = await createTestApp({}, { weather: stub.options });
  });

  afterAll(async () => {
    await t.cleanup();
    await stub.close();
  });

  it('fetches nothing and stores no location', async () => {
    for (const url of [
      '/weather/summary',
      '/weather/places?q=Brooklyn',
      '/styling/fit?role=top&garmentId=&lock=',
      // Profile › Weather's page (#728) is the weather's too.
      '/auth/profile/weather',
    ]) {
      const res = await t.inject({ method: 'GET', url, headers: HX_FRAGMENT });
      expect(res.statusCode).toBe(404);
    }
    for (const [url, fields] of [
      ['/weather/home', { name: 'Brooklyn', ...PRECISE }],
      ['/weather/here', PRECISE],
      ['/weather/feedback', { feeling: 'too-warm' }],
    ] as const) {
      const res = await t.inject({ method: 'POST', url, ...form(fields) });
      expect(res.statusCode).toBe(404);
    }
    for (const url of [
      '/wardrobe',
      '/calendar',
      '/calendar/month',
      '/auth/profile',
      '/styling',
    ]) {
      const res = await t.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('/weather/');
      expect(res.body).not.toContain('id="weather');
      expect(res.body).not.toContain('styling-fit');
    }
    const token = await createAccessToken(t);
    expect(await toolNamesOf(t, token)).not.toContain('get_weather');
    // Nor does the API's weather exist (#195a): the problem 404.
    const device = (await deviceToken(t)).token;
    for (const [method, url, payload] of [
      ['GET', '/api/v1/weather', undefined],
      ['GET', '/api/v1/weather/places?q=Brooklyn', undefined],
      [
        'PUT',
        '/api/v1/weather/home',
        { name: 'Brooklyn', latitude: 40.65, longitude: -73.95 },
      ],
      ['PUT', '/api/v1/weather/here', { latitude: 40.65, longitude: -73.95 }],
      ['GET', '/api/v1/trips/1/weather', undefined],
    ] as const) {
      expectProblem(
        await t.api(device, { method, url, payload }),
        404,
        'not_found',
      );
    }
    // Today is there, without weather.
    const today = await t.api(device, { method: 'GET', url: '/api/v1/today' });
    expect(today.statusCode).toBe(200);
    expect(today.json()).not.toHaveProperty('weather');

    expect(stub.hits).toEqual([]);
    expect(await t.db.select().from(userWeather)).toEqual([]);
    expect(await t.db.select().from(weatherForecast)).toEqual([]);
  });
});
