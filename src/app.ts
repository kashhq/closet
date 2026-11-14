import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
import Fastify, {
  type FastifyInstance,
  LogController,
  type RouteOptions,
} from 'fastify';
import { type BuildInfo, loadBuildInfo } from './build-info';
import { type Config, orderMailSenders, trustedProxies } from './config';
import { settlesWithin } from './cutout/deadline';
import { countPendingCutouts } from './cutout/queries';
import { CutoutQueue } from './cutout/queue';
import { createDb, type Db, dbConfig } from './db/client';
import { runMigrations } from './db/migrate';
import type { Logger } from './logger';
import { JobRoster } from './maintenance/scheduled';
import { CUTOUT_STOP_MS, HEIC_DECODER_STOP_MS } from './shutdown-budget';
import { createErrorTracker, type ErrorTracker } from './metrics/error-tracker';
import { registerHttpMetrics } from './metrics/http';
import { Metrics } from './metrics/metrics';
import { newRequestId, registerRequestContext } from './request-context';
import { registerStaticAssets } from './static-assets';
import { isStaticPath } from './static-prefixes';
import { normalizeEmail } from './web/auth/queries';
import {
  createCacheClearRelay,
  createSessionResolver,
} from './web/auth/session';
import { createSessionTokens } from './web/auth/tokens';
import { createErrorHandler, DatabaseOutage, HttpError } from './web/errors';
import { configurePhotoUrls } from './web/files/image-url';
import { configurePasswordHashing } from './web/auth/passwords';
import type { HeicDecoderOptions } from './web/files/heic-decoder';
import { createPhotos, type Photos, photosConfig } from './web/files/photos';
import { t } from './web/i18n';
import { loggableUrl } from './web/loggable-url';
import { webPlugin } from './web/plugin';
import { createPushSender, type PushSender } from './web/push/sender';
import {
  createOutboundFetcher,
  type OutboundFetcher,
  type OutboundStandIn,
} from './web/security/outbound-fetch';
import { registerRateLimit } from './web/security/rate-limit';
import {
  assertStatelessRoute,
  createSameOriginHook,
} from './web/security/same-origin';
import { UntrustedProxyWatch } from './web/security/untrusted-proxy';
import { assignSurface, surfaceOf } from './web/surface';
import { isWarmRequest } from './warm-request';
import { createQueuedWriteHook } from './web/offline-writes';
import { createViewContextBuilder } from './web/view-context';
import { createJmapClient } from './web/wardrobe/order-mail/jmap';
import type { OrderMailDeps } from './web/wardrobe/order-mail/poll';
import { OrderMailOwnerWatch } from './web/wardrobe/order-mail/owner-watch';
import { orderMailOwnerId } from './web/wardrobe/order-mail/queries';
import {
  createOpenMeteoClient,
  type WeatherEndpoints,
} from './web/weather/open-meteo';
import {
  createWeatherService,
  type WeatherService,
} from './web/weather/service';

export interface ClosetApp {
  app: FastifyInstance;
  db: Db;
  /**
   * The process's one Photos (its thumb single-flight must be shared): the
   * web layer's, and the nightly reconciliation's in server.ts.
   */
  photos: Photos;
  /**
   * The background-removal queue, never started here: server.ts starts it
   * with the model (main.ts) or a stub (the e2e test server), the specs with
   * a fake runner. The web layer wakes it when it queues a photo; closing
   * the app stops it.
   */
  cutouts: CutoutQueue;
  /**
   * The timers' roster, empty here: server.ts adopts every job it starts,
   * and /health/ready reports a stuck one (src/maintenance/scheduled.ts).
   */
  roster: JobRoster;
  /**
   * The Web Push sender, when PWA_ENABLED: the profile's test send, and the
   * reminders server.ts schedules (createApp never does, so the harness and
   * the CLIs send nothing on their own).
   */
  push: PushSender | undefined;
  /** The weather, when WEATHER_ENABLED: the reminders' forecast line. */
  weather: WeatherService | undefined;
  /**
   * The order mail's poll (#25), when ORDER_MAIL_JMAP_TOKEN is set:
   * server.ts schedules it, the specs run it (pollOrderMail).
   */
  orderMail: OrderMailDeps | undefined;
  /**
   * The process's metrics (src/metrics/): recorded always, exposed at
   * GET /metrics only with METRICS_ENABLED; server.ts times its jobs here.
   */
  metrics: Metrics;
  /**
   * The error tracker (src/metrics/error-tracker.ts): Bugsink with
   * SENTRY_DSN, a no-op without. The metrics and the error handler capture
   * through it; closing the app sends what it still holds.
   */
  errors: ErrorTracker;
}

