import {
  drizzle,
  type NodePgDatabase,
  type NodePgQueryResultHKT,
} from 'drizzle-orm/node-postgres';
import type { Logger as DrizzleLogger } from 'drizzle-orm/logger';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import {
  Client,
  type ClientConfig,
  Pool,
  type PoolClient,
  type PoolConfig,
} from 'pg';
import { readFileSync } from 'node:fs';
import type { Config, DatabaseSslMode } from '../config';
import type { Logger } from '../logger';
import {
  currentRequestTiming,
  type RequestTiming,
} from '../metrics/request-timing';
import {
  DatabaseUnreachable,
  isPoolQueueTimeout,
  isQueryReadTimeout,
  PoolExhausted,
} from './errors';
import * as schema from './schema';

/**
 * Where the database is: the DATABASE_* variables (src/config.ts), as
 * dbConfig() reads them for the server and the CLIs alike.
 */
export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** node-postgres's `ssl` (sslOption): false is plaintext, never PGSSLMODE. */
  ssl: false | { rejectUnauthorized: boolean; ca?: string };
}

export type Db = NodePgDatabase<typeof schema> & { $client: Pool };

/**
 * What a query function needs to run: the Drizzle instance or a transaction
 * opened on it (`db.transaction(async (tx) => ...)`). A write that must
 * commit with others takes this instead of `Db`, so its caller decides the
 * transaction (the outfit form saves and schedules in one).
 */
export type Queryable = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export function dbConfig(config: Config): DbConfig {
  return {
    host: config.DATABASE_HOST,
    port: config.DATABASE_PORT,
    database: config.DATABASE_NAME,
    user: config.DATABASE_USER,
    password: config.DATABASE_PASS,
    // loadConfig checked the file is readable, and only under `verify`.
    ssl: sslOption(
      config.DATABASE_SSL,
      config.DATABASE_SSL_CA && readFileSync(config.DATABASE_SSL_CA, 'utf8'),
    ),
  };
}

/**
 * DATABASE_SSL's mode as node-postgres's `ssl` (#694). `verify` checks the
 * chain (against `ca` when given, else Node's CAs) and the host name;
 * `no-verify` encrypts but accepts any certificate. Also drizzle.config.ts.
 */
export function sslOption(mode: DatabaseSslMode, ca?: string): DbConfig['ssl'] {
  switch (mode) {
    case 'verify':
      return ca === undefined
        ? { rejectUnauthorized: true }
        : { rejectUnauthorized: true, ca };
    case 'no-verify':
      return { rejectUnauthorized: false };
    case 'off':
      return false;
  }
}

/**
 * The limits a connection opens with. The session's are startup parameters
 * (they cost no round trip): a stalled transaction holds its row locks, the
 * owner lock included (src/web/auth/queries.ts), until one of these ends it.
 * `lock_timeout` is not here: every owner lock sets it for its own
 * transaction (OWNER_LOCK_TIMEOUT_MS, src/db/owner-lock.ts). The client's
 * own are for a host that stops answering (a NAS reboot, blackholed
 * packets), which no server-side limit can end: without them a request
 * waits on the kernel's TCP timeout, minutes (#643).
 */
export interface DbTimeouts {
  /** statement_timeout: the longest any one statement may run. */
  statementMs: number;
  /**
   * idle_in_transaction_session_timeout: how long a transaction may wait on
   * the application between statements before Postgres ends its session (a
   * request stuck on I/O inside a transaction, a client gone mid-way).
   */
  idleInTransactionMs: number;
  /**
   * connectionTimeoutMillis: how long opening a connection may take, and
   * also (pg-pool's own use of it) how long a caller waits for a pooled
   * connection to come free: that wait failing is PoolExhausted, a busy
   * pool, never the database out of reach.
   */
  connectMs: number;
  /**
   * query_timeout: how long the client waits for a statement's answer
   * before failing it itself. Just above statementMs, so a live server's
   * statement_timeout always fails first, with its SQLSTATE. The connection
   * it fails on is ended (TimedClient), never pooled again.
   */
  queryMs: number;
}

/**
 * TCP keepalive's first probe on an idle connection: one that silently died
 * is noticed (and dropped by the pool, or reopened by the cutout listener)
 * within about a minute, not the OS default's two hours.
 */
const KEEPALIVE_DELAY_MS = 60_000;

/**
 * The server's connections: every request, timer and job through the pool,
 * and the cutout listener's LISTEN connection (src/cutout/listener.ts).
 */
export const SERVER_TIMEOUTS: DbTimeouts = {
  statementMs: 15_000,
  idleInTransactionMs: 30_000,
  connectMs: 5_000,
  queryMs: 16_000,
};

