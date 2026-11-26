import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestApp } from './harness';
import { expectFullPage, pageTitle } from './pages';

/**
 * The web layer (src/web/) inside the real app: the session gate on `GET /`
 * and the public shell routes, pages in the shared shell, the 404 page, and
 * the request log.
 */
describe('web layer', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  describe('session hook on a protected route (GET /)', () => {
    it('lets a signed-in request through to the handler', async () => {
      const res = await t.inject({ method: 'GET', url: '/' });
      // Today (#15).
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
    });

    it('redirects an anonymous page navigation to the login page, without warn logs', async () => {
      t.logs.clear();
      const res = await t.inject({
        method: 'GET',
        url: '/',
        headers: { 'sec-fetch-mode': 'navigate' },
        anonymous: true,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/auth/login');
      expect(t.logs.messages('warn')).toEqual([]);
      expect(t.logs.messages('error')).toEqual([]);
    });

    it.each([
      ['an htmx fragment request', { 'hx-request': 'true' }],
      ['a fetch', { 'sec-fetch-mode': 'cors' }],
    ])(
      'answers %s without a session with a bodiless 401 and HX-Redirect',
      async (_label, headers) => {
        const res = await t.inject({
          method: 'GET',
          url: '/',
          headers,
          anonymous: true,
        });
        expect(res.statusCode).toBe(401);
        expect(res.headers['hx-redirect']).toBe('/auth/login');
        expect(res.headers.location).toBeUndefined();
        expect(res.body).toBe('');
      },
    );
  });

  describe('a path no route matches', () => {
    it('is the 404 error page in the shell, with the session', async () => {
      const res = await t.inject({ method: 'GET', url: '/no-such-page?x=1' });
      expect(res.statusCode).toBe(404);
      expectFullPage(res);
      expect(pageTitle(res.body)).toBe('Not found');
      expect(res.body).toContain('>There is no page at this address</p>');
      // The avatar: the account's initial, opening Profile.
      expect(res.body).toContain('<a href="/auth/profile" id="avatar"');
      expect(res.body).toContain('<nav class="dock"');
    });

    it('is the 404 page signed out too, not a login redirect', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/no-such-page',
        anonymous: true,
      });
      expect(res.statusCode).toBe(404);
      expect(pageTitle(res.body)).toBe('Not found');
      expect(res.body).toContain('href="/auth/login"');
      expect(res.body).not.toContain('id="avatar"');
    });

    it('answers a missing static asset as data', async () => {
      const res = await t.inject({ method: 'GET', url: '/assets/nope.png' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.json()).toMatchObject({ statusCode: 404 });
    });
  });

  describe('public pages', () => {
    it('renders /about in the shell for an anonymous visitor', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/about',
        anonymous: true,
      });
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      expect(res.body).toContain('<title>About</title>');
      expect(pageTitle(res.body)).toBe('About Closet');
      // The link to the source is the one raw-HTML string on the page.
      expect(res.body).toContain(
        '<a href="https://github.com/kashhq/closet" class="link"',
      );
      expect(res.body).toContain('href="/auth/login"');
      expect(res.body).toContain('id="connectivity-banner"');
      expect(res.body).toMatch(/<body[^>]*hx-inherit="hx-boost hx-indicator"/);
      // Security headers come from the root onSend hook.
      expect(res.headers['x-frame-options']).toBe('DENY');
    });

    it('says the page was not saved and links the cached tab roots', async () => {
      const res = await t.inject({ method: 'GET', url: '/offline.html' });
      expect(res.body).toContain('t saved on this device');
      expect(res.body).toContain('data-offline-fallback');
      for (const root of ['/wardrobe', '/styling', '/outfits', '/calendar']) {
        expect(res.body).toContain(`<a href="${root}" class="btn">`);
      }
    });

    it('shows the signed-in account as the avatar, which opens Profile', async () => {
      const res = await t.inject({ method: 'GET', url: '/offline.html' });
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      expect(res.body).toMatch(
        /<a href="\/auth\/profile" id="avatar" class="[^"]*" aria-label="Profile">/,
      );
      // owner@example.com: its initial, never the address, in the bar.
      expect(res.body).toMatch(/aria-hidden="true">O<\/span>/);
      expect(res.body).not.toContain(t.owner.email);
      // Signing out lives in Profile now: no page but Profile carries it.
      expect(res.body).not.toContain('logout');
    });
  });

  it('logs each page request once, and not the health endpoints', async () => {
    t.logs.clear();
    await t.inject({ method: 'GET', url: '/about' });
    await t.inject({ method: 'GET', url: '/health/live' });
    await t.inject({ method: 'GET', url: '/health/ready' });
    const lines = t.logs.messages('info', 'Http');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^GET \/about 200 \d+\.\dms$/);
  });

  it('logs a 404 like any other request', async () => {
    t.logs.clear();
    await t.inject({ method: 'GET', url: '/no-such-page' });
    expect(t.logs.messages('info', 'Http')).toEqual([
      expect.stringMatching(/^GET \/no-such-page 404 \d+\.\dms$/),
    ]);
  });
});
