import fastifyRateLimit, { type RateLimitOptions } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { loggableUrl } from '../loggable-url';
import type { Logger } from '../../logger';

/**
 * Brute-force limits for the routes that check a password, and a ceiling on
 * the routes that fetch a user's URL and on the MCP endpoint. Registered
 * once at the root by createApp() with `global: false`: nothing is limited
 * unless its route opts in with `config: { rateLimit: SIGN_IN_LIMIT }` (or
 * ACCOUNT_LIMIT, LINK_IMPORT_LIMIT, WEATHER_SEARCH_LIMIT, WEATHER_LOCATION_LIMIT,
 * VITALS_LIMIT, CLIENT_ERROR_LIMIT, MCP_LIMIT; HEALTH_LIMIT, SIGN_IN_LIMIT's
 * two sign-in doors, SIGN_IN_ACCOUNT_LIMIT, BEARER_REFUSAL_LIMIT, API_LIMIT, API_PHOTO_LIMIT, PHOTO_UPLOAD_LIMIT and PUSH_TEST_LIMIT through one
 * createRateLimit checker each). Every limited route counts on its own. Counters live in
 * process memory, which is right for the single container this runs as.
 *
 * The client address is `request.ip`, which Fastify takes from
 * X-Forwarded-For only when the peer is in TRUSTED_PROXIES. Behind Caddy,
 * TRUSTED_PROXIES must include Caddy's address, or every visitor shares
 * Caddy's IP and one person's typos lock out the household (AGENTS.md,
 * Deployment).
 */
export async function registerRateLimit(
  fastify: FastifyInstance,
  logger: Logger,
): Promise<void> {
  await fastify.register(fastifyRateLimit, {
    global: false,
    // An HttpError, so the web layer's error handler renders it as a page
    // with its status and message like any other refusal.
    errorResponseBuilder: (_request, context) =>
      new HttpError(
        context.statusCode,
        t('TOO_MANY_ATTEMPTS', { after: context.after }),
        { retryAfterSeconds: Math.ceil(context.ttl / 1000) },
      ),
    onExceeded: (request: FastifyRequest, key: string) => {
      logger.warn(
        `Rate limit reached: ${request.method} ${loggableUrl(request)} for ${key}`,
      );
    },
  });
}

/**
 * The 429 a route that counts through `createRateLimit` throws: the same
 * refusal and wording as a route-config limit's (errorResponseBuilder
 * above; the plugin's "after" is English, as the catalog is).
 */
export function tooManyAttempts(
  ttlInSeconds: number,
  { quiet }: { quiet?: true } = {},
): HttpError {
  const [count, unit] =
    ttlInSeconds < 60
      ? [Math.max(1, Math.round(ttlInSeconds)), 'second']
      : [Math.round(ttlInSeconds / 60), 'minute'];
  return new HttpError(
    429,
    t('TOO_MANY_ATTEMPTS', {
      after: `${count} ${unit}${count === 1 ? '' : 's'}`,
    }),
    { retryAfterSeconds: Math.ceil(ttlInSeconds), quiet },
  );
}

/** A `createRateLimit` checker: one budget, however many routes count on it. */
export type RateLimitChecker = ReturnType<FastifyInstance['createRateLimit']>;

/**
 * Counts `request` against `checker` and throws the 429 past its limit,
 * logged naming `who` (an address, a token row id; never a secret). For the
 * budgets several routes share, which route config cannot express.
 */
export async function enforceLimit(
  checker: RateLimitChecker,
  request: FastifyRequest,
  { logger, who }: { logger: Logger; who: string },
): Promise<void> {
  const exceeded = await countAgainst(checker, request);
  if (exceeded) throw limitReached(request, exceeded, { logger, who });
}

/**
 * Counts `request` against `checker`: undefined while there is room, else
 * the seconds until there is. For a caller that decides itself whether an
 * exhausted budget refuses (the bearer gate); everyone else enforceLimit.
 */
