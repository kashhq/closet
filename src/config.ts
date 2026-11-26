import { KindGuard, type Static, type TSchema, Type } from '@sinclair/typebox';
import { Value, ValueErrorType } from '@sinclair/typebox/value';
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { hostKey, urlHostKey } from './allowed-hosts';
import { isValidTimeZone } from './calendar-date';

/**
 * The application's configuration: every environment variable it reads,
 * declared once here with its default and its rule, and validated at boot.
 * `loadConfig()` is the only reader of process.env in src/; everything else
 * receives the typed object (createApp, the CLIs) or a slice of it. A new
 * variable goes here with a default and gets a row in the README's
 * configuration table.
 */

const NonEmpty = (options: { default?: string } = {}) =>
  Type.String({ minLength: 1, ...options });

// Loopback only: right for `npm run start:prod` on a laptop, wrong behind a
// containerised reverse proxy (production sets the Docker bridge range).
const DEFAULT_TRUSTED_PROXIES = '127.0.0.1,::1';

const ACCESS_TOKEN_SECRET_MIN = 32;
/** The bcrypt cost production must keep (the default, and the floor there). */
export const PASSWORD_HASH_ROUNDS_PRODUCTION = 12;

const DATABASE_SSL_MODES = ['verify', 'no-verify', 'off'] as const;
export type DatabaseSslMode = (typeof DATABASE_SSL_MODES)[number];

/**
 * DATABASE_SSL as a mode, or undefined for a value that is none. Before #694
 * it was a boolean: `false` is `off`; `true` is `no-verify`, what it always
 * meant, with a deprecation warning at boot, until homelab's env says
 * `no-verify`; the release after, `true` means `verify` (docs/decisions.md
 * 2026-11-14). Also read by drizzle.config.ts.
 */
export function databaseSslMode(raw: string): DatabaseSslMode | undefined {
  const value = raw.trim().toLowerCase();
  if (value === 'true') return 'no-verify';
  if (value === 'false') return 'off';
  return DATABASE_SSL_MODES.find((mode) => mode === value);
}

export const REGISTRATION_MODES = ['first-user', 'open', 'closed'] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

// Variables renamed before 0.1 froze the names: the old one is still read
// when the new one is unset, with a deprecation warning.
const DEPRECATED_NAMES: Record<string, string> = {
  DATABASE_SCHEMA: 'DATABASE_NAME',
};

