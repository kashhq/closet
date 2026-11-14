import { loginUrl } from '../../src/web/auth/return-to';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import jwt from 'jsonwebtoken';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalAccessToken, user, userDevice } from '../../src/db/schema';
import { runSetPassword } from '../../src/maintenance/set-password';
import {
  createSessionTokens,
  passwordFingerprint,
} from '../../src/web/auth/tokens';
import { captureLogs } from '../support/log-capture';
import { createGarment } from './garments';
import {
  createTestApp,
  PWA_ENV,
  subscribeAs,
  TEST_PASSWORD,
  type TestApp,
  unescapeHtml,
  uniqueClient,
  userIdOf,
} from './harness';
import { mintToken } from './mcp';
import { planEntry, takeSelfie } from './selfies';

/**
 * A session ended away from the device (a password changed on another one
 * or by `user:set-password`, the account deleted elsewhere, a rotated
 * ACCESS_TOKEN_SECRET, expiry) must not leave that account's private cache
 * behind: the next request carrying the dead cookie gets the cookie cleared
 * and `Clear-Site-Data: "cache"`, whatever it asked for (a page, an htmx
 * fragment, a selfie, the public login page). The session resolver does it
 * (createSessionResolver, src/web/auth/session.ts). A request without the
 * cookie, a live session and the device that changed its own password get
 * neither. Sign-out's own header is in account.spec.ts and security.spec.ts.
 */

// The app's signing secret, so a spec can sign what a server once issued:
// an expired token, one from before a rotation.
const SECRET = 'session-revocation-secret-0123456789abcdef';
const NEW_PASSWORD = 'NewPassword456!';