export async function countAgainst(
  checker: RateLimitChecker,
  request: FastifyRequest,
): Promise<{ ttlInSeconds: number; ttlMs: number } | undefined> {
  const verdict = await checker(request);
  // `isAllowed` is the plugin's allow list; the count is isExceeded.
  if (verdict.isAllowed || !verdict.isExceeded) return undefined;
  return { ttlInSeconds: verdict.ttlInSeconds, ttlMs: verdict.ttl };
}

/** enforceLimit's refusal, logged naming `who`. */
export function limitReached(
  request: FastifyRequest,
  { ttlInSeconds }: { ttlInSeconds: number },
  { logger, who }: { logger: Logger; who: string },
): HttpError {
  logger.warn(
    `Rate limit reached: ${request.method} ${loggableUrl(request)} for ${who}`,
  );
  return tooManyAttempts(ttlInSeconds);
}

/**
 * Every limit's window, in the milliseconds the plugin counts in (it would
 * parse '1 minute' to the same). A number, and each limit typed by
 * `satisfies` rather than annotated, so the page audit reads `max` and
 * `timeWindow` straight off these constants to pace the steps that share
 * a budget (scripts/audit/budget.ts).
 */
const MINUTE_MS = 60_000;

/**
 * Signing in with a password: per client address, before the body is read.
 * ONE checker for both doors, the login page and the API's device sign-in
 * (`signInLimits.address`, createSignInLimits in src/web/auth/sign-in.ts),
 * so an address gets 5 guesses a minute in all, the 6th a 429, whichever
 * door it knocks on. Registration counts the same limit as its own route
 * config.
 */
export const SIGN_IN_LIMIT = {
  max: 5,
  timeWindow: MINUTE_MS,
  keyGenerator: (request: FastifyRequest) => request.ip,
} satisfies RateLimitOptions;

/**
 * Signing in, per account as well as per address: guesses spread over many
 * addresses are capped per account too. ONE checker for both doors
 * (`signInLimits.account`, #705), keyed by the SHA-256 of the normalized
 * email (createSignInLimits), never the address itself; a preHandler, since
 * the email is in the body. Every attempt counts, a right one included, so
 * a guesser can hold an account's doors shut, but only for the window: the
 * owner gets in again within a minute of the guessing stopping, and a
 * guesser holding it needs 5 tries a minute from somewhere, which the
 * per-address limit and the warn line make visible.
 */
export const SIGN_IN_ACCOUNT_LIMIT = {
  max: 5,
  timeWindow: MINUTE_MS,
};

/**
 * Every route that checks the current password: change password, change
 * email, delete account, creating a personal access token (src/web/auth/
 * token-routes.tsx) and creating an edit link (INVITE_LIMIT). Per signed-in user, whatever address
 * they come from. A preHandler, so it runs after the session gate (the web
 * plugin's own preHandler) has guaranteed `request.auth`; an anonymous
 * request is answered by the gate and never counted.
 */
export const ACCOUNT_LIMIT = {
  max: 5,
  timeWindow: MINUTE_MS,
  hook: 'preHandler',
  keyGenerator: (request) => `user ${request.auth!.user.id}`,
} satisfies RateLimitOptions;

/**
 * Creating an invite (src/web/sharing/routes.tsx, #668): ACCOUNT_LIMIT for
 * an edit link, the one that checks the password; a view link checks none
 * and stays one uncounted tap. A preHandler, so the body is parsed and
 * validated (CreateInviteBody) when this reads it.
 */
export const INVITE_LIMIT = {
  ...ACCOUNT_LIMIT,
  allowList: (request) =>
    (request.body as { permission?: string } | null)?.permission !== 'MANAGE',
} satisfies RateLimitOptions;

