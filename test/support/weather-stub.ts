import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppOptions } from '../../src/app';
import { daysBetween, todayIn } from '../../src/calendar-date';
import { forecastDayOf, weatherFor } from '../../src/seed/weather';
import { REFERENCE_ANCHOR } from '../../src/seed/simulate';
import type { DayForecast } from '../../src/weather/forecast';

/**
 * A stand-in for Open-Meteo, so no spec, CI run or screenshot ever calls the
 * real service (#14). An HTTP server on the loopback alias 127.0.0.2 (Linux
 * routes all of 127/8 to lo; macOS needs `sudo ifconfig lo0 alias
 * 127.0.0.2`), admitted by an address policy for that one address, like the
 * link import's shop (test/integration/link-sites.ts). Hand `options` to
 * createTestApp (`weather`) or createApp (the e2e test server,
 * test/support/test-server.ts).
 *
 * The forecast is the seed's simulated New York weather (src/seed/weather.ts,
 * forecastDayOf, the demo persona's days) from today in the requested zone:
 * deterministic for a date, and the weather the demo's planned week was
 * drawn for. The archive (climate normals, #10's far trip days) answers
 * the same simulated days for the requested years, so the normals are New
 * York's as the seed models them. The search knows a few places (PLACES).
 */

/**
 * The instant a spec that renders the stub's weather pins Date to
 * (`vi.useFakeTimers({ toFake: ['Date'], now: STUB_WEATHER_NOW })`, before
 * its app boots): the weather is the date's, so unpinned, which days rain or
 * need a layer, and so the branches the run covers, move with the real date
 * (the ratchet's backend branch coverage drifted by one every few days). The
 * seed's reference anchor at noon in New York, the day the bibles are
 * written for.
 */
export const STUB_WEATHER_NOW = new Date(`${REFERENCE_ANCHOR}T16:00:00Z`);

const STUB_IP = '127.0.0.2';
// Whose simulated weather it serves: Theo's, for every location.
const WEATHER_KEY = 'demo';

interface StubPlace {
  name: string;
  latitude: number;
  longitude: number;
  admin1?: string;
  country: string;
  /** Open-Meteo's `timezone` per result: a trip's days are asked in it (#678). */
  timezone: string;
}

/** What the search answers, by the lower-case query. */
const PLACES: Readonly<Record<string, readonly StubPlace[]>> = {
  brooklyn: [
    {
      name: 'Brooklyn',
      latitude: 40.6501,
      longitude: -73.94958,
      admin1: 'New York',
      country: 'United States',
      timezone: 'America/New_York',
    },
  ],
  'fort greene': [
    {
      name: 'Fort Greene',
      latitude: 40.68982,
      longitude: -73.97625,
      admin1: 'New York',
      country: 'United States',
      timezone: 'America/New_York',
    },
  ],
  // A trip's destination (#10: the demo's Austin conference, the specs' trips).
  austin: [
    {
      name: 'Austin',
      latitude: 30.26715,
      longitude: -97.74306,
      admin1: 'Texas',
      country: 'United States',
      timezone: 'America/Chicago',
    },
  ],
  springfield: [
    {
      name: 'Springfield',
      latitude: 39.80172,
      longitude: -89.64371,
      admin1: 'Illinois',
      country: 'United States',
      timezone: 'America/Chicago',
    },
    {
      name: 'Springfield',
      latitude: 42.10148,
      longitude: -72.58981,
      admin1: 'Massachusetts',
      country: 'United States',
      timezone: 'America/New_York',
    },
  ],
  // Across the date line from the household (#678's specs).
  tokyo: [
    {
      name: 'Tokyo',
      latitude: 35.6895,
      longitude: 139.69171,
      country: 'Japan',
      timezone: 'Asia/Tokyo',
    },
  ],
};

export interface WeatherStub {
  options: NonNullable<AppOptions['weather']>;
  /** Every request, path and query, in order. */
  hits: string[];
  /** From now on, answer every request with a 500 (true) or normally (false). */
  fail(failing: boolean): void;
  /**
   * From now on, keep every answer back (true; requests are still recorded
   * in `hits` as they arrive), or send the kept ones and answer at once
   * again (false). For a spec that must see what is served while a refresh
   * is under way: without it, an ask that reaches the cache late (a loaded
   * machine) finds the refresh already saved (#184).
   */
  hold(holding: boolean): void;
  /**
   * From now on, answer the forecast `degrees` °C colder at every hour (a
   * cold snap, #768); 0 restores it. The app caches a location's answer, so
   * set it before that location's first read.
   */
  chill(degrees: number): void;
  close(): Promise<void>;
}