const ConfigSchema = Type.Object({
  NODE_ENV: Type.Union(
    [
      Type.Literal('development'),
      Type.Literal('production'),
      Type.Literal('test'),
    ],
    { default: 'production' },
  ),
  PORT: Type.Integer({ minimum: 0, maximum: 65535, default: 3000 }),
  // The release identity, baked into the image by its build (Dockerfile ARG -> ENV: the bare
  // 7-char sha from ci.yml's publish job, `gate-<n>` from the PR gate). Never set by compose or .env: a runtime value on `:latest`
  // cannot know the build. Unset outside an image; src/build-info.ts falls back to the commit
  // public/build.json records, else `dev`.
  APP_VERSION: Type.Optional(NonEmpty()),
  // Where this process runs, as the error tracker's `environment`: `production` (the image's
  // default), `dev` (a laptop, the tests) or `gate` (a smoke boot of a candidate image,
  // scripts/smoke-image.sh). Explicit rather than NODE_ENV, which every image sets to
  // production, so a CI boot's events would read as production's.
  APP_ENV: Type.Union(
    [Type.Literal('production'), Type.Literal('dev'), Type.Literal('gate')],
    { default: 'production' },
  ),
  // The shape of the console's lines (src/logger.ts): `json`, one object per
  // line (production: Docker hands each to Loki whole), or `text`, pino-pretty for a terminal
  // (`npm run start:dev` sets it).
  LOG_FORMAT: Type.Union([Type.Literal('json'), Type.Literal('text')], {
    default: 'json',
  }),
  // pino level for the console and LOG_FILE.
  LOG_LEVEL: Type.Union(
    [
      Type.Literal('trace'),
      Type.Literal('debug'),
      Type.Literal('info'),
      Type.Literal('warn'),
      Type.Literal('error'),
      Type.Literal('fatal'),
      Type.Literal('silent'),
    ],
    { default: 'info' },
  ),
  // Opt-in JSON lines for hand debugging, beside the console (unset: stdout only, which
  // production's Loki reads). Never under DATA_PATH: /file serves it and backups carry it
  // (crossFieldProblems).
  LOG_FILE: Type.Optional(NonEmpty()),
  // Comma-separated IPs/CIDRs whose X-Forwarded-* headers are trusted
  // (Fastify trustProxy): the client IP the rate limits count and the origin
  // the same-origin check compares. Behind a reverse proxy it must include
  // the proxy's address (AGENTS.md, Trusted proxies).
  TRUSTED_PROXIES: NonEmpty({ default: DEFAULT_TRUSTED_PROXIES }),
  APP_NAME: NonEmpty({ default: 'Closet' }),
  // The household's IANA time zone: it decides what "today" is on the
  // calendar and which week opens by default. One zone, because one
  // household shares the calendar; an unknown name fails the boot.
  APP_TIMEZONE: NonEmpty({ default: 'America/New_York' }),
  // Who may create an account (src/web/auth/registration.ts, #670):
  // `first-user` lets only the first one register, then sign-up is closed;
  // `open` lets anyone (a household member's window); `closed`, nobody.
  // DISABLE_REGISTRATION, its boolean before 0.1, is still read as an alias
  // (readDeprecatedRegistration).
  REGISTRATION: Type.Union(
    REGISTRATION_MODES.map((mode) => Type.Literal(mode)),
    { default: 'first-user' },
  ),
  PWA_ENABLED: Type.Boolean({ default: false }),
  // Signs every session token (HS256). No default on purpose: a known
  // secret lets anyone mint a session for any user id. 32 characters is the
  // floor (`openssl rand -hex 32` gives 64).
  ACCESS_TOKEN_SECRET: Type.String({ minLength: ACCESS_TOKEN_SECRET_MIN }),
  // bcrypt's cost for every password hash and comparison
  // (src/web/auth/passwords.ts). Below PASSWORD_HASH_ROUNDS_PRODUCTION only
  // outside APP_ENV=production (checked below): the test tiers run at 4,
  // where a sign-in costs a millisecond instead of a quarter second.
  PASSWORD_HASH_ROUNDS: Type.Integer({
    minimum: 4,
    maximum: 31,
    default: PASSWORD_HASH_ROUNDS_PRODUCTION,
  }),
  // No defaults on purpose: a PWA deploy that forgot its VAPID keys must fail
  // at boot rather than push with a keypair anyone can read from git.
  // Required when PWA_ENABLED (checked below).
  PUBLIC_VAPID_KEY: Type.Optional(NonEmpty()),
  PRIVATE_VAPID_KEY: Type.Optional(NonEmpty()),
  // Also the VAPID subject of Web Push (src/web/push/sender.ts): web-push
  // refuses anything but https: or mailto:, and a site address is not a mailto:, so
  // PWA_ENABLED requires an https SITE_URL (checked below).
  SITE_URL: NonEmpty({ default: 'http://localhost:3000' }),
  // The other names the server is reached by, `host[:port]`, comma-separated
  // (#702): a plain-HTTP twin, a gate's public name, a scraper's container
  // name. SITE_URL's host and loopback are always allowed; a request for any
  // other Host is a 421 (allowedHosts, src/web/security/allowed-host.ts).
  ALLOWED_HOSTS: Type.String({ default: '' }),
  // Full-size PNG under public/assets/ for Open Graph previews and the
  // share-link watermark. The manifest and apple-touch-icon use its
  // <stem>-192.png and <stem>-512.png siblings, which must exist beside it
  // (src/web/app-icon.ts).
  ICON_NAME: NonEmpty({ default: 'icon.png' }),
  // Composite the app icon onto share-link Open Graph images.
  WATERMARK_ENABLED: Type.Boolean({ default: false }),
  DATA_PATH: NonEmpty({ default: join(process.cwd(), 'data') }),
  // Postgres is the only database. No defaults on purpose: a missing value
  // must fail the boot, not reach localhost.
  DATABASE_HOST: NonEmpty(),
  DATABASE_PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 5432 }),
  // DATABASE_SCHEMA, its name before 0.1, is still read as a deprecated alias
  // (DEPRECATED_NAMES).
  DATABASE_NAME: NonEmpty(),
  DATABASE_USER: NonEmpty(),
  // Empty is valid: pgvault-dev and the test databases use trust auth.
  DATABASE_PASS: Type.String(),
  // TLS to Postgres (#694): `verify` checks the server's certificate against
  // the system's CAs or DATABASE_SSL_CA, `no-verify` encrypts without
  // checking it (pgvault's self-signed certificate on the tailnet: anyone on
  // the path can impersonate the server), `off` is plaintext. The boolean it
  // replaced is still read (databaseSslMode).
  DATABASE_SSL: Type.Union(
    DATABASE_SSL_MODES.map((mode) => Type.Literal(mode)),
    {
      default: 'off',
    },
  ),
  // A PEM file of the CA that signed the server's certificate, for `verify`
  // against a private CA; read once by dbConfig (src/db/client.ts).
  DATABASE_SSL_CA: Type.Optional(NonEmpty()),
  // Nightly storage reconciliation at 03:00 APP_TIMEZONE, scheduled by the
  // server (server.ts); `npm run maintenance:reconcile` runs it once
  // regardless.
  MAINTENANCE_ENABLED: Type.Boolean({ default: true }),
  // HEIC uploads are decoded in memory before sharp sees them; a part larger
  // than this is a 413.
  MAX_HEIC_BYTES: Type.Integer({ minimum: 1, default: 40 * 1024 * 1024 }),
  // Background removal (src/cutout/). Off: no model runner, no 940 MB
  // download and no model process (about 3 GB peak, more than a 1-2 GB host
  // has); uploads start as cutout `none`, the original with the mask
  // editor's pencil, and /health/ready reports cutout_queue disabled.
  CUTOUT_ENABLED: Type.Boolean({ default: true }),
  // Where the background-removal model (BiRefNet, 940 MB; src/cutout/) is
  // kept. Downloaded there at boot when missing and checksum-verified; a
  // local disk, not NFS (read whole on every model load). `npm run
  // cutout:fetch-model` seeds or repairs it.
  MODELS_PATH: NonEmpty({ default: join(process.cwd(), 'models') }),
  // onnxruntime intra-op threads of the background-removal model (the benchmark:
  // 3.3 s a photo at 4, 2.7 s at 8, on an 8-core Ryzen).
  CUTOUT_THREADS: Type.Integer({ minimum: 1, maximum: 64, default: 4 }),
  // How often an idle cutout queue looks for pending photos on its own. A
  // backstop only: writes notify the queue at once (LISTEN/NOTIFY,
  // src/cutout/listener.ts); the poll catches what a lost notification or a
  // dropped listener connection missed. One indexed claim, never while busy.
  CUTOUT_POLL_SECONDS: Type.Integer({ minimum: 1, maximum: 3600, default: 60 }),
  // Weather (#14): forecasts from Open-Meteo, fetched by the server for each
  // user's rounded location (src/web/weather/). Off: nothing is ever
  // fetched, no location is stored (the routes that take one are gone) and
  // no page shows weather.
  WEATHER_ENABLED: Type.Boolean({ default: true }),
  // Prometheus metrics (src/metrics/): GET /metrics for the homelab's
  // vmagent, which scrapes the container over the Docker network, and the
  // devices' timing beacon (POST /metrics/vitals). Off: neither route exists
  // and pages load no timing script.
  METRICS_ENABLED: Type.Boolean({ default: false }),
  // Error tracking (#117): the Sentry-compatible DSN of the homelab's
  // Bugsink project (`http://<key>@<tracker host>/<project id>`), as finplat's.
  // Empty or unset: off, nothing captured or sent, no /errors/client and no
  // error script on pages (src/metrics/error-tracker.ts). Empty counts as
  // unset so a compose file's `${SENTRY_DSN:-}` never fails the boot.
  SENTRY_DSN: Type.String({
    default: '',
    pattern: '^(https?://[^\\s@/]+@[^\\s/]+(/[^\\s]*)?/[0-9]+)?$',
  }),
  // Order email import (#25, src/web/wardrobe/order-mail/): the read-only
  // Fastmail API token of the account the owner forwards order emails to.
  // Empty or unset: off, nothing polled, no review list. A secret: never
  // logged, and ConfigError names it without its value.
  ORDER_MAIL_JMAP_TOKEN: Type.String({ default: '' }),
  // The owner's own addresses, comma-separated: only mail they forwarded is
  // read. Required with the token.
  ORDER_MAIL_SENDERS: Type.String({ default: '' }),
  // The sign-in email of the closet account the imported items belong to.
  // Required with the token. Read only to adopt that account once (the first
  // boot with the token) or by `order-mail:bind-owner`; from then on the
  // owner is the stored id (order_mail_owner, #976), never this address.
  ORDER_MAIL_OWNER: Type.String({ default: '' }),
  // How often the account is polled.
  ORDER_MAIL_POLL_MINUTES: Type.Integer({
    minimum: 1,
    maximum: 60,
    default: 5,
  }),
});