/**
 * The routes that fetch a URL the user supplied through the outbound
 * fetcher: the link import, its photo choice and the API's link import
 * (one import fetches the page and up to MAX_PHOTO_CHOICES images). All
 * three count on ONE checker, `linkImportLimit`, built once in webPlugin,
 * never a route's `config.rateLimit`: each of those, and each
 * createRateLimit call, gets a store of its own, so two would allow ten a
 * minute each. Per user, whichever door (the page's session or the API's
 * device token), like ACCOUNT_LIMIT: generous for someone adding what
 * they bought, and a ceiling on how hard the server can be made to hammer
 * another site.
 */
export const LINK_IMPORT_LIMIT = {
  max: 10,
  timeWindow: MINUTE_MS,
  keyGenerator: (request) =>
    `user ${request.accessToken?.user.id ?? request.auth!.user.id}`,
} satisfies RateLimitOptions;

/**
 * The weather's city search (GET /weather/places, src/web/weather; a trip's,
 * and the API's GET /api/v1/weather/places): each search is a call to
 * Open-Meteo's geocoding. Per user (the session's or the device token's),
 * like LINK_IMPORT_LIMIT: room for a few tries at a spelling, and a ceiling
 * on how hard one account can make the server ask a free service. The
 * weather page's search and the API's share ONE checker
 * (`WeatherLimits.search`), so a user's two doors are 20 in all; a trip's
 * search stays a route config of its own (decisions 2026-11-13).
 */
export const WEATHER_SEARCH_LIMIT = {
  max: 20,
  timeWindow: MINUTE_MS,
  hook: 'preHandler',
  keyGenerator: (request) =>
    `user ${request.accessToken?.user.id ?? request.auth!.user.id}`,
} satisfies RateLimitOptions;

/**
 * The routes that set a location the weather will be fetched for (POST
 * /weather/home, /weather/here, /trips/:id/destination, and their API twins
 * PUT /api/v1/weather/home, /weather/here, /trips/{id}/destination). Every
 * new rounded location misses the forecast cache, so each is an Open-Meteo
 * request and a weather_forecast row: per user (the session's or the device
 * token's), room for a few tries and a ceiling on how many one account can
 * make the server fetch and keep. Each page route counts on its own, and
 * shares its checker with its API twin (`WeatherLimits`: home, here,
 * destination), so a user's two doors are 10 in all per write.
 */
export const WEATHER_LOCATION_LIMIT = {
  max: 10,
  timeWindow: MINUTE_MS,
  hook: 'preHandler',
  keyGenerator: (request) =>
    `user ${request.accessToken?.user.id ?? request.auth!.user.id}`,
} satisfies RateLimitOptions;

/**
 * The budgets a weather page route and its API twin share, one checker each
 * built by `createWeatherLimits` in webPlugin: the place search, the home
 * and phone-location writes and a trip's destination. A route's
 * `config.rateLimit` would count the page and the API apart, doubling the
 * bound on the same Open-Meteo calls.
 */
export interface WeatherLimits {
  weatherLimits: {
    search: RateLimitChecker;
    home: RateLimitChecker;
    here: RateLimitChecker;
    destination: RateLimitChecker;
  };
}

export function createWeatherLimits(
  app: FastifyInstance,
): WeatherLimits['weatherLimits'] {
  return {
    search: app.createRateLimit(WEATHER_SEARCH_LIMIT),
    home: app.createRateLimit(WEATHER_LOCATION_LIMIT),
    here: app.createRateLimit(WEATHER_LOCATION_LIMIT),
    destination: app.createRateLimit(WEATHER_LOCATION_LIMIT),
  };
}

/**
 * The devices' timing beacon (POST /metrics/vitals, src/web/metrics): per
 * signed-in user, like ACCOUNT_LIMIT. public/js/vitals.js sends a batch at
 * most every few seconds while pages change and once as a page hides, so a
 * busy minute of taps is a handful; this is a ceiling on a device (or a
 * script with a session) filling the histograms.
 */
