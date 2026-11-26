import { and, lt, notExists, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  trip,
  userWeather,
  weatherForecast,
  weatherNormals,
} from '../db/schema';
import type { Logger } from '../logger';

/**
 * The weather caches' prune (audit weather-cache-never-pruned): both caches
 * are keyed by client-supplied coordinates (rounded to ~1 km), so a phone
 * that moves about with "Use my location" adds a row per cell for ever.
 * Nightly, a row that no user's home or here location and no trip's
 * destination sits at, and that was last attempted (good or not) more than
 * WEATHER_CACHE_RETENTION_DAYS ago, is deleted. A location someone still
 * uses is kept at any age: it is refreshed on demand, so its row is only as
 * old as the last page that wanted it, and deleting it would cost a
 * provider call for nothing.
 *
 * A row is matched on its coordinates alone, never its zone: a trip
 * destination from before #678 has no zone and reads APP_TIMEZONE's row, so
 * comparing zones would delete a row a trip still reads. The only cost is
 * keeping a stale row for a zone nobody asks for.
 *
 * Age is the process's clock, the one that stamped `attempted_at`
 * (location-cache.ts), so `now` is passed in and a spec controls it.
 * A row deleted just as a user picks that location is refetched by the next
 * read: the cache is rebuildable, which is why no lock is taken.
 */

/** How long an unreferenced location's row stays after its last attempt. */
export const WEATHER_CACHE_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WeatherPrune {
  forecasts: number;
  normals: number;
}

/** The coordinates of every place a user or a trip still points at. */
function referenced(cache: typeof weatherForecast | typeof weatherNormals) {
  return and(
    notExists(
      sql`(select 1 from ${userWeather}
        where (${userWeather.homeLatitude} = ${cache.latitude} and ${userWeather.homeLongitude} = ${cache.longitude})
           or (${userWeather.hereLatitude} = ${cache.latitude} and ${userWeather.hereLongitude} = ${cache.longitude}))`,
    ),
    notExists(
      sql`(select 1 from ${trip}
        where ${trip.latitude} = ${cache.latitude} and ${trip.longitude} = ${cache.longitude})`,
    ),
  );
}

/** Used by server.ts's nightly `weather_prune` job. */
export async function pruneWeatherCaches(
  { db, logger }: { db: Db; logger: Logger },
  now: Date,
): Promise<WeatherPrune> {
  const started = performance.now();
  const cutoff = new Date(
    now.getTime() - WEATHER_CACHE_RETENTION_DAYS * DAY_MS,
  );
  const forecasts = await db
    .delete(weatherForecast)
    .where(
      and(lt(weatherForecast.attemptedAt, cutoff), referenced(weatherForecast)),
    )
    .returning({ latitude: weatherForecast.latitude });
  const normals = await db
    .delete(weatherNormals)
    .where(
      and(lt(weatherNormals.attemptedAt, cutoff), referenced(weatherNormals)),
    )
    .returning({ latitude: weatherNormals.latitude });
  logger.info(
    `Pruned ${forecasts.length} forecast and ${normals.length} climate normals row(s) of locations unused since ${cutoff.toISOString()}, ${Math.round(performance.now() - started)} ms`,
  );
  return { forecasts: forecasts.length, normals: normals.length };
}
