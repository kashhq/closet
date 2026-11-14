import { eq, sql } from 'drizzle-orm';
import type {
  FastifyInstance,
  InjectOptions,
  LightMyRequestResponse,
} from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import type { OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { type AppOptions, createApp } from '../../src/app';
import { type Config, loadConfig } from '../../src/config';
import type { CutoutQueue } from '../../src/cutout/queue';
import {
  type Db,
  dbConfig,
  type DbConfig,
  type Queryable,
} from '../../src/db/client';
import { ownersLockCte } from '../../src/db/owner-lock';
import { user } from '../../src/db/schema';
import { createLoggerTo, type Logger } from '../../src/logger';
import { hashPassword } from '../../src/web/auth/passwords';
import { insertUser } from '../../src/web/auth/queries';
import {
  passwordFingerprint,
  type SessionStamp,
} from '../../src/web/auth/tokens';
import { type IsoDate, todayIn } from '../../src/calendar-date';
import type { Photos } from '../../src/web/files/photos';
import {
  type SubscriptionInput,
  upsertDevice,
} from '../../src/web/push/queries';
import type { PushSender } from '../../src/web/push/sender';
import type { WeatherService } from '../../src/web/weather/service';
import { UNMATCHED_ROUTE } from '../../src/metrics/http';
import type { ErrorTracker } from '../../src/metrics/error-tracker';
import type { Metrics } from '../../src/metrics/metrics';
import type { OrderMailDeps } from '../../src/web/wardrobe/order-mail/poll';
import { LogCapture } from '../support/log-capture';
import { recordStatements } from '../support/query-recorder';
import {
  noteStatements,
  type RequestStatements,
} from '../support/statement-budgets';
import { createScratchDatabase } from '../support/scratch-database';

/**
 * Boots the real application in-process (createApp + ready(), no listen)
 * against a private database and a fresh temp DATA_PATH, and exposes
 * inject() plus the database (t.db, Drizzle) and what the app logged
 * (t.logs) so specs can assert on HTML, headers, rows, files and log lines
 * together. The app's configuration is BASE_ENV plus the overrides, through
 * the real loadConfig() but without the process environment or the .env
 * files, so a developer's .env.local never leaks into a spec.
 *
 * Every spec file gets its own scratch Postgres database (see
 * test/support/scratch-database.ts), dropped again by cleanup().
 *
 * Login is always required, so every app starts with a signed-in default
 * user, `t.owner`, and t.inject() sends the owner's session cookie unless the
 * request carries its own `cookie` header or asks for `anonymous: true`.
 * Specs that are not about accounts or sharing never think about sessions.
 *
 * Every state-changing request must name this site in Origin (the CSRF
 * check, src/web/security/same-origin.ts), which inject() never does on its
 * own: t.inject() adds `Origin: http://localhost` (the origin inject's
 * requests are addressed to) unless the request sets Origin or Referer
 * itself or asks for `sameOrigin: false`.
 *
 * Login and registration are rate limited per client address, and inject()
 * always comes from 127.0.0.1: t.register() and t.login() each send their
 * own X-Forwarded-For (127.0.0.1 is a trusted proxy here), so no spec runs
 * into the limit by signing people up. Specs about the limit pick their own.
 */

export type Env = Record<string, string>;

const BASE_ENV: Env = {
  NODE_ENV: 'test',
  // Never `production`: an event a spec sends to its Bugsink stand-in says
  // so (APP_ENV is the error tracker's environment).
  APP_ENV: 'dev',
  // Everything down to debug reaches t.logs (nothing reaches the console).
  LOG_LEVEL: 'debug',
  APP_NAME: 'Closet',
  SITE_URL: 'http://localhost:3000',
  TRUSTED_PROXIES: '127.0.0.1,::1',
  DISABLE_REGISTRATION: 'false',
  PWA_ENABLED: 'false',
  // No spec reaches Open-Meteo: weather is off unless a spec turns it on
  // with the stand-in (test/support/weather-stub.ts), which createTestApp
  // then requires.
  WEATHER_ENABLED: 'false',
  ACCESS_TOKEN_SECRET: 'integration-test-secret-0123456789abcdef',
  // bcrypt at its floor: every spec file registers an owner, and the auth
  // specs sign in dozens of times; at 12 that was most of the tier's time.
  PASSWORD_HASH_ROUNDS: '4',
  // No spec loads the model; /health/ready's `storage` check only probes the
  // directory writable, so the system temp dir rather than ./models (which
  // the probe would create in the checkout).
  MODELS_PATH: tmpdir(),
};

export { PWA_ENV } from '../support/pwa-env';

export const TEST_PASSWORD = 'Password123!';
export const OWNER_EMAIL = 'owner@example.com';
/** The origin inject()'s requests are addressed to (Host: localhost:80). */
export const APP_ORIGIN = 'http://localhost';

export type TestInjectOptions = InjectOptions & {
  /** Send no session cookie at all (the owner's is otherwise the default). */
  anonymous?: boolean;
  /**
   * false: send no Origin on a state-changing request (the CSRF specs). By
   * default one naming this site is added unless Origin or Referer is set.
   */
  sameOrigin?: boolean;
};

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hasHeader(headers: OutgoingHttpHeaders, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

/** A state-changing request that says nothing about where it comes from. */
function needsOrigin(
  method: string | undefined,
  headers: OutgoingHttpHeaders,
): boolean {
  return (
    UNSAFE_METHODS.has((method ?? 'GET').toUpperCase()) &&
    !hasHeader(headers, 'origin') &&
    !hasHeader(headers, 'referer')
  );
}

let clientSeq = 0;
/** A client address of its own, for a request that counts against a rate limit. */
export function uniqueClient(): { 'x-forwarded-for': string } {
  clientSeq += 1;
  return {
    'x-forwarded-for': `198.18.${Math.floor(clientSeq / 250)}.${(clientSeq % 250) + 1}`,
  };
}

interface TestUser {
  id: number;
  email: string;
  /** `access_token=...`, ready for a `cookie` header. */
  cookie: string;
}

// The log captures of this process's live test apps:
// recordQueries reads the access lines its work's requests wrote.
const liveLogs = new Set<LogCapture>();

export interface TestApp {
  app: FastifyInstance;
  /**
   * What the app booted with: a spec booting a second app on the same
   * database (createApp({ ...t.config, ... }), storage-marker.spec.ts).
   */
  config: Config;
  /** Uploads and thumbs land here; removed by cleanup(). */
  dataPath: string;
  /** The app's one Photos (what the routes store and serve through). */
  photos: Photos;
  /**
   * The background-removal queue, not running: a spec starts it with a
   * fake runner (test/integration/cutouts.ts); cleanup() stops it.
   */
  cutouts: CutoutQueue;
  /**
   * The app's Web Push sender (PWA_ENV only): what the reminders send
   * through when a spec runs them (sendDueReminders); nothing schedules
   * them in the harness.
   */
  push: PushSender | undefined;
  /**
   * The app's weather service (WEATHER_ENABLED only). A spec that counts
   * fetches or reads the row after a stale ask awaits `settled()`: the
   * answer is served before its background refresh ends (#114).
   */
  weather: WeatherService | undefined;
  /** The app's metrics (what GET /metrics exposes with METRICS_ENABLED). */
  metrics: Metrics;
  /**
   * The app's error tracker (a no-op without SENTRY_DSN): `flush()` sends what
   * it holds, so a spec counts the events at a stub without waiting.
   */
  errors: ErrorTracker;
  /**
   * The order mail's poll (ORDER_MAIL_JMAP_TOKEN and the JMAP stub only):
   * a spec runs it with pollOrderMail; nothing schedules it here.
   */
  orderMail: OrderMailDeps | undefined;
  /** The user registered at boot, whose session t.inject() sends by default. */
  owner: TestUser;
  inject: (options: TestInjectOptions) => Promise<LightMyRequestResponse>;
  /**
   * A JSON API request as a native client sends it (test/integration/
   * api.ts): `token`, if any, as `Authorization: Bearer`, and no session
   * cookie and no Origin unless the request's own headers add them.
   */
  api: (
    token: string | undefined,
    options: TestInjectOptions,
  ) => Promise<LightMyRequestResponse>;
  /** The app's Drizzle instance (no identity map: reads see every commit). */
  db: Db;
  /**
   * Where the app's database is (dbConfig): for a spec that connects as
   * another process would (createDb, a pg Client).
   */
  database: DbConfig;
  /** The app's root logger, for modules a spec builds itself (into t.logs). */
  logger: Logger;
  /** The app's APP_TIMEZONE. */
  timeZone: string;
  /**
   * The app's "today": todayIn() in its APP_TIMEZONE, as every route asks,
   * read at the call so a faked Date moves it. The one way a spec names
   * today: a UTC date (toISOString) is tomorrow every evening in New York.
   */
  today: () => IsoDate;
  /**
   * Every line the app logged at LOG_LEVEL and above, parsed.
   */
  logs: LogCapture;
  /**
   * POST /auth/register (a seeded row plus a login when DISABLE_REGISTRATION
   * is on); returns the session cookie for later requests.
   */
  register: (email: string, password?: string) => Promise<string>;
  /** POST /auth/login; returns the session cookie for later requests. */
  login: (email: string, password?: string) => Promise<string>;
  cleanup: () => Promise<void>;
}

export interface TestAppOptions {
  /**
   * Runs against the scratch database before the app boots (and migrates
   * it), e.g. to build it with the legacy MikroORM migrations. Receives the
   * DATABASE_* values.
   */
  beforeBoot?: (databaseEnv: Env) => Promise<void>;
  /**
   * With beforeBoot, start it from the migrated template rather than an
   * empty database (a spec that changes a current schema's history).
   */
  migrated?: boolean;
  /**
   * The outbound fetcher's test-only options (AppOptions.outboundFetch): a
   * scripted resolver and a loopback alias standing in for the internet
   * (test/integration/link-sites.ts, which serves it).
   */
  outboundFetch?: AppOptions['outboundFetch'];
  /**
   * Open-Meteo's stand-in (startWeatherStub().options, test/support/
   * weather-stub.ts): required with WEATHER_ENABLED=true.
   */
  weather?: AppOptions['weather'];
  /**
   * Fastmail's stand-in (startJmapStub().options, test/support/
   * jmap-stub.ts): required with ORDER_MAIL_JMAP_TOKEN.
   */
  orderMail?: AppOptions['orderMail'];
  /** Every route as it registers (AppOptions.onRoute). */
  onRoute?: AppOptions['onRoute'];
  /** The HEIC decoder's stub thread and bounds (AppOptions.heicDecoder). */
  heicDecoder?: AppOptions['heicDecoder'];
  /** PHOTO_UPLOAD_LIMIT's max (AppOptions.photoUploadMax). */
  photoUploadMax?: AppOptions['photoUploadMax'];
}

/** A spec never reaches a real third party: each one it turns on needs its stand-in. */
function missingStandIn(
  config: Config,
  options: TestAppOptions,
): string | undefined {
  if (config.WEATHER_ENABLED && !options.weather) {
    return 'WEATHER_ENABLED=true needs the weather stub (options.weather): a spec must never call Open-Meteo';
  }
  if (config.ORDER_MAIL_JMAP_TOKEN && !options.orderMail) {
    return 'ORDER_MAIL_JMAP_TOKEN needs the JMAP stub (options.orderMail): a spec must never call Fastmail';
  }
  return undefined;
}

export async function createTestApp(
  overrides: Partial<Env> = {},
  options: TestAppOptions = {},
) {
  const dataPath = await mkdtemp(join(tmpdir(), 'closet-int-'));
  // Migrated already unless the spec builds the database from an older
  // shape itself (beforeBoot): the boot then finds nothing to apply.
  const database = await createScratchDatabase('closet_it', {
    migrated: options.migrated ?? !options.beforeBoot,
  });
  const config = loadConfig({
    env: { ...BASE_ENV, ...database.env, DATA_PATH: dataPath, ...overrides },
    envFiles: [],
  });
  const missing = missingStandIn(config, options);
  if (missing) {
    await database.drop();
    await rm(dataPath, { recursive: true, force: true });
    throw new Error(missing);
  }
  const logs = new LogCapture();
  liveLogs.add(logs);
  const logger = createLoggerTo(config.LOG_LEVEL, logs);

  let app: FastifyInstance;
  let db: Db;
  let photos: Photos;
  let cutouts: CutoutQueue;
  let push: PushSender | undefined;
  let weather: WeatherService | undefined;
  let metrics: Metrics;
  let errors: ErrorTracker;
  let orderMail: OrderMailDeps | undefined;
  try {
    await options.beforeBoot?.(database.env);
    ({ app, db, photos, cutouts, push, weather, metrics, errors, orderMail } =
      await createApp(config, logger, {
        outboundFetch: options.outboundFetch,
        weather: options.weather,
        orderMail: options.orderMail,
        onRoute: options.onRoute,
        heicDecoder: options.heicDecoder,
        photoUploadMax: options.photoUploadMax,
      }));
    await app.ready();
  } catch (error) {
    // A failing boot (typically a migration) must not leak the database.
    await database.drop();
    await rm(dataPath, { recursive: true, force: true });
    throw error;
  }

  let owner: TestUser | undefined;
  const inject = ({
    anonymous = false,
    sameOrigin = true,
    ...options
  }: TestInjectOptions) => {
    const headers: OutgoingHttpHeaders = { ...options.headers };
    if (!anonymous && !hasHeader(headers, 'cookie') && owner) {
      headers.cookie = owner.cookie;
    }
    if (sameOrigin && needsOrigin(options.method, headers)) {
      headers.origin = APP_ORIGIN;
    }
    return app.inject({ ...options, headers });
  };
  const api = (token: string | undefined, options: TestInjectOptions) =>
    inject({
      ...options,
      anonymous: true,
      sameOrigin: false,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...options.headers,
      },
    });
  // A sign-in that set no session names what the app logged at warn and
  // above while it ran: a setup 500 otherwise says only its status, and the
  // cause sits in t.logs, which no spec prints once createTestApp throws
  // (#249).
  const signIn = async (action: string, request: TestInjectOptions) => {
    const mark = logs.records.length;
    const res = await inject({
      method: 'POST',
      headers: uniqueClient(),
      anonymous: true,
      ...request,
    });
    const token = res.cookies.find((c) => c.name === 'access_token');
    if (!token) {
      const serverSide = logs.describeFrom(mark, 'warn');
      throw new Error(
        `${action} did not set access_token (status ${res.statusCode}); ${serverSide}`,
      );
    }
    return `access_token=${token.value}`;
  };

  const login = (email: string, password = TEST_PASSWORD) =>
    signIn('login', { url: '/auth/login', payload: { email, password } });
  const register = async (email: string, password = TEST_PASSWORD) => {
    if (config.DISABLE_REGISTRATION) {
      await insertUser(db, email, await hashPassword(password));
      return login(email, password);
    }
    return signIn('register', {
      url: '/auth/register',
      payload: { email, password, confirmPassword: password },
    });
  };

  try {
    const cookie = await register(OWNER_EMAIL);
    const [row] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, OWNER_EMAIL));
    owner = { id: row.id, email: OWNER_EMAIL, cookie };
  } catch (error) {
    await app.close();
    await database.drop();
    await rm(dataPath, { recursive: true, force: true });
    throw error;
  }

  return {
    app,
    config,
    dataPath,
    photos,
    cutouts,
    push,
    weather,
    metrics,
    errors,
    orderMail,
    owner,
    inject,
    api,
    db,
    database: dbConfig(config),
    logger,
    timeZone: config.APP_TIMEZONE,
    today: () => todayIn(config.APP_TIMEZONE, new Date()),
    logs,
    register,
    login,
    cleanup: async () => {
      liveLogs.delete(logs);
      await app.close();
      await database.drop();
      await rm(dataPath, { recursive: true, force: true });
    },
  } satisfies TestApp;
}