/**
 * Operator-scale work that may legitimately run long: the boot's migrations
 * (their advisory-lock wait included: an overlapping deploy's second server
 * waits out the first's migration) and every CLI (runCli: the seed's
 * one-transaction persona, reconciliation). Long, but bounded, so a hung run
 * still ends on its own.
 */
export const MAINTENANCE_TIMEOUTS: DbTimeouts = {
  statementMs: 10 * 60_000,
  idleInTransactionMs: 5 * 60_000,
  connectMs: 5_000,
  queryMs: 10 * 60_000 + 5_000,
};

/**
 * Without `timeouts` a session keeps the database's and node-postgres's
 * defaults (none): the specs' own clients, which build fixtures.
 */
export function connectionOptions(
  config: DbConfig,
  timeouts?: DbTimeouts,
): ClientConfig {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl,
    ...(timeouts && {
      statement_timeout: timeouts.statementMs,
      idle_in_transaction_session_timeout: timeouts.idleInTransactionMs,
      connectionTimeoutMillis: timeouts.connectMs,
      query_timeout: timeouts.queryMs,
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS,
    }),
  };
}

// The app's only pool. Modest because pgvault is one Postgres shared by every
// homelab app, and a household never needs more than a handful of concurrent
// queries (a page is one to three). `min` keeps connections open across idle
// periods: a fresh one costs ~11 ms, which the server audit measured on every
// request once the old ORM's pool had shrunk. The server holds one more
// connection outside the pool while its cutout queue runs (the LISTEN
// connection, src/cutout/listener.ts): at most POOL_MAX + 1 per server.
const POOL_MAX = 10;
const POOL_MIN = 2;
const POOL_IDLE_TIMEOUT_MS = 30_000;

export interface DbOptions {
  /** The server's unless a caller says otherwise. */
  timeouts?: DbTimeouts;
  /** POOL_MAX unless a spec needs a pool it can fill. */
  max?: number;
  /**
   * Called each time the database is seen answering: a connection opened,
   * or a connection given back after a query it answered (TimedPool), with
   * when that connection or query began (performance.now()). The server
   * ends an outage with it (DatabaseOutage, createApp), but only with an
   * answer to something begun after the outage did (#842).
   */
  onAnswer?: (startedAt: number) => void;
}

/**
 * One pg Pool and the Drizzle instance over it. The caller owns the pool's
 * lifetime: `db.$client.end()` on shutdown.
 */
export function createDb(
  config: DbConfig,
  logger: Logger,
  {
    timeouts = SERVER_TIMEOUTS,
    max = POOL_MAX,
    onAnswer = () => undefined,
  }: DbOptions = {},
): Db {
  const pool = new TimedPool(
    {
      ...connectionOptions(config, timeouts),
      max,
      min: Math.min(POOL_MIN, max),
      idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    },
    onAnswer,
  );
  // A connection that dies emits 'error', and an 'error' event without a
  // listener kills the process. The pool listens only while a connection is
  // idle in it (Postgres restarted, network dropped), but a checked-out one
  // dies too: idle_in_transaction_session_timeout ends the session of a
  // transaction stalled between statements. So each connection has its own
  // listener for life, and the pool's exists only to be there. A dead
  // connection is not queryable: its transaction's next statement fails, and
  // the pool discards it on release and opens another on demand.
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      logger.error({ err: error }, 'Database connection failed');
    });
  });
  pool.on('error', () => {
    // Logged by the connection's own listener above.
  });
  logger.info(
    `Drizzle pool for ${config.database} on ${config.host}:${config.port} (max ${max}, min ${Math.min(POOL_MIN, max)}; ` +
      `statement_timeout ${timeouts.statementMs} ms, idle_in_transaction_session_timeout ${timeouts.idleInTransactionMs} ms, ` +
      `connect ${timeouts.connectMs} ms, query ${timeouts.queryMs} ms)`,
  );
  return drizzle(pool, { schema, logger: new StatementCounter() });
}

/**
 * Counts, on the request it runs for, every statement Drizzle sends: the
 * `dbStatements` of its RequestTiming (http_request_db_statements). Drizzle
 * calls a logger's logQuery synchronously as each query is sent, from the
 * caller's await chain, so the async context is the caller's; begin, commit,
 * rollback and savepoints go through the same path, so the count matches
 * what node-postgres sends (the integration harness's recordQueries,
 * checked in test/integration/metrics.spec.ts). Outside a request (jobs,
 * CLIs) nothing is counted. Logs nothing: the SQL text holds what users sent.
 */
class StatementCounter implements DrizzleLogger {
  logQuery(): void {
    const timing = currentRequestTiming();
    if (timing) timing.dbStatements += 1;
  }
}

