import { loginUrl } from '../../src/web/auth/return-to';
import { and, eq, isNull } from 'drizzle-orm';
import type { RouteOptions } from 'fastify';
import { connect } from 'node:net';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { personalAccessToken, user } from '../../src/db/schema';
import committedSpec from '../../src/web/api/openapi.json';
import {
  DEVICE_IDLE_DAYS,
  MAX_ACTIVE_TOKENS,
} from '../../src/web/auth/personal-tokens';
import {
  deviceToken,
  expectNoCors,
  expectProblem,
  SIGN_IN_URL,
  signInDevice,
} from './api';
import {
  APP_ORIGIN,
  createTestApp,
  recordQueries,
  TEST_PASSWORD,
  type TestApp,
  unescapeHtml,
  uniqueClient,
  userIdOf,
} from './harness';
import { interleave } from './interleave';
import { mcpRequest, mintToken } from './mcp';

/**
 * The JSON API's foundation (#190; docs/plans/2026-11-12-json-api.md
 * sections 2, 3 and 9): the `api` surface and what it never reads, the
 * device sign-in and sign-out, /me, the problem body, the limits, and the
 * logs. One app; every account a test signs in is its own unless it says
 * so (SIGN_IN_ACCOUNT_LIMIT counts per email).
 */

let t: TestApp;
const routes: RouteOptions[] = [];
/** Every token this spec saw, for the log assertion at the end. */
const issued: string[] = [];

async function newAccount(email: string): Promise<number> {
  await t.register(email);
  return userIdOf(t, email);
}

async function signedIn(email: string, deviceName = 'iPhone') {
  const device = await deviceToken(t, { email, deviceName });
  issued.push(device.token);
  return device;
}

async function tokenState(id: number): Promise<'active' | 'revoked'> {
  const [row] = await t.db
    .select({ revokedAt: personalAccessToken.revokedAt })
    .from(personalAccessToken)
    .where(eq(personalAccessToken.id, id));
  return row.revokedAt === null ? 'active' : 'revoked';
}

beforeAll(async () => {
  t = await createTestApp({}, { onRoute: (route) => routes.push(route) });
});

afterAll(async () => {
  await t.cleanup();
});

// Before a later test clears the capture: no line may hold a token this
// spec saw, or its 11-character display prefix (mcp.spec's rule).
afterEach(() => {
  const everything = JSON.stringify(t.logs.records);
  for (const token of issued) {
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(token.slice(0, 11));
  }
});