export type Config = Static<typeof ConfigSchema>;

/** Variables as the process sees them (process.env's shape). */
export type Env = Record<string, string | undefined>;

/** The boot stops here, naming every offending variable (never its value). */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

// Earlier files win over later ones, and the environment over both.
// `.env` is committed (public defaults); `.env.local` is gitignored, for
// development only. The Docker image bakes `.env` and never sees
// `.env.local`, so production configuration is real environment variables.
const ENV_FILES = ['.env.local', '.env'];

/**
 * APP_VERSION alone, for the lines written before loadConfig() succeeds
 * (createBootLogger, src/logger.ts): a boot refused for its configuration
 * still names the build it was. Empty is unset, as loadConfig treats it.
 */
export function bootAppVersion(): string | undefined {
  return process.env.APP_VERSION || undefined;
}

export interface LoadConfigOptions {
  /** Defaults to process.env. */
  env?: Env;
  /** Files, relative to the working directory; defaults to .env.local, .env. */
  envFiles?: string[];
  /**
   * Told of each deprecated name or value the environment still uses, once
   * per load: the server logs it at boot (main.ts). Messages name keys,
   * never values.
   */
  onDeprecated?: (message: string) => void;
}

export function loadConfig({
  env = process.env,
  envFiles = ENV_FILES,
  onDeprecated = () => {},
}: LoadConfigOptions = {}): Config {
  // A set: a deprecated name in two sources is still one warning.
  const deprecations = new Set<string>();
  const merged = mergedEnv(envFiles, env, deprecations);
  const aliasProblems = readDeprecatedRegistration(merged, deprecations);
  for (const message of deprecations) onDeprecated(message);

  const values: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(ConfigSchema.properties)) {
    const raw = merged[key];
    if (raw !== undefined) values[key] = coerce(schema, raw);
  }
  const config: unknown = Value.Default(ConfigSchema, values);

  const problems = [...aliasProblems, ...describeErrors(config)];
  if (problems.length === 0) {
    problems.push(...crossFieldProblems(config as Config));
  }
  if (problems.length) throw new ConfigError(problems);
  return config as Config;
}