/** Open-Meteo's forecast answer for `days` (the fields the app reads). */
function forecastAnswer(days: readonly DayForecast[], timeZone: string) {
  const hours = days.flatMap((day) =>
    day.hours.map((h) => ({
      ...h,
      time: `${day.day}T${String(h.hour).padStart(2, '0')}:00`,
    })),
  );
  return {
    timezone: timeZone,
    hourly: {
      time: hours.map((h) => h.time),
      apparent_temperature: hours.map((h) => h.feelsLike),
      precipitation_probability: hours.map((h) => h.precipitationChance),
      weather_code: hours.map((h) => h.code),
    },
    daily: {
      time: days.map((d) => d.day),
      weather_code: days.map((d) => d.code),
      temperature_2m_max: days.map((d) => d.high),
      temperature_2m_min: days.map((d) => d.low),
      precipitation_probability_max: days.map((d) => d.precipitationChance),
    },
  };
}

/**
 * Open-Meteo's archive answer (the fields the app reads) for `first` to
 * `last`: the seed's simulated New York days as observations, air highs and
 * lows, the hours' feels-like range, and 5 mm on a rainy day.
 */
function archiveAnswer(first: string, last: string, timeZone: string) {
  const count = daysBetween(first, last) + 1;
  const days = weatherFor(WEATHER_KEY, first, count).map((weather) => ({
    weather,
    forecast: forecastDayOf(WEATHER_KEY, weather),
  }));
  const feels = (day: DayForecast) => day.hours.map((h) => h.feelsLike);
  return {
    timezone: timeZone,
    daily: {
      time: days.map(({ weather }) => weather.day),
      temperature_2m_max: days.map(({ forecast }) => forecast.high),
      temperature_2m_min: days.map(({ forecast }) => forecast.low),
      apparent_temperature_max: days.map(({ forecast }) =>
        Math.max(...feels(forecast)),
      ),
      apparent_temperature_min: days.map(({ forecast }) =>
        Math.min(...feels(forecast)),
      ),
      precipitation_sum: days.map(({ weather }) => (weather.rain ? 5 : 0)),
    },
  };
}

export async function startWeatherStub(): Promise<WeatherStub> {
  const hits: string[] = [];
  let failing = false;
  let chill = 0;
  // The answers hold(true) keeps back, sent by hold(false).
  let held: (() => void)[] | null = null;
  // Ten years of simulated days take a moment; a range is computed once.
  const archives = new Map<string, ReturnType<typeof archiveAnswer>>();
  // Each endpoint's answer to a request, by path.
  const endpoints: Record<string, (params: URLSearchParams) => unknown> = {
    '/v1/forecast': (params) => {
      const timeZone = params.get('timezone') ?? 'GMT';
      const count = Number(params.get('forecast_days') ?? 7);
      const today = todayIn(timeZone, new Date());
      const days = weatherFor(WEATHER_KEY, today, count).map((w) => {
        const day = forecastDayOf(WEATHER_KEY, w);
        return {
          ...day,
          hours: day.hours.map((h) => ({
            ...h,
            feelsLike: h.feelsLike - chill,
          })),
        };
      });
      return forecastAnswer(days, timeZone);
    },
    '/v1/archive': (params) => {
      const first = params.get('start_date') ?? '';
      const last = params.get('end_date') ?? '';
      const timeZone = params.get('timezone') ?? 'GMT';
      const key = `${first}/${last}/${timeZone}`;
      const answer = archives.get(key) ?? archiveAnswer(first, last, timeZone);
      archives.set(key, answer);
      return answer;
    },
    '/v1/search': (params) => {
      const results = PLACES[(params.get('name') ?? '').toLowerCase()];
      return results ? { results } : { generationtime_ms: 0.1 };
    },
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${STUB_IP}`);
    hits.push(`${url.pathname}${url.search}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const respond = () => {
      if (failing) return json(500, { error: true, reason: 'stubbed failure' });
      const answer = Object.hasOwn(endpoints, url.pathname)
        ? endpoints[url.pathname]
        : undefined;
      if (!answer) return json(404, { error: true, reason: 'Not found' });
      return json(200, answer(url.searchParams));
    };
    if (held) held.push(respond);
    else respond();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, STUB_IP, resolve);
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://${STUB_IP}:${port}`;
  return {
    options: {
      endpoints: {
        forecast: `${base}/v1/forecast`,
        geocoding: `${base}/v1/search`,
        archive: `${base}/v1/archive`,
      },
      fetch: {
        destinations: {
          allowsAddress: (address) => address === STUB_IP,
          allowsPort: () => true,
        },
      },
    },
    hits,
    fail(value) {
      failing = value;
    },
    chill(degrees) {
      chill = degrees;
    },
    hold(holding) {
      const waiting = held ?? [];
      held = holding ? waiting : null;
      if (!holding) for (const respond of waiting) respond();
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