/**
 * A fixture's write to synced tables (garments, outfits, trips, ...;
 * src/db/sync-tables.ts), made holding the owner locks as every writer
 * holds its own (src/db/owner-lock.ts): every account's, in id order,
 * since a fixture may write any of them (a cleanup deletes every outfit).
 * The sync triggers (drizzle/0052_sync-triggers.sql) refuse a write
 * without its owner's lock.
 */
export function asFixture<T>(
  db: Db,
  work: (tx: Queryable) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const lock = ownersLockCte(tx, sql`select ${user.id} from ${user}`);
    await tx.with(lock).select({ id: lock.id }).from(lock);
    return work(tx);
  });
}

/** The id of the account registered with `email`. */
export async function userIdOf(t: TestApp, email: string): Promise<number> {
  const [row] = await t.db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email));
  if (!row) throw new Error(`No account for ${email}`);
  return row.id;
}

/**
 * The stamp a session of `userId` opened now carries (its token's `pwf` and
 * `sv`): what a write that rechecks its session takes, called outside a
 * request (upsertDevice, createInvite).
 */
export async function sessionStampOf(
  db: Db,
  userId: number,
): Promise<SessionStamp> {
  const [row] = await db
    .select({ password: user.password, version: user.sessionVersion })
    .from(user)
    .where(eq(user.id, userId));
  if (!row) throw new Error(`No account ${userId}`);
  return {
    fingerprint: passwordFingerprint(row.password),
    version: row.version,
  };
}