// The files under the environment, old names and values read as current.
function mergedEnv(
  envFiles: string[],
  env: Env,
  deprecations: Set<string>,
): Env {
  const merged: Env = {};
  for (const source of [...[...envFiles].reverse().map(readEnvFile), env]) {
    Object.assign(merged, withCurrentNames(source, deprecations));
  }
  readDeprecatedSsl(merged, deprecations);
  return merged;
}

// A source's old names as their current ones, per source before the merge,
// so the environment's DATABASE_SCHEMA still wins over a file's DATABASE_NAME.
function withCurrentNames(source: Env, deprecations: Set<string>): Env {
  const renamed: Env = { ...source };
  for (const [old, current] of Object.entries(DEPRECATED_NAMES)) {
    if (source[old] === undefined) continue;
    if (source[current] === undefined) {
      renamed[current] = source[old];
      deprecations.add(`${old} is deprecated: rename it ${current}`);
    } else {
      deprecations.add(`${old} is ignored: ${current} is set; remove ${old}`);
    }
  }
  return renamed;
}

// DATABASE_SSL's boolean spellings as their modes, in place, before the
// schema reads it.
function readDeprecatedSsl(merged: Env, deprecations: Set<string>): void {
  const ssl = merged.DATABASE_SSL;
  if (ssl === undefined) return;
  const mode = databaseSslMode(ssl);
  // An unknown value stays as it is, for the schema to refuse by name.
  if (mode === undefined) return;
  merged.DATABASE_SSL = mode;
  if (ssl.trim().toLowerCase() === 'true') {
    deprecations.add(
      'DATABASE_SSL=true is deprecated: it means no-verify (the server certificate is not checked) and will mean verify; set no-verify or verify',
    );
  }
}

const DISABLE_REGISTRATION = 'DISABLE_REGISTRATION';

