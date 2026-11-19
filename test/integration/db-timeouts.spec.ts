import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  type Db,
  type DbTimeouts,
  SERVER_TIMEOUTS,
} from '../../src/db/client';
import { outfit } from '../../src/db/schema';
import { OWNER_LOCK_TIMEOUT_MS } from '../../src/db/owner-lock';
import { lockOwner, ownerTransaction } from '../../src/web/auth/queries';
import { isDatabaseUnavailable } from '../../src/db/errors';
import { HttpError } from '../../src/web/errors';
import { t as translate } from '../../src/web/i18n';
import { createGarment } from './garments';
import { createTestApp, type TestApp } from './harness';

/**
 * Database timeouts (#134, src/db/AGENTS.md, Timeouts): one stuck
 * transaction must not wedge an owner's writes. The server's pool opens its
 * connections with statement_timeout and idle_in_transaction_session_timeout;
 * every form of the owner lock bounds its lock waits (lock_timeout), so a
 * writer queued behind a held owner lock fails fast with a 503 instead of
 * hanging.
 */

describe('database timeouts', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  /** A second pool on the app's database, with timeouts short enough to watch. */
  async function withPool<T>(
    timeouts: DbTimeouts,
    use: (db: Db) => Promise<T>,
    max?: number,
  ): Promise<T> {
    const db = createDb(t.database, t.logger, { timeouts, max });
    try {
      return await use(db);
    } finally {
      await db.$client.end();
    }
  }

  const setting = async (db: Db, name: string) => {
    const { rows } = await db.execute<{ value: string }>(
      sql`select current_setting(${name}) as value`,
    );
    return rows[0].value;
  };

  it("opens the server pool's connections with its statement and idle-in-transaction timeouts", async () => {
    expect(SERVER_TIMEOUTS).toEqual({
      statementMs: 15_000,
      idleInTransactionMs: 30_000,
      connectMs: 5_000,
      queryMs: 16_000,
    });
    expect(await setting(t.db, 'statement_timeout')).toBe('15s');
    expect(await setting(t.db, 'idle_in_transaction_session_timeout')).toBe(
      '30s',
    );
    // Only an owner lock bounds its lock waits.
    expect(await setting(t.db, 'lock_timeout')).toBe('0');
    const inside = await ownerTransaction(t.db, t.owner.id, 'spec', (tx) =>
      tx
        .execute<{
          value: string;
        }>(sql`select current_setting('lock_timeout') as value`)
        .then(({ rows }) => rows[0].value),
    );
    expect(inside).toBe(`${OWNER_LOCK_TIMEOUT_MS / 1000}s`);
  });

  // Both forms of the lock behind one hold: ownerTransaction's (the outfit,
  // logged with its writer) and a folded one (the condition autosave's
  // update, src/db/owner-lock.ts), which waited to statement_timeout and
  // answered a 500 before every form set the timeout (PR #537).
  it('fails writers queued behind a held owner lock within the lock timeout, as a 503, whichever form of the lock they take', async () => {
    const tee = await createGarment(t, { name: 'Stuck tee' });
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = t.db.transaction(async (tx) => {
      await lockOwner(tx, t.owner.id);
      held();
      await released;
    });
    await Promise.race([holding, holder]);

    const outfitPost = {
      method: 'POST',
      url: '/outfits',
      payload: {
        name: 'Behind a stuck write',
        category: 'shirt',
        garmentId: String(tee),
      },
    } as const;
    const conditionPost = {
      method: 'POST',
      url: `/wardrobe/${tee}/condition`,
      payload: {
        condition: 'needs_repair',
        conditionNote: 'Behind a stuck write',
      },
    } as const;
    const started = performance.now();
    const timed = async (request: Parameters<TestApp['inject']>[0]) => {
      const answer = await t.inject(request);
      return { answer, waited: performance.now() - started };
    };
    const answers = await Promise.all([
      timed(outfitPost),
      timed(conditionPost),
    ]);
    release();
    await holder;

    for (const { answer, waited } of answers) {
      expect(answer.statusCode).toBe(503);
      expect(answer.body).toContain(translate('WARDROBE_BUSY'));
      expect(waited).toBeGreaterThanOrEqual(OWNER_LOCK_TIMEOUT_MS - 50);
      // The timeout, not the statement's 15 s or the holder's release.
      expect(waited).toBeLessThan(SERVER_TIMEOUTS.statementMs);
    }
    expect(t.logs.messages('warn', 'Web')).toEqual(
      expect.arrayContaining([
        `POST /outfits -> 503: ${translate('WARDROBE_BUSY')} (createOutfit for owner ${t.owner.id} waited ${OWNER_LOCK_TIMEOUT_MS} ms for a lock)`,
        `POST /wardrobe/${tee}/condition -> 503: ${translate('WARDROBE_BUSY')} (a write waited ${OWNER_LOCK_TIMEOUT_MS} ms for a lock)`,
      ]),
    );
    const written = await t.db
      .select({ id: outfit.id })
      .from(outfit)
      .where(eq(outfit.name, 'Behind a stuck write'));
    expect(written).toEqual([]);

    // Once the holder is gone the same write goes through.
    const retried = await t.inject(outfitPost);
    expect(retried.statusCode, retried.body).toBe(302);
  });

  it('answers a writer whose owner is gone with a 404, never an unlocked write', async () => {
    let ran = false;
    const refused = await ownerTransaction(t.db, 2_000_000_000, 'spec', () => {
      ran = true;
      return Promise.resolve();
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HttpError);
    expect((refused as HttpError).statusCode).toBe(404);
    expect(ran).toBe(false);
  });

  it('ends a transaction left idle past idle_in_transaction_session_timeout, and the pool recovers', async () => {
    await withPool(
      { ...SERVER_TIMEOUTS, idleInTransactionMs: 200 },
      async (db) => {
        let pid = 0;
        const stalled = await db
          .transaction(async (tx) => {
            const { rows } = await tx.execute<{ pid: number }>(
              sql`select pg_backend_pid() as pid`,
            );
            pid = rows[0].pid;
            // A request stuck on I/O inside its transaction.
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            await tx.execute(sql`select 1`);
          })
          .then(
            () => 'committed',
            () => 'failed',
          );
        expect(stalled).toBe('failed');
        // Postgres ended the session (not just the statement), and the
        // process heard it instead of dying of an unheard 'error'.
        const { rows } = await t.db.execute<{ alive: boolean }>(
          sql`select exists (select 1 from pg_stat_activity where pid = ${pid}) as alive`,
        );
        expect(rows[0].alive).toBe(false);
        expect(
          t.logs.records.some(
            (record) =>
              record.level === 'error' &&
              record.msg === 'Database connection failed',
          ),
        ).toBe(true);
        // The dead connection was dropped; the next query gets a live one.
        expect(await setting(db, 'idle_in_transaction_session_timeout')).toBe(
          '200ms',
        );
      },
    );
  });

  it('cancels a statement past statement_timeout', async () => {
    await withPool({ ...SERVER_TIMEOUTS, statementMs: 200 }, async (db) => {
      const outcome = await db.execute(sql`select pg_sleep(2)`).then(
        () => 'finished',
        // drizzle's error names the statement; the driver's, its cause.
        (error: Error) => String((error.cause as Error | undefined)?.message),
      );
      expect(outcome).toBe('canceling statement due to statement timeout');
    });
  });

  // The client's query_timeout fails the query but leaves it running on its
  // connection; a transaction's ROLLBACK then waited behind it, and the
  // connection went back to the pool still busy (#643). A pool of one shows
  // it: the next query would queue behind the sleeping statement.
  it('ends a connection whose query ran past query_timeout, so the next query gets a fresh one at once', async () => {
    await withPool(
      { ...SERVER_TIMEOUTS, statementMs: 60_000, queryMs: 200 },
      async (db) => {
        const pidOf = async (q: Pick<Db, 'execute'>) => {
          const { rows } = await q.execute<{ pid: number }>(
            sql`select pg_backend_pid() as pid`,
          );
          return rows[0].pid;
        };
        // Both of Drizzle's paths: a single statement (pool.query, released
        // with its error) and a transaction (released without one).
        const stuck: number[] = [];
        const single = await db.execute(sql`select pg_sleep(30)`).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(isDatabaseUnavailable(single)).toBe(true);
        const inTransaction = await db
          .transaction(async (tx) => {
            stuck.push(await pidOf(tx));
            await tx.execute(sql`select pg_sleep(30)`);
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(isDatabaseUnavailable(inTransaction)).toBe(true);

        const started = performance.now();
        const next = await pidOf(db);
        // Not behind a 30 s sleep: a fresh connection, opened at once.
        expect(performance.now() - started).toBeLessThan(5_000);
        expect(next).not.toBe(stuck[0]);
        // The server never heard the client leave: its sleeps run on.
        await t.db.execute(
          sql`select pg_terminate_backend(pid) from pg_stat_activity
              where datname = current_database() and query = 'select pg_sleep(30)'`,
        );
      },
      1,
    );
  });

  // DatabaseOutage ends an outage only with an answer to something begun
  // after it did (#842), so the pool must say when each answer began, not
  // when it came: a connection's opening, a query answered (the last of a
  // transaction), nothing for one that failed.
  it('tells onAnswer when each connection opened and each answered query began', async () => {
    const heard: number[] = [];
    const db = createDb(t.database, t.logger, {
      max: 1,
      onAnswer: (startedAt) => heard.push(startedAt),
    });
    try {
      const before = performance.now();
      await db.execute(sql`select 1`);
      // The connection's opening, then the query it answered.
      expect(heard).toHaveLength(2);
      const [opened, answered] = heard;
      expect(opened).toBeGreaterThanOrEqual(before);
      expect(answered).toBeGreaterThanOrEqual(opened);
      expect(answered).toBeLessThanOrEqual(performance.now());

      // A failed query says nothing of the database answering.
      await db.execute(sql`select 1 / 0`).catch(() => undefined);
      expect(heard).toHaveLength(2);

      // The failed connection is discarded, so a transaction opens another
      // (heard once) and reports its last statement's start, once.
      await db.transaction(async (tx) => {
        await tx.execute(sql`select 1`);
        await new Promise((later) => setTimeout(later, 20));
      });
      expect(heard).toHaveLength(4);
      const [, , reopened, committed] = heard;
      expect(reopened).toBeGreaterThanOrEqual(answered);
      expect(committed).toBeGreaterThan(reopened + 15);
    } finally {
      await db.$client.end();
    }
  });
});
