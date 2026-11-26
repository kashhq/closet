import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalAccessToken, user } from '../../src/db/schema';
import { MAX_ACTIVE_TOKENS } from '../../src/web/auth/personal-tokens';
import type { Queryable } from '../../src/db/client';
import { NotFound } from '../../src/web/refusals';
import {
  findSessionAccount,
  insertUser,
  updatePasswordHash,
} from '../../src/web/auth/queries';
import { recordStatements } from '../support/query-recorder';
import { passwordFingerprint } from '../../src/web/auth/tokens';
import {
  createTestApp,
  PWA_ENV,
  recordQueries,
  TEST_PASSWORD,
  type TestApp,
  uniqueClient,
  userIdOf,
} from './harness';
import { mintToken } from './mcp';
import { interleave } from './interleave';

/**
 * What each auth, account and push request costs in statements (#171):
 * production reaches Postgres over a link of ~114 ms a round trip, so the
 * count is the latency. The session lookup reads the hash's fingerprint,
 * not the hash, except on a route that checks the current password, where
 * the same statement hands the route its hash (sessionAccount). The
 * behaviour of each route is its own spec's (auth, account, access-tokens,
 * push, session-revocation); this one pins the statements.
 */

const NEW_PASSWORD = 'Another-pass-2';

describe('auth, account and push statements (#171)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp(PWA_ENV);
  });

  afterAll(() => t?.cleanup());

  const register = (email: string) =>
    t.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email,
        password: TEST_PASSWORD,
        confirmPassword: TEST_PASSWORD,
      },
      headers: uniqueClient(),
      anonymous: true,
    });

  const change = (cookie: string, email: string) =>
    t.inject({
      method: 'POST',
      url: '/auth/update-email',
      payload: { email, confirmEmail: email, currentPassword: TEST_PASSWORD },
      headers: { cookie },
    });

  /** The statements `work` sent that Postgres refused, by SQLSTATE. */
  const refusedStatements = async (work: () => Promise<unknown>) => {
    const { statements } = await recordStatements(work);
    return statements.flatMap((statement) =>
      statement.error ? [statement.error] : [],
    );
  };

  /**
   * Holds a transaction that has written `hold` open, runs `request` (which
   * must then wait on its lock: the unique index's), commits the first and
   * answers the request: the race a taken address's check cannot see.
   */
  async function raceAgainst(
    hold: (tx: Queryable) => Promise<unknown>,
    request: () => Promise<LightMyRequestResponse>,
  ): Promise<LightMyRequestResponse> {
    const [, answer] = await interleave(t.db, hold, request);
    return answer;
  }

  const passwordOf = async (id: number) => {
    const [row] = await t.db
      .select({ password: user.password })
      .from(user)
      .where(eq(user.id, id));
    return row.password;
  };

  describe('the session lookup', () => {
    it('is one statement on a plain signed-in page, and never reads the hash', async () => {
      const record = await recordQueries(async () => {
        const res = await t.inject({
          method: 'GET',
          url: '/auth/change-password',
        });
        expect(res.statusCode).toBe(200);
      });
      expect(record.statements).toBe(1);
      expect(record.rows).toBe(1);
      const [lookup] = record.sql;
      expect(lookup).toMatch(
        /^select "id", "email", right\("password", \$\d\), nullif\(coalesce\(\(select case when "bumped_at" .* from "sync_epoch"\), \$\d\), .*\), "session_version" from "user"/,
      );
      // The hash as a column of its own (the checksPassword shape below).
      expect(lookup).not.toMatch(/, "password"(,| from)/);
    });

    it('cuts the same fingerprint in SQL that a token carries', async () => {
      const id = t.owner.id;
      const hash = await passwordOf(id);
      const account = await findSessionAccount(t.db, id, { withHash: false });
      expect(account).toEqual({
        id,
        email: t.owner.email,
        fingerprint: passwordFingerprint(hash),
        sessionEpoch: null,
        sessionVersion: 0,
      });
      expect(await findSessionAccount(t.db, id, { withHash: true })).toEqual({
        ...account,
        password: hash,
      });
    });

    it('reads the hash in the same statement on a route that checks the password', async () => {
      const cookie = await t.register('hash-once@example.com');
      const record = await recordQueries(async () => {
        const res = await t.inject({
          method: 'POST',
          url: '/auth/update-email',
          payload: {
            email: 'hash-twice@example.com',
            confirmEmail: 'hash-twice@example.com',
            currentPassword: 'NotMyPassword1',
          },
          headers: { cookie },
        });
        expect(res.statusCode).toBe(400);
      });
      // The refusal is the lookup alone: the check read no row of its own.
      expect(record.statements).toBe(1);
      expect(record.sql[0]).toMatch(/, "password" from "user"/);
    });
  });

  it('sign-in is one statement', async () => {
    await t.register('sign-in@example.com');
    const record = await recordQueries(async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'sign-in@example.com', password: TEST_PASSWORD },
        headers: uniqueClient(),
        anonymous: true,
      });
      expect(res.statusCode).toBe(302);
    });
    expect(record.statements).toBe(1);
  });

  describe('registration', () => {
    it('is the insert alone', async () => {
      const record = await recordQueries(async () => {
        expect((await register('joiner@example.com')).statusCode).toBe(302);
      });
      expect(record.statements).toBe(1);
      expect(record.sql[0]).toMatch(/^\s*insert into "user"/);
      expect(record.sql[0]).toMatch(/where not exists/);
    });

    it('a taken address, in any case, is the same one statement and a field error', async () => {
      await t.register('first@example.com');
      const record = await recordQueries(async () => {
        const res = await register('First@Example.com');
        expect(res.statusCode).toBe(400);
        expect(res.body).toContain('Another account already uses this email');
        expect(res.headers['set-cookie']).toBeUndefined();
      });
      expect(record.statements).toBe(1);
      expect(record.rows).toBe(0);
      const accounts = await t.db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, 'first@example.com'));
      expect(accounts).toHaveLength(1);
      expect(t.logs.messages('info', 'Web')).toContain(
        'Registration refused: the email is taken',
      );
    });
  });

  describe('change email', () => {
    it('is the lookup and the update', async () => {
      const cookie = await t.register('mover@example.com');
      const record = await recordQueries(async () => {
        expect((await change(cookie, 'moved@example.com')).statusCode).toBe(
          302,
        );
      });
      expect(record.statements).toBe(2);
      expect(record.sql[1]).toMatch(/^update "user" set "email"/);
    });

    it('an address taken by another account is the same two statements', async () => {
      await t.register('holder@example.com');
      const cookie = await t.register('claimer@example.com');
      const id = await userIdOf(t, 'claimer@example.com');
      const record = await recordQueries(async () => {
        const res = await change(cookie, 'holder@example.com');
        expect(res.statusCode).toBe(400);
        expect(res.body).toContain('Another account already uses this email');
      });
      expect(record.statements).toBe(2);
      expect(t.logs.messages('info', 'Web')).toContain(
        `Email change refused for user ${id}: the email is taken`,
      );
    });
  });

  describe('a taken address raises no error; the race and other conflicts', () => {
    it('neither route sends a statement Postgres refuses for a taken address', async () => {
      await t.register('quiet@example.com');
      const cookie = await t.register('quiet-mover@example.com');
      expect(
        await refusedStatements(async () => {
          expect((await register('Quiet@example.com')).statusCode).toBe(400);
          expect((await change(cookie, 'quiet@example.com')).statusCode).toBe(
            400,
          );
        }),
      ).toEqual([]);
    });

    it('registration that loses the race to a sign-up is the field error', async () => {
      const res = await raceAgainst(
        (tx) =>
          insertUser(tx, 'racer@example.com', 'not-a-hash-racer').then((row) =>
            expect(row).toBeDefined(),
          ),
        () => register('racer@example.com'),
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('Another account already uses this email');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('an email change that loses the race is the field error', async () => {
      const cookie = await t.register('race-mover@example.com');
      const id = await userIdOf(t, 'race-mover@example.com');
      const res = await raceAgainst(
        (tx) => insertUser(tx, 'race-target@example.com', 'not-a-hash-target'),
        () => change(cookie, 'race-target@example.com'),
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('Another account already uses this email');
      const [row] = await t.db
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, id));
      expect(row.email).toBe('race-mover@example.com');
    });

    it('a unique violation of another index is an error, never "taken"', async () => {
      // At most one account at clash.test: a unique index that is not the
      // address's, standing in for one a later migration might add.
      await t.db.execute(
        sql.raw(`create unique index test_clash_unique on "user" ((true))
                 where email like '%@clash.test'`),
      );
      try {
        await t.register('first@clash.test');
        const registered = await register('second@clash.test');
        expect(registered.statusCode).toBe(500);
        expect(registered.body).not.toContain('Another account already uses');

        const cookie = await t.register('mover@elsewhere.test');
        const moved = await change(cookie, 'third@clash.test');
        expect(moved.statusCode).toBe(500);
        expect(moved.body).not.toContain('Another account already uses');
      } finally {
        await t.db.execute(sql.raw('drop index test_clash_unique'));
      }
    });
  });

  it('change password is the lookup and a transaction: the new hash, then one statement that revokes the rest', async () => {
    const email = 'rotator@example.com';
    const cookie = await t.register(email);
    const id = await userIdOf(t, email);
    await mintToken(t, id, 'Laptop');
    await mintToken(t, id, 'Phone', 'device');
    const before = await passwordOf(id);
    const record = await recordQueries(async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/auth/change-password',
        payload: {
          currentPassword: TEST_PASSWORD,
          newPassword: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
        },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(302);
    });
    // The lookup; begin, the hash (taking the row lock), the revocations
    // read after the lock was granted, commit (#189: one statement's
    // snapshot predates its lock wait, and missed a token minted meanwhile).
    expect(record.statements).toBe(1 + 4);
    expect(record.sql[2]).toMatch(/^update "user"/);
    expect(record.sql[3]).toMatch(/^with "revoked_tokens" as \(update/);
    expect(passwordFingerprint(await passwordOf(id))).not.toBe(
      passwordFingerprint(before),
    );
    const tokens = await t.db
      .select({ revokedAt: personalAccessToken.revokedAt })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.userId, id));
    expect(tokens).toHaveLength(2);
    for (const token of tokens) expect(token.revokedAt).not.toBeNull();
    expect(t.logs.messages('info', 'Web')).toContain(
      `Password changed for user ${id}: other sessions, 1 MCP tokens, 1 device tokens, 0 other push devices and 0 unanswered invites revoked`,
    );
  });

  // #700: the same shape, the bump in place of the hash; agent tokens stay.
  it('sign out everywhere is the lookup and a transaction: the bump, then one statement that revokes the device tokens and pushes', async () => {
    const email = 'everywhere-statements@example.com';
    const cookie = await t.register(email);
    const id = await userIdOf(t, email);
    await mintToken(t, id, 'Laptop');
    await mintToken(t, id, 'Phone', 'device');
    const record = await recordQueries(async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/auth/sign-out-everywhere',
        payload: { currentPassword: TEST_PASSWORD },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(302);
    });
    expect(record.statements).toBe(1 + 4);
    expect(record.sql[2]).toMatch(
      /^update "user" set "session_version" = "user"\."session_version" \+ 1/,
    );
    expect(record.sql[3]).toMatch(/^with "revoked_tokens" as \(update/);
    expect(record.sql[3]).not.toMatch(/wardrobe_share/);
    const tokens = await t.db
      .select({
        kind: personalAccessToken.kind,
        revokedAt: personalAccessToken.revokedAt,
      })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.userId, id));
    expect(
      tokens.map((token) => [token.kind, token.revokedAt !== null]).sort(),
    ).toEqual([
      ['device', true],
      ['mcp', false],
    ]);
  });

  it('a password written for an account that is gone is a 404, never a half-read row', async () => {
    const gone = await updatePasswordHash(t.db, 999_999, 'not-a-hash').catch(
      (error: unknown) => error,
    );
    expect(gone).toBeInstanceOf(NotFound);
    expect(gone).toMatchObject({
      statusCode: 404,
      resource: 'account',
      message: 'Account not found',
    });
  });

  it('delete account is the lookup and its transaction', async () => {
    const email = 'leaver@example.com';
    const cookie = await t.register(email);
    const record = await recordQueries(async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/auth/delete-account',
        payload: { email, password: TEST_PASSWORD },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(302);
    });
    // begin, the files, the pending photos, the user, commit.
    expect(record.statements).toBe(1 + 5);
  });

  describe('access tokens', () => {
    const create = (cookie: string, name: string) =>
      t.inject({
        method: 'POST',
        url: '/auth/tokens',
        payload: { name, currentPassword: TEST_PASSWORD },
        headers: { cookie },
      });

    it('creating reads the list under the lock and shows it without a read after commit', async () => {
      const email = 'minter@example.com';
      const cookie = await t.register(email);
      await mintToken(t, await userIdOf(t, email), 'Older');
      let body = '';
      const record = await recordQueries(async () => {
        const res = await create(cookie, 'Newer');
        expect(res.statusCode).toBe(200);
        body = res.body;
      });
      // The lookup; begin, the lock, the list, the insert, commit.
      expect(record.statements).toBe(1 + 5);
      expect(
        record.sql.filter((sql) => /personal_access_token/.test(sql)),
      ).toHaveLength(2);
      // Both tokens listed, the new one first.
      expect(body.indexOf('Newer')).toBeGreaterThan(-1);
      expect(body.indexOf('Newer')).toBeLessThan(body.indexOf('Older'));
    });

    it(`at ${MAX_ACTIVE_TOKENS} the refusal shows the list read under the lock`, async () => {
      const email = 'hoarder@example.com';
      const cookie = await t.register(email);
      const id = await userIdOf(t, email);
      for (let n = 0; n < MAX_ACTIVE_TOKENS; n += 1) {
        await mintToken(t, id, `Kept ${n}`);
      }
      let body = '';
      const record = await recordQueries(async () => {
        const res = await create(cookie, 'One more');
        expect(res.statusCode).toBe(400);
        body = res.body;
      });
      // The lookup; begin, the lock, the list, commit: no insert, no re-read.
      expect(record.statements).toBe(1 + 4);
      for (let n = 0; n < MAX_ACTIVE_TOKENS; n += 1) {
        expect(body).toContain(`Kept ${n}`);
      }
    });

    it('revoking is the lookup and the update', async () => {
      const email = 'revoker@example.com';
      const cookie = await t.register(email);
      const created = await mintToken(t, await userIdOf(t, email), 'Old');
      if (!created.created) throw new Error('no token');
      const record = await recordQueries(async () => {
        const res = await t.inject({
          method: 'POST',
          url: `/auth/tokens/${created.id}/revoke`,
          headers: { cookie },
        });
        expect(res.statusCode).toBe(303);
      });
      expect(record.statements).toBe(2);
    });

    it('signing a device out is the lookup and the update (#189)', async () => {
      const email = 'device-revoker@example.com';
      const cookie = await t.register(email);
      const created = await mintToken(
        t,
        await userIdOf(t, email),
        'Phone',
        'device',
      );
      if (!created.created) throw new Error('no token');
      const record = await recordQueries(async () => {
        const res = await t.inject({
          method: 'POST',
          url: `/auth/devices/${created.id}/revoke`,
          headers: { cookie },
        });
        expect(res.statusCode).toBe(303);
      });
      expect(record.statements).toBe(2);
    });
  });

  describe('push', () => {
    const subscription = () => ({
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      keys: {
        p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      },
    });

    it('subscribing and unsubscribing are the lookup and one write each', async () => {
      const device = subscription();
      const subscribed = await recordQueries(async () => {
        const res = await t.inject({
          method: 'POST',
          url: '/push/subscribe',
          payload: device,
        });
        expect(res.statusCode).toBe(204);
      });
      expect(subscribed.statements).toBe(2);
      const unsubscribed = await recordQueries(async () => {
        const res = await t.inject({
          method: 'POST',
          url: '/push/unsubscribe',
          payload: { endpoint: device.endpoint },
        });
        expect(res.statusCode).toBe(204);
      });
      expect(unsubscribed.statements).toBe(2);
    });
  });
});
