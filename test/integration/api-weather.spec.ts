import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, type IsoDate } from '../../src/calendar-date';
import {
  garment,
  trip,
  userWeather,
  weatherForecast,
} from '../../src/db/schema';
import { REFERENCE_ANCHOR } from '../../src/seed/simulate';
import {
  STUB_WEATHER_NOW,
  startWeatherStub,
  type WeatherStub,
} from '../support/weather-stub';
import { deviceToken, expectProblem } from './api';
import { createGarment } from './garments';
import { asFixture, createTestApp, type TestApp } from './harness';
import { createAccessToken, tool } from './mcp';

/**
 * Today and the weather on /api/v1 (#195a): each route its page twin's
 * read or writer (todayFor, userWeather, the settings' writers, the place
 * search, tripForecast, locateTrip). The forecast's own rules are
 * weather.spec.ts' and climate-normals.spec.ts'; who may reach a trip's
 * weather is authorization-trips'; what each costs is api-statements'.
 *
 * Date is pinned to the stub's day (STUB_WEATHER_NOW, noon in New York)
 * before the app boots, so the weather, and the branches it covers, are
 * the same every run.
 */

let t: TestApp;
let stub: WeatherStub;
let token: string;

const api = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as = token,
) => t.api(as, { method, url: `/api/v1${url}`, payload });

interface Weather {
  unit: string;
  temperatureOffset: number;
  home?: { name: string; latitude: number; longitude: number };
  here?: { latitude: number; longitude: number; locatedAt: string };
  source?: 'home' | 'here';
  fetchedAt?: string;
  days: {
    day: IsoDate;
    highC: number;
    outfit?: { occasion: string; needsLayer: boolean };
  }[];
}

// Fort Greene Park, precisely, as a phone or a geocoder would give it.
const PRECISE = { latitude: 40.689167, longitude: -73.975556 };
const ROUNDED = { latitude: 40.69, longitude: -73.98 };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: STUB_WEATHER_NOW });
  stub = await startWeatherStub();
  t = await createTestApp(
    { WEATHER_ENABLED: 'true' },
    { weather: stub.options },
  );
  token = (await deviceToken(t)).token;
});

afterAll(async () => {
  await t?.cleanup();
  await stub?.close();
  vi.useRealTimers();
});

