import { createECDH, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type {
  FastifyInstance,
  InjectOptions,
  LightMyRequestResponse,
} from 'fastify';
import webpush from 'web-push';
import type * as AppModule from '../../src/app';
import type * as BuildInfoModule from '../../src/build-info';
import type * as CalendarDateModule from '../../src/calendar-date';
import type * as ConfigModule from '../../src/config';
import type * as CutoutQueueModule from '../../src/cutout/queue';
import type { CutoutRunner } from '../../src/cutout/runner';
import type * as DbClientModule from '../../src/db/client';
import type * as ImageUrlModule from '../../src/web/files/image-url';
import type * as FileQueriesModule from '../../src/web/files/queries';
import type * as ShareQueriesModule from '../../src/web/share/queries';
import type * as LoggerModule from '../../src/logger';
import type * as ReconcileModule from '../../src/maintenance/reconcile';
import type * as SchemaModule from '../../src/db/schema';
import type * as SeedModule from '../../src/seed/seed';
import type * as TokensModule from '../../src/web/auth/personal-tokens';
import type * as OrderPollModule from '../../src/web/wardrobe/order-mail/poll';
import type * as PushScheduleModule from '../../src/push/reminders';
import type * as PushQueriesModule from '../../src/web/push/queries';
import type * as RemindersModule from '../../src/web/push/reminders';
import type * as ReplanModule from '../../src/web/week-plan/replan';
import type * as WeekTemplateModule from '../../src/web/week-plan/template';
import type * as WeatherServiceModule from '../../src/web/weather/service';
import {
  html,
  jpeg,
  type LinkSites,
  startLinkSites,
} from '../../test/integration/link-sites';
import { startJmapStub } from '../../test/support/jmap-stub';
import {
  ORDER_SENDER,
  serveForwardedOrder,
} from '../../test/support/order-mail-shop';
import { PWA_ENV } from '../../test/support/pwa-env';
import { createScratchDatabase } from '../../test/support/scratch-database';
import { startSentryStub } from '../../test/support/sentry-stub';
import {
  startWeatherStub,
  type WeatherStub,
} from '../../test/support/weather-stub';

/**
 * What the page audit walks (scripts/audit-pages.ts): the production build
 * (dist/, `npm run build` first) booted in this process with createApp, as
 * the integration harness boots src/, on a throwaway database on the shared
 * local Postgres with the demo persona seeded, so every step runs the real
 * pages over Theo's closet and nothing it writes outlives the run. The
 * internet is the tests' stand-ins: Open-Meteo (weather-stub.ts), a shop
 * for the link import and the order mail's links (link-sites.ts,
 * order-mail-shop.ts), Fastmail's JMAP (jmap-stub.ts), Bugsink
 * (sentry-stub.ts), and web-push's send, which answers in process (the push
 * services are never called). The config is production's flags: PWA,
 * weather, metrics, error tracking and the order mail (#25, for Theo) on. Background removal runs
 * an instant stand-in held behind a gate the cutout step opens, so no
 * upload's cutout runs while another step is being measured.
 */

const PROJECT_ROOT = resolve(__dirname, '..', '..');
const DIST = join(PROJECT_ROOT, 'dist');

/** The seed's password for its personas (development and CI use the same). */
export const PERSONA_PASSWORD = 'Closet-demo-1';
/** The password of every account newAccount() registers. */
export const ACCOUNT_PASSWORD = 'Audit-pass-1';
/** The demo persona's login: Theo, whom the walk signs in as. */
const THEO_EMAIL = 'demo@closet.invalid';

/** The dist modules the audit drives, typed from their sources. */
interface Build {
  app: typeof AppModule;
  buildInfo: typeof BuildInfoModule;
  config: typeof ConfigModule;
  logger: typeof LoggerModule;
  db: typeof DbClientModule;
  imageUrl: typeof ImageUrlModule;
  fileQueries: typeof FileQueriesModule;
  shareQueries: typeof ShareQueriesModule;
  schema: typeof SchemaModule;
  seed: typeof SeedModule;
  calendar: typeof CalendarDateModule;
  tokens: typeof TokensModule;
  orderPoll: typeof OrderPollModule;
  pushQueries: typeof PushQueriesModule;
  pushSchedule: typeof PushScheduleModule;
  reminders: typeof RemindersModule;
  replan: typeof ReplanModule;
  weekTemplate: typeof WeekTemplateModule;
  weather: typeof WeatherServiceModule;
  reconcile: typeof ReconcileModule;
  cutoutQueue: typeof CutoutQueueModule;
}

// The build, not src/: the audit measures what the image ships.
async function loadBuild(): Promise<Build> {
  const load = <T>(path: string) => import(join(DIST, path)) as Promise<T>;
  return {
    app: await load('app.js'),
    buildInfo: await load('build-info.js'),
    config: await load('config.js'),
    logger: await load('logger.js'),
    db: await load('db/client.js'),
    imageUrl: await load('web/files/image-url.js'),
    fileQueries: await load('web/files/queries.js'),
    shareQueries: await load('web/share/queries.js'),
    schema: await load('db/schema.js'),
    seed: await load('seed/seed.js'),
    calendar: await load('calendar-date.js'),
    tokens: await load('web/auth/personal-tokens.js'),
    orderPoll: await load('web/wardrobe/order-mail/poll.js'),
    pushQueries: await load('web/push/queries.js'),
    pushSchedule: await load('push/reminders.js'),
    reminders: await load('web/push/reminders.js'),
    replan: await load('web/week-plan/replan.js'),
    weekTemplate: await load('web/week-plan/template.js'),
    weather: await load('web/weather/service.js'),
    reconcile: await load('maintenance/reconcile.js'),
    cutoutQueue: await load('cutout/queue.js'),
  };
}

/** Someone the walk signs in as. */
export interface Actor {
  id: number;
  email: string;
  /** `access_token=...` */
  cookie: string;
}

/** A request as the audit describes it; `send` turns it into inject(). */
export interface AuditRequest {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  /** An urlencoded form, a list repeating its key. */
  form?: Record<string, string | readonly string[]>;
  json?: unknown;
  /** A body as it is, with its content type: a multipart upload, a beacon's text. */
  raw?: { payload: Buffer | string; headers: Record<string, string> };
  headers?: Record<string, string>;
  /** Whose session: Theo's by default; null is signed out. */
  as?: Actor | null;
  /** An htmx request (`HX-Request: true`): a fragment where the route has one. */
  htmx?: boolean;
  /**
   * false: no Origin on a write (a program, as an MCP client). By default a
   * write names this site, as a browser's does (the CSRF check).
   */
  sameOrigin?: boolean;
}

/** The demo persona's rows the steps address, found after the seed. */
interface SeedIds {
  /** A closet garment with a photo, wears and a repair: the fullest garment page. */
  garmentId: number;
  /** A second closet garment with a photo, for writes that change it. */
  otherGarmentId: number;
  /** The grid's second page starts before this id (GRID_PAGE_SIZE newest first). */
  secondPageBefore: number;
  /**
   * Its photo: what its URLs name (imageUrl's, signed by the build's own
   * module, so the steps request what a page renders).
   */
  photo: {
    fileName: string;
    version: number;
    variantKey: string | null;
  };
  /** Its public link, which the fixture shares (#669): the page's and the Open Graph image's. */
  garmentShareableId: string;
  /** The first item of his wishlist (the merino replacing T21). */
  wishlistId: number;
  /** The outfit worn most often, and its garments. */
  outfitId: number;
  outfitGarmentIds: number[];
  /** Shared by the fixture too (#669). */
  outfitShareableId: string;
  capsuleId: number;
  /** A past entry, worn. */
  wornEntryId: number;
  /** A selfie's photo. */
  selfie: { fileName: string; version: number };
  tripId: number;
  trip: { name: string; startsOn: string; endsOn: string };
  tripItemId: number;
  brandSizeId: number;
  /** Dana (sparse), who shares her wardrobe with Theo (MANAGE), and a garment of hers. */
  dana: { id: number; garmentId: number };
}

export interface Fixture {
  build: Build;
  app: FastifyInstance;
  closet: AppModule.ClosetApp;
  config: ConfigModule.Config;
  logger: LoggerModule.Logger;
  dataPath: string;
  theo: Actor;
  ids: SeedIds;
  timeZone: string;
  today: () => string;
  /** The shop's product page, for the link import. */
  productUrl: string;
  /** Another link to the same product page each call: suggest_garment refuses a link twice (#337). */
  newProductUrl: () => string;
  /** The order mail's review list (#25) and its poll's inbox. */
  orders: OrderReview;
  /** A push endpoint of Theo's phone, subscribed, with both reminders on. */
  pushEndpoint: string;
  /** Opens the cutout stand-in's gate for `work`, then closes it. */
  withCutouts: (work: () => Promise<void>) => Promise<void>;
  /** Unmeasured request (a step's setup): throws unless it answers `expected`. */
  send: (
    request: AuditRequest,
    expected?: number,
  ) => Promise<LightMyRequestResponse>;
  /** Turns an AuditRequest into inject()'s options (the measured path). */
  injectOptions: (request: AuditRequest) => InjectOptions;
  /** A new account of its own, signed in (for credential steps). */
  newAccount: () => Promise<Actor>;
  /** The JPEG every upload step posts. */
  photo: Buffer;
  /**
   * Theo's MCP_TOKENS tokens for the MCP steps, one per few tools: /mcp
   * allows 120 calls a minute per token (MCP_LIMIT), and a tool is called
   * 20-odd times; the walk paces each token's budget (budget.ts).
   */
  mcpTokens: string[];
  /**
   * An agent token for `userId` through the writer, as Agent Access mints
   * one, with the hash the page would have checked the password against.
   */
  mintToken: (
    userId: number,
    name: string,
  ) => Promise<TokensModule.CreateTokenResult>;
  /** Every tool /mcp offers (tools/list): the coverage check's list. */
  mcpTools: () => Promise<string[]>;
  close: () => Promise<void>;
}

/** The origin inject()'s requests are addressed to (Host: localhost:80). */
const ORIGIN = 'http://localhost';
const UNSAFE = new Set(['POST', 'DELETE']);
/**
 * Tokens for the MCP steps (steps.ts spreads its tools over them, each
 * token's MCP_LIMIT a budget); the seed made none, and a user may hold 20.
 */
export const MCP_TOKENS = 12;
/** The JMAP stand-in's token (jmap-stub.ts refuses any other); never Fastmail's. */
const ORDER_MAIL_TOKEN = 'fmu1-page-audit-stand-in';
/** Items on "From your orders" at the start (seeded, as the poll writes them). */
const ORDER_REVIEW_ITEMS = 6;
/** The grid's page (GRID_PAGE_SIZE, src/web/wardrobe). */
const GRID_PAGE_SIZE = 48;
/** Where the shop stand-in serves the seed photo its product pages name. */
const TEE_IMAGE_PATH = '/img/tee.jpg';

let clientSeq = 0;
/**
 * A client address of its own: sign-in and registration are limited per
 * address, and 127.0.0.1 (inject's) is a trusted proxy here.
 */
function uniqueClient(): Record<string, string> {
  clientSeq += 1;
  return {
    'x-forwarded-for': `198.18.${Math.floor(clientSeq / 250)}.${(clientSeq % 250) + 1}`,
  };
}

function formBody(fields: Record<string, string | readonly string[]>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of typeof value === 'string' ? [value] : value) {
      body.append(key, item);
    }
  }
  return body.toString();
}

