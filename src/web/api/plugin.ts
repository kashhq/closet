import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authApiRoutes } from '../auth/api-routes';
import { calendarApiRoutes } from '../calendar/api-routes';
import { capsuleApiRoutes } from '../capsules/api-routes';
import { galleryApiRoutes } from '../gallery/api-routes';
import { lookApiRoutes } from '../inspiration/api-routes';
import type { InspirationLinkLimit } from '../inspiration/writes';
import type { SignInLimits } from '../auth/sign-in';
import { type BearerRefusalLimit, createBearerGate } from '../auth/bearer-gate';
import { insightsApiRoutes } from '../insights/api-routes';
import { outfitApiRoutes } from '../outfits/api-routes';
import type { WebOptions } from '../plugin';
import { Problem } from '../problem';
import { selfieApiRoutes } from '../selfies/api-routes';
import { sharingApiRoutes } from '../sharing/api-routes';
import { styleApiRoutes } from '../style/api-routes';
import { syncApiRoutes } from '../sync/api-routes';
import {
  API_LIMIT,
  API_PHOTO_LIMIT,
  enforceLimit,
  type WeatherLimits,
} from '../security/rate-limit';
import { sizesApiRoutes } from '../sizes/api-routes';
import { API_PREFIX } from '../surface';
import { todayApiRoutes } from '../today/api-routes';
import { tripApiRoutes } from '../trips/api-routes';
import { wardrobeApiRoutes } from '../wardrobe/api-routes';
import { weatherApiRoutes } from '../weather/api-routes';
import { wearApiRoutes } from '../wears/api-routes';
import { weekPlanApiRoutes } from '../week-plan/api-routes';
import { wishlistApiRoutes } from '../wishlist/api-routes';
import type { LinkImportLimit } from '../wardrobe/link-import/import';
import { apiResponses, requireContract } from './contract';
import spec from './openapi.json';
import { refuseQueryToken, signInAgain } from './token-auth';
import { declareQuerystring, jsonApiValidator } from './validator';

export type ApiOptions = WebOptions &
  SignInLimits &
  BearerRefusalLimit &
  LinkImportLimit &
  InspirationLinkLimit &
  WeatherLimits;

/**
 * Registers apiPlugin under API_PREFIX (webPlugin, scripts/api-spec.ts).
 * The prefix belongs to a scope around it, never to apiPlugin's own
 * options: Fastify hands a plugin's `prefix` option on to every plugin it
 * registers with those options, which would double it on the feature routes.
 */
export async function registerApi(
  app: FastifyInstance,
  options: ApiOptions,
): Promise<void> {
  await app.register(
    async (scope) => {
      await scope.register(apiPlugin, options);
    },
    { prefix: API_PREFIX },
  );
}

/** The committed spec as served: what was reviewed is what clients read. */
const SPEC_BODY = JSON.stringify(spec);

/**
 * /api/v1, the native clients' JSON API (#190; docs/plans/2026-11-12-
 * json-api.md, src/web/api/AGENTS.md). Registered by webPlugin with the
 * prefix; every route under it is the `api` surface (assignSurface, the
 * root onRoute hook), so the cookie is never read, the same-origin check
 * lets a request without Origin through, and every error is problem+json.
 * In this scope, for every route:
 *  - a JSON body is validated as sent, never coerced (jsonApiValidator);
 *  - registration refuses a route without its contract (requireContract);
 *  - onRequest: a token in the query string is a 400, then the bearer gate
 *    (a device token, refusals on BEARER_REFUSAL_LIMIT) unless
 *    `config.public` (before the body is read);
 *  - preHandler: API_LIMIT per token, one budget for the whole API, but a
 *    route with `config.apiPhotoBytes` counts on API_PHOTO_LIMIT instead.
 * A feature's API routes live beside its pages (`src/web/<feature>/
 * api-routes.ts`) and register here.
 */
export const apiPlugin: FastifyPluginAsyncTypebox<ApiOptions> = async (
  app,
  options,
) => {
  const { db, apiLogger, bearerRefusalLimit, refusalSummaries } = options;
  // Every route's 4xx and 5xx refer to it (apiResponses).
  app.addSchema(Problem);
  app.setValidatorCompiler(jsonApiValidator(app));
  app.addHook('onRoute', requireContract);
  app.addHook('onRoute', declareQuerystring);
  app.addHook('onRequest', refuseQueryToken);
  app.addHook(
    'onRequest',
    createBearerGate({
      db,
      logger: apiLogger,
      label: 'API',
      kind: 'device',
      refusalLimit: bearerRefusalLimit,
      refusalSummaries,
      // quiet: the gate logs its refusals itself (bearer-gate.ts).
      refusal: () => signInAgain({ quiet: true }),
      readsShare: true,
    }),
  );
  const apiLimit = app.createRateLimit(API_LIMIT);
  const photoLimit = app.createRateLimit(API_PHOTO_LIMIT);
  app.addHook('preHandler', async (request: FastifyRequest) => {
    const { config } = request.routeOptions;
    if (config.public === true) return;
    await enforceLimit(config.apiPhotoBytes ? photoLimit : apiLimit, request, {
      logger: apiLogger,
      who: `token ${request.accessToken!.tokenId}`,
    });
  });

  app.get(
    '/openapi.json',
    {
      config: { public: true },
      schema: {
        operationId: 'getOpenApi',
        tags: ['meta'],
        summary: 'This API, as OpenAPI 3.1',
        security: [],
        response: apiResponses({
          200: Type.Object(
            {},
            {
              additionalProperties: true,
              description: 'The OpenAPI document',
            },
          ),
        }),
      },
    },
    // A string is sent as it is, never through the response schema.
    async (_request, reply) => reply.type('application/json').send(SPEC_BODY),
  );

  await app.register(authApiRoutes, options);
  await app.register(wardrobeApiRoutes, options);
  await app.register(wearApiRoutes, options);
  await app.register(outfitApiRoutes, options);
  await app.register(calendarApiRoutes, options);
  await app.register(todayApiRoutes, options);
  await app.register(weekPlanApiRoutes, options);
  await app.register(tripApiRoutes, options);
  await app.register(wishlistApiRoutes, options);
  await app.register(capsuleApiRoutes, options);
  await app.register(galleryApiRoutes, options);
  await app.register(selfieApiRoutes, options);
  await app.register(lookApiRoutes, options);
  await app.register(insightsApiRoutes, options);
  await app.register(sizesApiRoutes, options);
  await app.register(styleApiRoutes, options);
  await app.register(sharingApiRoutes, options);
  await app.register(syncApiRoutes, options);
  // Only with WEATHER_ENABLED, as /weather/* (webPlugin).
  const { weather } = options;
  if (weather) await app.register(weatherApiRoutes, { ...options, weather });
};
