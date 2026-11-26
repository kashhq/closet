import Fastify, { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_SCOPE } from '../auth/personal-tokens';
import { actorOf as toolActorOf } from '../mcp/tool';
import { type Actor, actorOf, rememberShareReadAhead } from './access';

/**
 * actorOf on real Fastify requests (no session hook here: each route sets
 * what the root preValidation hook would, src/web/auth/session.ts).
 */
describe('actorOf', () => {
  const app = Fastify();
  const signedIn = (request: FastifyRequest) => {
    request.auth = { user: { id: 7, email: 'a@example.com' } };
  };

  beforeAll(async () => {
    app.get('/own', (request): Actor => {
      signedIn(request);
      return actorOf(request);
    });
    app.get('/shared', (request): Actor => {
      signedIn(request);
      rememberShareReadAhead(request, { ownerId: 9, permission: 'VIEW' });
      return actorOf(request);
    });
    // The device token's user, on the API's surface: assignSurface stamps
    // /api/v1 routes in the app; surfaceOf answers the same from the path.
    app.get('/api/v1/me', (request): Actor => {
      request.accessToken = {
        user: { id: 8, email: 'b@example.com' },
        tokenId: 3,
        scope: FULL_SCOPE,
      };
      return actorOf(request);
    });
    app.get('/public', (request): Actor => actorOf(request));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('is the session user, without a read ahead on their own wardrobe', async () => {
    const res = await app.inject({ url: '/own' });
    expect(res.json()).toEqual({ userId: 7, surface: 'page' });
  });

  // The read ahead is what keeps a grantee's request at today's statements.
  it('carries the share the session statement read for this request', async () => {
    const res = await app.inject({ url: '/shared' });
    expect(res.json()).toEqual({
      userId: 7,
      surface: 'page',
      shareReadAhead: { ownerId: 9, permission: 'VIEW' },
    });
  });

  // The surface is what an action's log line names (#712, logOp).
  it("is the device token's user on the API, on the api surface", async () => {
    const res = await app.inject({ url: '/api/v1/me' });
    expect(res.json()).toEqual({ userId: 8, surface: 'api' });
  });

  it('refuses a request without a session, as sessionUserId does', async () => {
    const res = await app.inject({ url: '/public' });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ message: string }>().message).toContain(
      'which has no session',
    );
  });

  it("is the token's user for an MCP tool, never with a read ahead", () => {
    expect(toolActorOf({ userId: 7, scope: FULL_SCOPE })).toEqual({
      userId: 7,
      surface: 'mcp',
    });
  });

  it('carries an own-wardrobe-only token’s scope, and only that (#701)', () => {
    expect(
      toolActorOf({
        userId: 7,
        scope: { readOnly: true, ownWardrobeOnly: true },
      }),
    ).toEqual({ userId: 7, surface: 'mcp', ownWardrobeOnly: true });
    expect(
      toolActorOf({
        userId: 7,
        scope: { readOnly: true, ownWardrobeOnly: false },
      }),
    ).toEqual({ userId: 7, surface: 'mcp' });
  });
});