export const VITALS_LIMIT = {
  max: 30,
  timeWindow: MINUTE_MS,
  hook: 'preHandler',
  keyGenerator: (request) => `user ${request.auth!.user.id}`,
} satisfies RateLimitOptions;

/**
 * The pages' script errors (POST /errors/client, src/web/metrics/
 * client-errors.ts), each forwarded to Bugsink: per signed-in user, like
 * VITALS_LIMIT. public/js/errors.js already sends a distinct error once per
 * document and at most five a page; this caps a looping page, or a script
 * with a session, flooding the tracker.
 */
export const CLIENT_ERROR_LIMIT = {
  max: 10,
  timeWindow: MINUTE_MS,
  hook: 'preHandler',
  keyGenerator: (request) => `user ${request.auth!.user.id}`,
} satisfies RateLimitOptions;

/**
 * The profile's test notification (POST /push/test, src/web/push): per
 * signed-in user. Each one is a request per device to the push services
 * under the server's VAPID identity, so a looping client could get that
 * identity throttled and delay everyone's reminders. Past it the route
 * answers its own 200 fragment ("try again in a minute") and sends
 * nothing: an htmx button's result line, not a 429. One createRateLimit
 * checker, counted in the handler.
 */
export const PUSH_TEST_LIMIT = {
  max: 3,
  timeWindow: MINUTE_MS,
  keyGenerator: (request: FastifyRequest) =>
    `user ${request.auth!.user.id} push test`,
};

/**
 * /health/ready and its alias /healthz (src/web/health), on ONE
 * createRateLimit checker so the alias is no second budget: per client
 * address, since the route is public and each request is a database
 * round-trip (an unlimited one is a free lever on the pool). Its callers
 * are a container healthcheck every 30 s from 127.0.0.1, a smoke boot,
 * and phones on a stale connectivity.js still probing /healthz every 5 s
 * while offline; with TRUSTED_PROXIES covering Caddy (the `trusted_proxies`
 * check says when it does not) each phone is its own address. /health/live checks nothing and is never limited.
 */
export const HEALTH_LIMIT = {
  max: 60,
  timeWindow: MINUTE_MS,
  keyGenerator: (request: FastifyRequest) => request.ip,
};

/**
 * The bearer surfaces' refused credentials (/mcp and /api, the bearer gate,
 * src/web/auth/bearer-gate.ts): per client address, on ONE checker both
 * surfaces count on (`bearerRefusalLimit`, built in webPlugin), as
 * HEALTH_LIMIT is per address. Only a refusal is counted, never a token
 * that opens: a household behind one address keeps working while a
 * stranger probes. Past it, a missing, malformed or unknown credential is a
 * 429 instead of the 401; a revoked or other-kind token stays the 401, so a
 * signed-out device behind a throttled address still learns to sign in.
 */
export const BEARER_REFUSAL_LIMIT = {
  max: 30,
  timeWindow: MINUTE_MS,
  keyGenerator: (request: FastifyRequest) => `refused ${request.ip}`,
};

/**
 * The MCP endpoint (src/web/mcp): per personal access token, a preHandler
 * after the bearer gate has authenticated it at onRequest (a refused
 * credential counts on BEARER_REFUSAL_LIMIT instead). One request is one
 * JSON-RPC message (a batch is refused), so this counts tool calls. An
 * agent calls tools in bursts; this is room for a busy conversation and a
 * ceiling on a runaway loop.
 */
export const MCP_LIMIT = {
  max: 120,
  timeWindow: MINUTE_MS,
  hook: 'preHandler',
  keyGenerator: (request) => `token ${request.accessToken!.tokenId}`,
} satisfies RateLimitOptions;

/**
 * Every authenticated /api/v1 route (src/web/api/plugin.ts): per device
 * token, counted after the token is authenticated (a refused credential
 * counts on BEARER_REFUSAL_LIMIT instead), as MCP_LIMIT is. One checker for
 * the whole API: a client's budget, not a route's.
 */