/** The requests a revoked device may send next, as a browser sends them. */
const NEXT_REQUESTS = [
  {
    label: 'a page navigation',
    url: '/wardrobe',
    headers: { 'sec-fetch-mode': 'navigate' },
    status: 302,
  },
  {
    label: 'an htmx fragment',
    url: '/wardrobe',
    headers: { 'hx-request': 'true', 'sec-fetch-mode': 'cors' },
    status: 401,
  },
  {
    label: 'a selfie <img>',
    url: '/selfies/thumb/00000000-0000-4000-8000-000000000000.webp?v=1',
    headers: { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
    status: 401,
  },
  {
    label: 'the public login page',
    url: '/auth/login',
    headers: { 'sec-fetch-mode': 'navigate' },
    status: 200,
  },
] as const;

function expectSessionEnded(res: LightMyRequestResponse): void {
  expect(res.headers['clear-site-data']).toBe('"cache"');
  // What the service worker reads: Chromium hides Clear-Site-Data (#131).
  expect(res.headers['x-session-ended']).toBe('1');
  const cleared = res.cookies.find((c) => c.name === 'access_token');
  expect(cleared?.value).toBe('');
  expect(cleared?.path).toBe('/');
  expect(cleared?.expires?.getTime()).toBeLessThanOrEqual(Date.now());
}

function expectNothingCleared(res: LightMyRequestResponse): void {
  expect(res.headers['clear-site-data']).toBeUndefined();
  expect(res.headers['x-session-ended']).toBeUndefined();
  expect(res.cookies.find((c) => c.name === 'access_token')).toBeUndefined();
}

describe('a revoked session clears the device', () => {
  let t: TestApp;

  const accountRow = async (email: string) =>
    (await t.db.query.user.findFirst({ where: eq(user.email, email) }))!;

  /** Every shape of next request with the dead cookie ends the session. */
  const expectEndedOnEveryRequest = async (deadCookie: string) => {
    for (const next of NEXT_REQUESTS) {
      const res = await t.inject({
        method: 'GET',
        url: next.url,
        headers: { ...next.headers, cookie: deadCookie },
      });
      expect(res.statusCode, next.label).toBe(next.status);
      expectSessionEnded(res);
      if (next.status === 302) {
        expect(res.headers.location).toBe(loginUrl(next.url));
      }
      if (next.status === 401) {
        expect(res.headers['hx-redirect']).toBe('/auth/login');
      }
    }
  };

  beforeAll(async () => {
    t = await createTestApp({ ACCESS_TOKEN_SECRET: SECRET });
  });

  afterAll(() => t?.cleanup());

  it('a request without a cookie gets neither header: nothing was signed in', async () => {
    for (const next of NEXT_REQUESTS) {
      const res = await t.inject({
        method: 'GET',
        url: next.url,
        headers: next.headers,
        anonymous: true,
      });
      expect(res.statusCode, next.label).toBe(next.status);
      expectNothingCleared(res);
    }
  });

  it('a live session gets neither header', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(res.statusCode).toBe(200);
    expectNothingCleared(res);
  });

  it('a password change ends the other device, whose selfie is refused with the header; this device keeps its session and its cache', async () => {
    const email = 'changer@example.com';
    const thisDevice = await t.register(email);
    const otherDevice = await t.login(email);

    // The other device has a selfie in its HTTP cache, served privately.
    const garmentId = await createGarment(t, {
      name: 'Mirror tee',
      cookie: otherDevice,
    });
    const created = await t.inject({
      method: 'POST',
      url: '/outfits',
      payload: { name: 'Mirror', category: 'shirt', garmentId: `${garmentId}` },
      headers: { cookie: otherDevice },
    });
    const outfitId = Number(/(\d+)$/.exec(created.headers.location!)![1]);
    const entryId = await planEntry(t, outfitId, t.today(), otherDevice);
    const { fileName } = await takeSelfie(t, entryId, otherDevice);
    const selfieUrl = `/selfies/thumb/${fileName}?v=1`;
    const image = { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' };
    const cached = await t.inject({
      method: 'GET',
      url: selfieUrl,
      headers: { ...image, cookie: otherDevice },
    });
    expect(cached.statusCode).toBe(200);
    expect(cached.headers['cache-control']).toContain('private');
    expectNothingCleared(cached);

    const changed = await t.inject({
      method: 'POST',
      url: '/auth/change-password',
      payload: {
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      },
      headers: { cookie: thisDevice },
    });
    expect(changed.statusCode).toBe(302);
    // This device's answer reissues its cookie and clears nothing.
    expect(changed.headers['clear-site-data']).toBeUndefined();
    const replacement = changed.cookies.find((c) => c.name === 'access_token');
    expect(replacement?.value).toBeTruthy();
    const survivor = `access_token=${replacement!.value}`;

    // The other device's next request, whatever it is, ends it there.
    const refused = await t.inject({
      method: 'GET',
      url: selfieUrl,
      headers: { ...image, cookie: otherDevice },
    });
    expect(refused.statusCode).toBe(401);
    expect(refused.headers['hx-redirect']).toBe('/auth/login');
    expectSessionEnded(refused);
    await expectEndedOnEveryRequest(otherDevice);
    expect(t.logs.messages('info', 'Session')).toContain(
      `Rejected access token (password fingerprint mismatch for user ${await userIdOf(t, email)}): cookie cleared, Clear-Site-Data sent`,
    );

    // The device that changed it stays signed in, cache and all.
    for (const url of ['/wardrobe', '/auth/profile?passwordChanged=1']) {
      const res = await t.inject({
        method: 'GET',
        url,
        headers: { cookie: survivor },
      });
      expect(res.statusCode).toBe(200);
      expectNothingCleared(res);
    }
  });

  it('user:set-password ends every session, each on its next request', async () => {
    const email = 'recovered@example.com';
    const session = await t.register(email);
    const { logger } = captureLogs();
    const status = await runSetPassword({
      args: [email],
      db: t.db,
      input: Readable.from([`${NEW_PASSWORD}\n`]),
      output: new PassThrough(),
      errors: new PassThrough(),
      logger,
    });
    expect(status).toBe(0);

    await expectEndedOnEveryRequest(session);
  });

  it('deleting the account clears this device, and the other device on its next request', async () => {
    const email = 'leaving@example.com';
    const thisDevice = await t.register(email);
    const otherDevice = await t.login(email);

    const deleted = await t.inject({
      method: 'POST',
      url: '/auth/delete-account',
      payload: { email, password: TEST_PASSWORD },
      headers: { cookie: thisDevice },
    });
    expect(deleted.statusCode).toBe(302);
    expectSessionEnded(deleted);

    await expectEndedOnEveryRequest(otherDevice);
  });

  it('a rotated ACCESS_TOKEN_SECRET ends a session signed with the old one', async () => {
    const email = 'rotated@example.com';
    await t.register(email);
    const signedBefore = createSessionTokens(
      'the-secret-before-rotation-0123456789abcdef',
    ).issue({ ...(await accountRow(email)), sessionEpoch: null });

    await expectEndedOnEveryRequest(`access_token=${signedBefore}`);
  });

  it('an expired token ends the session', async () => {
    const email = 'expired@example.com';
    await t.register(email);
    const row = await accountRow(email);
    const expired = jwt.sign(
      {
        userId: row.id,
        email: row.email,
        pwf: passwordFingerprint(row.password),
        exp: Math.floor(Date.now() / 1000) - 60,
      },
      SECRET,
      { algorithm: 'HS256' },
    );

    await expectEndedOnEveryRequest(`access_token=${expired}`);
  });

  it('a garbled cookie is ended too', async () => {
    await expectEndedOnEveryRequest('access_token=not-a-jwt');
  });

  it('a refused sign-in over a dead cookie still ends it', async () => {
    const email = 'refused@example.com';
    await t.register(email);
    const res = await t.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'NotThePassword1' },
      headers: { ...uniqueClient(), cookie: 'access_token=not-a-jwt' },
    });
    expect(res.statusCode).toBe(401);
    expectSessionEnded(res);
  });

  it('signing in over a dead cookie keeps the new session', async () => {
    const email = 'again@example.com';
    await t.register(email);
    const res = await t.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: TEST_PASSWORD },
      headers: { ...uniqueClient(), cookie: 'access_token=not-a-jwt' },
    });
    expect(res.statusCode).toBe(302);
    // One Set-Cookie for the name: the new token, not the clearing.
    const tokens = res.cookies.filter((c) => c.name === 'access_token');
    expect(tokens).toHaveLength(1);
    const fresh = `access_token=${tokens[0].value}`;
    const profile = await t.inject({
      method: 'GET',
      url: '/auth/profile',
      headers: { cookie: fresh },
    });
    expect(profile.statusCode).toBe(200);
  });
});