describe('the api surface', () => {
  it('is every /api/v1 route, HEAD twins included, and no other route', () => {
    const api = routes.filter((route) => route.config?.surface === 'api');
    const underApi = routes.filter(
      (route) => route.url === '/api/v1' || route.url.startsWith('/api/v1/'),
    );
    expect(api).toEqual(underApi);
    expect(api.map((route) => `${String(route.method)} ${route.url}`)).toEqual(
      expect.arrayContaining([
        'GET /api/v1/me',
        'HEAD /api/v1/me',
        'GET /api/v1/openapi.json',
        'HEAD /api/v1/openapi.json',
        'POST /api/v1/auth/token',
        'DELETE /api/v1/auth/token',
      ]),
    );
    expect(
      routes.filter(
        (route) => /^\/api(\/|$)/i.test(route.url) && !api.includes(route),
      ),
    ).toEqual([]);
  });

  it.each(['/api', '/api/', '/api/v1/', '/API/v1/me', '/api/v2/me'])(
    'answers %s with a problem 404, never reading the cookie',
    async (url) => {
      // A cookie that no longer opens a session: a page would clear it and
      // send Clear-Site-Data; resolving it here would show.
      for (const cookie of [t.owner.cookie, 'access_token=revoked.jwt.value']) {
        const record = await recordQueries(async () => {
          const res = await t.api(undefined, {
            method: 'GET',
            url,
            headers: { cookie },
          });
          const problem = expectProblem(res, 404, 'not_found');
          expect(problem.detail).toBe('Not Found');
          expect(res.headers['clear-site-data']).toBeUndefined();
          expect(res.headers['set-cookie']).toBeUndefined();
        });
        expect(record.statements).toBe(0);
      }
    },
  );

  it('answers a cookie-only POST to an unknown path without Origin with a problem 404, no session read', async () => {
    const record = await recordQueries(async () => {
      const res = await t.api(undefined, {
        method: 'POST',
        url: '/api/v1/nope',
        headers: { cookie: t.owner.cookie },
        payload: {},
      });
      expectProblem(res, 404, 'not_found');
      expect(res.body).not.toContain('/api/v1/nope');
    });
    expect(record.statements).toBe(0);
  });

  it('refuses the session cookie: a signed-in browser gets the 401, not the account', async () => {
    const res = await t.api(undefined, {
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: t.owner.cookie },
    });
    const problem = expectProblem(res, 401, 'unauthorized');
    expect(problem.detail).toMatch(/^Sign in again/);
    expect(res.headers['www-authenticate']).toBe('Bearer realm="closet"');
  });

  it('ignores a cookie carrying a device token, and a cookie beside a valid bearer', async () => {
    const email = 'cookie-carrier@example.com';
    await newAccount(email);
    const { token } = await signedIn(email);
    const viaCookie = await t.api(undefined, {
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `access_token=${token}` },
    });
    expectProblem(viaCookie, 401, 'unauthorized');
    // The owner's cookie beside this account's token: the token decides.
    const both = await t.api(token, {
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: t.owner.cookie },
    });
    expect(both.statusCode).toBe(200);
    expect(both.json()).toMatchObject({ email });
  });

  it('takes a device token only: an agent token is the same 401 as an unknown one, recording no use', async () => {
    const minted = await mintToken(t, t.owner.id, 'Claude Code', 'mcp');
    if (!minted.created) throw new Error('no agent token');
    issued.push(minted.token);
    const [agent, unknown] = await Promise.all([
      t.api(minted.token, { method: 'GET', url: '/api/v1/me' }),
      t.api(`closet_${'x'.repeat(43)}`, { method: 'GET', url: '/api/v1/me' }),
    ]);
    const a = expectProblem(agent, 401, 'unauthorized');
    const b = expectProblem(unknown, 401, 'unauthorized');
    expect({ ...a, requestId: '' }).toEqual({ ...b, requestId: '' });
    const [row] = await t.db
      .select({ lastUsedAt: personalAccessToken.lastUsedAt })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.id, minted.id));
    expect(row.lastUsedAt).toBeNull();
  });

  it('opens nothing else: a device token is no session on a page and no credential on /mcp', async () => {
    const email = 'device-elsewhere@example.com';
    await newAccount(email);
    const { token } = await signedIn(email);
    const page = await t.inject({
      method: 'GET',
      url: '/wardrobe',
      anonymous: true,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe(loginUrl('/wardrobe'));
    const mcp = await mcpRequest(t, token, 'tools/list');
    expect(mcp.statusCode).toBe(401);
  });

  it('refuses a request without a token before reading its body: a 401, never a 400 or 413', async () => {
    for (const payload of [
      '{"broken":',
      JSON.stringify({ x: 'x'.repeat(2 * 1024 * 1024) }),
    ]) {
      const res = await t.api(undefined, {
        method: 'DELETE',
        url: SIGN_IN_URL,
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expectProblem(res, 401, 'unauthorized');
    }
  });

  it('reads Authorization deterministically: any case of the scheme, never two values', async () => {
    const email = 'header-shapes@example.com';
    await newAccount(email);
    const { token } = await signedIn(email);
    for (const scheme of ['bearer', 'BEARER', 'Bearer']) {
      const res = await t.api(undefined, {
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: `${scheme} ${token}` },
      });
      expect(res.statusCode, scheme).toBe(200);
    }
    // Two headers on the wire are bearer.spec's (inject() sends one); two
    // values folded into one, as a proxy may, are malformed.
    for (const authorization of [
      `Bearer ${token}, Bearer ${token}`,
      `Basic ${token}`,
      `Bearer ${token} extra`,
      'Bearer',
    ]) {
      const res = await t.api(undefined, {
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization },
      });
      expectProblem(res, 401, 'unauthorized');
    }
  });

  it('refuses two Authorization headers on the wire, whichever is valid', async () => {
    const email = 'two-headers@example.com';
    await newAccount(email);
    const { token } = await signedIn(email);
    // inject() folds headers into one, so this goes over a real socket.
    const address = await t.app.listen({ host: '127.0.0.1', port: 0 });
    const { hostname, port } = new URL(address);
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), hostname, () => {
        socket.end(
          [
            'GET /api/v1/me HTTP/1.1',
            `Host: ${hostname}:${port}`,
            `Authorization: Bearer ${token}`,
            'Authorization: Bearer closet_other',
            'Connection: close',
            '',
            '',
          ].join('\r\n'),
        );
      });
      let received = '';
      socket.on('data', (chunk) => (received += chunk.toString()));
      socket.on('end', () => resolve(received));
      socket.on('error', reject);
    });
    expect(answer).toMatch(/^HTTP\/1\.1 401 /);
    expect(answer).toMatch(/content-type: application\/problem\+json/i);
    expect(t.logs.messages('warn', 'Api')).toContainEqual(
      expect.stringMatching(/refused: duplicate header from /),
    );
  });

  it.each([
    '?access_token=anything',
    '?token=anything',
    '?TOKEN=anything',
    '?q=closet_notreallyatoken',
    '?q=fine&q=closet_notreallyatoken',
  ])(
    'refuses a token in the query string (%s), echoing nothing',
    async (query) => {
      const email = `query-${issued.length}@example.com`;
      await newAccount(email);
      const { token } = await signedIn(email);
      t.logs.clear();
      const res = await t.api(token, {
        method: 'GET',
        url: `/api/v1/me${query}`,
      });
      const problem = expectProblem(res, 400, 'validation');
      expect(problem.detail).toBe(
        'Send the token in the Authorization header, never in the URL',
      );
      expect(res.body).not.toContain('anything');
      expect(res.body).not.toContain('closet_notreally');
      expect(JSON.stringify(t.logs.records)).not.toContain('closet_notreally');
    },
  );
});

