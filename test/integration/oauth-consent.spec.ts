import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  oauthAuthorizationCode,
  personalAccessToken,
  user,
} from '../../src/db/schema';
import { pruneOAuthCodes } from '../../src/maintenance/oauth-code-prune';
import { grantConsent } from '../../src/web/oauth/codes';
import { STATE_MAX, URL_MAX } from '../../src/web/oauth/authorize-request';
import { CONSENT_AUDIENCE } from '../../src/web/oauth/consent-token';
import {
  createTestApp,
  OWNER_EMAIL,
  recordQueries,
  TEST_PASSWORD,
  type TestApp,
  uniqueClient,
} from './harness';
import { type LinkSites, startLinkSites } from './link-sites';

/**
 * The OAuth consent (#1290; src/web/oauth/AGENTS.md, plan 4.2 steps 5-7):
 * GET /oauth/authorize proving a request against a client's metadata
 * document (served by the link-sites stand-in over TLS), the consent page,
 * and the POST that writes a one-time code. The token exchange is #1291's.
 */
const SITE_URL = 'https://closet.example.com';
const MCP_HOST = 'closet-mcp.example.com';
const RESOURCE = `https://${MCP_HOST}/mcp`;
const ISSUER = `https://${MCP_HOST}`;
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const STATE = 'state-af0ifjsldkj';
const SECRET = 'integration-test-secret-0123456789abcdef';

