import type { FastifyPluginAsync } from 'fastify';
import type { CutoutQueueState } from '../cutout/queue-state';
import type { Db } from '../db/client';
import { registerApi } from './api/plugin';
import { createSessionHook } from './auth/require-session';
import { RefusalSummaries } from './auth/refusal-summaries';
import { authRoutes } from './auth/routes';
import { tokenRoutes } from './auth/token-routes';
import type { UntrustedProxyWatch } from './security/untrusted-proxy';
import { sizesRoutes } from './sizes/routes';
import { mcpRoutes } from './mcp/routes';
import {
  BEARER_REFUSAL_LIMIT,
  createWeatherLimits,
  LINK_IMPORT_LIMIT,
  PHOTO_UPLOAD_LIMIT,
  photoUploadHook,
  SIGN_IN_LIMIT,
} from './security/rate-limit';
import type { SessionTokens } from './auth/tokens';
import { calendarRoutes } from './calendar/routes';
import { capsuleRoutes } from './capsules/routes';
import { fileRoutes } from './files/routes';
import { galleryRoutes } from './gallery/routes';
import { inspirationRoutes } from './inspiration/routes';
import { healthRoutes } from './health/routes';
import { insightsRoutes } from './insights/routes';
import type { Photos } from './files/photos';
import type { Logger } from '../logger';
import type { JobRoster } from '../maintenance/scheduled';
import type { ErrorTracker } from '../metrics/error-tracker';
import type { Metrics } from '../metrics/metrics';
import { clientErrorRoutes } from './metrics/client-errors';
import { metricsRoutes } from './metrics/routes';
import { outfitRoutes } from './outfits/routes';
import { pushRoutes } from './push/routes';
import type { OutboundFetcher } from './security/outbound-fetch';
import type { PushSender, VapidConfig } from './push/sender';
import { selfieRoutes } from './selfies/routes';
import { shareRoutes } from './share/routes';
import { shellRoutes } from './shell/routes';
import { styleRoutes } from './style/routes';
import { stylingRoutes } from './styling/routes';
import { sharingRoutes } from './sharing/routes';
import { todayRoutes } from './today/routes';
import { tripRoutes } from './trips/routes';
import { linkImportRoutes } from './wardrobe/link-import/routes';
import { orderReviewRoutes } from './wardrobe/order-mail/routes';
import { lookalikeRoutes } from './wardrobe/lookalike-routes';
import { exportRoutes } from './wardrobe/export-routes';
import { repairRoutes } from './wardrobe/repair-routes';
import { gridRoutes } from './wardrobe/grid-routes';
import { garmentRoutes } from './wardrobe/garment-routes';
import { photoRoutes } from './wardrobe/photo-routes';
import type { WeatherService } from './weather/service';
import { weatherRoutes } from './weather/routes';
import { wearRoutes } from './wears/routes';
import { weekPlanRoutes } from './week-plan/routes';
import { inboxRoutes } from './wishlist/inbox-routes';
import { wishlistRoutes } from './wishlist/routes';

/** Config the routes read, resolved once by createApp(). */
interface WebConfig {
  appName: string;
  iconName: string;
  /**
   * SITE_URL: the origin the same-origin hook accepts beside the request's
   * own, which the session gate reads the page a refused request came from
   * against (src/web/auth/return-to.ts).
   */
  siteUrl: string;
  /** APP_TIMEZONE: the household's IANA zone, which decides "today". */
  timeZone: string;
  /** DISABLE_REGISTRATION: the registration routes redirect to the login page. */
  registrationDisabled: boolean;
  /**
   * PWA_ENABLED: the service worker is registered, so the manifest may name
   * the share target only it can answer (src/web/shell/manifest.ts).
   */
  pwaEnabled: boolean;
  /** Web Push identity; set exactly when PWA_ENABLED (no /push routes otherwise). */
  vapid: VapidConfig | undefined;
  /**
   * ORDER_MAIL_OWNER's account id, resolved at boot, when the order mail is
   * on (#25, #706): the one account whose review list exists
   * (/wardrobe/orders); a 404 for all otherwise.
   */
  orderMailOwnerId: number | undefined;
  /**
   * The build's release (src/build-info.ts): /health/ready's `version` and
   * the MCP server's version.
   */
  release: string;
  /**
   * DATA_PATH and MODELS_PATH: every directory the process writes at
   * runtime, which /health/ready's `storage` check probes (src/web/health).
   */
  storageDirs: readonly string[];
}

