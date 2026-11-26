import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { CloneType, Type } from '@sinclair/typebox';
import { addDays, daysBetween, todayIn } from '../../calendar-date';
import { DEFAULT_OCCASION, OCCASIONS } from '../../wardrobe/occasions';
import { FEELINGS, OFFSET_LIMIT, OFFSET_STEP } from '../../weather/temperature';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { literals } from '../api/resource';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { IsoDateSchema } from '../schemas';
import { enforceLimit } from '../security/rate-limit';
import { actorOf } from '../sharing/access';
import {
  PlaceQuery,
  keptPlace,
  pickedPlace,
  placeAnswer,
  postedLocation,
} from './place-input';
import { rainGearForDays } from './queries';
import {
  nudgeWeatherOffset,
  removeWeatherHere,
  removeWeatherHome,
  resetWeatherOffset,
  setWeatherHere,
  setWeatherHome,
  setWeatherUnit,
} from './weather-actions';
import { userWeather, type WeatherService } from './service';
import { MAX_SUMMARY_DAYS } from './summary';
import {
  HerePlace,
  KeptPlace,
  LocationInput,
  PlaceInput,
  PlaceList,
  toPlaceResource,
  toWeatherResource,
  weatherOnly,
  UnitInput,
  WeatherResource,
} from './weather-resource';

const TemperatureFeedback = Type.Object(
  {
    feeling: CloneType(literals(FEELINGS), {
      description:
        '`too-warm`: the weather felt warmer than it read, so lighter ideas follow; `too-cold` the other way',
    }),
  },
  { title: 'TemperatureFeedback' },
);

const TemperatureOffset = Type.Object(
  {
    offset: Type.Number({
      minimum: -OFFSET_LIMIT,
      maximum: OFFSET_LIMIT,
      description: `Your temperature offset now: °C added to the feels-like temperature before ideas are matched to it. Each feedback moves it ${OFFSET_STEP}, within ±${OFFSET_LIMIT}`,
    }),
  },
  { title: 'TemperatureOffset' },
);

const WeatherQuery = Type.Object({
  from: Type.Optional(IsoDateSchema),
  to: Type.Optional(IsoDateSchema),
  occasion: Type.Optional(
    CloneType(literals(OCCASIONS), {
      description:
        'What each day asks of an outfit is for it: all day unless given',
    }),
  ),
});

const cleared = { 204: Type.Null({ description: 'Cleared' }) };

export interface WeatherApiOptions extends ApiOptions {
  weather: WeatherService;
}

/** The place search's answer when Open-Meteo did not give one: worth a retry. */
function searchFailed(): HttpError {
  return new HttpError(503, t('weather.SEARCH_FAILED'));
}

/**
 * The weather on /api/v1 (#193c, #195a), each route its page twin's writer
 * or read (operations.ts names the twin). Registered by apiPlugin only with
 * WEATHER_ENABLED, as /weather/* is (webPlugin): without a service none of
 * these exists (the problem 404), so nothing can store a location. The
 * token's user's own settings and forecast, as the profile's: no
 * `?ownerId=`. The search and the location writes count on their page
 * twins' checkers (`weatherLimits`, one budget per user between the two
 * doors); the search reaches Open-Meteo only through the service's fetcher. The logs name the
 * user, never a place.
 */
export const weatherApiRoutes: FastifyPluginCallbackTypebox<
  WeatherApiOptions
