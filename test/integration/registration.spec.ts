import { count, eq } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionOptions } from '../../src/db/client';
import { user } from '../../src/db/schema';
import { lockFirstUser } from '../../src/web/auth/queries';
import { PAGE_ACCOUNT_HEADER } from '../../src/web/page-cache';
import { createTestApp, TEST_PASSWORD, TestApp, uniqueClient } from './harness';
import { backendPid, waitForBlockedOn } from './interleave';

/**
 * REGISTRATION (#670) other than `open`, which every other spec runs under
 * (the harness's default). Outside `open` the harness seeds its owner
 * through the database, so no account comes through the route unasked.
 */

const CLOSED = '/auth/login?registrationClosed=1';

/**
 * Closed, through DISABLE_REGISTRATION=true, the alias production's compose
 * still sets (config.spec.ts holds the mapping and its warning): every
 * registration route sends the visitor to the login page, which says so,
 * and creates nothing.
 */
describe('registration closed (DISABLE_REGISTRATION=true)', () => {
  let t: TestApp;
  const email = 'walk-in@example.com';

  const accounts = async () =>
    (
      await t.db.select({ n: count() }).from(user).where(eq(user.email, email))
    )[0].n;

  beforeAll(async () => {
    t = await createTestApp({
      REGISTRATION: undefined,
      DISABLE_REGISTRATION: 'true',
    });
  });

  afterAll(() => t?.cleanup());

  it.each([
    ['GET', '/auth/register'],
    ['POST', '/auth/register'],
    ['POST', '/auth/validate/register'],
  ] as const)(
    '%s %s redirects to the login page, which says why',
    async (method, url) => {
      const res = await t.inject({
        method,
        url,
        payload:
          method === 'POST'
            ? { email, password: TEST_PASSWORD, confirmPassword: TEST_PASSWORD }
            : undefined,
        headers: uniqueClient(),
        anonymous: true,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(CLOSED);
      expect(res.cookies).toHaveLength(0);
      expect(await accounts()).toBe(0);
    },
  );

  it('the login page shows the closed notice only when sent there', async () => {
    const notice = 'Registration is closed on this server';
    const sent = await t.inject({
      method: 'GET',
      url: CLOSED,
      anonymous: true,
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.body).toContain(notice);
    const plain = await t.inject({
      method: 'GET',
      url: '/auth/login',
      anonymous: true,
    });
    expect(plain.body).not.toContain(notice);
  });

  // What keeps the service worker's sentToLogin (src/web/page-cache.ts) from
  // reading this redirect as a session ended elsewhere: the session stays,
  // and the login page it lands on is rendered for the signed-in account.
  it('a signed-in visitor keeps the session, and the login page names the account', async () => {
    const res = await t.inject({ method: 'GET', url: '/auth/register' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(CLOSED);
    expect(res.cookies).toHaveLength(0);

    const landing = await t.inject({ method: 'GET', url: CLOSED });
    expect(landing.statusCode).toBe(200);
    expect(landing.headers[PAGE_ACCOUNT_HEADER.toLowerCase()]).toBe(
      String(t.owner.id),
    );
  });

  // An invite's register link: closed registration still comes back (#661).
  it('keeps a returnTo on its way to the login page', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/auth/register?returnTo=%2Fwardrobe-share%2Finvite%2Fabc',
      anonymous: true,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      '/auth/login?returnTo=%2Fwardrobe-share%2Finvite%2Fabc&registrationClosed=1',
    );
  });

  it('the login page offers no registration', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/auth/login',
      anonymous: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('href="/auth/register"');
  });

  it('existing accounts still sign in', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/auth/profile',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(t.owner.email);
  });
});

/**
 * The default, first-user: only the first account registers, then sign-up
 * is closed for good. The table starts empty (the seeded owner deleted), and
 * the cases run in order: the race decides the first account.
 */
describe('registration first-user (the default)', () => {
  let t: TestApp;

  const signUp = (email: string) =>
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
  const accounts = async () =>
    (await t.db.select({ n: count() }).from(user))[0].n;

  beforeAll(async () => {
    t = await createTestApp({ REGISTRATION: undefined });
    await t.db.delete(user);
  });

  afterAll(() => t?.cleanup());

  it('offers registration while no account exists', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/auth/login',
      anonymous: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="/auth/register"');
  });

  // Both pass the hook's look at an empty table; the lock decides. The spec
  // holds it until both wait behind it (pg_stat_activity), never by timing.
  it('lets exactly one of two simultaneous first sign-ups through', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: (pid: number) => void;
    const holder = new Promise<number>((resolve) => (locked = resolve));
    const holding = t.db.transaction(async (tx) => {
      await lockFirstUser(tx);
      locked(await backendPid(tx));
      await released;
    });
    const holderPid = await holder;
    const answers = Promise.all([
      signUp('first@example.com'),
      signUp('second@example.com'),
    ]);
    try {
      await waitForBlockedOn(t.db, holderPid, 2);
    } finally {
      release();
      await holding;
    }

    const [a, b] = await answers;
    const signedIn = [a, b].filter((res) =>
      res.cookies.some((c) => c.name === 'access_token'),
    );
    expect(signedIn).toHaveLength(1);
    const refused = signedIn[0] === a ? b : a;
    expect([a.statusCode, b.statusCode]).toEqual([302, 302]);
    expect(signedIn[0].headers.location).toBe('/');
    expect(refused.headers.location).toBe(CLOSED);
    expect(await accounts()).toBe(1);
    // In either order: the winner's latch and the loser's refusal.
    expect(t.logs.messages('info', 'Registration').sort()).toEqual([
      'Registration closed: the first account exists (first-user)',
      'Registration refused: an account exists (first-user)',
    ]);
  });

  it('is closed once the first account exists, and the login page says so', async () => {
    const res = await signUp('third@example.com');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(CLOSED);
    expect(res.cookies).toHaveLength(0);
    expect(await accounts()).toBe(1);

    const landing = await t.inject({
      method: 'GET',
      url: CLOSED,
      anonymous: true,
    });
    expect(landing.body).toContain('Registration is closed on this server');
    expect(landing.body).not.toContain('href="/auth/register"');
  });
});

/**
 * A restart with an account already stored starts latched: the account's
 * deletion in a session that never opened a registration page cannot
 * reopen sign-up (#1268).
 */
describe('registration first-user after a restart', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp(
      { REGISTRATION: undefined },
      {
        migrated: true,
        beforeBoot: async (env) => {
          const client = new Client(
            connectionOptions({
              host: env.DATABASE_HOST,
              port: Number(env.DATABASE_PORT),
              database: env.DATABASE_NAME,
              user: env.DATABASE_USER,
              password: env.DATABASE_PASS,
              ssl: false,
            }),
          );
          await client.connect();
          try {
            await client.query(
              `insert into "user" (email, password) values ('stored@example.com', 'x')`,
            );
          } finally {
            await client.end();
          }
        },
      },
    );
    await t.db.delete(user);
  });

  afterAll(() => t?.cleanup());

  it('stays closed after the last account is deleted', async () => {
    const page = await t.inject({
      method: 'GET',
      url: '/auth/register',
      anonymous: true,
    });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe(CLOSED);

    const post = await t.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'late@example.com',
        password: TEST_PASSWORD,
        confirmPassword: TEST_PASSWORD,
      },
      headers: uniqueClient(),
      anonymous: true,
    });
    expect(post.statusCode).toBe(302);
    expect(post.headers.location).toBe(CLOSED);
    expect(post.cookies).toHaveLength(0);
    expect(await t.db.select({ n: count() }).from(user)).toEqual([{ n: 0 }]);
  });
});