export const API_LIMIT = {
  max: 120,
  timeWindow: MINUTE_MS,
  keyGenerator: (request: FastifyRequest) =>
    `token ${request.accessToken!.tokenId}`,
};

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * An /api/v1 route that serves a private photo's bytes (servePrivatePhoto):
     * it counts on API_PHOTO_LIMIT, never API_LIMIT (the API plugin's
     * preHandler picks). The one way an API route serves image bytes.
     */
    apiPhotoBytes?: boolean;
  }
}

/**
 * The API's photo-byte routes (`config: { apiPhotoBytes: true }`), per
 * device token and a budget of their own: a client paints a page of
 * thumbnails with one request each, and on API_LIMIT's 120 a minute a page
 * of 50 would 429 its own JSON calls. 600 lets a 50-item page load twice a
 * minute with room for a few more; photo bytes are immutable for a year
 * (private-photo.ts), so a client that respects the cache stays far below it.
 * The 401 is never counted, as with API_LIMIT.
 */
export const API_PHOTO_LIMIT = {
  max: 600,
  timeWindow: MINUTE_MS,
  keyGenerator: (request: FastifyRequest) =>
    `token ${request.accessToken!.tokenId} photos`,
};

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * A route that reads an uploaded file (a photo, a mask): it counts on
     * PHOTO_UPLOAD_LIMIT (photoUploadHook). A multipart request to any
     * other route is a 415 before its handler, so an upload route without
     * the mark refuses its own uploads.
     */
    photoUpload?: boolean;
  }
}

/**
 * Every route that reads an uploaded file (`config: { photoUpload: true }`),
 * pages and /api/v1 alike, on ONE checker (`photoUploadHook`, webPlugin):
 * per user, the session's or the device token's, so a user's doors are one
 * budget. Each upload is buffered or decoded (a HEIC on the one decoder
 * thread, #699), so this is a ceiling on how much of that one account can
 * ask for. A page's library pick of many photos is one request, but a
 * device syncing through the API sends one per photo, and a camera roll's
 * worth (MAX_DRAFTS_PER_USER, 30) must fit with room to spare. Counted
 * before the body is read.
 */
export const PHOTO_UPLOAD_LIMIT = {
  max: 60,
  timeWindow: MINUTE_MS,
  keyGenerator: (request) =>
    `user ${request.accessToken?.user.id ?? request.auth!.user.id} uploads`,
} satisfies RateLimitOptions;

/**
 * webPlugin's preHandler for every route under it (after the session gate
 * and the bearer gate, before any handler reads a part): a `photoUpload`
 * route counts on PHOTO_UPLOAD_LIMIT; a multipart body sent anywhere else
 * is a 415 (the share target's stateless fallback aside, which reads no
 * file: share-fallback.ts).
 */
export function photoUploadHook(
  checker: RateLimitChecker,
  logger: Logger,
): (request: FastifyRequest) => Promise<void> {
  return async (request) => {
    const { config } = request.routeOptions;
    if (config.photoUpload === true) {
      await enforceLimit(checker, request, {
        logger,
        who: `user ${request.accessToken?.user.id ?? request.auth!.user.id}`,
      });
      return;
    }
    if (request.isMultipart() && config.stateless !== true) {
      throw new HttpError(415, undefined, {
        logDetail: 'a multipart body to a route that takes no upload',
      });
    }
  };
}

/**
 * The MCP tool that imports a link (add_garment_from_link) fetches a
 * stranger's site like the link import's routes, so it gets their budget,
 * per user, through `createRateLimit` (it is one call among many to the
 * same endpoint, not a route of its own).
 */
export const MCP_LINK_IMPORT_LIMIT = {
  max: 10,
  timeWindow: MINUTE_MS,
  keyGenerator: (request: FastifyRequest) =>
    `user ${request.accessToken!.user.id}`,
};