export interface AppOptions {
  /**
   * The error tracker, when the caller made it first (main.ts does, so a
   * boot that fails before or inside createApp is still captured);
   * otherwise createApp makes its own.
   */
  errors?: ErrorTracker;
  /**
   * The outbound fetcher's test-only options (a scripted resolver, a
   * loopback alias standing in for the internet, the TLS fixture's
   * certificate): the link import's specs pass them; production never does
   * (AGENTS.md Gotchas).
   */
  outboundFetch?: OutboundStandIn;
  /**
   * Open-Meteo's stand-in (test/support/weather-stub.ts): its endpoints and
   * the address policy that admits it. The specs and the e2e test server
   * pass it, so no test reaches the real service; production never does.
   */
  weather?: {
    endpoints: WeatherEndpoints;
    fetch: OutboundStandIn;
  };
  /**
   * Fastmail's stand-in (test/support/jmap-stub.ts): its session URL and
   * the address policy that admits it. The specs pass it; production never
   * does, so no test reaches Fastmail.
   */
  orderMail?: {
    sessionUrl: string;
    fetch: OutboundStandIn;
  };
  /**
   * Sees every route as it is registered: an onRoute hook added before any
   * plugin, since one added after boot sees nothing. The route-coverage
   * spec (test/integration/authorization-coverage.spec.ts) lists the app's
   * id routes with it; production never passes it.
   */
  onRoute?: (route: RouteOptions) => void;
  /**
   * The HEIC decoder's stand-ins (a stub thread, shorter bounds:
   * test/support/heic-stub-worker.ts); production never passes them.
   */
  heicDecoder?: HeicDecoderOptions;
  /**
   * PHOTO_UPLOAD_LIMIT's max: the authorization matrix builds its fixtures
   * through the upload routes, hundreds a minute as one owner. Production
   * never passes it.
   */
  photoUploadMax?: number;
}

function buildInfoFor(config: Config): BuildInfo {
  return loadBuildInfo(config.APP_VERSION, {
    trustStaticId: config.NODE_ENV === 'production',
  });
}

/** The tracker as createApp would make it; main.ts calls it before serve(). */
export function createAppErrorTracker(
  config: Config,
  logger: Logger,
): Promise<ErrorTracker> {
  return createErrorTracker({
    dsn: config.SENTRY_DSN,
    release: buildInfoFor(config).release,
    environment: config.APP_ENV,
    logger: logger.child({ logger: 'ErrorTracking' }),
  });
}

/**
 * Builds the application without binding a port: migrations, the database
 * pool, Photos, then the Fastify instance with its root hooks, plugins,
 * static roots, error and not-found handlers, and the routes (webPlugin).
 * server.ts listens on it; the integration harness
 * (test/integration/harness.ts) drives it with inject(). Closing the app
 * ends the pool.
 *
 * Registration order is behavior: a Fastify plugin inherits only the hooks,
 * content-type parsers, decorators and error handler its parent had when it
 * was registered, so everything below comes before webPlugin.
 */