describe('OAuth consent', () => {
  let t: TestApp;
  let sites: LinkSites;
  let clientId: string;

  /** A client document at `path`, listing `redirects`. */
  const publish = (path: string, doc: Record<string, unknown> = {}) => {
    const id = sites.secureUrl(path);
    sites.serve(path, {
      type: 'application/json; charset=utf-8',
      body: JSON.stringify({
        client_id: id,
        client_name: 'Claude',
        redirect_uris: [CALLBACK],
        ...doc,
      }),
    });
    return id;
  };

  const authorizeUrl = (
    params: Record<string, string | string[] | undefined> = {},
  ) => {
    const query = new URLSearchParams();
    const all = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      state: STATE,
      scope: 'closet:read closet:write',
      resource: RESOURCE,
      ...params,
    };
    for (const [name, value] of Object.entries(all)) {
      for (const one of [value ?? []].flat()) query.append(name, one);
    }
    return `/oauth/authorize?${query}`;
  };

  const get = (url: string, headers: Record<string, string> = {}) =>
    t.inject({
      method: 'GET',
      url,
      anonymous: true,
      headers: { ...uniqueClient(), ...headers },
    });

  const fieldOf = (html: string) => {
    const match = /name="consent" value="([^"]+)"/.exec(html);
    if (!match) throw new Error('no consent field on the page');
    return match[1];
  };

  const post = (
    payload: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    t.inject({
      method: 'POST',
      url: '/oauth/authorize',
      anonymous: true,
      payload,
      headers: { ...uniqueClient(), ...headers },
    });

  const allow = (field: string, extra: Record<string, string> = {}) =>
    post({
      consent: field,
      decision: 'allow',
      email: OWNER_EMAIL,
      password: TEST_PASSWORD,
      name: 'Claude',
      ...extra,
    });

  const consentField = async (url = authorizeUrl()) => {
    const res = await get(url);
    expect(res.statusCode).toBe(200);
    return fieldOf(res.body);
  };

  beforeAll(async () => {
    sites = await startLinkSites({ protocol: 'http/1.1' });
    t = await createTestApp(
      { SITE_URL, ALLOWED_HOSTS: MCP_HOST, MCP_PUBLIC_URL: RESOURCE },
      { outboundFetch: sites.outboundFetch, signInAccountMax: 1000 },
    );
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  beforeEach(() => {
    clientId = publish('/client.json');
  });

  it('renders the consent with the redirect host as headline, then 303s a hashed code', async () => {
    const page = await get(authorizeUrl());
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('same-origin');
    expect(page.headers['content-security-policy']).toContain(
      "form-action 'self' https://claude.ai;",
    );
    expect(page.body).toMatch(
      /Closet will send access to <strong>claude\.ai<\/strong>/,
    );
    // The document lives on shop.test, access goes to claude.ai.
    expect(page.body).toContain('but access goes to claude.ai');
    expect(page.body).not.toContain('class="dock"');

    const res = await allow(fieldOf(page.body));
    expect(res.statusCode).toBe(303);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
    const location = new URL(String(res.headers.location));
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    expect(location.searchParams.get('state')).toBe(STATE);
    expect(location.searchParams.get('iss')).toBe(ISSUER);
    const code = location.searchParams.get('code') ?? '';
    expect(code).toMatch(/^closet_code_[\w-]{43}$/);

    const [row] = await t.db
      .select()
      .from(oauthAuthorizationCode)
      .where(
        eq(
          oauthAuthorizationCode.codeHash,
          createHash('sha256').update(code).digest('hex'),
        ),
      );
    const [owner] = await t.db
      .select({ password: user.password })
      .from(user)
      .where(eq(user.id, t.owner.id));
    expect(row).toMatchObject({
      userId: t.owner.id,
      clientId,
      redirectUri: CALLBACK,
      codeChallenge: CHALLENGE,
      resource: RESOURCE,
      name: 'Claude',
      // Read-only and own-wardrobe-only unless ticked, whatever was asked.
      readOnly: true,
      ownWardrobeOnly: false,
      passwordFingerprint: owner.password.slice(-8),
      usedAt: null,
      tokenId: null,
    });
    const lifetime = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(lifetime).toBeGreaterThan(119_000);
    expect(lifetime).toBeLessThan(121_000);
    expect(t.logs.ops('oauth.consent.granted').at(-1)).toMatchObject({
      userId: t.owner.id,
      clientHost: 'shop.test',
      readOnly: true,
    });
  });

  it('grants writes only when asked and ticked, and the name as typed', async () => {
    const res = await allow(await consentField(), {
      writes: 'on',
      ownWardrobeOnly: 'on',
      name: 'My\u202E Claude\n',
    });
    const code =
      new URL(String(res.headers.location)).searchParams.get('code') ?? '';
    const [row] = await t.db
      .select()
      .from(oauthAuthorizationCode)
      .where(
        eq(
          oauthAuthorizationCode.codeHash,
          createHash('sha256').update(code).digest('hex'),
        ),
      );
    expect(row).toMatchObject({
      readOnly: false,
      ownWardrobeOnly: true,
      name: 'My Claude',
    });

    const readOnlyAsk = await consentField(
      authorizeUrl({ scope: 'closet:read' }),
    );
    const ignored = await allow(readOnlyAsk, { writes: 'on' });
    const ignoredCode =
      new URL(String(ignored.headers.location)).searchParams.get('code') ?? '';
    const [readRow] = await t.db
      .select({ readOnly: oauthAuthorizationCode.readOnly })
      .from(oauthAuthorizationCode)
      .where(
        eq(
          oauthAuthorizationCode.codeHash,
          createHash('sha256').update(ignoredCode).digest('hex'),
        ),
      );
    expect(readRow.readOnly).toBe(true);
  });

  it('adds its answer to a redirect URI that has a query of its own', async () => {
    const withQuery = `${CALLBACK}?tenant=a%20b`;
    clientId = publish('/client-query.json', { redirect_uris: [withQuery] });
    const res = await post({
      consent: await consentField(authorizeUrl({ redirect_uri: withQuery })),
      decision: 'deny',
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(
      `${withQuery}&error=access_denied&state=${STATE}&iss=${encodeURIComponent(ISSUER)}`,
    );
  });

  it('answers Deny with access_denied, state and iss, asking no password', async () => {
    const res = await post({ consent: await consentField(), decision: 'deny' });
    expect(res.statusCode).toBe(303);
    expect(res.headers['cache-control']).toBe('no-store');
    const location = new URL(String(res.headers.location));
    expect(Object.fromEntries(location.searchParams)).toEqual({
      error: 'access_denied',
      state: STATE,
      iss: ISSUER,
    });
  });

  it.each([
    ['an unlisted redirect_uri', { redirect_uri: 'https://evil.test/cb' }],
    ['an extra slash', { redirect_uri: `${CALLBACK}/` }],
    ['an added query', { redirect_uri: `${CALLBACK}?x=1` }],
    ['http for https', { redirect_uri: CALLBACK.replace('https:', 'http:') }],
    ['a repeated redirect_uri', { redirect_uri: [CALLBACK, CALLBACK] }],
    ['no redirect_uri', { redirect_uri: undefined }],
    [
      'a redirect_uri past the cap',
      { redirect_uri: `${CALLBACK}${'a'.repeat(URL_MAX)}` },
    ],
  ])('renders %s as a 400 page and never redirects', async (_label, params) => {
    const res = await get(authorizeUrl(params));
    expect(res.statusCode).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('has not listed');
    expect(res.body).not.toContain('evil.test');
  });

  it.each([
    [
      'a client_id that is not https',
      () => ({ client_id: clientId.replace('https:', 'http:') }),
    ],
    ['a repeated client_id', () => ({ client_id: [clientId, clientId] })],
    [
      'a document that is not there',
      () => ({ client_id: sites.secureUrl('/missing.json') }),
    ],
    [
      'a document whose client_id is another URL',
      () => ({
        client_id: publish('/liar.json', {
          client_id: sites.secureUrl('/other.json'),
        }),
      }),
    ],
    [
      'a document of another type',
      () => {
        sites.serve('/html.json', { type: 'text/html', body: '{}' });
        return { client_id: sites.secureUrl('/html.json') };
      },
    ],
    [
      'a document that redirects',
      () => {
        sites.serve('/moved.json', {
          status: 302,
          type: 'text/plain',
          body: '',
          headers: { location: sites.secureUrl('/client.json') },
        });
        return { client_id: sites.secureUrl('/moved.json') };
      },
    ],
  ])(
    'says the app could not be read for %s, with no redirect',
    async (_label, params) => {
      const res = await get(authorizeUrl(params()));
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
      expect(res.body).toContain('sign-in details could not be read');
    },
  );

  it.each([
    [
      'another response type',
      { response_type: 'token' },
      'unsupported_response_type',
    ],
    ['PKCE plain', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['no challenge', { code_challenge: undefined }, 'invalid_request'],
    [
      'another resource',
      { resource: 'https://evil.test/mcp' },
      'invalid_target',
    ],
    [
      'a repeated resource',
      { resource: [RESOURCE, RESOURCE] },
      'invalid_target',
    ],
    ['a repeated state', { state: [STATE, STATE] }, 'invalid_request'],
  ])(
    'shows %s after proof as a page with a link back, never a redirect',
    async (_label, params, error) => {
      const res = await get(authorizeUrl(params));
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
      expect(res.headers['cache-control']).toBe('no-store');
      const href =
        /<a href="([^"]+)" class="btn btn-outline"/.exec(res.body)?.[1] ?? '';
      const link = new URL(href.replaceAll('&amp;', '&'));
      expect(`${link.origin}${link.pathname}`).toBe(CALLBACK);
      expect(link.searchParams.get('error')).toBe(error);
      expect(link.searchParams.get('iss')).toBe(ISSUER);
      expect(res.body).toContain('Return to claude.ai');
    },
  );

  it('warns that a loopback redirect reaches only an app on this device, on any port', async () => {
    clientId = publish('/cli.json', {
      redirect_uris: ['http://127.0.0.1/callback'],
    });
    const res = await get(
      authorizeUrl({ redirect_uri: 'http://127.0.0.1:53682/callback' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('only to an app on this device');
    expect(res.headers['content-security-policy']).toContain(
      "form-action 'self' http://127.0.0.1:53682;",
    );
  });

  it('shows a client that names itself "Closet security check" only as what it calls itself', async () => {
    clientId = publish('/phish.json', {
      client_name: 'Closet\u202E security check\n',
    });
    const res = await get(authorizeUrl());
    expect(res.body).toContain('The app calls itself “Closet security check”');
    expect(res.body).toMatch(
      /Closet will send access to <strong>claude\.ai<\/strong>/,
    );
    expect(res.body.match(/Closet security check/g)).toHaveLength(2); // the line, and the name field's default
  });

  it('refuses a forged, re-signed or expired field as a page, never a redirect', async () => {
    const field = await consentField();
    const [header, payload] = field.split('.');
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString(),
    ) as Record<string, unknown>;
    const forged = `${header}.${Buffer.from(JSON.stringify({ ...claims, ru: 'https://evil.test/cb' })).toString('base64url')}.${field.split('.')[2]}`;
    const session = t.owner.cookie.replace('access_token=', '');
    // Signed with the app's key, eleven minutes ago, for its ten.
    const now = Math.floor(Date.now() / 1000);
    const expired = jwt.sign(
      { ...claims, iat: now - 660, exp: now - 60 },
      SECRET,
      { algorithm: 'HS256' },
    );
    for (const [bad, text] of [
      [forged, 'could not be read'],
      [session, 'could not be read'],
      [jwt.sign({ ...claims, aud: 'other' }, SECRET), 'could not be read'],
      [expired, 'has expired'],
    ] as const) {
      const res = await post({ consent: bad, decision: 'deny' });
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
      expect(res.body).toContain(text);
    }
    expect(claims.aud).toBe(CONSENT_AUDIENCE);
  });

  it('refuses an unknown email with the same page and statements as a wrong password', async () => {
    const field = await consentField();
    const refusal = async (email: string) => {
      let body = '';
      const queries = await recordQueries(async () => {
        const res = await allow(field, { email, password: 'WrongPassword1' });
        expect(res.statusCode).toBe(400);
        expect(res.headers.location).toBeUndefined();
        body = res.body.replaceAll(email, '<email>');
      });
      return { sql: queries.sql, body };
    };
    const known = await refusal(OWNER_EMAIL);
    const unknown = await refusal('nobody@example.com');
    expect(unknown.sql).toEqual(known.sql);
    expect(unknown.body).toBe(known.body);
    expect(known.body).toContain('Incorrect email or password');
    expect(known.body).not.toContain('WrongPassword1');
  });

  it('writes no code for a password changed since it was checked', async () => {
    const [account] = await t.db
      .select({ password: user.password })
      .from(user)
      .where(eq(user.id, t.owner.id));
    const result = await grantConsent(
      { db: t.db, logger: t.logger },
      { userId: t.owner.id, surface: 'page' },
      {
        request: {
          clientId,
          clientName: 'Claude',
          redirectUri: CALLBACK,
          codeChallenge: CHALLENGE,
          writeRequested: false,
        },
        resource: RESOURCE,
        name: 'Claude',
        scope: { readOnly: true, ownWardrobeOnly: false },
        verifiedPassword: `${account.password}x`,
      },
    );
    expect(result).toEqual({ granted: false, reason: 'password-changed' });
  });

  describe('Agent Access full', () => {
    let fullApp: TestApp;
    const tokenRows = (
      count: number,
      extra: Partial<typeof personalAccessToken.$inferInsert> = {},
    ) =>
      Array.from({ length: count }, (_, i) => ({
        userId: fullApp.owner.id,
        kind: 'mcp' as const,
        name: `agent ${i}`,
        tokenHash: createHash('sha256')
          .update(`${Math.random()}`)
          .digest('hex'),
        tokenPrefix: 'closet_abcd',
        ...extra,
      }));

    beforeAll(async () => {
      fullApp = await createTestApp(
        { SITE_URL, ALLOWED_HOSTS: MCP_HOST, MCP_PUBLIC_URL: RESOURCE },
        { outboundFetch: sites.outboundFetch, signInAccountMax: 1000 },
      );
    });
    afterAll(() => fullApp?.cleanup());

    const consentOn = async (app: TestApp) => {
      const page = await app.inject({
        method: 'GET',
        url: authorizeUrl(),
        anonymous: true,
        headers: uniqueClient(),
      });
      return app.inject({
        method: 'POST',
        url: '/oauth/authorize',
        anonymous: true,
        headers: uniqueClient(),
        payload: {
          consent: fieldOf(page.body),
          decision: 'allow',
          email: OWNER_EMAIL,
          password: TEST_PASSWORD,
          name: 'Claude',
        },
      });
    };

    it("leaves this client's own grant out of the count, then refuses at the cap", async () => {
      // 19 others and this client's earlier grant: the mint replaces that one.
      await fullApp.db
        .insert(personalAccessToken)
        .values([
          ...tokenRows(19),
          ...tokenRows(1, { oauthClientId: clientId }),
        ]);
      expect((await consentOn(fullApp)).statusCode).toBe(303);

      await fullApp.db.insert(personalAccessToken).values(tokenRows(1));
      const full = await consentOn(fullApp);
      expect(full.statusCode).toBe(400);
      expect(full.headers.location).toBeUndefined();
      expect(full.body).toContain('Agent access is full (20 agents)');
    });
  });

  it('fits a request with every value at its cap through the POST', async () => {
    const longId = sites.secureUrl(`/${'c'.repeat(200)}`);
    const pad = URL_MAX - longId.length;
    const maxId = sites.secureUrl(`/${'c'.repeat(200 + pad)}`);
    const maxRedirect = `https://claude.ai/${'r'.repeat(URL_MAX - 'https://claude.ai/'.length)}`;
    sites.serve(new URL(maxId).pathname, {
      type: 'application/json',
      body: JSON.stringify({
        client_id: maxId,
        client_name: '\u{1F600}'.repeat(80),
        redirect_uris: [maxRedirect],
      }),
    });
    clientId = maxId;
    expect(maxId).toHaveLength(URL_MAX);
    const field = await consentField(
      authorizeUrl({
        redirect_uri: maxRedirect,
        state: '"'.repeat(STATE_MAX),
        code_challenge: 'a'.repeat(128),
      }),
    );
    const res = await post({ consent: field, decision: 'deny' });
    expect(res.statusCode).toBe(303);
  });

  it('is a 404 on the public MCP host, and with OAuth off', async () => {
    expect((await get(authorizeUrl(), { host: MCP_HOST })).statusCode).toBe(
      404,
    );
    const post404 = await post(
      { consent: await consentField(), decision: 'deny' },
      { host: MCP_HOST, origin: `http://${MCP_HOST}` },
    );
    expect(post404.statusCode).toBe(404);
    expect(post404.headers.location).toBeUndefined();

    const off = await createTestApp(
      { SITE_URL },
      { outboundFetch: sites.outboundFetch, signInAccountMax: 1000 },
    );
    try {
      const res = await off.inject({
        method: 'GET',
        url: authorizeUrl(),
        anonymous: true,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await off.cleanup();
    }
  });

  it('fetches nothing for a HEAD or an OPTIONS', async () => {
    const before = sites.hits.length;
    for (const method of ['HEAD', 'OPTIONS'] as const) {
      const res = await t.inject({
        method,
        url: authorizeUrl(),
        anonymous: true,
        headers: uniqueClient(),
      });
      expect(res.statusCode).toBe(404);
    }
    expect(sites.hits).toHaveLength(before);
  });

  it('limits the GET per address before it fetches', async () => {
    const client = uniqueClient();
    for (let i = 0; i < 10; i++) {
      expect((await get(authorizeUrl(), client)).statusCode).toBe(200);
    }
    const before = sites.hits.length;
    const refused = await get(authorizeUrl(), client);
    expect(refused.statusCode).toBe(429);
    expect(sites.hits).toHaveLength(before);
  });

  it('never logs the code, state, challenge, password, client name or field', async () => {
    const mark = t.logs.records.length;
    clientId = publish('/secretive.json', { client_name: 'Unlogged Name' });
    const field = await consentField();
    await allow(field, { password: 'WrongPassword1' });
    const res = await allow(field);
    const code =
      new URL(String(res.headers.location)).searchParams.get('code') ?? '';
    const logged = JSON.stringify(t.logs.records.slice(mark));
    for (const secret of [
      code,
      STATE,
      CHALLENGE,
      TEST_PASSWORD,
      'WrongPassword1',
      'Unlogged Name',
      field,
    ]) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).toContain('/oauth/authorize');
  });

  it('prunes codes a day past their expiry, nightly', async () => {
    await t.db.delete(oauthAuthorizationCode);
    const row = (hash: string, expiresAt: ReturnType<typeof sql>) => ({
      codeHash: hash,
      userId: t.owner.id,
      clientId,
      redirectUri: CALLBACK,
      codeChallenge: CHALLENGE,
      resource: RESOURCE,
      name: 'Claude',
      readOnly: true,
      ownWardrobeOnly: false,
      passwordFingerprint: 'abcdefgh',
      expiresAt,
    });
    await t.db
      .insert(oauthAuthorizationCode)
      .values([
        row('a'.repeat(64), sql`now() - interval '25 hours'`),
        row('b'.repeat(64), sql`now() - interval '23 hours'`),
      ]);
    expect(await pruneOAuthCodes({ db: t.db, logger: t.logger })).toBe(1);
    const left = await t.db
      .select({ hash: oauthAuthorizationCode.codeHash })
      .from(oauthAuthorizationCode);
    expect(left).toEqual([{ hash: 'b'.repeat(64) }]);
  });
});