/**
 * DISABLE_REGISTRATION, the boolean before #670, as the REGISTRATION mode it
 * meant (`true` closed, `false` open), in place, with a deprecation warning,
 * for one release. Set beside REGISTRATION it must agree, or the boot stops
 * naming both: letting either win silently could open a sign-up the
 * operator closed. Answers the problems, never naming a value.
 */
function readDeprecatedRegistration(
  merged: Env,
  deprecations: Set<string>,
): string[] {
  const raw = merged[DISABLE_REGISTRATION];
  if (raw === undefined) return [];
  const disabled = coerce(Type.Boolean(), raw);
  if (typeof disabled !== 'boolean') {
    return [`${DISABLE_REGISTRATION}: expected boolean`];
  }
  const meant: RegistrationMode = disabled ? 'closed' : 'open';
  const current = merged.REGISTRATION;
  if (current === undefined) {
    merged.REGISTRATION = meant;
    deprecations.add(
      `${DISABLE_REGISTRATION} is deprecated: set REGISTRATION=${meant}`,
    );
    return [];
  }
  if (current === meant) {
    deprecations.add(
      `${DISABLE_REGISTRATION} is ignored: REGISTRATION is set; remove ${DISABLE_REGISTRATION}`,
    );
    return [];
  }
  // An unknown REGISTRATION is the schema's to refuse by name.
  if (!REGISTRATION_MODES.some((mode) => mode === current)) return [];
  return [
    `REGISTRATION: disagrees with ${DISABLE_REGISTRATION}; set REGISTRATION alone and remove ${DISABLE_REGISTRATION}`,
  ];
}

function readEnvFile(file: string): Env {
  const path = resolve(process.cwd(), file);
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}

/**
 * Environment values are strings; booleans and numbers are converted only
 * when they spell one exactly, so anything else stays a string and fails the
 * schema with the variable's name. (TypeBox's Value.Convert would truncate
 * "1.5" to an integer and accept "1" as true.)
 */
function coerce(schema: TSchema, raw: string): unknown {
  if (KindGuard.IsBoolean(schema)) {
    const lower = raw.trim().toLowerCase();
    if (lower === 'true') return true;
    return lower === 'false' ? false : raw;
  }
  if (KindGuard.IsNumber(schema) || KindGuard.IsInteger(schema)) {
    const number = Number(raw);
    return raw.trim() !== '' && Number.isFinite(number) ? number : raw;
  }
  return raw;
}

// What to do about a refused value, where the rule alone does not say.
const HINTS: Partial<Record<keyof Config, string>> = {
  ACCESS_TOKEN_SECRET: `at least ${ACCESS_TOKEN_SECRET_MIN} characters; generate one with: openssl rand -hex 32`,
};

function describeErrors(config: unknown): string[] {
  const byKey = new Map<string, string>();
  for (const error of Value.Errors(ConfigSchema, config)) {
    const key = error.path.slice(1);
    if (byKey.has(key)) continue;
    const hint = HINTS[key as keyof Config];
    byKey.set(
      key,
      `${key}: ${describe(error.type, error.schema, error.message)}${hint ? ` (${hint})` : ''}`,
    );
  }
  return [...byKey.values()];
}

function describe(
  type: ValueErrorType,
  schema: TSchema,
  message: string,
): string {
  if (type === ValueErrorType.ObjectRequiredProperty) return 'is required';
  if (KindGuard.IsUnion(schema)) {
    const allowed = schema.anyOf.map((option) => String(option.const));
    return `must be one of ${allowed.join(', ')}`;
  }
  return message.charAt(0).toLowerCase() + message.slice(1);
}

function crossFieldProblems(config: Config): string[] {
  const problems: string[] = [];
  if (!isValidTimeZone(config.APP_TIMEZONE)) {
    problems.push(
      `APP_TIMEZONE: "${config.APP_TIMEZONE}" is not an IANA time zone`,
    );
  }
  if (
    config.APP_ENV === 'production' &&
    config.PASSWORD_HASH_ROUNDS < PASSWORD_HASH_ROUNDS_PRODUCTION
  ) {
    problems.push(
      `PASSWORD_HASH_ROUNDS: at least ${PASSWORD_HASH_ROUNDS_PRODUCTION} when APP_ENV is production`,
    );
  }
  const sslCa = sslCaProblem(config);
  if (sslCa) problems.push(sslCa);
  if (config.LOG_FILE && isInside(config.DATA_PATH, config.LOG_FILE)) {
    problems.push('LOG_FILE: must not be under DATA_PATH');
  }
  if (!allowedHostEntries(config).every((entry) => hostKey(entry))) {
    problems.push(
      'ALLOWED_HOSTS: must be host names or host:port, comma-separated (no scheme or path)',
    );
  }
  problems.push(...pwaProblems(config));
  problems.push(...orderMailProblems(config));
  return problems;
}