/**
 * A Pool that adds, to the request it serves, the time from asking for a
 * connection to giving it back: the `db` of Server-Timing
 * (src/metrics/request-timing.ts). Drizzle reaches the pool two ways, both
 * through connect(): `pool.query` connects and releases around one query,
 * and a transaction holds one connection throughout. The request is read
 * when connect() is called, in the caller's async context; the pool's own
 * callbacks may run in another request's (a waiting connect is served from
 * whoever releases), so they only carry what was captured here. `release`
 * is the pool's own event, emitted synchronously as a client is returned.
 *
 * A connection it cannot hand out fails typed, the driver's error its cause
 * (errors.ts): waiting for a busy pool's connection to come free past
 * connectMs is PoolExhausted (load, the database fine); any other failure is
 * DatabaseUnreachable (node-postgres gives a connect timeout no code, and a
 * refused socket's errno is the same as an outbound fetch's, so only here is
 * it known to be the database).
 *
 * `onAnswer` hears the database answering: every connection opened, and
 * every connection given back with its last query answered (TimedClient), so
 * an outage ends with the first success whether or not the pool has to open
 * a connection for it (a full pool under steady load opens none). Each comes
 * with when it began: a slow query sent before the outage and answered after
 * its first failure says nothing of the database now (#842).
 */
class TimedPool extends Pool {
  private readonly held = new WeakMap<
    PoolClient,
    { timing: RequestTiming; since: number }
  >();

  constructor(config: PoolConfig, onAnswer: (startedAt: number) => void) {
    super({ ...config, Client: TimedClient });
    this.on('connect', (client) => {
      if (client instanceof TimedClient) onAnswer(client.openedAt);
    });
    this.on('release', (_error, client) => {
      const answered =
        client instanceof TimedClient ? client.takeAnswered() : undefined;
      if (answered !== undefined) onAnswer(answered);
      const hold = this.held.get(client);
      if (!hold) return;
      this.held.delete(client);
      hold.timing.dbMs += performance.now() - hold.since;
    });
  }

  override connect(): Promise<PoolClient>;
  override connect(
    callback: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ): void;
  override connect(
    callback?: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ): Promise<PoolClient> | void {
    const timing = currentRequestTiming();
    const since = performance.now();
    const hold = (client: PoolClient | undefined) => {
      if (timing && client) this.held.set(client, { timing, since });
    };
    if (callback) {
      super.connect((err, client, done) => {
        hold(client);
        callback(err && connectFailure(err), client, done);
      });
      return;
    }
    return super.connect().then(
      (client) => {
        hold(client);
        return client;
      },
      (error: unknown) => {
        throw connectFailure(error);
      },
    );
  }
}

function connectFailure(error: unknown): Error {
  return isPoolQueueTimeout(error)
    ? new PoolExhausted(error)
    : new DatabaseUnreachable(error);
}

/**
 * The pool's connection (TimedPool's `Client`), which watches each query's
 * outcome and changes nothing else: every form node-postgres takes (a
 * promise, a callback last) is passed through as it came.
 *
 * node-postgres's query_timeout fails the query but neither cancels it nor
 * ends the connection: the statement keeps running, and the next query
 * (Drizzle's ROLLBACK after a failed statement in a transaction) waits
 * behind it, then the connection goes back to the pool, still busy. So a
 * read timeout ends the connection at once (end() destroys a socket with a
 * query in flight): the rollback fails at once, and pg-pool discards an
 * ending client on release whether or not it is released with an error
 * (pool.query's is; a Drizzle transaction's is not).
 */
class TimedClient extends Client {
  /** Taken as the connection's start: pg-pool connects the client it has just made. */
  readonly openedAt = performance.now();
  // When the last query began, if it was answered.
  private answered: number | undefined;

  // Generic in its result so it stands in for each of the base's overloads.
  override query<R>(...args: unknown[]): R {
    const startedAt = performance.now();
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      args[args.length - 1] = (error: unknown, result: unknown) => {
        this.settled(error, startedAt);
        Reflect.apply(callback, undefined, [error, result]);
      };
    }
    const base: (...forwarded: unknown[]) => unknown = super.query.bind(this);
    const result = base(...args);
    if (result instanceof Promise) {
      void result.then(
        () => this.settled(undefined, startedAt),
        (error: unknown) => this.settled(error, startedAt),
      );
    }
    return result as R;
  }

  /**
   * When its last query began, if that query was answered; read once per
   * hold (TimedPool's release).
   */
  takeAnswered(): number | undefined {
    const answered = this.answered;
    this.answered = undefined;
    return answered;
  }

  // The last query decides: a transaction that began, then lost its
  // connection, says nothing of the database being back.
  private settled(error: unknown, startedAt: number): void {
    this.answered = error ? undefined : startedAt;
    // pg's end() never rejects.
    if (isQueryReadTimeout(error)) void this.end();
  }
}