/**
 * The login form stays open to a signed-in user, so B can sign in over A's
 * live session (#229). That ends A's session on the device like a sign-out:
 * B's cookie replaces A's and `Clear-Site-Data: "cache"` drops what the HTTP
 * cache holds for A (photos, selfies). Not `X-Session-Ended`: the worker
 * drops its own caches on any sign-in's redirect. The same account signing
 * in again keeps its cache.
 */
describe('signing in over a live session', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ ACCESS_TOKEN_SECRET: SECRET });
  });

  afterAll(() => t?.cleanup());

  const signIn = (email: string, password: string, cookie: string) =>
    t.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password },
      headers: { ...uniqueClient(), cookie },
    });

  /** The one session cookie the answer sets, ready for a `cookie` header. */
  const issuedCookie = (res: LightMyRequestResponse) => {
    const tokens = res.cookies.filter((c) => c.name === 'access_token');
    expect(tokens).toHaveLength(1);
    return `access_token=${tokens[0].value}`;
  };

  it("as another account clears the previous account's cache and opens the new session", async () => {
    const email = 'switcher@example.com';
    await t.register(email);
    const switcherId = await userIdOf(t, email);

    const res = await signIn(email, TEST_PASSWORD, t.owner.cookie);

    expect(res.statusCode).toBe(302);
    expect(res.headers['clear-site-data']).toBe('"cache"');
    expect(res.headers['x-session-ended']).toBeUndefined();
    const profile = await t.inject({
      method: 'GET',
      url: '/auth/profile',
      headers: { cookie: issuedCookie(res) },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.headers['x-page-account']).toBe(String(switcherId));
    expect(t.logs.messages('info', 'Web')).toContain(
      `User ${switcherId} signed in, replacing user ${t.owner.id}'s session: Clear-Site-Data sent`,
    );
  });

  it('as the same account keeps its cache', async () => {
    const email = 'same-again@example.com';
    const cookie = await t.register(email);

    const res = await signIn(email, TEST_PASSWORD, cookie);

    expect(res.statusCode).toBe(302);
    expect(res.headers['clear-site-data']).toBeUndefined();
    expect(res.headers['x-session-ended']).toBeUndefined();
    issuedCookie(res);
  });

  it('refused, leaves the live session and its cache alone', async () => {
    const email = 'refused-switch@example.com';
    await t.register(email);

    const res = await signIn(email, 'NotThePassword1', t.owner.cookie);

    expect(res.statusCode).toBe(401);
    expectNothingCleared(res);
    const still = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(still.statusCode).toBe(200);
  });

  it("registering over a live session clears the previous account's cache", async () => {
    const res = await t.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'newcomer@example.com',
        password: TEST_PASSWORD,
        confirmPassword: TEST_PASSWORD,
      },
      headers: { ...uniqueClient(), cookie: t.owner.cookie },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers['clear-site-data']).toBe('"cache"');
    issuedCookie(res);
  });
});