export async function createApp(
  config: Config,
  logger: Logger,
  options: AppOptions = {},
): Promise<ClosetApp> {
  const boot = logger.child({ logger: 'Bootstrap' });
  // Reverse proxies whose X-Forwarded-* headers are believed, so the rate
  // limits, the same-origin check and canonical URLs see the real client and
  // the address it asked for. Behind Caddy this must include Caddy's
  // address (AGENTS.md, Deployment).
  const trustProxy = trustedProxies(config);
  boot.info(`NODE_ENV: ${config.NODE_ENV}, APP_ENV: ${config.APP_ENV}`);
  boot.info(`DATA_PATH: ${config.DATA_PATH}`);
  boot.info(`Trusted proxies: ${trustProxy.join(', ')}`);
  const build = buildInfoFor(config);
  boot.info(`Release ${build.release}, static cache key ${build.assetVersion}`);

  boot.info(
    `Metrics: ${config.METRICS_ENABLED ? 'on (GET /metrics, POST /metrics/vitals)' : 'off (METRICS_ENABLED=false)'}`,
  );
  const errors =
    options.errors ?? (await createAppErrorTracker(config, logger));
  // The DSN's host only: its key is a credential of sorts.
  boot.info(
    errors.enabled
      ? `Error tracking: on (${new URL(config.SENTRY_DSN).host}, release ${build.release}, environment ${config.APP_ENV})`
      : 'Error tracking: off (SENTRY_DSN unset)',
  );
  const metrics = new Metrics({
    enabled: config.METRICS_ENABLED,
    version: build.release,
    logger: logger.child({ logger: 'Metrics' }),
    errors,
  });

  const database = dbConfig(config);
  // Before anything queries: the schema is current or the boot fails.
  await runMigrations(database, logger.child({ logger: 'Migrations' }));
  const dbLogger = logger.child({ logger: 'Db' });
  // An outage is one error-tracker event (createErrorHandler); it ends the
  // first time the database answers again.
  const outage = new DatabaseOutage(dbLogger);
  const db = createDb(database, dbLogger, {
    onAnswer: () => outage.recovered(),
  });
  // Both can refuse the boot before any onClose hook exists, so a refusal
  // ends the pool here: the owner lookup failing (an unanswering database),
  // an unmounted photo share (StorageIdentityError, main.ts). An owner no
  // account has refuses nothing: it turns the order mail off (OrderMailOwnerWatch).
  const orderMailWatch = new OrderMailOwnerWatch(
    logger.child({ logger: 'OrderMail' }),
  );
  const orderMailOwner = await resolveOrderMailOwner(
    config,
    db,
    orderMailWatch,
  ).catch(async (error: unknown) => {
    await db.$client.end();
    throw error;
  });
  const photos = await createPhotos(
    photosConfig(config),
    db,
    logger.child({ logger: 'Photos' }),
    options.heicDecoder,
  ).catch(async (error: unknown) => {
    await db.$client.end();
    throw error;
  });
  // Before any page renders a /file URL: the key the /file routes verify.
  configurePhotoUrls(config.ACCESS_TOKEN_SECRET);
  configurePasswordHashing(config.PASSWORD_HASH_ROUNDS);
  const cutouts = new CutoutQueue({
    db,
    database,
    photos,
    logger: logger.child({ logger: 'Cutout' }),
    enabled: config.CUTOUT_ENABLED,
    pollMs: config.CUTOUT_POLL_SECONDS * 1000,
    metrics,
  });
  metrics.trackCutoutQueue(() => countPendingCutouts(db));
  const roster = new JobRoster();
  // The only fetcher of user-supplied URLs (the link import); one per
  // process, handed to the web layer like Photos.
  const fetcher = createOutboundFetcher({
    logger: logger.child({ logger: 'OutboundFetch' }),
    ...options.outboundFetch,
  });
  const weather = createWeather(config, logger, db, options.weather);
  const orderMail = createOrderMail(
    config,
    logger,
    db,
    fetcher,
    options.orderMail,
    orderMailOwner,
    orderMailWatch,
  );
  // loadConfig requires both keys and an https SITE_URL when PWA_ENABLED; the
  // sender checks the pair's shape here, so a malformed one fails the boot.
  const vapid = config.PWA_ENABLED
    ? {
        subject: config.SITE_URL,
        publicKey: config.PUBLIC_VAPID_KEY!,
        privateKey: config.PRIVATE_VAPID_KEY!,
      }
    : undefined;
  const push =
    vapid &&
    createPushSender({
      db,
      logger: logger.child({ logger: 'Push' }),
      vapid,
      metrics,
    });

  const app = Fastify({
    trustProxy,
    loggerInstance: logger.child({ logger: 'Fastify' }),
    // One line per request comes from the onResponse hook below.
    logController: new LogController({ disableRequestLogging: true }),
    // Every request's id is minted here (12 hex), never taken from an
    // inbound header: a client could otherwise forge the id that joins its
    // report to Bugsink and the logs.
    genReqId: newRequestId,
    requestIdHeader: false,
    // request.log binds nothing: the logger's mixin adds request_id from
    // async context to every line (src/logger.ts), so Fastify's own
    // `reqId` binding would only repeat it under a second name.
    childLoggerFactory: (parent, _bindings, options) =>
      parent.child({}, options),
  });
  if (options.onRoute) app.addHook('onRoute', options.onRoute);
  // Before any route: every /api/v1 route is the API surface and no other
  // route is (src/web/surface.ts); a route that disagrees stops the boot.
  app.addHook('onRoute', assignSurface);
  // And only STATELESS_ROUTES may skip the same-origin check's Origin.
  app.addHook('onRoute', assertStatelessRoute);
  // The queue and the weather's background refreshes first: a job still
  // running needs the pool to record itself, a refresh to save its row.
  // The error tracker last, so a failure on the way out is still sent.
  app.addHook('onClose', async () => {
    // All inside CUTOUT_STOP_MS: a refresh is an outbound fetch and must
    // not outlast docker stop's grace (src/shutdown-budget.ts); the HEIC
    // thread is terminated, never waited out.
    await Promise.all([
      cutouts.stop(),
      weather && settlesWithin(weather.settled(), CUTOUT_STOP_MS),
      settlesWithin(photos.close(), HEIC_DECODER_STOP_MS),
    ]);
    await db.$client.end();
    await errors.close();
  });

  // First of all the hooks: the request's id and timing (Server-Timing) must
  // be in async context before any hook logs or queries, and every route's
  // template is noted as it is registered.
  registerRequestContext(app);
  registerHttpMetrics(app, metrics);

  // CSRF: every POST/PUT/PATCH/DELETE must come from this site's own pages.
  // onRequest, so it precedes every route and the body is never read; see
  // src/web/security/same-origin.ts.
  app.addHook(
    'onRequest',
    createSameOriginHook({
      siteUrl: config.SITE_URL,
      logger: logger.child({ logger: 'Security' }),
    }),
  );
  // A proxy missing from TRUSTED_PROXIES: one warning, and /health/ready's
  // `trusted_proxies` check (src/web/security/untrusted-proxy.ts).
  const proxyWatch = new UntrustedProxyWatch(
    logger.child({ logger: 'Security' }),
  );
  app.addHook('onRequest', (request, _reply, done) => {
    proxyWatch.observe(request);
    done();
  });
  // Per-route brute-force limits (login, registration, password changes);
  // before the routes so they see the plugin's onRoute hook.
  await registerRateLimit(app, logger.child({ logger: 'RateLimit' }));

  // One session resolution per request: the JWT is verified and the user
  // loaded here and nowhere else (the session gate and views read req.auth).
  // A cookie that no longer opens a session is ended on this reply
  // (cleared, Clear-Site-Data), whatever the route answers.
  // Static paths skip everything, so asset requests never touch the database.
  const tokens = createSessionTokens(config.ACCESS_TOKEN_SECRET);
  const sessionLogger = logger.child({ logger: 'Session' });
  const resolveSession = createSessionResolver({
    db,
    tokens,
    logger: sessionLogger,
  });
  const buildViewContext = createViewContextBuilder({
    appName: config.APP_NAME,
    iconName: config.ICON_NAME,
    siteUrl: config.SITE_URL,
    registrationDisabled: config.DISABLE_REGISTRATION,
    pwaEnabled: config.PWA_ENABLED,
    weatherEnabled: weather !== undefined,
    metricsEnabled: config.METRICS_ENABLED,
    errorTrackingEnabled: errors.enabled,
    orderMailOwnerId: orderMail?.ownerId,
    release: build.release,
    assetVersion: build.assetVersion,
    timeZone: config.APP_TIMEZONE,
  });
  // Declared up front so every request object has the same shape; the hook
  // below fills them (both stay undefined on static paths).
  app.decorateRequest('auth', undefined);
  app.decorateReply('locals', undefined);
  // preValidation, not preHandler: schema validation runs between the two,
  // and a request it refuses must already have its session and page context
  // for the 400 page. It runs for the not-found handler too, so a 404 page
  // shows who is signed in.
  // The bearer surfaces (/mcp, /api, an unmatched /api path included:
  // surfaceOf) skip it too: their credential is a token, the cookie is never
  // read there, and without a page context their errors answer as data.
  app.addHook('preValidation', async (request, reply) => {
    if (isStaticPath(request.url) || surfaceOf(request) !== 'page') return;
    try {
      request.auth = await resolveSession(request, reply);
    } catch (error) {
      // The session could not be read (the database out of reach, #643):
      // the error handler answers with a page only when it has a context,
      // so it gets a signed-out one rather than a JSON body for a document.
      reply.locals = buildViewContext(request, undefined);
      throw error;
    }
    reply.locals = buildViewContext(request, request.auth);
  });

  // A queued write's replay for another account is refused before its
  // handler writes (#178). preHandler: after the web plugin's session gate
  // (preValidation), so a replay without a session keeps its 401.
  app.addHook(
    'preHandler',
    createQueuedWriteHook(logger.child({ logger: 'Web' })),
  );

  // Security headers on all responses
  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.headers(SECURITY_HEADERS);
    done(null, payload);
  });
  // Clear-Site-Data on a redirect is repeated on the page it lands on, which
  // is the only answer WebKit applies it from (#244, session.ts).
  app.addHook('onSend', createCacheClearRelay(sessionLogger));

  // One line per request, never its headers (the session cookie is a
  // bearer credential). Static paths (every thumbnail, script and the 30 s
  // heartbeat) stay out: logging them cost ~16% of image throughput. Routes
  // with a secret in the path log their pattern (loggableUrl). A request
  // the service worker made to warm the offline caches (#286) says so.
  // request_id is passed, not left to the mixin: onResponse runs on the
  // response's 'finish' event, which need not carry the request's async
  // context.
  const http = logger.child({ logger: 'Http' });
  app.addHook('onResponse', (request, reply, done) => {
    if (!isStaticPath(request.url)) {
      const warm = isWarmRequest(request.headers) ? ' (warm)' : '';
      http.info(
        {
          request_id: request.id,
          method: request.method,
          route: request.routeOptions.url,
          status: reply.statusCode,
          duration_ms: Number(reply.elapsedTime.toFixed(1)),
          db_statements: request.timing?.dbStatements,
          // A bearer request's caller: the token's row id, never the token.
          user_id: request.accessToken?.user.id,
          token_id: request.accessToken?.tokenId,
        },
        `${request.method} ${loggableUrl(request)} ${reply.statusCode} ${reply.elapsedTime.toFixed(1)}ms${warm}`,
      );
    }
    done();
  });

  await app.register(fastifyCookie);
  // Pages and fragments; a static file goes out precompressed when it has
  // a variant (static-assets.ts), which this leaves alone.
  await app.register(fastifyCompress);
  // Forms post urlencoded bodies; JSON is Fastify's own parser.
  await app.register(fastifyFormbody);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB
      files: 5,
    },
  });

  await registerStaticAssets(
    app,
    config,
    logger.child({ logger: 'StaticAssets' }),
  );

  const web = logger.child({ logger: 'Web' });
  app.setErrorHandler(createErrorHandler(web, errors, outage));
  // A path no route matches is the 404 page (a static path, which has no
  // page context, gets data from the error handler instead; an htmx
  // fragment request its trigger); under /api a problem 404. Neither
  // message echoes the URL: a client may have put a token in it, and the
  // message reaches the warn line (the page shows the path itself).
  app.setNotFoundHandler((request) => {
    throw surfaceOf(request) === 'api'
      ? new HttpError(404)
      : new HttpError(404, t('refusal.notFound.page'));
  });

  await app.register(webPlugin, {
    config: {
      appName: config.APP_NAME,
      iconName: config.ICON_NAME,
      siteUrl: config.SITE_URL,
      timeZone: config.APP_TIMEZONE,
      registrationDisabled: config.DISABLE_REGISTRATION,
      pwaEnabled: config.PWA_ENABLED,
      vapid,
      orderMailOwnerId: orderMail?.ownerId,
      release: build.release,
      storageDirs: [config.DATA_PATH, config.MODELS_PATH],
    },
    logger: web,
    db,
    tokens,
    photos,
    cutouts,
    jobs: roster,
    proxyWatch,
    orderMailWatch,
    fetcher,
    weather,
    mcpLogger: logger.child({ logger: 'Mcp' }),
    apiLogger: logger.child({ logger: 'Api' }),
    push,
    metrics,
    errors,
    photoUploadMax: options.photoUploadMax,
  });

  return {
    app,
    db,
    photos,
    cutouts,
    roster,
    push,
    weather,
    orderMail,
    metrics,
    errors,
  };
}

