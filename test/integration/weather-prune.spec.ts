import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  trip,
  userWeather,
  weatherForecast,
  weatherNormals,
} from '../../src/db/schema';
import {
  pruneWeatherCaches,
  WEATHER_CACHE_RETENTION_DAYS,
} from '../../src/maintenance/weather-prune';
import { asFixture, createTestApp, type TestApp, userIdOf } from './harness';

/**
 * The weather caches' nightly prune (src/maintenance/weather-prune.ts):
 * unreferenced locations last attempted over 30 days before the `now` the
 * job is handed. Every age is relative to that `now`, so the gate's clock
 * shift moves nothing.
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.cleanup();
});

const NOW = new Date('2026-06-15T03:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
const ZONE = 'America/New_York';

async function cacheRow(latitude: number, attemptedDaysAgo: number) {
  const row = {
    latitude,
    longitude: 10,
    timeZone: ZONE,
    attemptedAt: daysAgo(attemptedDaysAgo),
  };
  await t.db.insert(weatherForecast).values(row);
  await t.db.insert(weatherNormals).values(row);
}

const forecastLatitudes = async () =>
  (await t.db.select().from(weatherForecast))
    .map((row) => row.latitude)
    .sort((a, b) => a - b);

const normalsLatitudes = async () =>
  (await t.db.select().from(weatherNormals))
    .map((row) => row.latitude)
    .sort((a, b) => a - b);

const prune = () =>
  pruneWeatherCaches(
    { db: t.db, logger: t.logger.child({ logger: 'Weather' }) },
    NOW,
  );

describe('the weather cache prune', () => {
  it("deletes unused locations past the retention in both caches and keeps a home's, a here's, a trip's and young ones whatever their age; timed as a job", async () => {
    await t.register('weather-prune@example.com');
    const userId = await userIdOf(t, 'weather-prune@example.com');
    const stale = WEATHER_CACHE_RETENTION_DAYS + 1;
    await cacheRow(1, stale); // unused and old: pruned
    await cacheRow(2, stale); // a home
    await cacheRow(3, stale); // a here
    await cacheRow(4, stale); // a trip's
    await cacheRow(5, WEATHER_CACHE_RETENTION_DAYS - 1); // unused, young
    await cacheRow(6, WEATHER_CACHE_RETENTION_DAYS + 200); // unused and old: pruned
    await t.db.insert(userWeather).values({
      userId,
      homeName: 'Home',
      homeLatitude: 2,
      homeLongitude: 10,
      hereLatitude: 3,
      hereLongitude: 10,
      hereLocatedAt: daysAgo(40),
    });
    // No zone, as a trip located before #678: it reads the row of any zone.
    await asFixture(t.db, (tx) =>
      tx.insert(trip).values({
        ownerId: userId,
        name: 'Trip',
        destination: 'Somewhere',
        latitude: 4,
        longitude: 10,
        startsOn: '2026-01-01',
        endsOn: '2026-01-05',
      }),
    );

    const run = t.metrics.timeJob('weather_prune', prune);
    expect(await run()).toEqual({ forecasts: 2, normals: 2 });

    expect(await forecastLatitudes()).toEqual([2, 3, 4, 5]);
    expect(await normalsLatitudes()).toEqual([2, 3, 4, 5]);
    expect(t.logs.messages('info', 'Weather')).toContainEqual(
      expect.stringMatching(
        /^Pruned 2 forecast and 2 climate normals row\(s\) of locations unused since 2026-05-16T03:00:00.000Z, \d+ ms$/,
      ),
    );
    const { body } = await t.metrics.exposition();
    expect(body).toMatch(
      /^job_duration_seconds_count\{name="weather_prune",outcome="success"\} 1$/m,
    );

    // The home's row goes once nobody points at it.
    await t.db
      .update(userWeather)
      .set({ homeName: null, homeLatitude: null, homeLongitude: null })
      .where(eq(userWeather.userId, userId));
    expect(await prune()).toEqual({ forecasts: 1, normals: 1 });
    expect(await forecastLatitudes()).toEqual([3, 4, 5]);
    expect(await normalsLatitudes()).toEqual([3, 4, 5]);
  });
});