/**
 * WebKit applies Clear-Site-Data only to the response a load ends on, never
 * to a redirect it follows (#244), and every way a session ends answers with
 * a redirect (or a bodiless 401 the page follows). So such an answer also
 * sets a short-lived marker cookie, and the next whole HTML document (the
 * page the redirect lands on) repeats `Clear-Site-Data: "cache"` and clears
 * the marker (createCacheClearRelay, src/web/auth/session.ts). Exactly one
 * page repeats it; no static path, fragment or unmarked page ever does.
 */
describe('Clear-Site-Data reaches the page a redirect lands on', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ ACCESS_TOKEN_SECRET: SECRET });
  });

  afterAll(() => t?.cleanup());

  const MARKER = 'cache_clear_pending';
  const MARKED = `${MARKER}=1`;
  const navigate = { 'sec-fetch-mode': 'navigate' };

  const markerOf = (res: LightMyRequestResponse) =>
    res.cookies.find((c) => c.name === MARKER);

  /** The answer set the marker: httpOnly, Lax, the whole site, a minute. */
  const expectMarked = (res: LightMyRequestResponse) => {
    expect(res.headers['clear-site-data']).toBe('"cache"');
    const marker = markerOf(res);
    expect(marker?.value).toBe('1');
    expect(marker?.maxAge).toBe(60);
    expect(marker?.path).toBe('/');
    expect(marker?.httpOnly).toBe(true);
    expect(marker?.sameSite).toBe('Lax');
    expect(marker?.secure).toBeUndefined();
  };

  /**
   * GETs `url` as the redirect's landing (the marker sent, as the browser
   * would): the header once, the marker cleared, and the next load of the
   * same page, without it, clears nothing.
   */
  const expectLandingClears = async (url: string, session = '') => {
    const cookie = session ? `${session}; ${MARKED}` : MARKED;
    const landing = await t.inject({
      method: 'GET',
      url,
      headers: { ...navigate, cookie },
      anonymous: !session,
    });
    expect(landing.statusCode).toBe(200);
    // A string, not an array: sent once.
    expect(landing.headers['clear-site-data']).toBe('"cache"');
    const cleared = markerOf(landing);
    expect(cleared?.value).toBe('');
    expect(cleared?.expires?.getTime()).toBeLessThanOrEqual(Date.now());
    expect(t.logs.messages('info', 'Session')).toContain(
      `Clear-Site-Data relayed to the landing page ${url} (200)`,
    );

    const next = await t.inject({
      method: 'GET',
      url,
      headers: session ? { ...navigate, cookie: session } : navigate,
      anonymous: !session,
    });
    expect(next.statusCode).toBe(200);
    expect(next.headers['clear-site-data']).toBeUndefined();
    expect(markerOf(next)).toBeUndefined();
  };

  it('signing out marks its redirect, and the login page it lands on clears', async () => {
    const cookie = await t.register('relay-out@example.com');
    const res = await t.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/auth/login');
    expectMarked(res);

    await expectLandingClears('/auth/login');
  });

  it('deleting the account marks its redirect; the redirect after it keeps the marker for the login page', async () => {
    const email = 'relay-delete@example.com';
    const cookie = await t.register(email);
    const res = await t.inject({
      method: 'POST',
      url: '/auth/delete-account',
      payload: { email, password: TEST_PASSWORD },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    expectMarked(res);

    // `/` signed out is the gate's redirect: not a page, so not consumed.
    const home = await t.inject({
      method: 'GET',
      url: '/',
      headers: { ...navigate, cookie: MARKED },
      anonymous: true,
    });
    expect(home.statusCode).toBe(302);
    expect(home.headers['clear-site-data']).toBeUndefined();
    expect(markerOf(home)).toBeUndefined();

    await expectLandingClears('/auth/login');
  });

  it("a revoked cookie's redirect and its htmx 401 are marked; the login page it ends on is not", async () => {
    const page = await t.inject({
      method: 'GET',
      url: '/wardrobe',
      headers: { ...navigate, cookie: 'access_token=not-a-jwt' },
    });
    expect(page.statusCode).toBe(302);
    expectMarked(page);

    const fragment = await t.inject({
      method: 'GET',
      url: '/wardrobe',
      headers: { 'hx-request': 'true', cookie: 'access_token=not-a-jwt' },
    });
    expect(fragment.statusCode).toBe(401);
    expect(fragment.headers['hx-redirect']).toBe('/auth/login');
    expectMarked(fragment);

    // The header already rides on the document the load ends on.
    const login = await t.inject({
      method: 'GET',
      url: '/auth/login',
      headers: { ...navigate, cookie: 'access_token=not-a-jwt' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers['clear-site-data']).toBe('"cache"');
    expect(markerOf(login)).toBeUndefined();

    await expectLandingClears('/auth/login');
  });

  it('signing in over another account marks its redirect, and Today it lands on clears', async () => {
    const email = 'relay-switch@example.com';
    await t.register(email);
    const res = await t.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: TEST_PASSWORD },
      headers: { ...uniqueClient(), cookie: t.owner.cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    expectMarked(res);
    const token = res.cookies.find((c) => c.name === 'access_token')!;

    await expectLandingClears('/', `access_token=${token.value}`);
  });

  it('the same account signing in again sets no marker', async () => {
    const email = 'relay-again@example.com';
    const cookie = await t.register(email);
    const res = await t.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: TEST_PASSWORD },
      headers: { ...uniqueClient(), cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers['clear-site-data']).toBeUndefined();
    expect(markerOf(res)).toBeUndefined();
  });

  it('a static path or an htmx fragment never clears, and leaves the marker for the page', async () => {
    for (const url of ['/js/pwa.js', '/health/live', '/manifest.json']) {
      const res = await t.inject({
        method: 'GET',
        url,
        headers: { cookie: `${t.owner.cookie}; ${MARKED}` },
      });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['clear-site-data'], url).toBeUndefined();
      expect(markerOf(res), url).toBeUndefined();
    }
    const fragment = await t.inject({
      method: 'GET',
      url: '/wardrobe',
      headers: { 'hx-request': 'true', cookie: `${t.owner.cookie}; ${MARKED}` },
    });
    expect(fragment.statusCode).toBe(200);
    expect(fragment.headers['clear-site-data']).toBeUndefined();
    expect(markerOf(fragment)).toBeUndefined();
  });

  it('a page without the marker never clears', async () => {
    for (const url of ['/', '/wardrobe', '/auth/profile']) {
      const res = await t.inject({ method: 'GET', url, headers: navigate });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['clear-site-data'], url).toBeUndefined();
      expect(markerOf(res), url).toBeUndefined();
    }
  });
});