export interface WebOptions {
  config: WebConfig;
  logger: Logger;
  db: Db;
  tokens: SessionTokens;
  /** AppOptions.photoUploadMax: PHOTO_UPLOAD_LIMIT's max, for the specs alone. */
  photoUploadMax?: number;
  /**
   * The process's one Photos, built by createApp() (its thumb single-flight
   * must be shared): garment writes store through it, /file/** serves
   * through it, account deletion and reconciliation unlink through it.
   */
  photos: Photos;
  /**
   * The background-removal queue, woken when a photo is queued; its state
   * (running, or waiting for the model) is /health/ready's cutout_queue check.
   */
  cutouts: {
    wake(): void;
    readonly enabled: boolean;
    readonly state: CutoutQueueState;
  };
  /**
   * The timers serve() started, adopted after createApp() built this
   * (src/maintenance/scheduled.ts): /health/ready's cron_jobs check.
   */
  jobs: JobRoster;
  /**
   * Whether a peer outside TRUSTED_PROXIES has sent X-Forwarded-For (a
   * root hook in createApp): /health/ready's trusted_proxies check.
   */
  proxyWatch: UntrustedProxyWatch;
  /**
   * The process's one outbound fetcher (src/web/security/outbound-fetch.ts),
   * built by createApp(): the only way a route fetches a URL a user
   * supplied (the link import).
   */
  fetcher: OutboundFetcher;
  /**
   * The weather (src/web/weather/service.ts), built by createApp() only
   * when WEATHER_ENABLED: undefined means no weather route, view or tool.
   */
  weather: WeatherService | undefined;
  /** Context `Mcp`: one line per MCP tool call (src/web/mcp). */
  mcpLogger: Logger;
  /** Context `Api`: the JSON API's credentials and sign-ins (src/web/api). */
  apiLogger: Logger;
  /**
   * The process's one Web Push sender (src/web/push/sender.ts), built by
   * createApp() exactly when PWA_ENABLED (with `config.vapid`): the
   * profile's test send uses it, and server.ts's reminders.
   */
  push: PushSender | undefined;
  /**
   * The process's metrics (src/metrics/metrics.ts): MCP calls are timed
   * into it, and with METRICS_ENABLED /metrics and the device beacon exist.
   */
  metrics: Metrics;
  /**
   * The error tracker (src/metrics/error-tracker.ts); with SENTRY_DSN the
   * pages' script errors reach it through POST /errors/client.
   */
  errors: ErrorTracker;
}

/**
 * Every feature's routes, registered by createApp() after the root hooks
 * and plugins (same-origin check, rate limits, body parsers, session and
 * page context at preValidation, security headers, cookies, compression,
 * multipart) and the error handler, all of which a plugin inherits only if
 * they exist when it is registered. Encapsulated: the session gate below
 * applies to these routes, not to the static roots or the not-found
 * handler.
 *
 * Request validation is Fastify's own: each route declares a JSON schema
 * for its body, querystring and params with TypeBox, and the handler's
 * request types are inferred from it (FastifyPluginCallbackTypebox). A
 * request that fails it never reaches the handler: the error handler
 * renders a 400 page with Fastify's message. The session gate and the root
 * hook run at preValidation, before that check, so an anonymous request is
 * sent to log in and a failed validation still has its page context.
 *
 * A new feature is one more `app.register(<feature>Routes, options)`.
 */