/**
 * `subscription` stored for `userId` as a request of a session opened now
 * would store it (upsertDevice, with that session's stamp), for specs
 * that set up a device outside a request. Its device id.
 */
export async function subscribeAs(
  db: Db,
  userId: number,
  subscription: SubscriptionInput,
): Promise<number> {
  const session = await sessionStampOf(db, userId);
  const deviceId = await upsertDevice(
    db,
    userId,
    session,
    subscription,
    undefined,
  );
  if (deviceId === undefined) throw new Error(`No session for ${userId}`);
  return deviceId;
}

export { multipart, type MultipartFile } from '../support/multipart';

/** Full `<img ...>` tags in document order. */
export function imgTags(html: string): string[] {
  return html.match(/<img\b[^>]*>/g) ?? [];
}

export function extractImgSrcs(html: string): string[] {
  return imgTags(html)
    .map((tag) => /\ssrc="([^"]*)"/.exec(tag)?.[1])
    .filter((src): src is string => src !== undefined);
}

/**
 * Undoes the escaping JSX views apply to text and attribute values (the set
 * src/web/html.ts escapeHtml writes), so a spec can match an attribute such
 * as `href="/calendar?week=...&calMonth=..."` as the browser reads it.
 */
export function unescapeHtml(html: string): string {
  return html
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

/**
 * The path an htmx write navigates to (`navigateTo`, src/web/render.ts):
 * asserts the answer is an HX-Location that swaps the body as a boosted page
 * (no HX-Redirect, which reloads the document) and returns its path.
 */
export function hxLocationPath(res: LightMyRequestResponse): string {
  expect(res.headers['hx-redirect']).toBeUndefined();
  const location = JSON.parse(String(res.headers['hx-location'])) as {
    path: string;
  };
  expect(location).toMatchObject({
    target: 'body',
    headers: { 'HX-Boosted': 'true' },
  });
  return location.path;
}

export function hasText(html: string, text: string): boolean {
  return html.includes(text);
}

/**
 * The markup a page shows: without the other states the queued writes keep
 * in `<template data-outbox-state>` (src/web/outbox.tsx), which the outbox
 * swaps in only for a tap it queued offline.
 */
export function shownMarkup(html: string): string {
  return html.replace(
    /<template data-outbox-state="">[\s\S]*?<\/template>/g,
    '',
  );
}

export interface QueryRecord {
  /** SQL statements sent. */
  statements: number;
  /** Rows they returned, all together. */
  rows: number;
  /** Each statement's SQL text, in order. */
  sql: string[];
  /**
   * Each request the work made, by `<METHOD>:<route template>`, with the
   * statements the app counted for it (its access line's db_statements,
   * the count http_request_db_statements records). Requests to static paths
   * write no access line and are not here.
   */
  requests: RequestStatements[];
}

/** The access lines (logger Http) written since each capture's mark. */
function requestsSince(marks: Map<LogCapture, number>): RequestStatements[] {
  return [...marks].flatMap(([logs, mark]) =>
    logs.records
      .slice(mark)
      .filter((record) => record.logger === 'Http')
      .map((record) => ({
        key: `${String(record.method)}:${typeof record.route === 'string' ? record.route : UNMATCHED_ROUTE}`,
        statements: Number(record.db_statements),
      })),
  );
}

/**
 * Runs `work` and counts the SQL statements the app sends meanwhile and the
 * rows they return (recordStatements, test/support/query-recorder.ts). For
 * proving a page reads what it shows rather than a whole table: rows, not
 * only statements, since one statement can return everything. Each
 * request's own count is noted as a statement budget (STATEMENTS_OUT,
 * test/support/statement-budgets.ts): the counts these specs pin are the
 * ones the metrics ratchet holds.
 */
export async function recordQueries(
  work: () => Promise<unknown>,
): Promise<QueryRecord> {
  const marks = new Map(
    [...liveLogs].map((logs) => [logs, logs.records.length]),
  );
  const { statements } = await recordStatements(work);
  const requests = requestsSince(marks);
  noteStatements(requests);
  return {
    statements: statements.length,
    rows: statements.reduce((sum, statement) => sum + statement.rows, 0),
    sql: statements.map((statement) => statement.sql),
    requests,
  };
}