/**
 * Sign out everywhere (#700): the session version's bump ends every other
 * session, device token and push subscription; the acting session goes on
 * with a cookie issued from the bump's own row. Agent tokens and invites
 * stay (revokeSignIns, src/web/auth/queries.ts).
 */
describe('sign out everywhere', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ ...PWA_ENV, ACCESS_TOKEN_SECRET: SECRET });
  });

  afterAll(() => t?.cleanup());

  const signOutEverywhere = (
    cookie: string,
    payload: Record<string, string> = { currentPassword: TEST_PASSWORD },
  ) =>
    t.inject({
      method: 'POST',
      url: '/auth/sign-out-everywhere',
      payload,
      headers: { cookie },
    });

  const subscription = () => ({
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
    keys: {
      p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  });

  const endpointsOf = async (userId: number) =>
    (
      await t.db
        .select({ endpoint: userDevice.pushEndpoint })
        .from(userDevice)
        .where(eq(userDevice.userId, userId))
    ).map((row) => row.endpoint);

  const wardrobeStatus = async (cookie: string) =>
    (
      await t.inject({
        method: 'GET',
        url: '/wardrobe',
        headers: { 'sec-fetch-mode': 'navigate', cookie },
      })
    ).statusCode;

  it('ends the other session, its device token and its pushes; this session continues; agent tokens stay', async () => {
    const email = 'everywhere@example.com';
    const thisDevice = await t.register(email);
    const otherDevice = await t.login(email);
    const id = await userIdOf(t, email);
    const kept = subscription();
    await subscribeAs(t.db, id, kept);
    await subscribeAs(t.db, id, subscription());
    const agent = await mintToken(t, id, 'Laptop');
    const app = await mintToken(t, id, 'Phone', 'device');
    if (!agent.created || !app.created) throw new Error('tokens not minted');

    const res = await signOutEverywhere(thisDevice, {
      currentPassword: TEST_PASSWORD,
      pushEndpoint: kept.endpoint,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/auth/profile?signedOutEverywhere=1');
    expect(res.headers['clear-site-data']).toBeUndefined();
    const reissued = res.cookies.find((c) => c.name === 'access_token');
    expect(reissued?.value).toBeTruthy();
    expect(reissued?.sameSite).toBe('Lax');
    const survivor = `access_token=${reissued!.value}`;

    // The other session: refused and ended on whatever it sends next.
    const refused = await t.inject({
      method: 'GET',
      url: '/wardrobe',
      headers: { 'sec-fetch-mode': 'navigate', cookie: otherDevice },
    });
    expect(refused.statusCode).toBe(302);
    expectSessionEnded(refused);
    expect(t.logs.messages('info', 'Session')).toContain(
      `Rejected access token (session version 0, now 1 (signed out everywhere or a new password), for user ${id}): cookie cleared, Clear-Site-Data sent`,
    );
    // This browser's own earlier cookie is no better than the other's.
    expect(await wardrobeStatus(thisDevice)).toBe(302);

    // This session goes on, on the reissued cookie.
    const profile = await t.inject({
      method: 'GET',
      url: '/auth/profile?signedOutEverywhere=1',
      headers: { cookie: survivor },
    });
    expect(profile.statusCode).toBe(200);
    expectNothingCleared(profile);
    expect(unescapeHtml(profile.body)).toContain(
      'Every other device has been signed out.',
    );

    // The native app is signed out; the agent keeps working.
    expect(
      (await t.api(app.token, { method: 'GET', url: '/api/v1/me' })).statusCode,
    ).toBe(401);
    const [agentRow] = await t.db
      .select({ revokedAt: personalAccessToken.revokedAt })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.id, agent.id));
    expect(agentRow.revokedAt).toBeNull();
    expect(await endpointsOf(id)).toEqual([kept.endpoint]);
    expect(t.logs.messages('info', 'Web')).toContain(
      `User ${id} signed out everywhere: sessions before version 1, 1 device tokens and 1 other push devices revoked`,
    );
  });

  it("an installed app's queued write replayed after it gets the 401 that keeps the record", async () => {
    const email = 'everywhere-outbox@example.com';
    const thisDevice = await t.register(email);
    const phone = await t.login(email);
    const id = await userIdOf(t, email);
    const garmentId = await createGarment(t, { name: 'Queued', cookie: phone });
    expect((await signOutEverywhere(thisDevice)).statusCode).toBe(302);

    const replay = await t.inject({
      method: 'POST',
      url: `/wardrobe/${garmentId}/wear`,
      payload: 'worn=1',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-closet-queued': String(id),
        'idempotency-key': randomUUID(),
        'sec-fetch-mode': 'cors',
        cookie: phone,
      },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.headers['hx-redirect']).toBe('/auth/login');
    expectSessionEnded(replay);
  });

  it('a wrong password is the form again and ends nothing', async () => {
    const email = 'everywhere-wrong@example.com';
    const thisDevice = await t.register(email);
    const otherDevice = await t.login(email);
    const res = await signOutEverywhere(thisDevice, {
      currentPassword: 'NotMyPassword1',
    });
    expect(res.statusCode).toBe(400);
    expect(unescapeHtml(res.body)).toContain('Current password is incorrect');
    expect(res.cookies.find((c) => c.name === 'access_token')).toBeUndefined();
    expect(await wardrobeStatus(thisDevice)).toBe(200);
    expect(await wardrobeStatus(otherDevice)).toBe(200);
  });

  it('a session issued before #700 (no sv) opens until the first bump', async () => {
    const email = 'everywhere-legacy@example.com';
    await t.register(email);
    const [row] = await t.db.select().from(user).where(eq(user.email, email));
    const legacy = `access_token=${jwt.sign(
      {
        userId: row.id,
        email: row.email,
        pwf: passwordFingerprint(row.password),
      },
      SECRET,
      { algorithm: 'HS256', expiresIn: 3600 },
    )}`;
    expect(await wardrobeStatus(legacy)).toBe(200);

    const other = await t.login(email);
    expect((await signOutEverywhere(other)).statusCode).toBe(302);
    expect(await wardrobeStatus(legacy)).toBe(302);
  });

  it('a new password bumps the session version too', async () => {
    const email = 'everywhere-password@example.com';
    const cookie = await t.register(email);
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
    const [row] = await t.db
      .select({ version: user.sessionVersion })
      .from(user)
      .where(eq(user.email, email));
    expect(row.version).toBe(1);
  });
});
