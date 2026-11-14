import { eq } from 'drizzle-orm';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import webpush, { type PushSubscription } from 'web-push';
import { user, userDevice } from '../../src/db/schema';
import { PUSH_TEST_LIMIT } from '../../src/web/security/rate-limit';
import { createTestApp, PWA_ENV, TestApp } from './harness';
import { expectFragment, expectFullPage } from './pages';

/**
 * Web Push (src/web/push/): subscriptions stored per browser endpoint, the
 * test send to the caller's own devices, pruning of devices their push
 * service reports gone, and the profile page's controls. web-push's
 * sendNotification is stubbed: nothing leaves the process.
 */

interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** A subscription as a browser's toJSON() writes it, with real key sizes. */
function subscription(endpoint = newEndpoint()): Subscription {
  return {
    endpoint,
    keys: {
      p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

function newEndpoint(): string {
  // An FCM-shaped URL: subscribe only accepts push-service hosts, and
  // sendNotification is stubbed, so nothing is sent to Google.
  return `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
}

/** What a push service answers a delivered message with. */
const DELIVERED = { statusCode: 201, body: '', headers: {} };

/** A sendNotification stub that fails for one endpoint and delivers to the rest. */
function failingFor(endpoint: string, error: Error) {
  return (target: PushSubscription) =>
    target.endpoint === endpoint
      ? Promise.reject(error)
      : Promise.resolve(DELIVERED);
}

describe('web push (PWA_ENABLED=true)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp(PWA_ENV);
  });

  afterAll(() => t?.cleanup());

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const subscribe = (body: unknown, cookie?: string) =>
    t.inject({
      method: 'POST',
      url: '/push/subscribe',
      payload: body as object,
      headers: {
        'user-agent': 'Mozilla/5.0 (Linux; Android 15) Chrome/140',
        ...(cookie ? { cookie } : {}),
      },
    });

  const devicesAt = (endpoint: string) =>
    t.db.select().from(userDevice).where(eq(userDevice.pushEndpoint, endpoint));

  const sendTest = (cookie?: string) =>
    t.inject({
      method: 'POST',
      url: '/push/test',
      headers: { 'hx-request': 'true', ...(cookie ? { cookie } : {}) },
    });

  describe('sessions', () => {
    it.each([
      ['GET', '/push/vapid-public-key'],
      ['POST', '/push/subscribe'],
      ['POST', '/push/unsubscribe'],
      ['POST', '/push/test'],
    ] as const)(
      'anonymous fetch %s %s -> 401 with HX-Redirect',
      async (method, url) => {
        const res = await t.inject({
          method,
          url,
          headers: { 'sec-fetch-mode': 'cors' },
          anonymous: true,
        });
        expect(res.statusCode).toBe(401);
        expect(res.headers['hx-redirect']).toBe('/auth/login');
      },
    );

    it('an anonymous navigation is sent to log in', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/push/vapid-public-key',
        anonymous: true,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location?.split('?')[0]).toBe('/auth/login');
    });
  });

  it('serves the VAPID public key to signed-in pages', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/push/vapid-public-key',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toBe(PWA_ENV.PUBLIC_VAPID_KEY);
  });

  describe('subscribe', () => {
    it('stores the subscription for the signed-in user', async () => {
      const sub = subscription();
      const res = await subscribe(sub);
      expect(res.statusCode).toBe(204);

      const [row] = await devicesAt(sub.endpoint);
      expect(row).toMatchObject({
        userId: t.owner.id,
        keyP256dh: sub.keys.p256dh,
        keyAuth: sub.keys.auth,
        userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140',
      });
    });

    // The server POSTs to the endpoint, so an internal address would make
    // /push/test an SSRF gadget (src/web/push/endpoint.ts).
    it.each([
      'https://127.0.0.1:5432/x',
      'https://pgvault/x',
      'https://nas.example/admin',
      'https://fcm.googleapis.com.evil.example/x',
    ])(
      'refuses an endpoint outside the push services: %s',
      async (endpoint) => {
        const res = await subscribe(subscription(endpoint));
        expect(res.statusCode).toBe(400);
        expect(await devicesAt(endpoint)).toEqual([]);
      },
    );

    it('stores endpoints longer than 255 characters (Firefox)', async () => {
      const endpoint = `https://updates.push.services.mozilla.com/wpush/v2/${'g'.repeat(300)}`;
      expect((await subscribe(subscription(endpoint))).statusCode).toBe(204);
      expect(await devicesAt(endpoint)).toHaveLength(1);
    });

    it('updates the row when the same browser sends renewed keys', async () => {
      const first = subscription();
      await subscribe(first);
      const [before] = await devicesAt(first.endpoint);

      const renewed = subscription(first.endpoint);
      expect((await subscribe(renewed)).statusCode).toBe(204);

      const rows = await devicesAt(first.endpoint);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: before.id,
        keyP256dh: renewed.keys.p256dh,
        keyAuth: renewed.keys.auth,
      });
      expect(rows[0].updatedAt.getTime()).toBeGreaterThanOrEqual(
        before.updatedAt.getTime(),
      );
    });

    it('moves the endpoint to the account now signed in on that browser', async () => {
      const sub = subscription();
      await subscribe(sub);
      const other = await t.register(`push-mover-${randomUUID()}@example.com`);

      expect((await subscribe(sub, other)).statusCode).toBe(204);

      const rows = await devicesAt(sub.endpoint);
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).not.toBe(t.owner.id);
    });

    it.each([
      [
        'an http endpoint',
        (s: Subscription) => ({ ...s, endpoint: 'http://push.example.test/x' }),
      ],
      [
        'an endpoint that is no URL',
        (s: Subscription) => ({ ...s, endpoint: 'not a url' }),
      ],
      [
        'an endpoint past 2048 characters',
        (s: Subscription) => ({
          ...s,
          endpoint: `https://push.example.test/${'x'.repeat(2048)}`,
        }),
      ],
      [
        'a short p256dh',
        (s: Subscription) => ({ ...s, keys: { ...s.keys, p256dh: 'abc' } }),
      ],
      [
        'a p256dh in standard base64',
        (s: Subscription) => ({
          ...s,
          keys: { ...s.keys, p256dh: `+/${s.keys.p256dh.slice(2)}` },
        }),
      ],
      [
        'an auth secret of the wrong size',
        (s: Subscription) => ({
          ...s,
          keys: { ...s.keys, auth: randomBytes(24).toString('base64url') },
        }),
      ],
      ['no keys', (s: Subscription) => ({ endpoint: s.endpoint })],
    ])('refuses %s with a 400 and stores nothing', async (_label, spoil) => {
      const sub = subscription();
      const res = await subscribe(spoil(sub));
      expect(res.statusCode).toBe(400);
      expect(await devicesAt(sub.endpoint)).toHaveLength(0);
    });
  });

  describe('unsubscribe', () => {
    it("removes the caller's row for the endpoint", async () => {
      const sub = subscription();
      await subscribe(sub);
      const res = await t.inject({
        method: 'POST',
        url: '/push/unsubscribe',
        payload: { endpoint: sub.endpoint },
      });
      expect(res.statusCode).toBe(204);
      expect(await devicesAt(sub.endpoint)).toHaveLength(0);
    });

    it("leaves another user's row alone", async () => {
      const sub = subscription();
      await subscribe(sub);
      const other = await t.register(`push-other-${randomUUID()}@example.com`);
      const res = await t.inject({
        method: 'POST',
        url: '/push/unsubscribe',
        payload: { endpoint: sub.endpoint },
        headers: { cookie: other },
      });
      expect(res.statusCode).toBe(204);
      expect(await devicesAt(sub.endpoint)).toHaveLength(1);
    });
  });

  describe('CSRF', () => {
    it.each([
      ['no Origin', { sameOrigin: false }],
      ['another origin', { headers: { origin: 'https://evil.test' } }],
    ] as const)('refuses a subscribe with %s', async (_label, options) => {
      const sub = subscription();
      const res = await t.inject({
        method: 'POST',
        url: '/push/subscribe',
        payload: sub,
        ...options,
      });
      expect(res.statusCode).toBe(403);
      expect(await devicesAt(sub.endpoint)).toHaveLength(0);
    });

    it('refuses a cross-origin test send', async () => {
      const send = vi.spyOn(webpush, 'sendNotification');
      const res = await t.inject({
        method: 'POST',
        url: '/push/test',
        headers: { origin: 'https://evil.test' },
      });
      expect(res.statusCode).toBe(403);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('test send', () => {
    // A user of their own, so the owner's rows from other tests do not count.
    async function userWithDevices(count: number) {
      const cookie = await t.register(`push-test-${randomUUID()}@example.com`);
      const subs = Array.from({ length: count }, () => subscription());
      for (const sub of subs) await subscribe(sub, cookie);
      return { cookie, subs };
    }

    it("sends the payload to each of the caller's devices and nobody else's", async () => {
      const { cookie, subs } = await userWithDevices(2);
      await userWithDevices(1);
      const send = vi
        .spyOn(webpush, 'sendNotification')
        .mockResolvedValue(DELIVERED);

      const res = await sendTest(cookie);

      expect(res.statusCode).toBe(200);
      expectFragment(res);
      expect(res.body).toContain('Test sent to 2 of your devices.');
      expect(send).toHaveBeenCalledTimes(2);
      expect(
        send.mock.calls
          .map(([target]) => target)
          .toSorted((a, b) => a.endpoint.localeCompare(b.endpoint)),
      ).toEqual(subs.toSorted((a, b) => a.endpoint.localeCompare(b.endpoint)));
      const [, payload, options] = send.mock.calls[0];
      expect(JSON.parse(String(payload))).toEqual({
        title: 'Closet notifications work',
        body: 'This is the test you sent from your profile.',
        url: '/auth/profile#notifications',
        tag: 'push-test',
      });
      expect(options).toMatchObject({
        TTL: 600,
        contentEncoding: 'aes128gcm',
        vapidDetails: {
          subject: PWA_ENV.SITE_URL,
          publicKey: PWA_ENV.PUBLIC_VAPID_KEY,
          privateKey: PWA_ENV.PRIVATE_VAPID_KEY,
        },
      });
    });

    it('never contacts a stored endpoint outside the push services, and removes it', async () => {
      const email = `push-internal-${randomUUID()}@example.com`;
      const cookie = await t.register(email);
      const [{ id: userId }] = await t.db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, email));
      // A row from before subscribe checked hosts, written directly.
      const internal = `https://10.0.0.5/${randomUUID()}`;
      const keys = subscription().keys;
      await t.db.insert(userDevice).values({
        userId,
        pushEndpoint: internal,
        keyP256dh: keys.p256dh,
        keyAuth: keys.auth,
      });
      const send = vi.spyOn(webpush, 'sendNotification');

      const res = await sendTest(cookie);

      expect(res.statusCode).toBe(200);
      expect(send).not.toHaveBeenCalled();
      expect(await devicesAt(internal)).toEqual([]);
    });

    it('says so when the caller has no device', async () => {
      const cookie = await t.register(`push-none-${randomUUID()}@example.com`);
      const send = vi.spyOn(webpush, 'sendNotification');
      const res = await sendTest(cookie);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('No device has notifications on.');
      expect(send).not.toHaveBeenCalled();
    });

    it.each([404, 410])(
      'removes a device its push service answers %i for',
      async (status) => {
        const { cookie, subs } = await userWithDevices(2);
        const [gone, alive] = subs;
        vi.spyOn(webpush, 'sendNotification').mockImplementation(
          failingFor(
            gone.endpoint,
            new webpush.WebPushError(
              'Received unexpected response code',
              status,
              {},
              'push subscription has unsubscribed or expired.',
              gone.endpoint,
            ),
          ),
        );

        const res = await sendTest(cookie);

        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('Test sent to 1 of your devices.');
        expect(res.body).toContain(
          'Devices that no longer accept notifications were removed: 1.',
        );
        expect(await devicesAt(gone.endpoint)).toHaveLength(0);
        expect(await devicesAt(alive.endpoint)).toHaveLength(1);
      },
    );

    it('keeps a device on any other failure and logs it by id, never by endpoint', async () => {
      const { cookie, subs } = await userWithDevices(1);
      const [sub] = subs;
      const [row] = await devicesAt(sub.endpoint);
      t.logs.clear();
      vi.spyOn(webpush, 'sendNotification').mockRejectedValue(
        new webpush.WebPushError(
          'Received unexpected response code',
          500,
          {},
          'upstream hiccup',
          sub.endpoint,
        ),
      );

      const res = await sendTest(cookie);

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(
        'The test could not be delivered to 1 of your devices.',
      );
      expect(await devicesAt(sub.endpoint)).toHaveLength(1);
      // The status, never the push service's answer: upstream text.
      expect(t.logs.records).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          msg: `Push to device ${row.id} of user ${row.userId} failed`,
          err: expect.objectContaining({ status: 500 }),
        }),
      );
      const logged = t.logs.text();
      expect(logged).not.toContain('upstream hiccup');
      expect(logged).not.toContain(sub.endpoint);
      expect(logged).not.toContain(new URL(sub.endpoint).pathname);
    });

    it('a network failure on one device does not stop the others', async () => {
      const { cookie, subs } = await userWithDevices(2);
      const [down] = subs;
      vi.spyOn(webpush, 'sendNotification').mockImplementation(
        failingFor(
          down.endpoint,
          new Error('connect ECONNREFUSED 192.0.2.1:443'),
        ),
      );

      const res = await sendTest(cookie);

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Test sent to 1 of your devices.');
      expect(res.body).toContain(
        'The test could not be delivered to 1 of your devices.',
      );
    });

    // #705: a looping client must not get the VAPID identity throttled.
    it('sends PUSH_TEST_LIMIT tests a minute per user, then answers its fragment saying to wait, sending nothing', async () => {
      const { cookie } = await userWithDevices(1);
      const other = await userWithDevices(1);
      const send = vi
        .spyOn(webpush, 'sendNotification')
        .mockResolvedValue(DELIVERED);

      for (let i = 0; i < PUSH_TEST_LIMIT.max; i++) {
        const res = await sendTest(cookie);
        expect(res.body).toContain('Test sent to 1 of your devices.');
      }
      t.logs.clear();
      const limited = await sendTest(cookie);

      expect(limited.statusCode).toBe(200);
      expectFragment(limited);
      expect(limited.body).toContain('Try again in a minute.');
      expect(limited.body).not.toContain('Test sent');
      expect(send).toHaveBeenCalledTimes(PUSH_TEST_LIMIT.max);
      expect(t.logs.messages('warn')).toEqual([
        expect.stringMatching(
          /^Rate limit reached: POST \/push\/test for user \d+: nothing sent$/,
        ),
      ]);
      // Per user: another account's test still goes.
      expect((await sendTest(other.cookie)).body).toContain(
        'Test sent to 1 of your devices.',
      );
    });
  });

  describe('profile page', () => {
    it('renders the notification controls and marks the page signed in', async () => {
      const res = await t.inject({ method: 'GET', url: '/auth/profile' });
      expectFullPage(res);
      expect(res.body).toMatch(/<html[^>]*\bdata-signed-in\b/);
      expect(res.body).toContain('<push-settings');
      expect(res.body).toContain('data-action="enable"');
      expect(res.body).toContain('data-action="disable"');
      // Every state but "checking" starts hidden; the script picks one.
      expect(res.body).toMatch(/<p data-show="checking">/);
      expect(res.body).toMatch(/<p data-show="on" hidden/);
      expect(res.body).toMatch(/hx-post="\/push\/test"/);
      expect(res.body).toContain('"push":"/js/push.js?v=');
    });

    it('a signed-out page is not marked signed in', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/auth/login',
        anonymous: true,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toMatch(/<html[^>]*\bdata-signed-in\b/);
    });
  });
});