describe('the weather', () => {
  it('without a location: the settings, no forecast, nothing fetched', async () => {
    const res = await api('GET', '/weather');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      unit: 'fahrenheit',
      temperatureOffset: 0,
      days: [],
    });
    expect(stub.hits).toEqual([]);
  });

  it('sets the home rounded, then answers the week from the household day with what each asks', async () => {
    const set = await api('PUT', '/weather/home', {
      name: '  Fort Greene, New York, United States ',
      ...PRECISE,
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toEqual({
      name: 'Fort Greene, New York, United States',
      ...ROUNDED,
    });
    expect(t.logs.ops('weather.home.set')).toContainEqual(
      expect.objectContaining({ surface: 'api' }),
    );

    const week = (await api('GET', '/weather')).json<Weather>();
    expect(week).toMatchObject({
      source: 'home',
      home: { name: 'Fort Greene, New York, United States', ...ROUNDED },
      fetchedAt: STUB_WEATHER_NOW.toISOString(),
    });
    expect(week.days.map((d) => d.day)).toEqual(
      Array.from({ length: 7 }, (_, i) => addDays(REFERENCE_ANCHOR, i)),
    );
    expect(week.days[0].outfit?.occasion).toBe('all-day');
    // Only the rounded location ever left the server.
    expect(stub.hits.join('\n')).not.toContain('40.689');

    const evening = (
      await api(
        'GET',
        `/weather?from=${REFERENCE_ANCHOR}&to=${REFERENCE_ANCHOR}&occasion=evening`,
      )
    ).json<Weather>();
    expect(evening.days).toHaveLength(1);
    expect(evening.days[0].outfit?.occasion).toBe('evening');
    // Up to `to` alone; days past the forecast are left out.
    const upTo = (
      await api('GET', `/weather?to=${addDays(REFERENCE_ANCHOR, 2)}`)
    ).json<Weather>();
    expect(upTo.days.map((d) => d.day)).toEqual([
      REFERENCE_ANCHOR,
      addDays(REFERENCE_ANCHOR, 1),
      addDays(REFERENCE_ANCHOR, 2),
    ]);
    expect(
      (
        await api('GET', `/weather?from=${addDays(REFERENCE_ANCHOR, 20)}`)
      ).json<Weather>().days,
    ).toEqual([]);
  });

  it('agrees with the ideas on the umbrella: a cool rainy day wants the outfit to keep it off until the closet has a water-resistant hat (#648)', async () => {
    const [kept] = await t.db.select().from(weatherForecast);
    const forecast = kept.forecast!;
    await t.db.update(weatherForecast).set({
      forecast: {
        ...forecast,
        days: forecast.days.map((day) =>
          day.day === REFERENCE_ANCHOR
            ? {
                ...day,
                hours: day.hours.map((h) => ({
                  ...h,
                  feelsLike: 12,
                  precipitationChance: h.hour >= 8 && h.hour < 22 ? 90 : 0,
                })),
              }
            : day,
        ),
      },
    });
    const both = async () => {
      const week = (await api('GET', `/weather?to=${REFERENCE_ANCHOR}`)).json<{
        days: {
          outfit: {
            rain: boolean;
            needsWaterResistance: boolean;
            takeUmbrella: boolean;
          };
        }[];
      }>();
      const ideas = (await api('GET', `/ideas?day=${REFERENCE_ANCHOR}`)).json<{
        weather: { needsWaterResistance: boolean; takeUmbrella: boolean };
      }>();
      return { resource: week.days[0].outfit, ideas: ideas.weather };
    };
    try {
      const bare = await both();
      expect(bare.resource).toMatchObject({
        rain: true,
        needsWaterResistance: true,
        takeUmbrella: false,
      });
      expect(bare.ideas).toMatchObject({
        needsWaterResistance: true,
        takeUmbrella: false,
      });

      const hat = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: {
          name: 'Rain hat',
          category: 'accessories',
          type: 'hat',
          props: '1',
          color: ['black'],
          waterResistant: 'true',
        },
      });
      expect(hat.statusCode).toBe(302);
      const geared = await both();
      expect(geared.resource).toMatchObject({
        rain: true,
        needsWaterResistance: false,
        takeUmbrella: true,
      });
      expect(geared.ideas).toMatchObject({
        needsWaterResistance: false,
        takeUmbrella: true,
      });
    } finally {
      await t.db
        .update(weatherForecast)
        .set({ forecast, fetchedAt: kept.fetchedAt });
      await asFixture(t.db, (tx) =>
        tx.delete(garment).where(eq(garment.name, 'Rain hat')),
      );
    }
  });

  it('refuses a backward range, one past 42 days, and any other occasion', async () => {
    for (const query of [
      `from=${REFERENCE_ANCHOR}&to=${addDays(REFERENCE_ANCHOR, -1)}`,
      `from=${REFERENCE_ANCHOR}&to=${addDays(REFERENCE_ANCHOR, 42)}`,
      'occasion=brunch',
    ]) {
      expectProblem(await api('GET', `/weather?${query}`), 400, 'validation');
    }
  });

  it("is the household's day, not UTC's, in the evening (#195a)", async () => {
    // 20:30 in New York: UTC is on tomorrow already.
    const evening = new Date(`${addDays(REFERENCE_ANCHOR, 1)}T00:30:00Z`);
    vi.setSystemTime(evening);
    try {
      const days = (await api('GET', '/weather')).json<Weather>().days;
      expect(days[0].day).toBe(REFERENCE_ANCHOR);
      expect(
        (await api('GET', '/today')).json<{ today: IsoDate }>().today,
      ).toBe(REFERENCE_ANCHOR);
      // The stale row's refresh, started by the ask, ends before the clock moves back.
      await t.weather!.settled();
    } finally {
      vi.setSystemTime(STUB_WEATHER_NOW);
    }
  });

  it("the phone's location stands in for home until cleared; the unit and the offset are settings", async () => {
    const here = await api('PUT', '/weather/here', PRECISE);
    expect(here.json()).toEqual({
      ...ROUNDED,
      locatedAt: STUB_WEATHER_NOW.toISOString(),
    });
    expect((await api('GET', '/weather')).json<Weather>()).toMatchObject({
      source: 'here',
      here: { ...ROUNDED },
    });
    expectProblem(
      await api('PUT', '/weather/here', { latitude: 91, longitude: 0 }),
      400,
      'validation',
    );
    expect((await api('DELETE', '/weather/here')).statusCode).toBe(204);
    expect((await api('GET', '/weather')).json<Weather>().source).toBe('home');

    expect(
      (await api('PUT', '/weather/unit', { unit: 'celsius' })).json(),
    ).toEqual({ unit: 'celsius' });
    expectProblem(
      await api('PUT', '/weather/unit', { unit: 'kelvin' }),
      400,
      'validation',
    );
    await api('POST', '/weather/feedback', { feeling: 'too-cold' });
    expect((await api('DELETE', '/weather/offset')).statusCode).toBe(204);
    const [row] = await t.db
      .select({
        unit: userWeather.temperatureUnit,
        offset: userWeather.temperatureOffset,
        hereAt: userWeather.hereLocatedAt,
      })
      .from(userWeather)
      .where(eq(userWeather.userId, t.owner.id));
    expect(row).toEqual({ unit: 'celsius', offset: 0, hereAt: null });
  });

  it('searches places through the server, never logging the name; a failed search is a 503', async () => {
    t.logs.clear();
    const res = await api('GET', '/weather/places?q=Brooklyn');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      data: [
        {
          label: 'Brooklyn, New York, United States',
          latitude: 40.65,
          longitude: -73.95,
          timeZone: 'America/New_York',
        },
      ],
    });
    expect(t.logs.text()).not.toMatch(/brooklyn/i);
    expect((await api('GET', '/weather/places?q=Atlantis')).json()).toEqual({
      data: [],
    });
    expectProblem(await api('GET', '/weather/places?q=B'), 400, 'validation');
    stub.fail(true);
    try {
      expectProblem(
        await api('GET', '/weather/places?q=Brooklyn'),
        503,
        'busy',
      );
    } finally {
      stub.fail(false);
    }
  });

  it("keeps the page's location budget per user: the 11th set in a minute is a 429", async () => {
    const email = 'api-wanderer@example.com';
    await t.register(email);
    const wanderer = (await deviceToken(t, { email })).token;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await api(
        'PUT',
        '/weather/here',
        { latitude: 40 + i / 10, longitude: -73.98 },
        wanderer,
      );
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    // Someone else's count is their own.
    expect((await api('PUT', '/weather/here', PRECISE)).statusCode).toBe(200);
    expect((await api('DELETE', '/weather/here')).statusCode).toBe(204);
  });

  it('shares each budget with its page twin: the page spends the location writes, the API spends the search', async () => {
    const email = 'two-doors@example.com';
    const cookie = await t.register(email);
    const device = (await deviceToken(t, { email })).token;
    const page = (method: 'GET' | 'POST', url: string, payload?: string) =>
      t.inject({
        method,
        url,
        headers: {
          cookie,
          'hx-request': 'true',
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload,
      });

    // Ten phone locations through the page leave the API none.
    for (let i = 0; i < 10; i++) {
      const res = await page(
        'POST',
        '/weather/here',
        new URLSearchParams({
          latitude: String(40 + i / 10),
          longitude: '-73.98',
        }).toString(),
      );
      expect(res.statusCode).toBe(200);
    }
    const refused = await api(
      'PUT',
      '/weather/here',
      { latitude: 41.5, longitude: -73.98 },
      device,
    );
    expectProblem(refused, 429, 'rate_limited');
    // Home is its own budget on the page and the API, so it is still open.
    expect(
      (await api('PUT', '/weather/home', { name: 'Home', ...PRECISE }, device))
        .statusCode,
    ).toBe(200);

    // Twenty searches through the API leave the page none.
    for (let i = 0; i < 20; i++) {
      const res = await api(
        'GET',
        '/weather/places?q=Brooklyn',
        undefined,
        device,
      );
      expect(res.statusCode).toBe(200);
    }
    expect((await page('GET', '/weather/places?q=Brooklyn')).statusCode).toBe(
      429,
    );
  });

  it('clears the home: no location, no forecast', async () => {
    expect((await api('DELETE', '/weather/home')).statusCode).toBe(204);
    const cleared = (await api('GET', '/weather')).json<Weather>();
    expect(cleared).not.toHaveProperty('source');
    expect(cleared.days).toEqual([]);
    // Set again for the sections below.
    await api('PUT', '/weather/home', { name: 'Fort Greene', ...PRECISE });
  });
});

