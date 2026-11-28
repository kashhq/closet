import { eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  oauthAuthorizationCode,
  oauthRetiredRefreshToken,
  personalAccessToken,
  user,
} from '../../src/db/schema';
import {
  hashToken,
  MAX_ACTIVE_TOKENS,
  OAUTH_IDLE_DAYS,
  type TokenScope,
} from '../../src/web/auth/personal-tokens';
import { SIGN_OUT_EVERYWHERE_PATH } from '../../src/web/auth/urls';
import { pruneRetiredRefreshTokens } from '../../src/maintenance/oauth-code-prune';
import { grantConsent } from '../../src/web/oauth/codes';
import { refreshGrant, exchangeCode } from '../../src/web/oauth/grants';
import {
  BEARER_REFUSAL_LIMIT,
  OAUTH_TOKEN_LIMIT,
} from '../../src/web/security/rate-limit';
import {
  createTestApp,
  TEST_PASSWORD,
  type TestApp,
  uniqueClient,
  userIdOf,
} from './harness';
import { backendPid, interleave, waitForBlockedOn } from './interleave';
import { mcpRequest } from './mcp';

/**
 * OAuth's token endpoint (#1291; src/web/oauth/AGENTS.md, plan 4.2 steps
 * 8-9, 4.5): the code grant with PKCE and its one attempt, the refresh
 * grant's rotation and family-wide reuse revocation (#1295), the access
 * token's hour and the grant's idle days at /mcp, the refusals' RFC 6749
 * words and budget, and nothing a client sent ever logged. Codes come from
 * grantConsent (the consent's own writer, oauth-consent.spec.ts), so no
 * client document is fetched here.
 */
const SITE_URL = 'https://closet.example.com';
const MCP_HOST = 'closet-mcp.example.com';
const RESOURCE = `https://${MCP_HOST}/mcp`;
const PRM_URL = `https://${MCP_HOST}/.well-known/oauth-protected-resource/mcp`;
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
// RFC 7636 appendix B's pair.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const FORM = 'application/x-www-form-urlencoded';
const READ_ONLY: TokenScope = { readOnly: true, ownWardrobeOnly: false };
const DAY_MS = 24 * 60 * 60 * 1000;

interface Issued {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

describe('OAuth token endpoint', () => {
  let t: TestApp;
  /** Every code and token issued: none may reach a log line. */
  const secrets: string[] = [VERIFIER, CHALLENGE];
  let users = 0;
  // Each test's own account and client, so grants never replace or crowd
  // another test's.
  let userId: number;
  let cookie: string;
  let email: string;
  let clientId: string;

  beforeAll(async () => {
    t = await createTestApp({
      SITE_URL,
      ALLOWED_HOSTS: MCP_HOST,
      MCP_PUBLIC_URL: RESOURCE,
    });
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  beforeEach(async () => {
    users += 1;
    email = `oauth-token-${users}@example.com`;
    cookie = await t.register(email);
    userId = await userIdOf(t, email);
    clientId = `https://claude.ai/oauth/client-${users}.json`;
  });

  /** A consent's code, as POST /oauth/authorize writes it. */
  const consent = async ({
    scope = READ_ONLY,
    resource = RESOURCE,
    forUser = userId,
  }: { scope?: TokenScope; resource?: string; forUser?: number } = {}) => {
    const [account] = await t.db
      .select({ password: user.password })
      .from(user)
      .where(eq(user.id, forUser));
    const result = await grantConsent(
      { db: t.db, logger: t.logger },
      { userId: forUser, surface: 'page' },
      {
        request: {
          clientId,
          clientName: 'Claude',
          redirectUri: CALLBACK,
          codeChallenge: CHALLENGE,
          writeRequested: !scope.readOnly,
        },
        resource,
        name: 'Claude',
        scope,
        verifiedPassword: account.password,
      },
    );
    if (!result.granted) throw new Error(`no code: ${result.reason}`);
    secrets.push(result.code);
    return result.code;
  };

  const post = (
    fields: Record<string, string | string[]>,
    {
      headers = {},
      client = uniqueClient(),
    }: {
      headers?: Record<string, string>;
      client?: Record<string, string>;
    } = {},
  ) => {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) {
      for (const one of [value].flat()) body.append(name, one);
    }
    return t.inject({
      method: 'POST',
      url: '/oauth/token',
      anonymous: true,
      // Server to server: no Origin.
      sameOrigin: false,
      headers: { 'content-type': FORM, host: MCP_HOST, ...client, ...headers },
      payload: body.toString(),
    });
  };

  const exchange = (
    code: string,
    extra: Record<string, string | string[]> = {},
    options?: Parameters<typeof post>[1],
  ) =>
    post(
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: VERIFIER,
        redirect_uri: CALLBACK,
        client_id: clientId,
        resource: RESOURCE,
        ...extra,
      },
      options,
    );

  const refresh = (
    refreshToken: string,
    extra: Record<string, string> = {},
    options?: Parameters<typeof post>[1],
  ) =>
    post(
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        ...extra,
      },
      options,
    );

  const expectNoStore = (res: LightMyRequestResponse) => {
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.pragma).toBe('no-cache');
  };

