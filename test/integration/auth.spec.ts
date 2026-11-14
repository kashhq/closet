import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { loginUrl } from '../../src/web/auth/return-to';
import {
  createTestApp,
  recordQueries,
  TEST_PASSWORD,
  TestApp,
  uniqueClient,
} from './harness';

describe('sessions', () => {
  let t: TestApp;
  let cookie: string;
  const email = 'alice@example.com';

  beforeAll(async () => {
    t = await createTestApp();
    cookie = await t.register(email);
  });

  afterAll(() => t?.cleanup());

  it('register sets an httpOnly session cookie and lands on Today', async () => {
    const res = await t.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'bob@example.com',
        password: TEST_PASSWORD,
        confirmPassword: TEST_PASSWORD,
      },
      anonymous: true,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const token = res.cookies.find((c) => c.name === 'access_token');
    expect(token?.httpOnly).toBe(true);
    expect(token?.path).toBe('/');
    // Not sent on cross-site POSTs; not Secure over plain http (the HTTP
    // twin: AGENTS.md, Conventions; account.spec.ts covers https).
    expect(token?.sameSite).toBe('Lax');
    expect(token?.secure).toBeUndefined();
  });

  // requireSession, the one session gate. Its three outcomes: public routes
  // answer anyone, a page navigation without a session is redirected, and an
  // htmx fragment or fetch gets a 401 whose HX-Redirect htmx follows.
  describe('login required (requireSession)', () => {
    it.each([
      ['/auth/login', 200],
      ['/auth/register', 200],
      ['/about', 200],
      ['/offline.html', 200],
      ['/health/live', 200],
      ['/health/ready', 200],
      ['/healthz', 200],
      ['/manifest.json', 200],
      // An unknown link: the empty page, a 404, never a redirect to log in.
      ['/share?shareableId=nothing&type=garment', 404],
    ])('public %s answers an anonymous visitor (%i)', async (url, status) => {
      const res = await t.inject({ method: 'GET', url, anonymous: true });
      expect(res.statusCode).toBe(status);
      expect(res.headers.location).toBeUndefined();
    });

    it.each([
      '/',
      '/wardrobe',
      '/outfits',
      '/calendar',
      '/wardrobe-share/manage',
      '/auth/profile',
      '/auth/update-email',
      '/auth/delete-account',
    ])(
      'anonymous navigation to %s -> 302 /auth/login, returning there',
      async (url) => {
        for (const headers of [
          {},
          { 'sec-fetch-mode': 'navigate' },
          { 'hx-request': 'true', 'hx-boosted': 'true' },
        ]) {
          const res = await t.inject({
            method: 'GET',
            url,
            headers,
            anonymous: true,
          });
          expect(res.statusCode).toBe(302);
          // Today (the start_url) and the account's forms return to Today.
          expect(res.headers.location).toBe(loginUrl(url));
        }
      },
    );

    it.each([
      ['htmx fragment', 'GET', '/wardrobe', { 'hx-request': 'true' }],
      [
        'htmx form post',
        'POST',
        '/calendar/1/worn',
        { 'hx-request': 'true', 'sec-fetch-mode': 'cors' },
      ],
      [
        'fetch',
        'POST',
        '/wardrobe-share/create-invite-link',
        { 'sec-fetch-mode': 'cors' },
      ],
      [
        'same-origin fetch',
        'POST',
        '/wardrobe/1/nobg',
        { 'sec-fetch-mode': 'same-origin' },
      ],
    ] as const)(
      'anonymous %s (%s %s) -> 401 with HX-Redirect',
      async (_label, method, url, headers) => {
        const res = await t.inject({ method, url, headers, anonymous: true });
        expect(res.statusCode).toBe(401);
        expect(res.headers['hx-redirect']).toBe('/auth/login');
        expect(res.headers.location).toBeUndefined();
        expect(res.body).toBe('');
      },
    );
  });

  it('a logged-out page hit redirects without warn or error log lines', async () => {
    t.logs.clear();
    const res = await t.inject({
      method: 'GET',
      url: '/wardrobe',
      anonymous: true,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/auth/login?returnTo=%2Fwardrobe');
    expect(t.logs.messages('warn')).toEqual([]);
    expect(t.logs.messages('error')).toEqual([]);
  });

  it('a session cookie opens the wardrobe and the profile', async () => {
    const wardrobe = await t.inject({
      method: 'GET',
      url: '/wardrobe',
      headers: { cookie },
    });
    expect(wardrobe.statusCode).toBe(200);

    const profile = await t.inject({
      method: 'GET',
      url: '/auth/profile',
      headers: { cookie },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.body).toContain(email);
  });

  it('a garbage cookie is an anonymous request', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/wardrobe',
      headers: { cookie: 'access_token=not-a-jwt' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(loginUrl('/wardrobe'));
  });

  it('login issues a session only for the right password', async () => {
    const fresh = await t.login(email);
    const res = await t.inject({
      method: 'GET',
      url: '/auth/profile',
      headers: { cookie: fresh },
    });
    expect(res.statusCode).toBe(200);

    const wrong = await t.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'WrongPassword1' },
      anonymous: true,
    });
    // The login page again, with the refusal.
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toContain('action="/auth/login"');
    expect(
      wrong.cookies.find((c) => c.name === 'access_token'),
    ).toBeUndefined();
  });

  // #136: nothing in the answer or the work behind it tells an existing
  // address from an unknown one. Same statements (the lookup by
  // lower(email), found or not), the same bcrypt cost (passwords.spec.ts),
  // the same page; and no Server-Timing (metrics.spec.ts).
  it('a refused sign-in does the same work for an existing and an unknown email', async () => {
    const refusal = async (address: string) => {
      let body = '';
      const queries = await recordQueries(async () => {
        const res = await t.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email: address, password: 'WrongPassword1' },
          anonymous: true,
        });
        expect(res.statusCode).toBe(401);
        body = res.body.replaceAll(address, '<email>');
      });
      return { sql: queries.sql, body };
    };
    const known = await refusal(email);
    const unknown = await refusal('nobody@example.com');
    expect(unknown.sql).toEqual(known.sql);
    expect(unknown.body).toBe(known.body);
  });

  it('a wardrobe you have no share for does not exist for you', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/wardrobe?ownerId=999',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('static assets are served without resolving the session', async () => {
    // The session resolver's user lookup is the only Drizzle query a
    // page makes before its handler; an asset must make none at all.
    const query = vi.spyOn(t.db.$client, 'query');
    try {
      const asset = await t.inject({
        method: 'GET',
        url: '/robots.txt',
        headers: { cookie },
      });
      expect(asset.statusCode).toBe(200);
      expect(query).not.toHaveBeenCalled();

      await t.inject({ method: 'GET', url: '/about', headers: { cookie } });
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      query.mockRestore();
    }
  });

  // #661: where signing in lands. The page a refused request came from
  // travels as ?returnTo= (signInReturnTo, src/web/auth/return-to.ts), then
  // as the form's hidden field; anything unusable is Today.
  describe('where sign-in lands', () => {
    const WEEK = '/calendar?week=2026-11-09';
    const HIDDEN = (path: string) =>
      `type="hidden" name="returnTo" value="${path}"`;

    // An account per test: the cases sign in more than
    // SIGN_IN_ACCOUNT_LIMIT allows one account a minute (#705).
    let email: string;
    beforeEach(async () => {
      email = `lands-${randomUUID()}@example.com`;
      await t.register(email);
    });

    const signInFrom = (returnTo?: unknown, password = TEST_PASSWORD) =>
      t.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email,
          password,
          ...(returnTo === undefined ? {} : { returnTo }),
        },
        headers: uniqueClient(),
        anonymous: true,
      });

    it('a plain sign-in lands on Today', async () => {
      const res = await signInFrom();
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/');
    });

    it('a bounced navigation returns to its page after sign-in', async () => {
      const bounced = await t.inject({
        method: 'GET',
        url: WEEK,
        anonymous: true,
      });
      expect(bounced.headers.location).toBe(
        '/auth/login?returnTo=%2Fcalendar%3Fweek%3D2026-11-09',
      );

      const page = await t.inject({
        method: 'GET',
        url: bounced.headers.location,
        anonymous: true,
      });
      expect(page.statusCode).toBe(200);
      // The token an invite's returnTo carries must stay in no cache.
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.body).toContain(HIDDEN(WEEK));

      const res = await signInFrom(WEEK);
      expect(res.headers.location).toBe(WEEK);
    });

    it.each([
      ['an absolute URL', 'https://evil.example/'],
      ['a protocol-relative URL', '//evil.example'],
      ['a backslash protocol-relative URL', '/\\evil.example'],
      ['the login page itself', '/auth/login?returnTo=%2Fcalendar'],
      ['a POST-only route', '/wardrobe-share/invite/abc/accept'],
      ['a repeated field', ['/calendar', '/insights']],
    ])('a hostile returnTo (%s) lands on Today', async (_label, returnTo) => {
      const res = await signInFrom(returnTo);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/');
    });

    it('a refused sign-in keeps its returnTo on the page it renders again', async () => {
      const res = await signInFrom(WEEK, 'WrongPassword1');
      expect(res.statusCode).toBe(401);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toContain(HIDDEN(WEEK));
    });

    it.each([
      [
        'a repeated parameter',
        '/auth/login?returnTo=%2Fcalendar&returnTo=%2Finsights',
      ],
      ['a value past 2 KB', `/auth/login?returnTo=%2F${'a'.repeat(2100)}`],
      ['an absolute URL', '/auth/login?returnTo=https%3A%2F%2Fevil.example'],
    ])(
      'the login page answers %s with no returnTo, never a 400',
      async (_label, url) => {
        const res = await t.inject({ method: 'GET', url, anonymous: true });
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain('name="returnTo"');
      },
    );

    it('registration carries its returnTo through a refusal and lands there', async () => {
      const register = (password: string, confirmPassword: string) =>
        t.inject({
          method: 'POST',
          url: '/auth/register',
          payload: {
            email: 'returning@example.com',
            password,
            confirmPassword,
            returnTo: '/insights',
          },
          headers: uniqueClient(),
          anonymous: true,
        });
      const page = await t.inject({
        method: 'GET',
        url: '/auth/register?returnTo=%2Finsights',
        anonymous: true,
      });
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.body).toContain(HIDDEN('/insights'));
      // The app bar's way back to sign in keeps it too.
      expect(page.body).toContain('href="/auth/login?returnTo=%2Finsights"');

      const refused = await register(TEST_PASSWORD, 'Different1Password');
      expect(refused.statusCode).toBe(400);
      expect(refused.body).toContain(HIDDEN('/insights'));

      const res = await register(TEST_PASSWORD, TEST_PASSWORD);
      expect(res.headers.location).toBe('/insights');
    });

    it('an htmx fragment returns to the page it was on, read from HX-Current-URL', async () => {
      const fragment = (current: string) =>
        t.inject({
          method: 'GET',
          url: '/wardrobe',
          headers: { 'hx-request': 'true', 'hx-current-url': current },
          anonymous: true,
        });
      const own = await fragment('http://localhost/insights?range=year');
      expect(own.statusCode).toBe(401);
      expect(own.headers['hx-redirect']).toBe(loginUrl('/insights?range=year'));

      const foreign = await fragment('https://evil.example/insights');
      expect(foreign.headers['hx-redirect']).toBe('/auth/login');
    });

    it.each([
      [
        'a same-origin Referer',
        'http://localhost/wardrobe/12',
        loginUrl('/wardrobe/12'),
      ],
      // A foreign Referer never gets this far: the same-origin hook 403s
      // the post (bounceReturnTo's unit spec covers reading one).
      ['no Referer', undefined, '/auth/login'],
    ])(
      'a form post whose session ended, with %s, returns to its page',
      async (_label, referer, location) => {
        const res = await t.inject({
          method: 'POST',
          url: '/calendar/1/worn',
          headers: referer ? { referer } : {},
          anonymous: true,
        });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe(location);
      },
    );

    it('a bounce never copies a credential-shaped query into the login URL or a log line', async () => {
      t.logs.clear();
      const res = await t.inject({
        method: 'GET',
        url: '/calendar?token=closet_leakedtoken123',
        anonymous: true,
      });
      expect(res.headers.location).toBe('/auth/login');
      expect(JSON.stringify(t.logs.records)).not.toContain('leakedtoken123');
    });

    it('the login page logs its pattern, never the returnTo it carries', async () => {
      t.logs.clear();
      const res = await t.inject({
        method: 'GET',
        url: '/auth/login?returnTo=%2Fwardrobe-share%2Finvite%2Fsecret-invite-token',
        anonymous: true,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.stringify(t.logs.records)).not.toContain(
        'secret-invite-token',
      );
    });
  });
});
