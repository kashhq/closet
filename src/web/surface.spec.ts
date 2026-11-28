import type { RouteOptions } from 'fastify';
import { describe, expect, it } from 'vitest';
import { assignSurface, surfaceOf } from './surface';

const route = (url: string, config?: RouteOptions['config']) =>
  ({ method: 'GET', url, handler: () => undefined, config }) as RouteOptions;

describe('assignSurface', () => {
  it.each(['/api/v1', '/api/v1/me', '/api/v1/auth/token'])(
    'stamps %s as the api surface',
    (url) => {
      const options = route(url, { public: true });
      assignSurface(options);
      expect(options.config).toEqual({ public: true, surface: 'api' });
    },
  );

  it('leaves a page and /mcp as they say', () => {
    const page = route('/wardrobe');
    const mcp = route('/mcp', { surface: 'mcp' });
    assignSurface(page);
    assignSurface(mcp);
    expect(page.config).toBeUndefined();
    expect(mcp.config).toEqual({ surface: 'mcp' });
  });

  it.each([
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
    '/oauth/token',
  ])('lets %s be the oauth surface', (url) => {
    const options = route(url, { surface: 'oauth' });
    assignSurface(options);
    expect(options.config).toEqual({ surface: 'oauth' });
  });

  it.each([
    ['an api route outside /api/v1', route('/wardrobe', { surface: 'api' })],
    ['another surface under /api/v1', route('/api/v1/me', { surface: 'mcp' })],
    ['a path under /api but not /api/v1', route('/api/v2/me')],
    ['/api itself', route('/api')],
    ['oauth on a page path', route('/wardrobe', { surface: 'oauth' })],
    [
      'oauth on the consent page, a page',
      route('/oauth/authorize', { surface: 'oauth' }),
    ],
    [
      'oauth on another well-known name',
      route('/.well-known/assetlinks.json', { surface: 'oauth' }),
    ],
  ])('stops the boot for %s', (_case, options) => {
    expect(() => assignSurface(options)).toThrow();
  });
});

describe('surfaceOf', () => {
  // The not-found handler's config, or the static files' `GET /*`: no
  // surface of their own.
  const unmatched = (url: string) => ({ url, routeOptions: { config: {} } });

  it.each(['/api', '/api/', '/api/v1/', '/API/v1/me', '/Api?x=1', '/api/v2'])(
    'calls the unmatched %s the api',
    (url) => {
      expect(surfaceOf(unmatched(url) as never)).toBe('api');
    },
  );

  it.each(['/apix', '/wardrobe', '/', '/x/api'])(
    'calls the unmatched %s a page',
    (url) => {
      expect(surfaceOf(unmatched(url) as never)).toBe('page');
    },
  );

  it("reads a matched route's own config, whatever the path", () => {
    expect(
      surfaceOf({
        url: '/mcp',
        routeOptions: { config: { surface: 'mcp' } },
      } as never),
    ).toBe('mcp');
  });
});
