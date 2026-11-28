import Fastify, { type RouteOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureLogs } from '../../../test/support/log-capture';
import { assignSurface } from '../surface';
import {
  assertStatelessRoute,
  createSameOriginHook,
  STATELESS_ROUTES,
} from './same-origin';

const route = (
  method: string | string[],
  url: string,
  config?: RouteOptions['config'],
) => ({ method, url, handler: () => undefined, config }) as RouteOptions;

// `stateless` is the same-origin hook's one exemption for pages (a post with
// no Origin): a CSRF exemption, so the list is reviewed entry by entry and
// any other route that claims it stops the boot.
describe('assertStatelessRoute', () => {
  it('lists only the share target', () => {
    expect([...STATELESS_ROUTES]).toEqual(['POST /inspiration/share']);
  });

  it('lets the share target say stateless, and any route not say it', () => {
    expect(() =>
      assertStatelessRoute(
        route('POST', '/inspiration/share', { stateless: true }),
      ),
    ).not.toThrow();
    expect(() =>
      assertStatelessRoute(route('POST', '/inspiration')),
    ).not.toThrow();
  });

  it.each([
    ['another route', route('POST', '/inspiration', { stateless: true })],
    [
      'another method on the share path',
      route('PUT', '/inspiration/share', { stateless: true }),
    ],
    [
      'a method list with one outside',
      route(['POST', 'DELETE'], '/inspiration/share', { stateless: true }),
    ],
  ])('stops the boot for %s', (_case, options) => {
    expect(() => assertStatelessRoute(options)).toThrow(/STATELESS_ROUTES/);
  });
});

// The token endpoint (#1291) is called server to server, so the `oauth`
// surface takes a POST with no Origin as /mcp does, and answers a foreign
// one as OAuth clients read errors.
describe('createSameOriginHook on the oauth surface', () => {
  const app = Fastify();

  beforeAll(async () => {
    app.addHook('onRoute', assignSurface);
    app.addHook(
      'onRequest',
      createSameOriginHook({
        siteUrl: 'https://closet.example',
        logger: captureLogs().logger,
      }),
    );
    app.post('/oauth/token', { config: { surface: 'oauth' } }, () =>
      Promise.resolve({ ok: true }),
    );
    await app.ready();
  });

  afterAll(() => app.close());

  const post = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/oauth/token', headers });

  it('passes a POST with no Origin', async () => {
    expect((await post({})).statusCode).toBe(200);
  });

  it('refuses a foreign Origin with an OAuth error body', async () => {
    const res = await post({ origin: 'https://evil.test' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: 'forbidden',
      error_description: 'Cross-origin request refused',
    });
  });
});