// Both resolved, so `data/../data/x` and a trailing slash cannot slip past.
function isInside(directory: string, path: string): boolean {
  const from = relative(resolve(directory), resolve(path));
  return from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from);
}

// The PWA needs its push keys and a secure origin.
function pwaProblems(config: Config): string[] {
  if (!config.PWA_ENABLED) return [];
  const problems: string[] = [];
  for (const key of ['PUBLIC_VAPID_KEY', 'PRIVATE_VAPID_KEY'] as const) {
    if (!config[key]) {
      problems.push(`${key}: is required when PWA_ENABLED is true`);
    }
  }
  // The value stays out of the message (it can carry credentials in a URL).
  if (
    !URL.canParse(config.SITE_URL) ||
    new URL(config.SITE_URL).protocol !== 'https:'
  ) {
    problems.push(
      'SITE_URL: must be an https: URL when PWA_ENABLED is true (it is the Web Push VAPID subject)',
    );
  }
  return problems;
}

// A CA outside `verify` would be silently unused; an unreadable one would
// fail every connection instead of the boot.
function sslCaProblem(config: Config): string | undefined {
  if (config.DATABASE_SSL_CA === undefined) return undefined;
  if (config.DATABASE_SSL !== 'verify') {
    return 'DATABASE_SSL_CA: applies only when DATABASE_SSL is verify';
  }
  return isReadableFile(config.DATABASE_SSL_CA)
    ? undefined
    : 'DATABASE_SSL_CA: must be a readable file';
}

function isReadableFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Order mail is optional: its token switches it on, and then needs who may send and who owns.
function orderMailProblems(config: Config): string[] {
  if (!config.ORDER_MAIL_JMAP_TOKEN) return [];
  const problems: string[] = [];
  const senders = orderMailSenders(config);
  if (senders.length === 0) {
    problems.push(
      'ORDER_MAIL_SENDERS: is required when ORDER_MAIL_JMAP_TOKEN is set',
    );
  } else if (!senders.every(looksLikeAddress)) {
    problems.push(
      'ORDER_MAIL_SENDERS: must be email addresses, comma-separated',
    );
  }
  const owner = config.ORDER_MAIL_OWNER.trim();
  if (!owner) {
    problems.push(
      'ORDER_MAIL_OWNER: is required when ORDER_MAIL_JMAP_TOKEN is set',
    );
  } else if (!looksLikeAddress(owner)) {
    problems.push('ORDER_MAIL_OWNER: must be an email address');
  }
  return problems;
}

/** ORDER_MAIL_SENDERS as lower-case addresses, blanks dropped. */
export function orderMailSenders(
  config: Pick<Config, 'ORDER_MAIL_SENDERS'>,
): string[] {
  return config.ORDER_MAIL_SENDERS.split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

// The shape only (one @, something on each side, no spaces): the check that
// matters is the sender's authentication (order-mail/trust.ts).
function looksLikeAddress(value: string): boolean {
  return /^[^\s@,]+@[^\s@,]+$/.test(value);
}

function allowedHostEntries(config: Pick<Config, 'ALLOWED_HOSTS'>): string[] {
  return config.ALLOWED_HOSTS.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * The hosts a request may be addressed to, as host keys
 * (src/allowed-hosts.ts): SITE_URL's, then ALLOWED_HOSTS'. Loopback is the
 * allowlist's own, never listed.
 */
export function allowedHosts(
  config: Pick<Config, 'SITE_URL' | 'ALLOWED_HOSTS'>,
): string[] {
  const keys = [
    urlHostKey(config.SITE_URL),
    ...allowedHostEntries(config).map(hostKey),
  ].filter((key) => key !== undefined);
  return [...new Set(keys)];
}

/** TRUSTED_PROXIES as Fastify's trustProxy list. */
export function trustedProxies(config: Pick<Config, 'TRUSTED_PROXIES'>) {
  return config.TRUSTED_PROXIES.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