describe('a closed querystring (#577)', () => {
  let token: string;

  beforeAll(async () => {
    await newAccount('closed-query@example.com');
    ({ token } = await signedIn('closed-query@example.com'));
  });

  /** A path's `:param`s filled with a value its schema accepts. */
  function fill(url: string): string {
    return url.replace(/:(\w+)/g, (_, name: string) =>
      name === 'fileName' ? 'a.webp' : '1',
    );
  }

  it('refuses an undeclared parameter on every GET route with a 400 naming it', async () => {
    const gets = routes.filter(
      (route) => route.method === 'GET' && route.config?.surface === 'api',
    );
    expect(gets.length).toBeGreaterThan(15);
    for (const route of gets) {
      const res = await t.api(token, {
        method: 'GET',
        url: `${fill(route.url)}?bogus=1`,
      });
      const problem = expectProblem(res, 400, 'validation');
      expect(problem.errors, route.url).toEqual([
        { path: 'querystring/bogus', message: expect.any(String) },
      ]);
    }
  });

  it('keeps a declared filter working and leaves page routes lenient', async () => {
    const res = await t.api(token, {
      method: 'GET',
      url: '/api/v1/garments?category=top&limit=5',
    });
    expect(res.statusCode, res.body).toBe(200);
    const page = await t.inject({
      method: 'GET',
      url: '/wardrobe?bogus=1',
      headers: { cookie: t.owner.cookie },
    });
    expect(page.statusCode).toBe(200);
  });
});