describe('Today', () => {
  interface Today {
    today: IsoDate;
    weather?: Weather;
    rows: {
      kind: string;
      occasion: string;
      ideas?: { garments: { id: number }[] }[];
      entries?: { id: number; outfit: { id: number } }[];
      nextCursor?: string;
    }[];
  }

  it("is the page's model: the day's weather, then ideas whose cursor is Refresh on GET /ideas", async () => {
    for (let i = 0; i < 4; i += 1) {
      await createGarment(t, { name: `Tee ${i}`, category: 'tops' });
      await createGarment(t, { name: `Jeans ${i}`, category: 'bottoms' });
    }
    const res = await api('GET', '/today');
    expect(res.statusCode, res.body).toBe(200);
    const today = res.json<Today>();
    expect(today.today).toBe(REFERENCE_ANCHOR);
    expect(today.weather?.days.map((d) => d.day)).toEqual([REFERENCE_ANCHOR]);
    expect(today).not.toHaveProperty('muse');
    const [ideas] = today.rows;
    expect(ideas).toMatchObject({ kind: 'ideas', occasion: 'all-day' });
    expect(ideas.ideas).toHaveLength(3);

    const ids = (list: { garments: { id: number }[] }[]) =>
      list.map((idea) => idea.garments.map((g) => g.id));
    const six = (await api('GET', '/ideas?limit=6')).json<{
      data: { garments: { id: number }[] }[];
    }>().data;
    const refreshed = (
      await api('GET', `/ideas?limit=3&cursor=${ideas.nextCursor!}`)
    ).json<{ data: { garments: { id: number }[] }[] }>().data;
    expect([...ids(ideas.ideas!), ...ids(refreshed)]).toEqual(ids(six));
  });

  it('a planned all-day outfit replaces the ideas with its entry', async () => {
    const shirt = await createGarment(t, {
      name: 'Planned',
      category: 'shirt',
    });
    const made = await api('POST', '/outfits', {
      slots: [{ category: 'shirt', garmentId: shirt }],
    });
    expect(made.statusCode, made.body).toBe(201);
    const outfitId = made.json<{ id: number }>().id;
    const planned = await api('POST', '/calendar-entries', {
      outfitId,
      day: REFERENCE_ANCHOR,
      occasion: 'all-day',
    });
    expect(planned.statusCode, planned.body).toBe(201);
    const { rows } = (await api('GET', '/today')).json<Today>();
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'planned',
        occasion: 'all-day',
        entries: [
          expect.objectContaining({
            outfit: expect.objectContaining({ id: outfitId }),
          }),
        ],
      }),
    ]);
  });
});