> = (app, { db, config, logger, weather, weatherLimits }, done) => {
  app.get(
    '/weather',
    {
      schema: {
        operationId: 'getWeather',
        tags: ['weather'],
        summary: 'Your weather settings and forecast',
        description: weatherOnly(
          `The header line's weather and the calendar's day chips: where you are (the home, or the phone while fresh), your unit and offset, and each forecast day asked for with what it asks of an outfit. Seven days unless both ends are sent: from today without dates, from \`from\` with it alone, up to \`to\` with it alone. At most ${MAX_SUMMARY_DAYS} days, else a 400; days the forecast does not reach are left out. Fetches the forecast only when none is kept for the place (else serves it, refreshing it behind once stale).`,
        ),
        querystring: WeatherQuery,
        response: apiResponses({ 200: WeatherResource }),
      },
    },
    async (request) => {
      const { query } = request;
      const now = new Date();
      const today = todayIn(config.timeZone, now);
      // A week by default, as GET /calendar-entries: from today, or up to
      // `to` when only it is sent.
      const from =
        query.from ?? (query.to === undefined ? today : addDays(query.to, -6));
      const to = query.to ?? addDays(from, 6);
      const span = daysBetween(from, to) + 1;
      if (span < 1 || span > MAX_SUMMARY_DAYS) {
        throw new HttpError(400, t('api.DAY_RANGE', { max: MAX_SUMMARY_DAYS }));
      }
      const days = Array.from({ length: span }, (_, i) => addDays(from, i));
      const { userId } = actorOf(request);
      const own = await userWeather(db, weather, userId, now);
      const occasion = query.occasion ?? DEFAULT_OCCASION;
      const rainGear = await rainGearForDays(
        db,
        userId,
        own,
        days.map((day) => ({ day, occasion })),
      );
      return toWeatherResource(own, days, occasion, rainGear);
    },
  );

  app.get(
    '/weather/places',
    {
      schema: {
        operationId: 'searchPlaces',
        tags: ['weather'],
        summary: 'Finds places by name',
        description: weatherOnly(
          "The profile's and a trip's city search (Open-Meteo's geocoding, through the server): pick one for PUT /weather/home or PUT /trips/{id}/destination. 20 a minute per user; a 503 when the search did not answer, worth a retry.",
        ),
        querystring: CloneType(PlaceQuery, {
          description: 'The name typed, 2 to 100 characters',
        }),
        response: apiResponses({ 200: PlaceList }),
      },
      // The typed city never reaches the request log (loggableUrl).
      config: { secretPath: true },
    },
    async (request) => {
      await enforceLimit(weatherLimits.search, request, {
        logger,
        who: `user ${actorOf(request).userId}`,
      });
      const answer = await placeAnswer(weather, request.query);
      if ('failed' in answer) throw searchFailed();
      return { data: answer.places.map(toPlaceResource) };
    },
  );

  app.put(
    '/weather/home',
    {
      schema: {
        operationId: 'setWeatherHome',
        tags: ['weather'],
        summary: 'Sets your home city',
        description: weatherOnly(
          "The profile's pick from the place search: the forecast is for it whenever the phone's location is not fresh. Set-state. 10 a minute per user (each new place is a forecast to fetch).",
        ),
        body: PlaceInput,
        response: apiResponses({ 200: KeptPlace }),
      },
    },
    async (request) => {
      const userId = actorOf(request).userId;
      await enforceLimit(weatherLimits.home, request, {
        logger,
        who: `user ${userId}`,
      });
      const home = pickedPlace(request.body);
      await setWeatherHome({ db, logger }, actorOf(request), home);
      return keptPlace(home);
    },
  );

  app.delete(
    '/weather/home',
    {
      schema: {
        operationId: 'clearWeatherHome',
        tags: ['weather'],
        summary: 'Forgets your home city',
        description: weatherOnly(),
        response: apiResponses(cleared),
      },
    },
    async (request, reply) => {
      await removeWeatherHome({ db, logger }, actorOf(request));
      return reply.status(204).send(null);
    },
  );

  app.put(
    '/weather/here',
    {
      schema: {
        operationId: 'setWeatherHere',
        tags: ['weather'],
        summary: "Sets the phone's location",
        description: weatherOnly(
          '"Use my location": the forecast is for it, standing in for home while fresh; send it again to keep it fresh. Round it on the phone too: a precise position need never leave it. 10 a minute per user.',
        ),
        body: LocationInput,
        response: apiResponses({ 200: HerePlace }),
      },
    },
    async (request) => {
      const userId = actorOf(request).userId;
      await enforceLimit(weatherLimits.here, request, {
        logger,
        who: `user ${userId}`,
      });
      const location = postedLocation(request.body);
      const at = new Date();
      await setWeatherHere({ db, logger }, actorOf(request), location, at);
      return { ...location, locatedAt: at.toISOString() };
    },
  );

  app.delete(
    '/weather/here',
    {
      schema: {
        operationId: 'clearWeatherHere',
        tags: ['weather'],
        summary: "Forgets the phone's location",
        description: weatherOnly(
          'Stop: the forecast is for the home again, if one is set.',
        ),
        response: apiResponses(cleared),
      },
    },
    async (request, reply) => {
      await removeWeatherHere({ db, logger }, actorOf(request));
      return reply.status(204).send(null);
    },
  );

  app.put(
    '/weather/unit',
    {
      schema: {
        operationId: 'setTemperatureUnit',
        tags: ['weather'],
        summary: 'Sets how you read temperatures',
        description: weatherOnly(
          'Display only: every temperature here stays °C. Set-state.',
        ),
        body: UnitInput,
        response: apiResponses({ 200: UnitInput }),
      },
    },
    async (request) => {
      const { unit } = request.body;
      await setWeatherUnit({ db, logger }, actorOf(request), unit);
      return { unit };
    },
  );

  app.post(
    '/weather/feedback',
    {
      schema: {
        operationId: 'sendTemperatureFeedback',
        tags: ['weather'],
        summary: 'Says an outfit felt too warm or too cold',
        description: weatherOnly(
          'An Ideas card\'s and the profile\'s "Too warm" / "Too cold": your temperature offset moves a step, and the next ideas are matched to it. Not idempotent: each call is a step.',
        ),
        body: TemperatureFeedback,
        response: apiResponses({ 200: TemperatureOffset }),
      },
    },
    async (request) => {
      const offset = await nudgeWeatherOffset(
        { db, logger },
        actorOf(request),
        request.body.feeling,
      );
      return { offset };
    },
  );

  app.delete(
    '/weather/offset',
    {
      schema: {
        operationId: 'resetTemperatureOffset',
        tags: ['weather'],
        summary: 'Resets your temperature offset to 0',
        description: weatherOnly(
          "The profile's Reset: the feedback's steps are forgotten, and ideas are matched to the forecast as it reads.",
        ),
        response: apiResponses(cleared),
      },
    },
    async (request, reply) => {
      await resetWeatherOffset({ db, logger }, actorOf(request));
      return reply.status(204).send(null);
    },
  );

  done();
};