/**
 * The order mail's poll (#25), or nothing without ORDER_MAIL_JMAP_TOKEN:
 * no timer, no review list, no menu entry. Its JMAP client has an outbound
 * fetcher of its own, pinned to the session's host (the only one that may
 * see the token), so a spec's stand-in for Fastmail is admitted for it
 * alone; each link in an email goes through `fetcher`, the one for user
 * URLs, like a link the owner pasted.
 */
function createOrderMail(
  config: Config,
  logger: Logger,
  db: Db,
  fetcher: OutboundFetcher,
  stub: AppOptions['orderMail'],
  ownerId: number | undefined,
  ownerWatch: OrderMailOwnerWatch,
): OrderMailDeps | undefined {
  const boot = logger.child({ logger: 'Bootstrap' });
  if (!config.ORDER_MAIL_JMAP_TOKEN || ownerId === undefined) {
    boot.info(
      config.ORDER_MAIL_JMAP_TOKEN
        ? 'Order mail: off (ORDER_MAIL_OWNER names no account)'
        : 'Order mail: off (ORDER_MAIL_JMAP_TOKEN unset)',
    );
    return undefined;
  }
  const senders = orderMailSenders(config);
  // The token is never logged; the owner and senders are the owner's own.
  boot.info(
    `Order mail: on (${stub ? 'a stand-in for Fastmail' : 'Fastmail'}, every ${config.ORDER_MAIL_POLL_MINUTES} min, ${senders.length} trusted senders, for user ${ownerId})`,
  );
  return {
    db,
    jmap: createJmapClient({
      fetcher: createOutboundFetcher({
        logger: logger.child({ logger: 'OutboundFetch' }),
        ...stub?.fetch,
      }),
      token: config.ORDER_MAIL_JMAP_TOKEN,
      sessionUrl: stub?.sessionUrl,
    }),
    fetcher,
    senders,
    ownerId,
    ownerWatch,
    timeZone: config.APP_TIMEZONE,
    logger: logger.child({ logger: 'OrderMail' }),
  };
}