describe("a trip's weather", () => {
  it('says the destination is not located, then gives its forecast once it is', async () => {
    const made = await api('POST', '/trips', {
      name: 'Weekend',
      startsOn: REFERENCE_ANCHOR,
      endsOn: addDays(REFERENCE_ANCHOR, 2),
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json<{ id: number }>().id;
    expect((await api('GET', `/trips/${id}/weather`)).json()).toEqual({
      status: 'no-location',
      days: [],
      typicalDays: [],
    });

    const located = await api('PUT', `/trips/${id}/destination`, {
      name: 'Brooklyn, New York, United States',
      latitude: 40.6501,
      longitude: -73.94958,
    });
    expect(located.json()).toEqual({
      name: 'Brooklyn, New York, United States',
      latitude: 40.65,
      longitude: -73.95,
      timeZone: null,
    });
    const [row] = await t.db
      .select({ destination: trip.destination, latitude: trip.latitude })
      .from(trip)
      .where(eq(trip.id, id));
    expect(row).toEqual({
      destination: 'Brooklyn, New York, United States',
      latitude: 40.65,
    });
    const weather = (await api('GET', `/trips/${id}/weather`)).json<{
      status: string;
      forecastUnavailable: boolean;
      days: { day: IsoDate; outfit?: { occasion: string } }[];
      typicalDays: unknown[];
    }>();
    expect(weather).toMatchObject({
      status: 'forecast',
      forecastUnavailable: false,
      typicalDays: [],
    });
    expect(weather.days.map((d) => d.day)).toEqual([
      REFERENCE_ANCHOR,
      addDays(REFERENCE_ANCHOR, 1),
      addDays(REFERENCE_ANCHOR, 2),
    ]);
    expect(weather.days[0].outfit?.occasion).toBe('all-day');
  });

  it("asks a Tokyo trip's days in Tokyo's zone, a row apart from home's at the same cell (#678)", async () => {
    const made = await api('POST', '/trips', {
      name: 'Tokyo',
      startsOn: addDays(REFERENCE_ANCHOR, 2),
      endsOn: addDays(REFERENCE_ANCHOR, 3),
    });
    const id = made.json<{ id: number }>().id;
    const [place] = (await api('GET', '/weather/places?q=Tokyo')).json<{
      data: { label: string; timeZone: string | null }[];
    }>().data;
    expect(place.timeZone).toBe('Asia/Tokyo');
    // The home set at Tokyo's cell too: asked in the household's zone.
    const home = {
      name: place.label,
      latitude: 35.6895,
      longitude: 139.69171,
      timeZone: 'Asia/Tokyo',
    };
    expect((await api('PUT', '/weather/home', home)).statusCode).toBe(200);
    expect((await api('GET', '/weather')).statusCode).toBe(200);
    const kept200 = await api('PUT', `/trips/${id}/destination`, {
      ...home,
      timeZone: 'America/Chicago',
    });
    expect(kept200.statusCode).toBe(200);
    // The answer names the zone that was saved.
    expect(kept200.json<{ timeZone: string | null }>().timeZone).toBe(
      'America/Chicago',
    );
    expect(
      (await api('PUT', `/trips/${id}/destination`, home)).statusCode,
    ).toBe(200);
    const [row] = await t.db
      .select({ timeZone: trip.timeZone })
      .from(trip)
      .where(eq(trip.id, id));
    expect(row.timeZone).toBe('Asia/Tokyo');
    const weather = (await api('GET', `/trips/${id}/weather`)).json<{
      days: { day: IsoDate }[];
    }>();
    expect(weather.days.map((d) => d.day)).toEqual([
      addDays(REFERENCE_ANCHOR, 2),
      addDays(REFERENCE_ANCHOR, 3),
    ]);
    expect(
      stub.hits.some(
        (hit) =>
          hit.startsWith('/v1/forecast?latitude=35.69') &&
          hit.includes('timezone=Asia%2FTokyo'),
      ),
    ).toBe(true);
    const zones = await t.db
      .select({ timeZone: weatherForecast.timeZone })
      .from(weatherForecast)
      .where(
        and(
          eq(weatherForecast.latitude, 35.69),
          eq(weatherForecast.longitude, 139.69),
        ),
      );
    expect(zones.map((z) => z.timeZone).sort()).toEqual([
      'America/New_York',
      'Asia/Tokyo',
    ]);
    // A zone Intl does not know is none: the household's days, never a 400.
    const unknown = await api('PUT', `/trips/${id}/destination`, {
      ...home,
      timeZone: 'Mars/Olympus_Mons',
    });
    expect(unknown.statusCode).toBe(200);
    // The answer says what was kept: no zone.
    expect(unknown.json<{ timeZone: string | null }>().timeZone).toBeNull();
    const [kept] = await t.db
      .select({ timeZone: trip.timeZone })
      .from(trip)
      .where(eq(trip.id, id));
    expect(kept.timeZone).toBeNull();
    // A search result that named no zone comes back as null (#807): the
    // same fallback, on the destination and on the home.
    const sentBack = { ...home, timeZone: null };
    const nulled = await api('PUT', `/trips/${id}/destination`, sentBack);
    expect(nulled.statusCode).toBe(200);
    expect(nulled.json<{ timeZone: string | null }>().timeZone).toBeNull();
    expect((await api('PUT', '/weather/home', sentBack)).statusCode).toBe(200);
    // Created at a picked place (#684): located with the trip, its label the destination.
    const placed = await api('POST', '/trips', {
      name: 'Tokyo again',
      destination: 'tokyo',
      startsOn: addDays(REFERENCE_ANCHOR, 2),
      endsOn: addDays(REFERENCE_ANCHOR, 3),
      place: home,
    });
    expect(placed.statusCode, placed.body).toBe(201);
    const [located] = await t.db
      .select()
      .from(trip)
      .where(eq(trip.id, placed.json<{ id: number }>().id));
    expect(located).toMatchObject({
      destination: place.label,
      latitude: 35.69,
      longitude: 139.69,
      timeZone: 'Asia/Tokyo',
    });
    // Home again for the sections below.
    await api('PUT', '/weather/home', { name: 'Fort Greene', ...PRECISE });
  });
});

describe('one answer to the rain on every surface (#759)', () => {
  const placeOf = (row: { latitude: number; longitude: number }) =>
    and(
      eq(weatherForecast.latitude, row.latitude),
      eq(weatherForecast.longitude, row.longitude),
    );
  interface Outfit {
    rain: boolean;
    needsWaterResistance: boolean;
    takeUmbrella: boolean;
  }
  // The ideas' weather carries no `rain`: the two answers are the contract.
  const pick = (o: Outfit | undefined) => ({
    needsWaterResistance: o?.needsWaterResistance,
    takeUmbrella: o?.takeUmbrella,
  });

  it('a cool rainy day with a water-resistant hat is the umbrella on all of them, a capsule without the hat included', async () => {
    const shirt = await createGarment(t, {
      name: 'Rain tee',
      category: 'tops',
    });
    const made = await api('POST', '/outfits', {
      slots: [{ category: 'tops', garmentId: shirt }],
    });
    const outfitId = made.json<{ id: number }>().id;
    const entry = await api('POST', '/calendar-entries', {
      outfitId,
      day: REFERENCE_ANCHOR,
      occasion: 'all-day',
    });
    expect(entry.statusCode, entry.body).toBe(201);
    const capsule = (await api('POST', '/capsules', { name: 'Hatless' })).json<{
      id: number;
    }>().id;
    const tripId = (
      await api('POST', '/trips', {
        name: 'Rainy weekend',
        startsOn: REFERENCE_ANCHOR,
        endsOn: addDays(REFERENCE_ANCHOR, 1),
      })
    ).json<{ id: number }>().id;
    await api('PUT', `/trips/${tripId}/destination`, {
      name: 'Brooklyn, New York, United States',
      latitude: 40.6501,
      longitude: -73.94958,
    });
    const mcp = await createAccessToken(t);

    const rows = await t.db.select().from(weatherForecast);
    const rainy = async () => {
      for (const row of rows) {
        await t.db
          .update(weatherForecast)
          .set({
            fetchedAt: new Date(),
            forecast: {
              ...row.forecast!,
              days: row.forecast!.days.map((day) =>
                day.day === REFERENCE_ANCHOR
                  ? {
                      ...day,
                      hours: day.hours.map((h) => ({
                        ...h,
                        feelsLike: 12,
                        precipitationChance:
                          h.hour >= 8 && h.hour < 22 ? 90 : 0,
                      })),
                    }
                  : day,
              ),
            },
          })
          .where(placeOf(row));
      }
    };
    const everywhere = async () => {
      const weather = (
        await api('GET', `/weather?to=${REFERENCE_ANCHOR}`)
      ).json<{ days: { outfit?: Outfit }[] }>();
      const todayRes = await api('GET', '/today');
      const today = todayRes.json<{
        weather: { days: { outfit?: Outfit }[] };
        rows: { kind: string; weather?: Outfit }[];
      }>();
      const ideasRes = await api(
        'GET',
        `/ideas?day=${REFERENCE_ANCHOR}&capsuleId=${capsule}`,
      );
      const ideas = ideasRes.json<{ weather: Outfit }>();
      const tripDays = (await api('GET', `/trips/${tripId}/weather`)).json<{
        days: { outfit?: Outfit }[];
      }>();
      const calendar = await tool<{
        entries: { weather?: { outfit?: Outfit } }[];
      }>(t, mcp, 'get_calendar', {
        from: REFERENCE_ANCHOR,
        to: REFERENCE_ANCHOR,
      });
      const mcpToday = await tool<{ weather: { outfit?: Outfit } }>(
        t,
        mcp,
        'get_today',
      );
      const mcpTrip = await tool<{
        weather: { days: { outfit?: Outfit }[] };
      }>(t, mcp, 'get_trip', { tripId });
      const mcpWeather = await tool<{ days: { outfit?: Outfit }[] }>(
        t,
        mcp,
        'get_weather',
        { from: REFERENCE_ANCHOR, to: REFERENCE_ANCHOR },
      );
      return [
        weather.days[0].outfit,
        today.weather.days[0].outfit,
        ideas.weather,
        tripDays.days[0].outfit,
        calendar.entries[0].weather?.outfit,
        mcpToday.weather.outfit,
        mcpTrip.weather.days[0].outfit,
        mcpWeather.days[0].outfit,
      ].map(pick);
    };
    // "Plan my week" for the rainy day, undone so it can be asked again. The
    // owner's trips (this one, earlier specs') moved off the week meanwhile:
    // the planner skips a trip's days (#684), and the rain is the same at home.
    const shiftTrips = (days: number) =>
      asFixture(t.db, (tx) =>
        tx
          .update(trip)
          .set({
            startsOn: sql`${trip.startsOn} + ${days}::int`,
            endsOn: sql`${trip.endsOn} + ${days}::int`,
          })
          .where(eq(trip.ownerId, t.owner.id)),
      );
    const planProblems = async () => {
      await shiftTrips(90);
      // Back even when the plan throws: later steps read the trip on its days.
      const planned = await api('POST', '/week-plans').finally(() =>
        shiftTrips(-90),
      );
      expect(planned.statusCode, planned.body).toBe(200);
      const plan = planned.json<{
        weekPlanId: number;
        planned: { day: IsoDate; problems: string[] }[];
      }>();
      const day = plan.planned.find((p) => p.day === REFERENCE_ANCHOR);
      expect(day, 'the rainy day is planned').toBeDefined();
      await api('DELETE', `/week-plans/${plan.weekPlanId}`);
      return day!.problems;
    };
    // The trip day's ideas page: "Take the umbrella" is the umbrella advice,
    // which must agree with the trip's own forecast (the packing list's gear).
    const tripIdeasUmbrella = async () => {
      const page = await t.inject({
        method: 'GET',
        url: `/outfits/ideas?for=trip:${tripId}:${REFERENCE_ANCHOR}`,
      });
      expect(page.statusCode).toBe(200);
      return page.body.includes('Take the umbrella');
    };
    try {
      await rainy();
      expect(await tripIdeasUmbrella()).toBe(false);
      const bare = await everywhere();
      expect(bare).toEqual(
        Array(bare.length).fill({
          needsWaterResistance: true,
          takeUmbrella: false,
        }),
      );

      expect(
        (
          await api('PUT', '/week-template', {
            days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
              weekday,
              around: ['night-out'],
            })),
          })
        ).statusCode,
      ).toBe(200);
      for (let i = 0; i < 4; i += 1) {
        await createGarment(t, { name: `Plan top ${i}`, category: 'tops' });
        await createGarment(t, {
          name: `Plan jeans ${i}`,
          category: 'bottoms',
        });
      }
      expect(await planProblems()).toContain('needs-water-resistance');

      const hat = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: {
          name: 'Rain hat',
          category: 'accessories',
          type: 'hat',
          props: '1',
          color: ['black'],
          waterResistant: 'true',
        },
      });
      expect(hat.statusCode).toBe(302);
      // A trip day answers with what is on its packing list, never with the
      // closet at home: the hat is not on the list yet.
      const TRIP_SURFACES = [3, 6];
      const answers = (all: ReturnType<typeof pick>[], trip: boolean) =>
        all.map((_, i) => ({
          needsWaterResistance: TRIP_SURFACES.includes(i) ? !trip : false,
          takeUmbrella: TRIP_SURFACES.includes(i) ? trip : true,
        }));
      const atHome = await everywhere();
      expect(atHome).toEqual(answers(atHome, false));
      expect(await tripIdeasUmbrella()).toBe(false);
      // The plan reads the gear as Today does: the hat answers the rain.
      expect(await planProblems()).not.toContain('needs-water-resistance');

      // In the wash it is not the closet's gear: every surface, the plan
      // included, asks the outfit for water resistance, as the closet at
      // home stands (a dirty hat is not available). Washed again, it is back.
      const [hatRow] = await t.db
        .select({ id: garment.id })
        .from(garment)
        .where(eq(garment.name, 'Rain hat'));
      await asFixture(t.db, (tx) =>
        tx
          .update(garment)
          .set({ washAfterWears: 1 })
          .where(eq(garment.id, hatRow.id)),
      );
      const wornHat = await api(
        'PUT',
        `/garments/${hatRow.id}/wears/${REFERENCE_ANCHOR}`,
        {},
      );
      expect(wornHat.statusCode, wornHat.body).toBe(200);
      const dirty = await everywhere();
      expect(dirty).toEqual(
        dirty.map(() => ({ needsWaterResistance: true, takeUmbrella: false })),
      );
      expect(await planProblems()).toContain('needs-water-resistance');
      const washed = await api('POST', `/garments/${hatRow.id}/washes`, {
        day: REFERENCE_ANCHOR,
      });
      expect(washed.statusCode, washed.body).toBe(200);
      expect(await everywhere()).toEqual(atHome);

      // Planned to come: the umbrella answer, packed or not.
      const hatOutfit = await api('POST', '/outfits', {
        slots: [{ category: 'accessories', garmentId: hatRow.id }],
      });
      const added = await api('POST', `/trips/${tripId}/outfits`, {
        outfitId: hatOutfit.json<{ id: number }>().id,
      });
      expect(added.statusCode, added.body).toBe(201);
      const listed = await everywhere();
      expect(listed).toEqual(answers(listed, true));
      expect(await tripIdeasUmbrella()).toBe(true);

      // Lent out, the closet at home has no gear (not available), but it is
      // still the one on the trip's list.
      await asFixture(t.db, (tx) =>
        tx
          .update(garment)
          .set({ away: 'lent' })
          .where(eq(garment.id, hatRow.id)),
      );
      const lent = await everywhere();
      expect(lent).toEqual(
        lent.map((_, i) =>
          TRIP_SURFACES.includes(i)
            ? { needsWaterResistance: false, takeUmbrella: true }
            : { needsWaterResistance: true, takeUmbrella: false },
        ),
      );
      expect(await tripIdeasUmbrella()).toBe(true);

      // Archived, it left the closet: it is no gear even on the list.
      const archived = await api('PUT', `/garments/${hatRow.id}/status`, {
        status: 'archived',
      });
      expect(archived.statusCode, archived.body).toBe(200);
      const gone = await everywhere();
      expect(gone).toEqual(
        gone.map(() => ({ needsWaterResistance: true, takeUmbrella: false })),
      );
      expect(await tripIdeasUmbrella()).toBe(false);
    } finally {
      for (const row of rows) {
        await t.db
          .update(weatherForecast)
          .set({ forecast: row.forecast, fetchedAt: row.fetchedAt })
          .where(placeOf(row));
      }
      await asFixture(t.db, (tx) =>
        tx.delete(garment).where(eq(garment.name, 'Rain hat')),
      );
    }
  });
});