  const issued = (res: LightMyRequestResponse): Issued => {
    expect(res.statusCode, res.body).toBe(200);
    expectNoStore(res);
    const body = res.json<Issued>();
    secrets.push(body.access_token, body.refresh_token);
    return body;
  };

  const expectRefusal = (
    res: LightMyRequestResponse,
    error: string,
    status = 400,
  ) => {
    expect(res.statusCode, res.body).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expectNoStore(res);
    expect(res.json()).toEqual({
      error,
      error_description: expect.any(String),
    });
  };

  const connect = async (scope?: TokenScope) =>
    issued(await exchange(await consent({ scope })));

  const grantOf = async (accessToken: string) => {
    const [row] = await t.db
      .select()
      .from(personalAccessToken)
      .where(eq(personalAccessToken.tokenHash, hashToken(accessToken)));
    return row;
  };

  const grantById = async (id: number) => {
    const [row] = await t.db
      .select()
      .from(personalAccessToken)
      .where(eq(personalAccessToken.id, id));
    return row;
  };

  const opens = async (accessToken: string) =>
    (await mcpRequest(t, accessToken, 'tools/list', {}, uniqueClient()))
      .statusCode;

  /** Static agent tokens straight into the table, past the consent's own cap check. */
  const staticTokens = (count: number, extra = {}) =>
    t.db.insert(personalAccessToken).values(
      Array.from({ length: count }, (_, n) => ({
        userId,
        kind: 'mcp' as const,
        name: `Static ${n}`,
        tokenHash: hashToken(`static-${userId}-${n}-${Math.random()}`),
        tokenPrefix: 'closet_Stat',
        ...extra,
      })),
    );