/**
 * ORDER_MAIL_OWNER's account id, once per boot (#706), or undefined with
 * the order mail off: no token, or no account with the address. The latter
 * is one error naming the key (never the address) and a degraded
 * /health/ready, never a refused boot: the owner changing their email or
 * deleting their account must not make the next deploy an outage. Bound by
 * id, an email change or another account taking the address moves nothing
 * until a boot.
 */
async function resolveOrderMailOwner(
  config: Config,
  db: Db,
  watch: OrderMailOwnerWatch,
): Promise<number | undefined> {
  if (!config.ORDER_MAIL_JMAP_TOKEN) return undefined;
  const ownerId = await orderMailOwnerId(
    db,
    normalizeEmail(config.ORDER_MAIL_OWNER),
  );
  if (ownerId === undefined) watch.markMissing('boot');
  return ownerId;
}

/**
 * The weather (#14), or nothing with WEATHER_ENABLED=false: no service, so
 * no route, page or tool can fetch or store a location. Its own outbound
 * fetcher (the same rules as the link import's; see outbound-fetch.ts), so a
 * spec's stand-in for Open-Meteo is admitted for the weather alone.
 */
function createWeather(
  config: Config,
  logger: Logger,
  db: Db,
  stub: AppOptions['weather'],
): WeatherService | undefined {
  const boot = logger.child({ logger: 'Bootstrap' });
  if (!config.WEATHER_ENABLED) {
    boot.info('Weather: off (WEATHER_ENABLED=false)');
    return undefined;
  }
  boot.info(
    `Weather: on (${stub ? 'a stand-in for Open-Meteo' : 'Open-Meteo'})`,
  );
  return createWeatherService({
    db,
    client: createOpenMeteoClient({
      fetcher: createOutboundFetcher({
        logger: logger.child({ logger: 'OutboundFetch' }),
        ...stub?.fetch,
      }),
      endpoints: stub?.endpoints,
    }),
    logger: logger.child({ logger: 'Weather' }),
    timeZone: config.APP_TIMEZONE,
  });
}

// Inline script: the pages' one-line handlers and inline modules (AGENTS.md,
// Conventions). blob: images: the mask editor draws the original and the
// cutout from object URLs. No eval (htmx's filters, hx-on and js: values are
// unused) and no blob: scripts or workers: those were the in-browser
// background-removal model's, removed on 2026-09-26.
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none';";

// Every response's, set by the root onSend hook.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
} as const;
