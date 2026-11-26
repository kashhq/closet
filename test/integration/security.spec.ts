import { connect } from 'node:net';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, outfitCalendar, user } from '../../src/db/schema';
import { createGarment } from './garments';
import { APP_ORIGIN, createTestApp, TEST_PASSWORD, TestApp } from './harness';

/**
 * Cross-cutting request security: the same-origin (CSRF) check on every
 * state-changing route; `returnTo` values;
 * what logout tells the browser; and invite tokens staying out of the logs.
 */
describe('request security', () => {
  let t: TestApp;
  let outfitId: number;

  const rows = async (table: typeof garment | typeof outfitCalendar) =>
    (await t.db.select({ n: count() }).from(table))[0].n;

  beforeAll(async () => {
    // A second name, as production's plain-HTTP twin: the Host allowlist
    // and the trusted proxy's forwarded host below.
    t = await createTestApp({ ALLOWED_HOSTS: 'closet.example' });
    // The outfit form only renders its fields (and the posted-back
    // returnTo) once there is a garment to pick.
    await createGarment(t, { name: 'Plain tee' });
    const created = await t.inject({
      method: 'POST',
      url: '/outfits',
      payload: { name: 'Scheduled look' },
    });
    outfitId = Number(/\d+$/.exec(created.headers.location as string)![0]);
  });

  afterAll(() => t?.cleanup());

  describe('same-origin check (CSRF)', () => {
    // Two writes of two features, the garments and the calendar.
    const createGarmentFrom = (headers: Record<string, string>) =>
      t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: { name: 'Planted garment', category: 'shirt' },
        headers,
        sameOrigin: false,
      });
    const schedule = (headers: Record<string, string>) =>
      t.inject({
        method: 'POST',
        url: '/calendar',
        payload: { date: '2026-09-21', outfitId: String(outfitId) },
        headers,
        sameOrigin: false,
      });

    it.each([
      ['another site in Origin', { origin: 'https://evil.test' }],
      ['another site in Referer', { referer: 'https://evil.test/page' }],
      ['an opaque Origin', { origin: 'null' }],
      ['neither Origin nor Referer', {}],
      // Same host, other scheme: a different origin.
      ['this host over another scheme', { origin: 'https://localhost' }],
    ])('refuses %s with 403, before any write', async (_label, headers) => {
      const garmentsBefore = await rows(garment);
      const garments = await createGarmentFrom(headers);
      expect(garments.statusCode).toBe(403);
      expect(await rows(garment)).toBe(garmentsBefore);

      const entriesBefore = await rows(outfitCalendar);
      const web = await schedule(headers);
      expect(web.statusCode).toBe(403);
      expect(await rows(outfitCalendar)).toBe(entriesBefore);
    });

    // A cross-site page's auto-submitted form, as the browser sends it now
    // that the service worker leaves every navigation post alone (#542):
    // its own Origin (or a cross-site Referer, or an opaque or no Origin),
    // never this site's. Each must change no session: login CSRF signs the
    // victim into the attacker's account; a cross-site sign-out or deletion
    // ends theirs. The deletion carries the right password, which a
    // cross-site page could only have phished: the Origin still refuses it.
    const crossSiteNavigation = {
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'sec-fetch-site': 'cross-site',
    };
    describe.each([
      ['another site in Origin', { origin: 'https://evil.test' }],
      ['another site in Referer only', { referer: 'https://evil.test/form' }],
      ['an opaque Origin', { origin: 'null' }],
      ['neither Origin nor Referer', {}],
    ])('a cross-site navigation post with %s', (label, from) => {
      // Each case's own accounts: a taken email would refuse on its own.
      const slug = label.replace(/\W+/g, '-').toLowerCase();
      const post = (url: string, payload: object, cookie?: string) =>
        t.inject({
          method: 'POST',
          url,
          payload,
          headers: {
            ...crossSiteNavigation,
            ...from,
            ...(cookie === undefined ? {} : { cookie }),
          },
          anonymous: cookie === undefined,
          sameOrigin: false,
        });
      // The same-origin hook's own refusal, before any route ran.
      const refusedByOrigin = (res: { statusCode: number; body: string }) =>
        res.statusCode === 403 && res.body === 'Cross-origin request refused';

      it('signs nobody in or up', async () => {
        const login = await post('/auth/login', {
          email: t.owner.email,
          password: TEST_PASSWORD,
        });
        expect(refusedByOrigin(login)).toBe(true);
        expect(login.cookies).toHaveLength(0);

        const email = `planted-${slug}@evil.test`;
        const register = await post('/auth/register', {
          email,
          password: TEST_PASSWORD,
          confirmPassword: TEST_PASSWORD,
        });
        expect(refusedByOrigin(register)).toBe(true);
        expect(register.cookies).toHaveLength(0);
        expect(
          await t.db.select().from(user).where(eq(user.email, email)),
        ).toEqual([]);
      });

      it('signs nobody out and deletes no account', async () => {
        const email = `victim-${slug}@example.com`;
        const cookie = await t.register(email);
        for (const [url, payload] of [
          ['/auth/logout', {}],
          ['/auth/delete-account', { email, password: TEST_PASSWORD }],
        ] as const) {
          const res = await post(url, payload, cookie);
          expect({ url, refused: refusedByOrigin(res) }).toEqual({
            url,
            refused: true,
          });
          expect(res.cookies).toHaveLength(0);
          expect(res.headers['clear-site-data']).toBeUndefined();
        }
        const profile = await t.inject({
          method: 'GET',
          url: '/auth/profile',
          headers: { cookie },
        });
        expect(profile.statusCode).toBe(200);
        expect(
          await t.db.select().from(user).where(eq(user.email, email)),
        ).toHaveLength(1);
      });
    });

    it('refuses a cross-site email change', async () => {
      const change = await t.inject({
        method: 'POST',
        url: '/auth/update-email',
        payload: {
          email: 'hijacked@evil.test',
          confirmEmail: 'hijacked@evil.test',
          currentPassword: TEST_PASSWORD,
        },
        headers: { origin: 'https://evil.test' },
        sameOrigin: false,
      });
      expect(change.statusCode).toBe(403);
      const [owner] = await t.db
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, t.owner.id));
      expect(owner.email).toBe(t.owner.email);
    });

    it.each([
      ['its own origin', { origin: APP_ORIGIN }],
      [
        'its own origin with the default port',
        { origin: 'http://localhost:80' },
      ],
      ["SITE_URL's origin", { origin: 'http://localhost:3000' }],
      [
        'a same-origin Referer without Origin',
        { referer: `${APP_ORIGIN}/outfits/new` },
      ],
    ])('accepts %s', async (_label, headers) => {
      const res = await createGarmentFrom(headers);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/^\/wardrobe\/\d+/);
      expect((await schedule(headers)).statusCode).toBe(302);
    });

    it('believes forwarded scheme and host only from a trusted proxy', async () => {
      // inject() comes from 127.0.0.1, which TRUSTED_PROXIES lists here: the
      // request's own origin is then what the proxy says it was sent to.
      const res = await createGarmentFrom({
        origin: 'https://closet.example',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'closet.example',
      });
      expect(res.statusCode).toBe(302);
    });

    it('never checks a safe method', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/outfits',
        headers: { origin: 'https://evil.test' },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('Host allowlist (DNS rebinding, #702)', () => {
    const ATTACKER = 'attacker.example';
    const forHost = (
      host: string,
      request: { method: 'GET' | 'POST'; url: string; payload?: object },
    ) =>
      t.inject({
        ...request,
        anonymous: true,
        // A rebound page is same-origin to itself: Origin agrees with Host.
        headers: { host, origin: `http://${host}` },
      });

    it.each([
      ['a page', { method: 'GET', url: '/outfits' }],
      ['the API', { method: 'GET', url: '/api/v1/garments' }],
      ['MCP', { method: 'POST', url: '/mcp', payload: {} }],
      ['a static path', { method: 'GET', url: '/js/connectivity.js' }],
    ] as const)(
      'refuses %s for a foreign Host with a 421 that names the fix',
      async (_label, request) => {
        const res = await forHost(ATTACKER, request);
        expect(res.statusCode).toBe(421);
        expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.body).toContain('ALLOWED_HOSTS');
        expect(res.body).not.toContain(ATTACKER);
      },
    );

    it('refuses a request with no Host at all with the 421, not a 500', async () => {
      t.logs.clear();
      // inject() always sends a Host, and HTTP/1.1 requires one, so this is
      // HTTP/1.0 over a real socket.
      const address = await t.app.listen({ host: '127.0.0.1', port: 0 });
      const { hostname, port } = new URL(address);
      const answer = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(port), hostname, () => {
          socket.end(['GET /outfits HTTP/1.0', '', ''].join('\r\n'));
        });
        let received = '';
        socket.on('data', (chunk) => (received += chunk.toString()));
        socket.on('end', () => resolve(received));
        socket.on('error', reject);
      });
      expect(answer).toMatch(/^HTTP\/1\.1 421 /);
      expect(t.logs.messages('warn', 'Security')).toContainEqual(
        expect.stringContaining('"(none)"'),
      );
    });

    it('reads X-Forwarded-Host only from a trusted proxy', async () => {
      const outfits = (
        headers: Record<string, string>,
        remoteAddress?: string,
      ) =>
        t.inject({
          method: 'GET',
          url: '/outfits',
          anonymous: true,
          headers,
          remoteAddress,
        });
      // Fastify's request.host takes X-Forwarded-Host only when the direct
      // peer is in TRUSTED_PROXIES (127.0.0.1 here, inject's default).
      const listed = { 'x-forwarded-host': 'localhost:3000' };
      expect(
        (await outfits({ host: ATTACKER, ...listed }, '203.0.113.9'))
          .statusCode,
      ).toBe(421);
      expect((await outfits({ host: ATTACKER, ...listed })).statusCode).toBe(
        302,
      );
      expect(
        (
          await outfits({
            host: 'localhost:3000',
            'x-forwarded-host': ATTACKER,
          })
        ).statusCode,
      ).toBe(421);
    });

    it('refuses a rebound registration before it writes', async () => {
      const email = 'rebound@example.com';
      const res = await forHost(ATTACKER, {
        method: 'POST',
        url: '/auth/register',
        payload: {
          email,
          password: TEST_PASSWORD,
          confirmPassword: TEST_PASSWORD,
        },
      });
      expect(res.statusCode).toBe(421);
      expect(
        await t.db.select().from(user).where(eq(user.email, email)),
      ).toHaveLength(0);
    });

    it.each([
      ["SITE_URL's host", 'localhost:3000'],
      ['an ALLOWED_HOSTS name, any case', 'Closet.Example'],
      ['loopback at any port', '127.0.0.1:3802'],
    ])('serves %s', async (_label, host) => {
      expect(
        (await forHost(host, { method: 'GET', url: '/outfits' })).statusCode,
      ).toBe(302);
      expect(
        (await forHost(host, { method: 'GET', url: '/api/v1/garments' }))
          .statusCode,
      ).toBe(401);
      expect(
        (await forHost(host, { method: 'POST', url: '/mcp', payload: {} }))
          .statusCode,
      ).toBe(401);
    });

    it('names a refused host in one warn line, not one per request', async () => {
      t.logs.clear();
      const host = 'once.attacker.example';
      await forHost(host, { method: 'GET', url: '/outfits' });
      await forHost(host, { method: 'GET', url: '/outfits' });
      expect(
        t.logs
          .messages('warn', 'Security')
          .filter((line) => line.includes(host)),
      ).toHaveLength(1);
    });
  });

  describe('returnTo on Styling (the outfit form it replaced)', () => {
    it.each([
      "javascript:alert('x')",
      '//evil.test',
      '/\\evil.test',
      'https://evil.test',
    ])('drops %s', async (value) => {
      const res = await t.inject({
        method: 'GET',
        url: `/styling?returnTo=${encodeURIComponent(value)}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('evil.test');
      expect(res.body).not.toContain('javascript:');
      expect(res.body).not.toContain('name="returnTo"');
    });

    it('keeps a path on this site', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/styling?returnTo=/calendar',
      });
      expect(res.body).toContain('href="/calendar"');
    });

    it('a saved edit goes nowhere else', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/styling',
        payload: {
          outfit: '999999',
          garmentId: '1',
          returnTo: 'https://evil.test',
        },
      });
      expect(res.headers.location ?? '').not.toContain('evil.test');
    });
  });

  it('logout clears the cookie and tells the browser to drop its cache', async () => {
    const cookie = await t.register('leaving-device@example.com');
    const res = await t.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers['clear-site-data']).toBe('"cache"');
    const cleared = res.cookies.find((c) => c.name === 'access_token');
    expect(cleared?.value).toBe('');
    expect(cleared?.sameSite).toBe('Lax');
  });

  it('an invite token never reaches the request log', async () => {
    const created = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission: 'VIEW' },
      headers: { 'hx-request': 'true' },
    });
    const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
      created.body,
    )![1];

    t.logs.clear();
    const landing = await t.inject({
      method: 'GET',
      url: `/wardrobe-share/invite/${token}`,
      anonymous: true,
    });
    expect(landing.statusCode).toBe(200);
    const declined = await t.inject({
      method: 'POST',
      url: `/wardrobe-share/invite/${token}/decline`,
    });
    expect(declined.statusCode).toBe(302);
    expect(t.logs.messages('info', 'Http')).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^GET \/wardrobe-share\/invite\/:token 200 /),
      ]),
    );
    expect(t.logs.text()).not.toContain(token);
  });
});