export const webPlugin: FastifyPluginAsync<WebOptions> = async (
  app,
  options,
) => {
  const { logger } = options;
  app.addHook(
    'preValidation',
    createSessionHook(logger, options.config.siteUrl),
  );
  // Every upload route's PHOTO_UPLOAD_LIMIT, the page's and the API's on one
  // checker; a multipart body anywhere else is a 415 (rate-limit.ts).
  app.addHook(
    'preHandler',
    photoUploadHook(
      app.createRateLimit({
        ...PHOTO_UPLOAD_LIMIT,
        max: options.photoUploadMax ?? PHOTO_UPLOAD_LIMIT.max,
      }),
      logger.child({ logger: 'Security' }),
    ),
  );
  // The budgets a page and its API twin share, one checker each: the two
  // sign-in doors' SIGN_IN_LIMIT (src/web/auth/sign-in.ts), the bearer
  // surfaces' BEARER_REFUSAL_LIMIT (/mcp and /api, bearer-gate.ts), the link
  // imports' LINK_IMPORT_LIMIT (the page's import and photo choice, the
  // API's import), and the inspiration paste's own LINK_IMPORT_LIMIT (the
  // page's, the API's look link import), and the weather's search and
  // location writes (WeatherLimits: the page's and the API's).
  const shared = {
    ...options,
    signInLimit: app.createRateLimit(SIGN_IN_LIMIT),
    bearerRefusalLimit: app.createRateLimit(BEARER_REFUSAL_LIMIT),
    refusalSummaries: new RefusalSummaries(
      options.logger.child({ logger: 'Security' }),
    ),
    linkImportLimit: app.createRateLimit(LINK_IMPORT_LIMIT),
    inspirationLinkLimit: app.createRateLimit(LINK_IMPORT_LIMIT),
    weatherLimits: createWeatherLimits(app),
  };

  await app.register(healthRoutes, options);
  await app.register(shellRoutes, options);
  await app.register(todayRoutes, options);
  await app.register(gridRoutes, options);
  await app.register(garmentRoutes, options);
  await app.register(photoRoutes, options);
  await app.register(linkImportRoutes, shared);
  await app.register(capsuleRoutes, options);
  await app.register(wishlistRoutes, options);
  await app.register(inboxRoutes, options);
  await app.register(styleRoutes, options);
  await app.register(insightsRoutes, options);
  await app.register(wearRoutes, options);
  await app.register(repairRoutes, options);
  await app.register(exportRoutes, options);
  await app.register(lookalikeRoutes, options);
  await app.register(calendarRoutes, options);
  await app.register(tripRoutes, shared);
  await app.register(selfieRoutes, options);
  await app.register(weekPlanRoutes, options);
  await app.register(outfitRoutes, options);
  await app.register(stylingRoutes, options);
  await app.register(galleryRoutes, options);
  await app.register(inspirationRoutes, shared);
  await app.register(authRoutes, shared);
  await app.register(tokenRoutes, options);
  await app.register(sizesRoutes, options);
  await app.register(sharingRoutes, options);
  // No ORDER_MAIL_JMAP_TOKEN: the review list is a 404 for everyone
  // (src/web/wardrobe/order-mail).
  // Registered on or off: off, every route is the 404 a missing route
  // would be. Unregistered, /wardrobe/orders fell to /wardrobe/:id, whose
  // id check answered 400.
  await app.register(orderReviewRoutes, {
    ...options,
    orderMailOwnerId: options.config.orderMailOwnerId,
  });
  // WEATHER_ENABLED=false: no /weather route, so nothing stores a location.
  const { weather } = options;
  if (weather) await app.register(weatherRoutes, { ...shared, weather });
  // The bearer surfaces (src/web/surface.ts): the session gate above passes
  // them, each authenticates its own kind of token.
  await app.register(mcpRoutes, shared);
  await registerApi(app, shared);
  const { vapid } = options.config;
  if (vapid && options.push) {
    await app.register(pushRoutes, {
      db: options.db,
      logger,
      appName: options.config.appName,
      vapid,
      sender: options.push,
    });
  }
  await app.register(fileRoutes, options);
  await app.register(shareRoutes, options);
  // METRICS_ENABLED=false: no /metrics and no beacon (src/web/metrics).
  if (options.metrics.enabled) await app.register(metricsRoutes, options);
  // No SENTRY_DSN: no /errors/client (src/web/metrics/client-errors.ts).
  if (options.errors.enabled) await app.register(clientErrorRoutes, options);
};