  describe('the code grant', () => {
    it('mints a read-only grant on the agent-token row, with both tokens, no-store', async () => {
      const code = await consent();
      const body = issued(
        await exchange(
          code,
          {},
          {
            headers: { 'content-type': `${FORM}; charset=UTF-8` },
          },
        ),
      );
      expect(body).toEqual({
        access_token: expect.stringMatching(/^closet_[\w-]{43}$/),
        refresh_token: expect.stringMatching(/^closet_rt_[\w-]{43}$/),
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'closet:read',
      });
      const grant = await grantOf(body.access_token);
      expect(grant).toMatchObject({
        userId,
        kind: 'mcp',
        name: 'Claude',
        oauthClientId: clientId,
        refreshTokenHash: hashToken(body.refresh_token),
        readOnly: true,
        revokedAt: null,
      });
      const lifetime = grant.accessExpiresAt!.getTime() - Date.now();
      expect(lifetime).toBeGreaterThan(3590 * 1000);
      expect(lifetime).toBeLessThanOrEqual(3600 * 1000);
      const [row] = await t.db
        .select()
        .from(oauthAuthorizationCode)
        .where(eq(oauthAuthorizationCode.codeHash, hashToken(code)));
      expect(row.usedAt).not.toBeNull();
      expect(row.tokenId).toBe(grant.id);
      expect(await opens(body.access_token)).toBe(200);
      expect(t.logs.ops('oauth.grant.minted').at(-1)).toMatchObject({
        userId,
        surface: 'oauth',
        tokenId: grant.id,
        codeId: row.id,
        clientHost: 'claude.ai',
        readOnly: true,
      });
    });

    it('names both scopes for a grant that can make changes, and takes the media type in any case', async () => {
      const code = await consent({
        scope: { readOnly: false, ownWardrobeOnly: true },
      });
      const body = issued(
        await exchange(
          code,
          {},
          {
            headers: { 'content-type': 'Application/X-WWW-Form-Urlencoded' },
          },
        ),
      );
      expect(body.scope).toBe('closet:read closet:write');
    });

    it('revokes the grant a code minted when the code comes again', async () => {
      const code = await consent();
      const first = issued(await exchange(code));
      expectRefusal(await exchange(code), 'invalid_grant');
      expect((await grantOf(first.access_token)).revokedAt).not.toBeNull();
      expect(await opens(first.access_token)).toBe(401);
      expectRefusal(await refresh(first.refresh_token), 'invalid_grant');
      expect(t.logs.messages('warn', 'OAuth').join('\n')).toMatch(
        /OAuth code \d+ used again: grant \d+ revoked/,
      );
    });

    it('revokes what a concurrent first use minted (interleaved on the account)', async () => {
      const code = await consent();
      const [first, second] = await interleave(
        t.db,
        (tx) =>
          exchangeCode(
            { db: tx, logger: t.logger },
            {
              code,
              verifier: VERIFIER,
              redirectUri: CALLBACK,
              clientId,
              resource: RESOURCE,
            },
          ),
        () => exchange(code),
      );
      if (!first.granted) throw new Error('the first use was refused');
      secrets.push(first.tokens.accessToken, first.tokens.refreshToken);
      expectRefusal(second, 'invalid_grant');
      expect(
        (await grantOf(first.tokens.accessToken)).revokedAt,
      ).not.toBeNull();
      expect(await opens(first.tokens.accessToken)).toBe(401);
    });

    it('refuses a code past its two minutes (the Postgres clock that stamped it)', async () => {
      const code = await consent();
      await t.db
        .update(oauthAuthorizationCode)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(oauthAuthorizationCode.codeHash, hashToken(code)));
      expectRefusal(await exchange(code), 'invalid_grant');
    });

    it('refuses a code once the password changed since consent', async () => {
      const code = await consent();
      await t.db
        .update(user)
        .set({ password: sql`${user.password} || 'x'` })
        .where(eq(user.id, userId));
      expectRefusal(await exchange(code), 'invalid_grant');
      // Burned: one attempt, whatever refused it.
      const [row] = await t.db
        .select()
        .from(oauthAuthorizationCode)
        .where(eq(oauthAuthorizationCode.codeHash, hashToken(code)));
      expect(row.usedAt).not.toBeNull();
      expect(row.tokenId).toBeNull();
    });

    it('refuses a code whose password changes while the mint waits on the account (interleaved)', async () => {
      const code = await consent();
      const [, res] = await interleave(
        t.db,
        (tx) =>
          tx
            .update(user)
            .set({ password: sql`${user.password} || 'y'` })
            .where(eq(user.id, userId)),
        () => exchange(code),
      );
      expectRefusal(res, 'invalid_grant');
      const live = await t.db
        .select({ id: personalAccessToken.id })
        .from(personalAccessToken)
        .where(eq(personalAccessToken.userId, userId));
      expect(live).toEqual([]);
    });

    it('burns the code on a wrong verifier, but not on a malformed one', async () => {
      const wrong = await consent();
      expectRefusal(
        await exchange(wrong, { code_verifier: 'x'.repeat(43) }),
        'invalid_grant',
      );
      expectRefusal(await exchange(wrong), 'invalid_grant');

      const code = await consent();
      for (const verifier of [VERIFIER.slice(0, 42), `${VERIFIER}+`]) {
        expectRefusal(
          await exchange(code, { code_verifier: verifier }),
          'invalid_request',
        );
      }
      issued(await exchange(code));
    });

    it.each([
      [
        'redirect_uri',
        { redirect_uri: 'https://claude.ai/other' },
        'invalid_grant',
      ],
      [
        'client_id',
        { client_id: 'https://claude.ai/oauth/other.json' },
        'invalid_grant',
      ],
      [
        'resource',
        { resource: 'https://elsewhere.example.com/mcp' },
        'invalid_target',
      ],
    ])('refuses a %s other than the code’s', async (_name, extra, error) => {
      const code = await consent();
      expectRefusal(await exchange(code, extra), error);
    });

    it('refuses a code consented for another resource, burning it', async () => {
      const code = await consent({ resource: 'https://old.example.com/mcp' });
      expectRefusal(await exchange(code), 'invalid_target');
      expectRefusal(await exchange(code), 'invalid_grant');
    });

    it('refuses at the cap with Agent Access full, burning the code', async () => {
      const code = await consent();
      await staticTokens(MAX_ACTIVE_TOKENS);
      const res = await exchange(code);
      expectRefusal(res, 'invalid_grant');
      expect(
        res.json<{ error_description: string }>().error_description,
      ).toMatch(/Agent Access is full/);
      expectRefusal(await exchange(code), 'invalid_grant');
    });

    it('replaces the same client’s grant on a reconnect, only once the cap allows the mint', async () => {
      const old = await connect();
      await staticTokens(MAX_ACTIVE_TOKENS - 1);
      // At the cap with its own grant: the reconnect replaces it.
      const again = await connect();
      expect((await grantOf(old.access_token)).revokedAt).not.toBeNull();
      expect(await opens(again.access_token)).toBe(200);
      expect(t.logs.ops('oauth.grant.minted').at(-1)).toMatchObject({
        replacedIds: [(await grantOf(old.access_token)).id],
      });

      // Past it even without the grant: refused, and the grant stands.
      const code = await consent();
      await staticTokens(1);
      expectRefusal(await exchange(code), 'invalid_grant');
      expect((await grantOf(again.access_token)).revokedAt).toBeNull();
      issued(await refresh(again.refresh_token));
    });
    it('leaves a grant idle past its days out of the cap, and Agent Access says it expired', async () => {
      const idle = await connect();
      await t.db
        .update(personalAccessToken)
        .set({
          lastUsedAt: new Date(Date.now() - (OAUTH_IDLE_DAYS + 1) * DAY_MS),
        })
        .where(eq(personalAccessToken.tokenHash, hashToken(idle.access_token)));
      await staticTokens(MAX_ACTIVE_TOKENS - 1);
      // Another client's consent replaces nothing: only the idle grant
      // leaving the count makes room.
      clientId = `${clientId}?second`;
      const fresh = await connect();
      expect(await opens(fresh.access_token)).toBe(200);
      // Not revoked by the mint: listed, as expired, until revoked by hand.
      expect((await grantOf(idle.access_token)).revokedAt).toBeNull();
      const page = await t.inject({
        method: 'GET',
        url: '/auth/tokens',
        headers: { cookie },
      });
      expect(page.statusCode).toBe(200);
      expect(
        page.body.split(`expired: unused for ${OAUTH_IDLE_DAYS} days`),
      ).toHaveLength(2);
    });
  });

  describe('the refresh grant', () => {
    it('rotates both tokens in one statement: the old access token dies, the family grows', async () => {
      const first = await connect();
      const { id } = await grantOf(first.access_token);
      const second = issued(await refresh(first.refresh_token));
      expect(second.access_token).not.toBe(first.access_token);
      expect(second.refresh_token).not.toBe(first.refresh_token);
      expect(second.scope).toBe('closet:read');
      const res = await mcpRequest(
        t,
        first.access_token,
        'tools/list',
        {},
        uniqueClient(),
      );
      expect(res.statusCode).toBe(401);
      expect(await opens(second.access_token)).toBe(200);
      const family = await t.db
        .select({ hash: oauthRetiredRefreshToken.refreshTokenHash })
        .from(oauthRetiredRefreshToken)
        .where(eq(oauthRetiredRefreshToken.tokenId, id));
      expect(family).toEqual([{ hash: hashToken(first.refresh_token) }]);
      expect((await grantById(id)).revokedAt).toBeNull();
    });

    it.each([
      ['N-1', 1],
      ['N-2', 2],
    ])(
      'revokes the whole grant when generation %s comes again',
      async (_name, back) => {
        const generations = [await connect()];
        for (let n = 0; n < 2; n += 1) {
          generations.push(
            issued(await refresh(generations.at(-1)!.refresh_token)),
          );
        }
        const current = generations.at(-1)!;
        const { id } = await grantOf(current.access_token);
        const reused = generations[generations.length - 1 - back];
        expectRefusal(await refresh(reused.refresh_token), 'invalid_grant');
        expect((await grantById(id)).revokedAt).not.toBeNull();
        expect(await opens(current.access_token)).toBe(401);
        expectRefusal(await refresh(current.refresh_token), 'invalid_grant');
        expect(t.logs.messages('warn', 'OAuth')).toContain(
          `OAuth refresh token reused: grant ${id} revoked`,
        );
      },
    );

    it('counts two refreshes racing on one token as reuse: one answer, then the grant revoked (interleaved)', async () => {
      const first = await connect();
      const { id } = await grantOf(first.access_token);
      const [winner, loser] = await interleave(
        t.db,
        (tx) =>
          refreshGrant(
            { db: tx, logger: t.logger },
            { refreshToken: first.refresh_token, clientId },
          ),
        () => refresh(first.refresh_token),
      );
      if (!winner.granted) throw new Error('the first refresh was refused');
      secrets.push(winner.tokens.accessToken, winner.tokens.refreshToken);
      expectRefusal(loser, 'invalid_grant');
      expect((await grantById(id)).revokedAt).not.toBeNull();
      expect(await opens(winner.tokens.accessToken)).toBe(401);
    });

    it('refuses a grant revoked on Agent Access', async () => {
      const first = await connect();
      const { id } = await grantOf(first.access_token);
      const revoke = await t.inject({
        method: 'POST',
        url: `/auth/tokens/${id}/revoke`,
        headers: { cookie },
      });
      expect(revoke.statusCode).toBe(303);
      expectRefusal(await refresh(first.refresh_token), 'invalid_grant');
    });

    it(`keeps a grant used ${OAUTH_IDLE_DAYS - 1} days ago and refuses one idle ${OAUTH_IDLE_DAYS + 1}, at refresh and at /mcp alike`, async () => {
      const first = await connect();
      const { id } = await grantOf(first.access_token);
      const lastUsed = (days: number) =>
        t.db
          .update(personalAccessToken)
          .set({ lastUsedAt: new Date(Date.now() - days * DAY_MS) })
          .where(eq(personalAccessToken.id, id));
      await lastUsed(OAUTH_IDLE_DAYS - 1);
      const second = issued(await refresh(first.refresh_token));
      await lastUsed(OAUTH_IDLE_DAYS + 1);
      expect(await opens(second.access_token)).toBe(401);
      expectRefusal(await refresh(second.refresh_token), 'invalid_grant');
      // Refused, not revoked: idle is judged where it is read.
      expect((await grantById(id)).revokedAt).toBeNull();
    });

    it('survives Sign out everywhere: a grant is no sign-in (sv)', async () => {
      const first = await connect();
      const res = await t.inject({
        method: 'POST',
        url: SIGN_OUT_EVERYWHERE_PATH,
        headers: { cookie },
        payload: { currentPassword: TEST_PASSWORD },
      });
      expect(res.statusCode).toBeLessThan(400);
      issued(await refresh(first.refresh_token));
    });

    it('ends with a new password, as every token does', async () => {
      const first = await connect();
      const code = await consent();
      const res = await t.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: { cookie },
        payload: {
          currentPassword: TEST_PASSWORD,
          newPassword: 'Another-password-456!',
          confirmPassword: 'Another-password-456!',
        },
      });
      expect(res.statusCode).toBeLessThan(400);
      expectRefusal(await refresh(first.refresh_token), 'invalid_grant');
      expect(await opens(first.access_token)).toBe(401);
      // A code written under the old password mints nothing.
      expectRefusal(await exchange(code), 'invalid_grant');
    });

    it('refuses a refresh token of another client without touching the grant', async () => {
      const first = await connect();
      expectRefusal(
        await refresh(first.refresh_token, {
          client_id: 'https://claude.ai/oauth/other.json',
        }),
        'invalid_grant',
      );
      issued(await refresh(first.refresh_token));
    });

    it('refuses a resource other than MCP_PUBLIC_URL, and takes none', async () => {
      const first = await connect();
      expectRefusal(
        await refresh(first.refresh_token, {
          resource: 'https://elsewhere.example.com/mcp',
        }),
        'invalid_target',
      );
      const second = issued(
        await refresh(first.refresh_token, { resource: RESOURCE }),
      );
      issued(await refresh(second.refresh_token));
    });

    it('requires client_id', async () => {
      const first = await connect();
      expectRefusal(
        await post({
          grant_type: 'refresh_token',
          refresh_token: first.refresh_token,
        }),
        'invalid_request',
      );
    });
  });

  describe('the access token at /mcp', () => {
    it('answers an expired one with the 401 that says invalid_token and points at the metadata', async () => {
      const first = await connect();
      await t.db
        .update(personalAccessToken)
        .set({ accessExpiresAt: new Date(Date.now() - 1000) })
        .where(
          eq(personalAccessToken.tokenHash, hashToken(first.access_token)),
        );
      const res = await mcpRequest(
        t,
        first.access_token,
        'tools/list',
        {},
        uniqueClient(),
      );
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe(
        `Bearer realm="closet", error="invalid_token", resource_metadata="${PRM_URL}", scope="closet:read closet:write"`,
      );
      // A request with no token says no error.
      const none = await mcpRequest(
        t,
        undefined,
        'tools/list',
        {},
        uniqueClient(),
      );
      expect(none.headers['www-authenticate']).not.toContain('error=');
      // And the refresh still works: the grant is in force.
      issued(await refresh(first.refresh_token));
    });

    it(`never charges an expired token to BEARER_REFUSAL_LIMIT`, async () => {
      const first = await connect();
      await t.db
        .update(personalAccessToken)
        .set({ accessExpiresAt: new Date(Date.now() - 1000) })
        .where(
          eq(personalAccessToken.tokenHash, hashToken(first.access_token)),
        );
      const client = uniqueClient();
      for (let n = 0; n <= BEARER_REFUSAL_LIMIT.max; n += 1) {
        const res = await mcpRequest(
          t,
          first.access_token,
          'tools/list',
          {},
          client,
        );
        expect(res.statusCode).toBe(401);
      }
      // The budget is whole: a tokenless refusal is still the 401, not the 429.
      expect(
        (await mcpRequest(t, undefined, 'tools/list', {}, client)).statusCode,
      ).toBe(401);
    });

    it('logs an address stuck on an expired token once per window, the rest as one summary (#940)', async () => {
      const first = await connect();
      await t.db
        .update(personalAccessToken)
        .set({ accessExpiresAt: new Date(Date.now() - 1000) })
        .where(
          eq(personalAccessToken.tokenHash, hashToken(first.access_token)),
        );
      const client = uniqueClient();
      const address = client['x-forwarded-for'];
      const expired = async () =>
        expect(
          (await mcpRequest(t, first.access_token, 'tools/list', {}, client))
            .statusCode,
        ).toBe(401);
      const linesOf = () =>
        t.logs.records
          .map((record) => record.msg)
          .filter((msg) => msg.split(' ').includes(address));
      const own = `MCP POST /mcp refused: expired token from ${address}`;
      for (let n = 0; n < 10; n += 1) await expired();
      expect(linesOf()).toEqual([own]);

      // The next window's first writes the last one's summary and its own line.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() + 2 * BEARER_REFUSAL_LIMIT.timeWindow);
        await expired();
      } finally {
        vi.useRealTimers();
      }
      expect(linesOf()).toEqual([
        own,
        `9 further credential refusals from ${address} not logged one by one (expired token x9)`,
        own,
      ]);
    });

    it('never idles a static agent token out', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/auth/tokens',
        headers: { cookie },
        payload: { name: 'Static', currentPassword: TEST_PASSWORD },
      });
      const token = /closet_[\w-]{43}/.exec(res.body)?.[0];
      if (!token) throw new Error('no token on the page');
      secrets.push(token);
      await t.db
        .update(personalAccessToken)
        .set({
          lastUsedAt: new Date(Date.now() - (OAUTH_IDLE_DAYS + 1) * DAY_MS),
        })
        .where(eq(personalAccessToken.tokenHash, hashToken(token)));
      expect(await opens(token)).toBe(200);
    });
  });

  describe('the request', () => {
    it('refuses a JSON body, a repeated parameter, a missing or unknown grant type', async () => {
      const code = await consent();
      const json = await t.inject({
        method: 'POST',
        url: '/oauth/token',
        anonymous: true,
        sameOrigin: false,
        headers: { 'content-type': 'application/json', ...uniqueClient() },
        payload: {
          grant_type: 'authorization_code',
          code,
          code_verifier: VERIFIER,
          redirect_uri: CALLBACK,
          client_id: clientId,
          resource: RESOURCE,
        },
      });
      expectRefusal(json, 'invalid_request');
      expectRefusal(
        await exchange(code, { client_id: [clientId, clientId] }),
        'invalid_request',
      );
      expectRefusal(await post({ code }), 'invalid_request');
      expectRefusal(
        await post({ grant_type: 'password' }),
        'unsupported_grant_type',
      );
      // None of those touched the code.
      issued(await exchange(code));
    });

    it('refuses client authentication: a public client sends client_id alone', async () => {
      const code = await consent();
      const basic = await exchange(
        code,
        {},
        {
          headers: {
            authorization: `Basic ${Buffer.from(`${clientId}:secret`).toString('base64')}`,
          },
        },
      );
      expectRefusal(basic, 'invalid_client', 401);
      expect(basic.headers['www-authenticate']).toBe('Basic realm="closet"');
      const secret = await exchange(code, { client_secret: 'secret' });
      expectRefusal(secret, 'invalid_client', 401);
      expect(secret.headers['www-authenticate']).toBeUndefined();
      issued(await exchange(code));
    });

    it.each(['client_id', 'redirect_uri', 'code', 'refresh_token'])(
      'refuses a control character in %s before any statement, never a 500',
      async (field) => {
        const code = await consent();
        const fields: Record<string, string> =
          field === 'refresh_token'
            ? {
                grant_type: 'refresh_token',
                refresh_token: 'closet_rt_a',
                client_id: clientId,
              }
            : {
                grant_type: 'authorization_code',
                code,
                code_verifier: VERIFIER,
                redirect_uri: CALLBACK,
                client_id: clientId,
                resource: RESOURCE,
              };
        fields[field] = `${fields[field]}\u0000b`;
        expectRefusal(await post(fields), 'invalid_request');
      },
    );

    it('answers a body past the limit as JSON invalid_request', async () => {
      const res = await post({
        grant_type: 'refresh_token',
        pad: 'a'.repeat(9000),
      });
      expect(res.statusCode).toBe(413);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expectNoStore(res);
      expect(res.json()).toMatchObject({ error: 'invalid_request' });
    });

    it(`charges only refusals to OAUTH_TOKEN_LIMIT; past it a stranger's is the 429, a known grant's still invalid_grant`, async () => {
      const client = uniqueClient();
      let tokens = await connect();
      // Refreshes that open never count.
      for (let n = 0; n <= OAUTH_TOKEN_LIMIT.max; n += 1) {
        tokens = issued(await refresh(tokens.refresh_token, {}, { client }));
      }
      for (let n = 0; n < OAUTH_TOKEN_LIMIT.max; n += 1) {
        expectRefusal(
          await refresh(`closet_rt_unknown${n}`, {}, { client }),
          'invalid_grant',
        );
      }
      const throttled = await refresh('closet_rt_unknown', {}, { client });
      expect(throttled.statusCode).toBe(429);
      expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);
      expectNoStore(throttled);
      // A revoked grant's client still learns to reconnect.
      const { id } = await grantOf(tokens.access_token);
      await t.db
        .update(personalAccessToken)
        .set({ revokedAt: new Date() })
        .where(eq(personalAccessToken.id, id));
      expectRefusal(
        await refresh(tokens.refresh_token, {}, { client }),
        'invalid_grant',
      );
    });
  });

  it('locks the account before the code: an exchange racing its deletion never deadlocks (interleaved)', async () => {
    const code = await consent();
    let holder!: number;
    let exchanging!: Promise<LightMyRequestResponse>;
    // A third transaction holds the account, so the deletion queues on it
    // first and the exchange behind: the deletion then takes the user row
    // and cascades into the code, which an exchange that claimed the code
    // before the account would hold (40P01, one side's 500).
    const [, deleted] = await interleave(
      t.db,
      async (tx) => {
        holder = await backendPid(tx);
        await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.id, userId))
          .for('update');
      },
      () =>
        t.inject({
          method: 'POST',
          url: '/auth/delete-account',
          headers: { cookie },
          payload: { email, password: TEST_PASSWORD },
        }),
      async () => {
        exchanging = exchange(code);
        await waitForBlockedOn(t.db, holder, 2);
      },
    );
    expect(deleted.statusCode).toBeLessThan(400);
    expectRefusal(await exchanging, 'invalid_grant');
    expect(
      await t.db
        .select({ id: personalAccessToken.id })
        .from(personalAccessToken)
        .where(eq(personalAccessToken.userId, userId)),
    ).toEqual([]);
  });

  it('deletes an account with a live grant, its family and an unused code, cascading every key', async () => {
    const first = await connect();
    const second = issued(await refresh(first.refresh_token));
    const { id } = await grantOf(second.access_token);
    await consent();
    const res = await t.inject({
      method: 'POST',
      url: '/auth/delete-account',
      headers: { cookie },
      payload: { email, password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBeLessThan(400);
    expect(
      await t.db
        .select({ id: oauthAuthorizationCode.id })
        .from(oauthAuthorizationCode)
        .where(eq(oauthAuthorizationCode.userId, userId)),
    ).toEqual([]);
    expect(
      await t.db
        .select({ id: oauthRetiredRefreshToken.id })
        .from(oauthRetiredRefreshToken)
        .where(eq(oauthRetiredRefreshToken.tokenId, id)),
    ).toEqual([]);
    expect(await grantById(id)).toBeUndefined();
    expect(await opens(second.access_token)).toBe(401);
    expectRefusal(await refresh(second.refresh_token), 'invalid_grant');
  });

  it('prunes nightly the families of revoked grants only', async () => {
    const familyOf = async (accessToken: string) => {
      const { id } = await grantOf(accessToken);
      return t.db
        .select({ id: oauthRetiredRefreshToken.id })
        .from(oauthRetiredRefreshToken)
        .where(eq(oauthRetiredRefreshToken.tokenId, id));
    };
    const doomed = await connect();
    const doomedNext = issued(await refresh(doomed.refresh_token));
    // Reuse revokes it.
    expectRefusal(await refresh(doomed.refresh_token), 'invalid_grant');
    // Another client of this user's, so this consent replaces nothing.
    clientId = `${clientId}?second`;
    const kept = issued(await refresh((await connect()).refresh_token));
    expect(await familyOf(doomedNext.access_token)).toHaveLength(1);
    expect(
      await pruneRetiredRefreshTokens({ db: t.db, logger: t.logger }),
    ).toBeGreaterThanOrEqual(1);
    expect(await familyOf(doomedNext.access_token)).toEqual([]);
    expect(await familyOf(kept.access_token)).toHaveLength(1);
  });

  it('logs no code, token, verifier or challenge, in any line of this spec', async () => {
    // A last refusal and grant, so this test has lines of its own too.
    const code = await consent();
    issued(await exchange(code));
    expectRefusal(await exchange(code), 'invalid_grant');
    const logged = JSON.stringify(t.logs.records);
    for (const secret of secrets) {
      // The random part: `closet_` alone is in many lines.
      expect(logged).not.toContain(secret.slice(-24));
    }
  });
});
