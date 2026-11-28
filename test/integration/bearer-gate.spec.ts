import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BEARER_REFUSAL_LIMIT,
  MCP_LIMIT,
} from '../../src/web/security/rate-limit';
import { deviceToken, expectProblem, signInDevice } from './api';
import { createTestApp, type TestApp, uniqueClient } from './harness';
import { createAccessToken, mcpRequest, mintToken } from './mcp';

/**
 * The bearer gate (#667, src/web/auth/bearer-gate.ts), the one credential
 * check of /mcp and /api: at onRequest, before the body is read, and every
 * refusal charged to one per-address budget the two surfaces share. Each
 * test takes its own client address (uniqueClient), so the budgets it
 * spends are its own.
 */

const UNKNOWN = `closet_${'A'.repeat(43)}`;

describe('the bearer gate', () => {
  let t: TestApp;
  let agent: string;
  let device: string;

  beforeAll(async () => {
    t = await createTestApp();
    agent = await createAccessToken(t);
    ({ token: device } = await deviceToken(t));
  });

  afterAll(async () => {
    await t.cleanup();
  });

  /** The request ids each client address's requests got, from `x-request-id`. */
  const requestIds = new Map<string, Set<string>>();
  const track = async (
    client: Record<string, string>,
    pending: Promise<LightMyRequestResponse>,
  ) => {
    const res = await pending;
    const address = client['x-forwarded-for'];
    const ids = requestIds.get(address) ?? new Set<string>();
    ids.add(String(res.headers['x-request-id']));
    requestIds.set(address, ids);
    return res;
  };

  /** /mcp's tools/list from `client`, presenting `token` if any. */
  const mcp = (client: Record<string, string>, token?: string) =>
    track(client, mcpRequest(t, token, 'tools/list', {}, client));

  /** /api's GET /me from `client`, presenting `token` if any. */
  const me = (client: Record<string, string>, token?: string) =>
    track(
      client,
      t.api(token, { method: 'GET', url: '/api/v1/me', headers: client }),
    );

  /** One refusal of each kind the budget throttles, turn about per surface. */
  const refused = (client: Record<string, string>, n: number) => {
    const headers: Record<string, string> = [
      {},
      { authorization: 'Token nope' },
      { authorization: `Bearer ${UNKNOWN}` },
    ][n % 3];
    const request = { ...client, ...headers };
    return track(
      client,
      n % 2
        ? mcpRequest(t, undefined, 'tools/list', {}, request)
        : t.api(undefined, {
            method: 'GET',
            url: '/api/v1/me',
            headers: request,
          }),
    );
  };

  /** Spends `client`'s whole refusal budget: every one a 401. */
  const exhaust = async (client: Record<string, string>) => {
    for (let n = 0; n < BEARER_REFUSAL_LIMIT.max; n += 1) {
      expect((await refused(client, n)).statusCode).toBe(401);
    }
  };

  /**
   * The warn lines written while serving `client`'s requests, by their
   * `request_id` (a line's text need not name the address). Every refusal also
   * writes the summaries of other addresses whose window has ended, under its
   * own request id, so a line naming another address is left out: an
   * assertion over all warn lines depends on how long the run took.
   */
  const warnsFrom = (client: Record<string, string>) => {
    const own = client['x-forwarded-for'];
    const ids = requestIds.get(own) ?? new Set<string>();
    return t.logs.records
      .filter(
        (record) =>
          record.level === 'warn' &&
          ids.has(String(record.request_id)) &&
          !(record.msg.match(/\b198\.18\.\d+\.\d+\b/g) ?? []).some(
            (address) => address !== own,
          ),
      )
      .map((record) => record.msg);
  };

  /** `presented`: a token was sent and refused, RFC 6750's invalid_token. */
  const expectMcp401 = (res: LightMyRequestResponse, presented = false) => {
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      presented
        ? 'Bearer realm="closet", error="invalid_token"'
        : 'Bearer realm="closet"',
    );
    expect(res.json()).toEqual({
      statusCode: 401,
      message: 'Unauthorized',
      request_id: res.headers['x-request-id'],
    });
  };

  it('refuses before the body is read: a body the parser rejects is the 401, not a 400', async () => {
    const malformed = (authorization?: string) =>
      t.inject({
        method: 'POST',
        url: '/mcp',
        anonymous: true,
        sameOrigin: false,
        headers: {
          ...uniqueClient(),
          'content-type': 'application/json',
          ...(authorization ? { authorization } : {}),
        },
        payload: '{"jsonrpc": "2.0", "method": ',
      });
    expectMcp401(await malformed());
    expectMcp401(await malformed(`Bearer ${UNKNOWN}`), true);
    // The same body with a token that opens reaches the parser.
    expect((await malformed(`Bearer ${agent}`)).statusCode).toBe(400);
  });

  it(`gives an address ${BEARER_REFUSAL_LIMIT.max} refusals a minute across both surfaces, then a 429 with Retry-After on each`, async () => {
    expect(BEARER_REFUSAL_LIMIT.max).toBe(30);
    const client = uniqueClient();
    await exhaust(client);

    const onMcp = await mcp(client);
    expect(onMcp.statusCode).toBe(429);
    expect(onMcp.headers['content-type']).toMatch(/^application\/json/);
    expect(Number(onMcp.headers['retry-after'])).toBeGreaterThan(0);
    expect(onMcp.json()).toMatchObject({ statusCode: 429 });

    const onApi = await me(client, UNKNOWN);
    expectProblem(onApi, 429, 'rate_limited');
    expect(Number(onApi.headers['retry-after'])).toBeGreaterThan(0);

    // The refusals past the budget are counted into a summary, not logged one by one.
    // The filter sees this client's lines: the budget's own, one each.
    expect(warnsFrom(client)).toHaveLength(BEARER_REFUSAL_LIMIT.max);
    expect(warnsFrom(client).join('\n')).not.toContain('Rate limit reached');
    // Another address has its own budget.
    expectMcp401(await mcp(uniqueClient()));
  });

  it('lets a valid token through from a throttled address, and still tells a revoked or other-kind one to sign in again', async () => {
    const client = uniqueClient();
    await exhaust(client);
    expect((await mcp(client)).statusCode).toBe(429);

    expect((await mcp(client, agent)).statusCode).toBe(200);
    expect((await me(client, device)).statusCode).toBe(200);

    // A device token on /mcp and an agent token on /api: the wrong kind.
    expectMcp401(await mcp(client, device), true);
    expectProblem(await me(client, agent), 401, 'unauthorized');

    // A device that signed out (its token revoked) learns to sign in again.
    const { token: signedOut } = await deviceToken(t, { deviceName: 'Old' });
    const signOut = await t.api(signedOut, {
      method: 'DELETE',
      url: '/api/v1/auth/token',
      headers: client,
    });
    expect(signOut.statusCode).toBe(204);
    const revoked = expectProblem(
      await me(client, signedOut),
      401,
      'unauthorized',
    );
    expect(revoked.detail).toMatch(/^Sign in again/);

    // Signing in is outside the gate: a throttled address still can.
    const signIn = await signInDevice(t, { deviceName: 'New', client });
    expect(signIn.statusCode, signIn.body).toBe(201);
  });

  it('charges a revoked or other-kind token to the budget', async () => {
    const client = uniqueClient();
    const minted = await mintToken(t, t.owner.id, 'Phone', 'device');
    if (!minted.created) throw new Error('no device token');
    for (let n = 0; n < BEARER_REFUSAL_LIMIT.max; n += 1) {
      expectMcp401(await mcp(client, minted.token), true);
    }
    expect((await mcp(client)).statusCode).toBe(429);
  });

  it('answers refusals past the budget as before but logs them as one summary (#940)', async () => {
    const client = uniqueClient();
    const address = client['x-forwarded-for'];
    const minted = await mintToken(t, t.owner.id, 'Phone', 'device');
    if (!minted.created) throw new Error('no device token');
    const lines = () => warnsFrom(client);
    t.logs.clear();
    for (let n = 0; n < 50; n += 1) {
      expectMcp401(await mcp(client, minted.token), true);
    }
    // The budget's lines, each its own; the rest are counted, not written.
    expect(lines()).toHaveLength(BEARER_REFUSAL_LIMIT.max);

    // The next window's first refusal writes the last one's summary.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 2 * BEARER_REFUSAL_LIMIT.timeWindow);
      expectMcp401(await mcp(client, minted.token), true);
    } finally {
      vi.useRealTimers();
    }
    const over = 50 - BEARER_REFUSAL_LIMIT.max;
    expect(
      lines().filter((line) => line.includes('further credential')),
    ).toEqual([
      `${over} further credential refusals from ${address} not logged one by one (wrong kind of token (wants mcp) x${over})`,
    ]);
    // The summary, and the new window's first refusal as a line of its own.
    expect(lines()).toHaveLength(BEARER_REFUSAL_LIMIT.max + 2);
  });

  it('counts a throttled unknown credential in the summary too, still a 429', async () => {
    const client = uniqueClient();
    await exhaust(client);
    // Control: the filter sees this client's under-budget refusal lines.
    expect(warnsFrom(client)).toHaveLength(BEARER_REFUSAL_LIMIT.max);
    t.logs.clear();
    for (let n = 0; n < 5; n += 1) {
      expect((await mcp(client)).statusCode).toBe(429);
    }
    expect(warnsFrom(client)).toEqual([]);
  });

  it("does not count another address's summary, due once its window ends, as this address's line (#943)", async () => {
    const window = BEARER_REFUSAL_LIMIT.timeWindow;
    const earlier = uniqueClient();
    const client = uniqueClient();
    await exhaust(earlier);
    for (let n = 0; n < 5; n += 1) {
      expect((await mcp(earlier)).statusCode).toBe(429);
    }

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // This address's window opens half a window later than the earlier one's.
      vi.setSystemTime(Date.now() + window / 2);
      await exhaust(client);
      expect(warnsFrom(client)).toHaveLength(BEARER_REFUSAL_LIMIT.max);
      t.logs.clear();
      // The earlier window has ended and this one has not: the first refusal
      // below writes the earlier address's summary.
      vi.setSystemTime(Date.now() + (window * 7) / 10);
      for (let n = 0; n < 5; n += 1) {
        expect((await mcp(client)).statusCode).toBe(429);
      }
      expect(
        t.logs
          .messages('warn')
          .some((line) => line.includes(earlier['x-forwarded-for'])),
      ).toBe(true);
      expect(warnsFrom(client)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never resets the count on a token that opens', async () => {
    const client = uniqueClient();
    for (let n = 0; n < BEARER_REFUSAL_LIMIT.max - 1; n += 1) {
      expect((await refused(client, n)).statusCode).toBe(401);
    }
    for (let n = 0; n < 3; n += 1) {
      expect((await mcp(client, agent)).statusCode).toBe(200);
      expect((await me(client, device)).statusCode).toBe(200);
    }
    expectMcp401(await mcp(client));
    expect((await mcp(client)).statusCode).toBe(429);
  });

  it('leaves an unknown /api path and an unknown /mcp method a 404, never counted', async () => {
    const client = uniqueClient();
    for (let n = 0; n <= BEARER_REFUSAL_LIMIT.max; n += 1) {
      const unknownPath = await t.api(undefined, {
        method: 'GET',
        url: '/api/v1/nope',
        headers: client,
      });
      expectProblem(unknownPath, 404, 'not_found');
      for (const method of ['PUT', 'OPTIONS'] as const) {
        // The same-origin check still asks a PUT for its Origin (an
        // unmatched /mcp is no bearer surface), so the harness sends one.
        const res = await t.inject({
          method,
          url: '/mcp',
          anonymous: true,
          headers: client,
        });
        expect(res.statusCode).toBe(404);
      }
    }
    expectMcp401(await mcp(client));
  });

  it('answers a wrong password at the API sign-in with WWW-Authenticate, as before', async () => {
    const res = await signInDevice(t, { password: 'not-the-password' });
    const problem = expectProblem(res, 401, 'unauthorized');
    expect(problem.detail).toBe('Incorrect email or password');
    expect(res.headers['www-authenticate']).toBe('Bearer realm="closet"');
  });

  describe('a JSON-RPC batch', () => {
    let packer: string;

    beforeAll(async () => {
      packer = await createAccessToken(t, { name: 'Packer' });
    });

    const batch = (size: number) =>
      t.inject({
        method: 'POST',
        url: '/mcp',
        anonymous: true,
        sameOrigin: false,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${packer}`,
        },
        payload: Array.from({ length: size }, (_, n) => ({
          jsonrpc: '2.0',
          id: n + 1,
          method: 'tools/call',
          params: { name: 'wardrobe_stats', arguments: {} },
        })),
      });

    it('is refused before the SDK: a JSON-RPC error, no tool run', async () => {
      t.logs.clear();
      const res = await batch(2);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'Batches are not supported: send one message per request.',
        },
        id: null,
      });
      expect(t.logs.messages('info', 'Mcp')).toEqual([]);
      expect(t.logs.messages('warn', 'Mcp')).toEqual([
        expect.stringMatching(
          /^MCP batch of 2 refused for user \d+ \(token \d+\)$/,
        ),
      ]);
    });

    it(`meets MCP_LIMIT at ${MCP_LIMIT.max + 1} calls however they are packed`, async () => {
      // The first test's batch spent one request of the minute.
      for (let call = 1; call < MCP_LIMIT.max - 1; call += 1) {
        const res = await mcpRequest(t, packer, 'tools/call', {
          name: 'wardrobe_stats',
          arguments: {},
        });
        expect(res.statusCode, res.body).toBe(200);
      }
      expect((await batch(100)).statusCode).toBe(400);
      expect(
        (
          await mcpRequest(t, packer, 'tools/call', {
            name: 'wardrobe_stats',
            arguments: {},
          })
        ).statusCode,
      ).toBe(429);
    });
  });
});