/**
 * Background removal for the audit: instant (a full-frame mask), and held
 * at ready() until the gate opens, so the queue claims nothing while other
 * steps run (the queue waits for ready() before every claim).
 */
function gatedRunner(): {
  runner: CutoutRunner;
  open: () => void;
  close: () => void;
} {
  const size = 64;
  let gate: Promise<void> = new Promise(() => undefined);
  let release: () => void = () => undefined;
  const shut = () => {
    gate = new Promise((done) => (release = done));
  };
  shut();
  return {
    runner: {
      inputSize: size,
      ready: () => gate,
      mask: () =>
        Promise.resolve({
          mask: Buffer.alloc(size * size, 255),
          inferenceMs: 0,
        }),
      close: () => Promise.resolve(),
    },
    open: () => release(),
    close: shut,
  };
}

/**
 * The push services' stand-in: web-push's send answers 201 in process, as
 * the integration specs' spy does, so the reminders and the profile's test
 * send run their real statements and encryption and nothing leaves.
 */
function stubPushServices(): void {
  webpush.sendNotification = () =>
    Promise.resolve({ statusCode: 201, body: '', headers: {} });
}

let museProducts = 0;

function productPage(image: string): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Heavyweight Pocket Tee',
    brand: { '@type': 'Brand', name: 'Studio Knit' },
    color: 'Navy',
    material: '100% cotton',
    image: [image],
    offers: { '@type': 'Offer', price: '48.00', priceCurrency: 'USD' },
  })}</script></head><body><h1>Heavyweight Pocket Tee</h1></body></html>`;
}

async function startShop(photo: Buffer): Promise<LinkSites> {
  const sites = await startLinkSites();
  sites.serve(TEE_IMAGE_PATH, jpeg(photo));
  sites.serve('/products/tee', html(productPage(sites.url(TEE_IMAGE_PATH))));
  return sites;
}

export async function createFixture(options: {
  /** The JPEG every upload posts and the shop serves. */
  photo: Buffer;
  /** Where the app's log goes (kept: a failed step's story is there). */
  appLog: string;
}): Promise<Fixture> {
  const build = await loadBuild();
  stubPushServices();
  const database = await createScratchDatabase('closet_audit', {
    migrated: true,
  });
  const dataPath = await mkdtemp(join(tmpdir(), 'closet-audit-'));
  const weatherStub: WeatherStub = await startWeatherStub();
  const shop = await startShop(options.photo);
  const bugsink = await startSentryStub();
  const jmap = await startJmapStub(ORDER_MAIL_TOKEN);
  const forwardedOrder = await serveForwardedOrder(shop);
  const config = build.config.loadConfig({
    env: {
      ...database.env,
      ...PWA_ENV,
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      DATA_PATH: dataPath,
      ACCESS_TOKEN_SECRET: 'page-audit-secret-0123456789abcdef0123',
      TRUSTED_PROXIES: '127.0.0.1,::1',
      DISABLE_REGISTRATION: 'false',
      WEATHER_ENABLED: 'true',
      METRICS_ENABLED: 'true',
      SENTRY_DSN: bugsink.dsn,
      ORDER_MAIL_JMAP_TOKEN: ORDER_MAIL_TOKEN,
      ORDER_MAIL_SENDERS: ORDER_SENDER,
      ORDER_MAIL_OWNER: THEO_EMAIL,
    },
    envFiles: [],
  });
  // Production's volume: every line a request logs, into a file (the
  // server's pino-pretty worker costs about as much).
  const logStream = createWriteStream(options.appLog);
  const logger = build.logger.createLoggerTo(config.LOG_LEVEL, logStream);
  // Each part on its own, so one that fails never keeps the database.
  const cleanup = async () => {
    logStream.end();
    const results = await Promise.allSettled([
      weatherStub.close(),
      shop.close(),
      bugsink.close(),
      jmap.close(),
      database.drop(),
      rm(dataPath, { recursive: true, force: true }),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Page audit cleanup:', result.reason);
      }
    }
  };

  let closet: AppModule.ClosetApp;
  try {
    closet = await build.app.createApp(config, logger, {
      weather: weatherStub.options,
      outboundFetch: shop.outboundFetch,
      orderMail: jmap.options,
    });
    await closet.app.ready();
  } catch (error) {
    await cleanup();
    throw error;
  }
  const { app } = closet;
  const cutouts = gatedRunner();
  closet.cutouts.start(cutouts.runner);
  let closing: Promise<void> | undefined;
  // Once, however often it is called (a Ctrl-C during the walk, then the
  // walk's own end).
  const close = () =>
    (closing ??= (async () => {
      // The gate open, so the queue's stop finds nothing held.
      cutouts.open();
      await app.close();
      await cleanup();
    })());

  const today = () => build.calendar.todayIn(config.APP_TIMEZONE, new Date());
  let theo: Actor | undefined;
  const injectOptions = (request: AuditRequest): InjectOptions => {
    const headers: Record<string, string> = {
      'accept-encoding': 'br, gzip',
      ...request.headers,
    };
    const actor = request.as === undefined ? theo : request.as;
    if (actor) headers.cookie = actor.cookie;
    if (UNSAFE.has(request.method) && request.sameOrigin !== false) {
      headers.origin ??= ORIGIN;
    }
    if (request.htmx) headers['hx-request'] = 'true';
    const options: InjectOptions = {
      method: request.method,
      url: request.url,
      headers,
    };
    if (request.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      options.payload = formBody(request.form);
    } else if (request.json !== undefined) {
      headers['content-type'] = 'application/json';
      options.payload = JSON.stringify(request.json);
    } else if (request.raw) {
      Object.assign(headers, request.raw.headers);
      options.payload = request.raw.payload;
    }
    return options;
  };
  const send = async (request: AuditRequest, expected?: number) => {
    // Uncompressed: a setup reads the answer, and nothing here is measured.
    const res = await app.inject(
      injectOptions({
        ...request,
        headers: { 'accept-encoding': 'identity', ...request.headers },
      }),
    );
    if (expected !== undefined && res.statusCode !== expected) {
      throw new Error(
        `${request.method} ${request.url} answered ${res.statusCode}, not ${expected}: ${res.body.slice(0, 300)}`,
      );
    }
    return res;
  };
  const sessionOf = (res: LightMyRequestResponse, what: string) => {
    const token = res.cookies.find((c) => c.name === 'access_token');
    if (!token) throw new Error(`${what} set no session (${res.statusCode})`);
    return `access_token=${token.value}`;
  };
  const login = async (email: string, password: string) =>
    sessionOf(
      await send({
        method: 'POST',
        url: '/auth/login',
        form: { email, password },
        headers: uniqueClient(),
        as: null,
      }),
      `Signing in ${email}`,
    );
  const userId = async (email: string) => {
    const [row] = await closet.db
      .select({ id: build.schema.user.id })
      .from(build.schema.user)
      .where(eq(build.schema.user.email, email));
    if (!row) throw new Error(`No account ${email}`);
    return row.id;
  };
  const mintToken = async (id: number, name: string) => {
    const [row] = await closet.db
      .select({ password: build.schema.user.password })
      .from(build.schema.user)
      .where(eq(build.schema.user.id, id));
    if (!row) throw new Error(`No account ${id}`);
    return build.tokens.createToken(
      { db: closet.db, logger },
      {
        userId: id,
        kind: 'mcp',
        name,
        // The audit calls every tool, writes included.
        scope: build.tokens.FULL_SCOPE,
        verifiedPassword: row.password,
      },
    );
  };
  let accounts = 0;
  const newAccount = async (): Promise<Actor> => {
    accounts += 1;
    const email = `audit-${accounts}@example.com`;
    const res = await send({
      method: 'POST',
      url: '/auth/register',
      form: {
        email,
        password: ACCOUNT_PASSWORD,
        confirmPassword: ACCOUNT_PASSWORD,
      },
      headers: uniqueClient(),
      as: null,
    });
    return {
      id: await userId(email),
      email,
      cookie: sessionOf(res, `Registering ${email}`),
    };
  };

  try {
    await seedPersonas(build, closet, logger, config.APP_TIMEZONE);
    const theoId = await userId(THEO_EMAIL);
    const review = await seedOrderReview(
      build,
      closet.db,
      shop,
      theoId,
      today(),
    );
    // Planner statistics now, as a production database has them: a fresh
    // database's first plans guess one row a table until autovacuum gets
    // to it, which would change plans (and times) partway through a walk.
    await closet.db.execute(sql`analyze`);
    theo = {
      id: theoId,
      email: THEO_EMAIL,
      cookie: await login(THEO_EMAIL, PERSONA_PASSWORD),
    };
    let delivered = 0;
    const ids = await findSeedIds(build, closet.db, theo.id);
    const pushEndpoint = await subscribePhone(build, closet, send, theo.id);
    const mcpTokens: string[] = [];
    for (let i = 1; i <= MCP_TOKENS; i++) {
      const created = await mintToken(theo.id, `Page audit ${i}`);
      if (!created.created) throw new Error('Theo has too many tokens');
      mcpTokens.push(created.token);
    }
    return {
      build,
      app,
      closet,
      config,
      logger,
      dataPath,
      theo,
      ids,
      timeZone: config.APP_TIMEZONE,
      today,
      productUrl: shop.url('/products/tee'),
      newProductUrl: () => {
        const path = `/products/tee?muse=${++museProducts}`;
        shop.serve(path, html(productPage(shop.url(TEE_IMAGE_PATH))));
        return shop.url(path);
      },
      orders: {
        ...review,
        deliver: () => {
          delivered += 1;
          jmap.deliver({
            ...forwardedOrder,
            id: `${forwardedOrder.id}-audit-${delivered}`,
            receivedAt: new Date().toISOString(),
          });
        },
      },
      photo: options.photo,
      pushEndpoint,
      withCutouts: async (work) => {
        cutouts.open();
        try {
          await work();
        } finally {
          cutouts.close();
        }
      },
      send,
      injectOptions,
      newAccount,
      mcpTokens,
      mintToken,
      mcpTools: async () => {
        const res = await send(
          {
            method: 'POST',
            url: '/mcp',
            as: null,
            sameOrigin: false,
            headers: {
              accept: 'application/json, text/event-stream',
              authorization: `Bearer ${mcpTokens[0]}`,
            },
            json: { jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} },
          },
          200,
        );
        const { result } = res.json<{
          result: { tools: { name: string }[] };
        }>();
        return result.tools.map((tool) => tool.name);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

interface OrderReview {
  /** The seeded order email the review list's items belong to. */
  emailId: number;
  /** A pending item whose product page the shop serves ("Add to closet" imports it). */
  addItemId: number;
  /**
   * Puts the forwarded order (order-mail-shop.ts) in the stand-in inbox as
   * a new email, arrived now: the poll's next run reads it.
   */
  deliver: () => void;
}

/**
 * "From your orders" for Theo: one order email and its pending items,
 * written as the poll writes them (test/order-review.spec.ts (retired 2026-10-13) does the same),
 * each linking to the shop's tee page under its own query, so "Add to
 * closet" runs a real link import.
 */
async function seedOrderReview(
  build: Build,
  db: DbClientModule.Db,
  shop: LinkSites,
  theoId: number,
  today: string,
): Promise<Omit<OrderReview, 'deliver'>> {
  const s = build.schema;
  const [email] = await db
    .insert(s.orderEmail)
    .values({
      accountId: 'page-audit',
      emailId: 'page-audit-seeded',
      receivedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      outcome: 'imported',
      items: ORDER_REVIEW_ITEMS,
    })
    .returning({ id: s.orderEmail.id });
  const page = html(productPage(shop.url(TEE_IMAGE_PATH)));
  const items = await db
    .insert(s.orderItem)
    .values(
      Array.from({ length: ORDER_REVIEW_ITEMS }, (_, i) => {
        const path = `/products/tee?order=${i + 1}`;
        shop.serve(path, page);
        return {
          ownerId: theoId,
          orderEmailId: email.id,
          productUrl: shop.url(path),
          name: `Heavyweight Pocket Tee ${i + 1}`,
          brand: 'Studio Knit',
          price: '48.00',
          currency: 'USD',
          orderedOn: today,
        };
      }),
    )
    .returning({ id: s.orderItem.id });
  return { emailId: email.id, addItemId: items[0].id };
}

/** Theo (demo) and Dana (sparse), who shares her wardrobe with him. */
async function seedPersonas(
  build: Build,
  closet: AppModule.ClosetApp,
  logger: LoggerModule.Logger,
  timeZone: string,
): Promise<void> {
  let output = '';
  const out = new PassThrough();
  out.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const status = await build.seed.runSeed({
    args: ['--persona', 'demo', '--persona', 'sparse', '--password-stdin'],
    db: closet.db,
    photos: closet.photos,
    logger: logger.child({ logger: 'Seed' }),
    timeZone,
    weatherEnabled: true,
    input: Readable.from([`${PERSONA_PASSWORD}\n`]),
    output: out,
    errors: out,
    now: new Date(),
  });
  if (status !== 0) throw new Error(`The seed failed (${status}):\n${output}`);
}

/**
 * Theo's phone: a subscription on a push service's address (never called:
 * stubPushServices) with both reminders on, set a day ago so today's are
 * due (a device set after its time waits a day).
 */
async function subscribePhone(
  build: Build,
  closet: AppModule.ClosetApp,
  send: Fixture['send'],
  theoId: number,
): Promise<string> {
  const endpoint = 'https://fcm.googleapis.com/fcm/send/page-audit-phone';
  await send(
    {
      method: 'POST',
      url: '/push/subscribe',
      json: {
        endpoint,
        keys: {
          p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
          auth: randomBytes(16).toString('base64url'),
        },
      },
    },
    204,
  );
  const { morning, evening } = build.pushSchedule.DEFAULT_REMINDER_TIMES;
  await build.pushQueries.saveReminderSettings(
    closet.db,
    theoId,
    endpoint,
    { morning, evening, museRounds: false },
    new Date(Date.now() - 24 * 60 * 60 * 1000),
  );
  return endpoint;
}

async function findSeedIds(
  build: Build,
  db: DbClientModule.Db,
  theoId: number,
): Promise<SeedIds> {
  const s = build.schema;
  const one = <T>(rows: T[], what: string): T => {
    if (!rows[0]) throw new Error(`The seed has no ${what}`);
    return rows[0];
  };
  // The seed shares nothing publicly (#669): Share, as the ⋯ menu does.
  const shareOf = async (
    kind: ShareQueriesModule.ShareableKind,
    id: number,
  ): Promise<string> => {
    const shared = await build.shareQueries.setPublicShare(
      db,
      kind,
      id,
      theoId,
      true,
    );
    if (!shared?.shareableId) throw new Error(`Could not share ${kind} ${id}`);
    return shared.shareableId;
  };

  const repaired = one(
    await db
      .select({
        garmentId: s.garment.id,
        fileName: s.file.fileName,
        version: s.file.version,
        variantKey: s.file.variantKey,
      })
      .from(s.garmentRepair)
      .innerJoin(s.garment, eq(s.garment.id, s.garmentRepair.garmentId))
      .innerJoin(s.file, eq(s.file.id, s.garment.photoId))
      .where(and(eq(s.garment.ownerId, theoId), eq(s.garment.status, 'closet')))
      .orderBy(asc(s.garmentRepair.id))
      .limit(1),
    'repaired garment',
  );
  const other = one(
    await db
      .select({ id: s.garment.id })
      .from(s.garment)
      .where(
        and(
          eq(s.garment.ownerId, theoId),
          eq(s.garment.status, 'closet'),
          isNotNull(s.garment.photoId),
          sql`${s.garment.id} <> ${repaired.garmentId}`,
        ),
      )
      .orderBy(asc(s.garment.id))
      .limit(1),
    'second closet garment',
  );
  const secondPage = one(
    await db
      .select({ id: s.garment.id })
      .from(s.garment)
      .where(and(eq(s.garment.ownerId, theoId), eq(s.garment.status, 'closet')))
      .orderBy(desc(s.garment.id))
      .offset(GRID_PAGE_SIZE - 1)
      .limit(1),
    'second grid page',
  );
  const wish = one(
    await db
      .select({ id: s.garment.id })
      .from(s.garment)
      .where(
        and(eq(s.garment.ownerId, theoId), eq(s.garment.status, 'wishlist')),
      )
      .orderBy(asc(s.garment.id))
      .limit(1),
    'wishlist item',
  );
  const wornCount = sql<number>`count(*)`;
  const outfit = one(
    await db
      .select({
        id: s.outfit.id,
        worn: wornCount,
      })
      .from(s.outfit)
      .innerJoin(s.outfitCalendar, eq(s.outfitCalendar.outfitId, s.outfit.id))
      .where(
        and(eq(s.outfit.ownerId, theoId), isNotNull(s.outfitCalendar.wornAt)),
      )
      .groupBy(s.outfit.id)
      .orderBy(desc(wornCount), asc(s.outfit.id))
      .limit(1),
    'worn outfit',
  );
  const slots = await db
    .select({ garmentId: s.outfitSlot.garmentId })
    .from(s.outfitSlot)
    .where(
      and(
        eq(s.outfitSlot.outfitId, outfit.id),
        isNotNull(s.outfitSlot.garmentId),
      ),
    )
    .orderBy(asc(s.outfitSlot.position));
  const capsule = one(
    await db
      .select({ id: s.capsule.id })
      .from(s.capsule)
      .where(and(eq(s.capsule.ownerId, theoId), eq(s.capsule.name, 'Office'))),
    'Office capsule',
  );
  const worn = one(
    await db
      .select({ id: s.outfitCalendar.id })
      .from(s.outfitCalendar)
      .where(
        and(
          eq(s.outfitCalendar.ownerId, theoId),
          isNotNull(s.outfitCalendar.wornAt),
        ),
      )
      .orderBy(desc(s.outfitCalendar.day), asc(s.outfitCalendar.id))
      .limit(1),
    'worn entry',
  );
  const selfie = one(
    await db
      .select({ fileName: s.file.fileName, version: s.file.version })
      .from(s.selfie)
      .innerJoin(s.file, eq(s.file.id, s.selfie.photoId))
      .where(
        and(eq(s.selfie.ownerId, theoId), isNotNull(s.selfie.outfitCalendarId)),
      )
      .orderBy(desc(s.selfie.day))
      .limit(1),
    'selfie',
  );
  const trip = one(
    await db
      .select({
        id: s.trip.id,
        name: s.trip.name,
        startsOn: s.trip.startsOn,
        endsOn: s.trip.endsOn,
      })
      .from(s.trip)
      .where(eq(s.trip.ownerId, theoId))
      .orderBy(asc(s.trip.id))
      .limit(1),
    'trip',
  );
  const tripItem = one(
    await db
      .select({ id: s.tripItem.id })
      .from(s.tripItem)
      .where(eq(s.tripItem.tripId, trip.id))
      .orderBy(asc(s.tripItem.id))
      .limit(1),
    'trip item',
  );
  const brandSize = one(
    await db
      .select({ id: s.brandSize.id })
      .from(s.brandSize)
      .where(eq(s.brandSize.userId, theoId))
      .orderBy(asc(s.brandSize.id))
      .limit(1),
    'brand size',
  );
  const share = one(
    await db
      .select({ danaId: s.wardrobeShare.grantorId })
      .from(s.wardrobeShare)
      .where(eq(s.wardrobeShare.granteeId, theoId)),
    'share with Theo',
  );
  const danaGarment = one(
    await db
      .select({ id: s.garment.id })
      .from(s.garment)
      .where(
        and(eq(s.garment.ownerId, share.danaId), isNotNull(s.garment.photoId)),
      )
      .orderBy(asc(s.garment.id))
      .limit(1),
    'garment of Dana’s with a photo',
  );
  return {
    garmentId: repaired.garmentId,
    otherGarmentId: other.id,
    secondPageBefore: secondPage.id,
    photo: {
      fileName: repaired.fileName,
      version: repaired.version,
      variantKey: repaired.variantKey,
    },
    garmentShareableId: await shareOf('garment', repaired.garmentId),
    wishlistId: wish.id,
    outfitId: outfit.id,
    outfitGarmentIds: slots.flatMap((slot) =>
      slot.garmentId === null ? [] : [slot.garmentId],
    ),
    outfitShareableId: await shareOf('outfit', outfit.id),
    capsuleId: capsule.id,
    wornEntryId: worn.id,
    selfie,
    tripId: trip.id,
    trip: { name: trip.name, startsOn: trip.startsOn, endsOn: trip.endsOn },
    tripItemId: tripItem.id,
    brandSizeId: brandSize.id,
    dana: { id: share.danaId, garmentId: danaGarment.id },
  };
}