describe('CSRF and CORS', () => {
  it('lets a bearer request without Origin through and refuses a foreign one with a problem', async () => {
    const email = 'origin@example.com';
    await newAccount(email);
    const { token } = await signedIn(email);
    const foreign = await t.api(token, {
      method: 'DELETE',
      url: SIGN_IN_URL,
      headers: { origin: 'https://evil.example' },
    });
    expectProblem(foreign, 403, 'forbidden');
    const sameSite = await t.api(token, {
      method: 'DELETE',
      url: SIGN_IN_URL,
      headers: { origin: APP_ORIGIN },
    });
    expect(sameSite.statusCode).toBe(204);
  });

  it('still refuses a cookie POST to a page without Origin', async () => {
    const res = await t.inject({
      method: 'POST',
      url: '/auth/tokens',
      sameOrigin: false,
      payload: { name: 'x', currentPassword: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('answers a CORS preflight with no Access-Control header', async () => {
    const res = await t.api(undefined, {
      method: 'OPTIONS',
      url: '/api/v1/me',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expectProblem(res, 404, 'not_found');
  });
});

describe('POST /api/v1/auth/token (sign in a device)', () => {
  it('mints a device token, answered once, no-store, and sets no cookie', async () => {
    const email = 'sign-in@example.com';
    const id = await newAccount(email);
    t.logs.clear();
    const res = await signInDevice(t, {
      email: `  ${email.toUpperCase()} `,
      deviceName: '  Kitchen iPad ',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
    expectNoCors(res);
    const body = res.json<{ token: string; tokenId: number }>();
    issued.push(body.token);
    expect(Object.keys(body).sort()).toEqual(['token', 'tokenId']);
    expect(body.token).toMatch(/^closet_[A-Za-z0-9_-]{43}$/);
    const [row] = await t.db
      .select({
        userId: personalAccessToken.userId,
        kind: personalAccessToken.kind,
        name: personalAccessToken.name,
      })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.id, body.tokenId));
    expect(row).toEqual({ userId: id, kind: 'device', name: 'Kitchen iPad' });
    expect(t.logs.messages('info', 'Api')).toEqual([
      expect.stringMatching(
        new RegExp(
          `^User ${id} signed in a device: token ${body.tokenId} from `,
        ),
      ),
    ]);
  });

  it('answers a wrong password and an unknown email alike', async () => {
    const email = 'wrong-password@example.com';
    const id = await newAccount(email);
    t.logs.clear();
    const wrong = await signInDevice(t, { email, password: 'Nope12345' });
    const unknown = await signInDevice(t, { email: 'nobody@example.com' });
    const a = expectProblem(wrong, 401, 'unauthorized');
    const b = expectProblem(unknown, 401, 'unauthorized');
    expect({ ...a, requestId: '' }).toEqual({ ...b, requestId: '' });
    expect(a.detail).toBe('Incorrect email or password');
    expect(t.logs.messages('warn', 'Api')).toEqual([
      expect.stringMatching(
        new RegExp(`^Failed API sign-in for user ${id} from `),
      ),
      expect.stringMatching(/^Failed API sign-in for an unknown email from /),
    ]);
  });

  it.each([
    ['a blank device name', { deviceName: '   ' }, '/deviceName'],
    ['no device name', { deviceName: undefined }, ''],
  ])('refuses %s with a validation problem', async (_case, body, path) => {
    const res = await t.api(undefined, {
      method: 'POST',
      url: SIGN_IN_URL,
      headers: uniqueClient(),
      payload: { email: 'v@example.com', password: TEST_PASSWORD, ...body },
    });
    const problem = expectProblem(res, 400, 'validation');
    expect(problem.errors?.[0].path).toBe(`body${path}`);
  });

  it('answers a body that is not JSON, and one past the body limit, with problems', async () => {
    const broken = await t.api(undefined, {
      method: 'POST',
      url: SIGN_IN_URL,
      headers: { ...uniqueClient(), 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expectProblem(broken, 400, 'validation');
    const huge = await t.api(undefined, {
      method: 'POST',
      url: SIGN_IN_URL,
      headers: { ...uniqueClient(), 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expectProblem(huge, 413, 'validation');
  });

  it('never echoes a broken body: no part of the password reaches the problem or a log line', async () => {
    const fragment = 'Qx7-hunter2-Vb9';
    t.logs.clear();
    for (const payload of [
      `{"email":"owner@example.com","password":"${fragment}`,
      `{"email":"owner@example.com","password":${fragment}}`,
    ]) {
      const res = await t.api(undefined, {
        method: 'POST',
        url: SIGN_IN_URL,
        headers: { ...uniqueClient(), 'content-type': 'application/json' },
        payload,
      });
      const problem = expectProblem(res, 400, 'validation');
      expect(problem.detail).toBe('The request could not be read');
    }
    const everything = JSON.stringify(t.logs.records);
    for (const part of [fragment, 'Qx7', 'hunter2', 'Vb9']) {
      expect(everything).not.toContain(part);
    }
  });

  it('refuses a sign-in whose password changed under it, minting nothing', async () => {
    const email = 'moved-under-api@example.com';
    const id = await newAccount(email);
    t.logs.clear();
    const [, res] = await interleave(
      t.db,
      (tx) =>
        tx
          .update(user)
          .set({ password: 'not-a-hash-moved' })
          .where(eq(user.id, id)),
      () => signInDevice(t, { email }),
    );
    expectProblem(res, 401, 'unauthorized');
    expect(
      await t.db.$count(
        personalAccessToken,
        eq(personalAccessToken.userId, id),
      ),
    ).toBe(0);
    expect(t.logs.messages('warn', 'Api')).toEqual([
      expect.stringMatching(
        new RegExp(`^API sign-in for user ${id} refused: password-changed`),
      ),
    ]);
  });

  it('refuses a sign-in whose account was deleted under it', async () => {
    const email = 'deleted-under-api@example.com';
    const id = await newAccount(email);
    const [, res] = await interleave(
      t.db,
      (tx) => tx.delete(user).where(eq(user.id, id)),
      () => signInDevice(t, { email }),
    );
    expectProblem(res, 401, 'unauthorized');
    expect(
      await t.db.$count(
        personalAccessToken,
        eq(personalAccessToken.userId, id),
      ),
    ).toBe(0);
  });

  it('at the device cap evicts the least recently used device, never an agent token', async () => {
    const email = 'at-the-cap@example.com';
    const id = await newAccount(email);
    const agents: number[] = [];
    const devices: number[] = [];
    for (let i = 0; i < MAX_ACTIVE_TOKENS; i++) {
      const agent = await mintToken(t, id, `Agent ${i}`, 'mcp');
      const device = await mintToken(t, id, `Phone ${i}`, 'device');
      if (!agent.created || !device.created) throw new Error('not minted');
      agents.push(agent.id);
      devices.push(device.id);
    }
    t.logs.clear();
    const { tokenId } = await signedIn(email, 'New phone');
    expect(await tokenState(devices[0])).toBe('revoked');
    for (const agent of agents) expect(await tokenState(agent)).toBe('active');
    for (const device of devices.slice(1)) {
      expect(await tokenState(device)).toBe('active');
    }
    expect(t.logs.messages('info', 'Api')).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^User ${id} signed in a device: token ${tokenId} from .*, evicting token ${devices[0]}$`,
        ),
      ),
    );
    expect(
      await t.db.$count(
        personalAccessToken,
        and(
          eq(personalAccessToken.userId, id),
          eq(personalAccessToken.kind, 'device'),
          isNull(personalAccessToken.revokedAt),
        ),
      ),
    ).toBe(MAX_ACTIVE_TOKENS);
  });
});

describe('sign-in limits', () => {
  it('shares one budget per address with the login page: 5 a minute in all, the 6th a 429', async () => {
    const client = uniqueClient();
    const email = 'shared-budget@example.com';
    await newAccount(email);
    const page = () =>
      t.inject({
        method: 'POST',
        url: '/auth/login',
        anonymous: true,
        headers: client,
        payload: { email, password: 'Wrong12345' },
      });
    const statuses = [
      (await page()).statusCode,
      (await page()).statusCode,
      (await page()).statusCode,
      (await signInDevice(t, { email, password: 'Wrong12345', client }))
        .statusCode,
      (await signInDevice(t, { email, password: 'Wrong12345', client }))
        .statusCode,
    ];
    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    const sixth = await signInDevice(t, { email, client });
    expectProblem(sixth, 429, 'rate_limited');
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
    expect((await page()).statusCode).toBe(429);
  });

  // #705: one SIGN_IN_ACCOUNT_LIMIT checker for both doors, so guesses
  // spread over addresses and doors are 5 a minute per account in all.
  it('caps an account across addresses and both doors: the 6th is a 429 at either, another account unaffected', async () => {
    const email = 'per-account@example.com';
    await newAccount(email);
    const page = (typed: string) =>
      t.inject({
        method: 'POST',
        url: '/auth/login',
        anonymous: true,
        headers: uniqueClient(),
        payload: { email: typed, password: 'Wrong12345' },
      });
    const statuses = [
      (await page(email)).statusCode,
      // The key is the address as the lookup normalises it.
      (await page('  Per-Account@Example.COM ')).statusCode,
      (await page(email)).statusCode,
      (await signInDevice(t, { email, password: 'Wrong12345' })).statusCode,
      (await signInDevice(t, { email, password: 'Wrong12345' })).statusCode,
    ];
    expect(statuses).toEqual([401, 401, 401, 401, 401]);

    // The right password, from an address with room, is refused too.
    expectProblem(await signInDevice(t, { email }), 429, 'rate_limited');
    const sixthPage = await t.inject({
      method: 'POST',
      url: '/auth/login',
      anonymous: true,
      headers: uniqueClient(),
      payload: { email, password: TEST_PASSWORD },
    });
    expect(sixthPage.statusCode).toBe(429);
    expect(Number(sixthPage.headers['retry-after'])).toBeGreaterThan(0);
    expect(sixthPage.cookies.find((c) => c.name === 'access_token')).toBe(
      undefined,
    );
    expect(t.logs.messages('warn')).toContainEqual(
      'Rate limit reached: POST /auth/login for an account',
    );

    const other = 'per-account-other@example.com';
    await newAccount(other);
    await signedIn(other);
    await t.login(other);
  });
});

describe('DELETE /api/v1/auth/token (sign a device out)', () => {
  it('revokes the calling token and nothing else', async () => {
    const email = 'sign-out@example.com';
    const id = await newAccount(email);
    const phone = await signedIn(email, 'Phone');
    const tablet = await signedIn(email, 'Tablet');
    const agent = await mintToken(t, id, 'Claude', 'mcp');
    if (!agent.created) throw new Error('no agent token');
    issued.push(agent.token);
    const res = await t.api(phone.token, {
      method: 'DELETE',
      url: SIGN_IN_URL,
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(await tokenState(phone.tokenId)).toBe('revoked');
    expect(await tokenState(tablet.tokenId)).toBe('active');
    expect(await tokenState(agent.id)).toBe('active');
    const after = await t.api(phone.token, {
      method: 'GET',
      url: '/api/v1/me',
    });
    expectProblem(after, 401, 'unauthorized');
  });

  it('answers 204 for a token revoked after this request authenticated', async () => {
    const email = 'revoked-meanwhile@example.com';
    const id = await newAccount(email);
    const phone = await signedIn(email);
    t.logs.clear();
    // The token's first use writes last_used_at, which waits on the row
    // the revocation holds; the revoke then finds it revoked.
    const [, res] = await interleave(
      t.db,
      (tx) =>
        tx
          .update(personalAccessToken)
          .set({ revokedAt: new Date() })
          .where(eq(personalAccessToken.id, phone.tokenId)),
      () => t.api(phone.token, { method: 'DELETE', url: SIGN_IN_URL }),
    );
    expect(res.statusCode).toBe(204);
    expect(t.logs.messages('info', 'Api')).toEqual([
      `User ${id} signed out device token ${phone.tokenId} (already revoked)`,
    ]);
  });
});

// #705: a device token unused for DEVICE_IDLE_DAYS, from its last use or
// else its creation, is refused as revoked; agent tokens never idle out.
describe('a device token idle past its expiry', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const IDLE_MS = DEVICE_IDLE_DAYS * DAY_MS;

  afterEach(() => {
    vi.useRealTimers();
  });

  async function stamps(tokenId: number) {
    const [row] = await t.db
      .select({
        createdAt: personalAccessToken.createdAt,
        lastUsedAt: personalAccessToken.lastUsedAt,
      })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.id, tokenId));
    return row;
  }

  const me = (token: string) =>
    t.api(token, { method: 'GET', url: '/api/v1/me' });

  it('opens until 90 days after its last use, then is the 401 of a revoked token', async () => {
    const email = 'idle-device@example.com';
    const id = await newAccount(email);
    const { token, tokenId } = await signedIn(email);
    const { createdAt } = await stamps(tokenId);
    vi.useFakeTimers({ toFake: ['Date'], now: createdAt });

    // Never used: counted from its creation.
    vi.setSystemTime(createdAt.getTime() + IDLE_MS - 60_000);
    expect((await me(token)).statusCode).toBe(200);
    const { lastUsedAt } = await stamps(tokenId);
    expect(lastUsedAt).toEqual(
      new Date(createdAt.getTime() + IDLE_MS - 60_000),
    );

    // Past 90 days from its creation, but not from its last use.
    vi.setSystemTime(lastUsedAt!.getTime() + IDLE_MS - 60_000);
    expect((await me(token)).statusCode).toBe(200);

    const used = (await stamps(tokenId)).lastUsedAt!;
    vi.setSystemTime(used.getTime() + IDLE_MS);
    t.logs.clear();
    expectProblem(await me(token), 401, 'unauthorized');
    expect(t.logs.messages('warn')).toContainEqual(
      expect.stringMatching(
        /^API GET \/api\/v1\/me refused: revoked token from /,
      ),
    );
    // A refusal records no use: the token stays idle.
    expect((await stamps(tokenId)).lastUsedAt).toEqual(used);
    expect(await tokenState(tokenId)).toBe('active');

    // Agent tokens have no idle expiry.
    const agent = await mintToken(t, id, 'Claude', 'mcp');
    if (!agent.created) throw new Error('no agent token');
    issued.push(agent.token);
    vi.setSystemTime(Date.now() + 4 * IDLE_MS);
    expect((await mcpRequest(t, agent.token, 'tools/list')).statusCode).toBe(
      200,
    );
  });

  it('a never-used device is idle 90 days from its creation, and Profile › Devices says so', async () => {
    const email = 'idle-unused@example.com';
    const cookie = await t.register(email);
    const idle = await signedIn(email, 'Old phone');
    const { createdAt } = await stamps(idle.tokenId);
    vi.useFakeTimers({ toFake: ['Date'], now: createdAt });
    vi.setSystemTime(createdAt.getTime() + IDLE_MS);
    const fresh = await signedIn(email, 'New phone');
    expect((await me(fresh.token)).statusCode).toBe(200);
    expectProblem(await me(idle.token), 401, 'unauthorized');

    const profile = await t.inject({
      method: 'GET',
      url: '/auth/profile',
      headers: { cookie },
    });
    expect(profile.statusCode).toBe(200);
    const body = unescapeHtml(profile.body);
    expect(body).toContain(
      `an app unused for ${DEVICE_IDLE_DAYS} days is signed out by itself`,
    );
    const rowOf = (name: string) =>
      body.slice(
        body.indexOf(`>${name}<`),
        body.indexOf('</li>', body.indexOf(`>${name}<`)),
      );
    expect(rowOf('Old phone')).toContain(
      `signed out: unused for ${DEVICE_IDLE_DAYS} days`,
    );
    expect(rowOf('New phone')).toContain('last used');
  });
});

describe('GET /api/v1/me', () => {
  it('names the account, the household zone and its day, and nothing else', async () => {
    const email = 'me@example.com';
    const id = await newAccount(email);
    const { token } = await signedIn(email);
    const res = await t.api(token, { method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.json()).toEqual({
      id,
      email,
      timeZone: t.timeZone,
      today: t.today(),
    });
  });

  it('logs the caller as the token row, never the token', async () => {
    const email = 'me-logged@example.com';
    const id = await newAccount(email);
    const { token, tokenId } = await signedIn(email);
    t.logs.clear();
    await t.api(token, { method: 'GET', url: '/api/v1/me' });
    const [line] = t.logs.records.filter((record) => record.logger === 'Http');
    expect(line).toMatchObject({ user_id: id, token_id: tokenId, status: 200 });
  });

  it('holds 120 calls a minute per token, then a 429 problem', async () => {
    const email = 'busy-client@example.com';
    await newAccount(email);
    const { token } = await signedIn(email);
    for (let i = 0; i < 120; i++) {
      const res = await t.api(token, { method: 'GET', url: '/api/v1/me' });
      expect(res.statusCode).toBe(200);
    }
    const refused = await t.api(token, { method: 'GET', url: '/api/v1/me' });
    expectProblem(refused, 429, 'rate_limited');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('GET /api/v1/openapi.json', () => {
  it('serves the committed spec, without a token', async () => {
    const res = await t.api(undefined, {
      method: 'GET',
      url: '/api/v1/openapi.json',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.json()).toEqual(committedSpec);
  });
});
