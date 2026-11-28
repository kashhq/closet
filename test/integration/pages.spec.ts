import { loginUrl } from '../../src/web/auth/return-to';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostForm } from '../../src/web/form';
import { renderToString } from '../../src/web/render';
import { createTestApp, TestApp } from './harness';
import {
  createPageFixture,
  expectFormPageFlag,
  expectFragment,
  expectFullPage,
  HX_BOOSTED,
  HX_FRAGMENT,
  misannouncedSessionForms,
  offlineUnguardedPostForms,
  PageFixture,
  PageRoute,
  pageRoutes,
  SESSION_BOUNDARY_ACTIONS,
} from './pages';

/**
 * Every GET page renders for the signed-in default user: status 200, a whole
 * document with one htmx-config meta and no untranslated `lang.` key, the
 * full page again for boosted navigations, and bare fragments for the routes
 * htmx swaps into a page. Plus what an anonymous visitor gets: the public
 * pages, and a login redirect for everything else.
 */
describe('pages', () => {
  let t: TestApp;
  let fixture: PageFixture;
  let inviteToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    fixture = await createPageFixture(t);

    const invite = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission: 'VIEW' },
      headers: HX_FRAGMENT,
    });
    expect(invite.statusCode).toBeLessThan(300);
    expectFragment(invite);
    const match = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(invite.body);
    if (!match) throw new Error(`No invite URL in partial:\n${invite.body}`);
    inviteToken = match[1];
  });

  afterAll(() => t?.cleanup());

  // A getter: the table needs the fixture, which only exists after beforeAll.
  const routes = (): PageRoute[] => pageRoutes(fixture, inviteToken);

  it('renders every page route for a signed-in user', async () => {
    // expectFullPage holds every PostForm to the offline guard; the count
    // proves the table reaches the forms (the account, token, link import,
    // laundry, sharing and styling ones were unguarded before #411's default).
    let postForms = 0;
    // expectFullPage also holds the sign-in and sign-out forms to their
    // data-ends-session mark (#542); this proves the table reaches all four.
    const announced = new Set<string>();
    for (const route of routes()) {
      const { url } = route;
      const res = await t.inject({ method: 'GET', url });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
      expectFullPage(res);
      expectFormPageFlag(route, res);
      postForms +=
        res.body.match(/<form\b[^>]*data-submit-once=/g)?.length ?? 0;
      for (const [, action] of res.body.matchAll(
        /<form\b[^>]*\baction="([^"]*)"[^>]*\bdata-ends-session=/g,
      )) {
        announced.add(action);
      }
    }
    expect(postForms).toBeGreaterThan(40);
    expect([...announced].sort()).toEqual([...SESSION_BOUNDARY_ACTIONS].sort());
  });

  it('a form posting elsewhere with the session mark is what the check catches', async () => {
    const signIn = await renderToString(
      PostForm({ action: '/auth/login', endsSession: true }),
    );
    expect(misannouncedSessionForms(signIn)).toEqual([]);
    expect(
      misannouncedSessionForms(signIn.replace(' data-ends-session=""', '')),
    ).toHaveLength(1);
    expect(
      misannouncedSessionForms(
        await renderToString(PostForm({ action: '/x', endsSession: true })),
      ),
    ).toHaveLength(1);
  });

  it('a PostForm posts offline only with a stated reason', async () => {
    const guarded = await renderToString(PostForm({ action: '/x' }));
    expect(guarded).toContain('data-needs-network=""');
    expect(offlineUnguardedPostForms(guarded)).toEqual([]);

    const reason = 'the worker queues this post itself';
    const allowed = await renderToString(
      PostForm({ action: '/x', allowOffline: reason }),
    );
    expect(allowed).not.toContain('data-needs-network');
    expect(allowed).toContain(`data-allow-offline="${reason}"`);
    expect(offlineUnguardedPostForms(allowed)).toEqual([]);

    // A form marked as PostForm's but with neither is what the check catches.
    const bare = allowed.replace(/ data-allow-offline="[^"]*"/, '');
    expect(offlineUnguardedPostForms(bare)).toHaveLength(1);
  });

  it('answers boosted navigations with the full page', async () => {
    for (const { url } of routes()) {
      const res = await t.inject({ method: 'GET', url, headers: HX_BOOSTED });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
      expectFullPage(res);
    }
  });

  it('the profile shows the signed-in account; the public invite page does not', async () => {
    const profile = await t.inject({ method: 'GET', url: '/auth/profile' });
    expect(profile.body).toContain(t.owner.email);

    // Public (anonymous visitors, link previews): the inviter is named by
    // first name or generically, never by email.
    const invite = await t.inject({
      method: 'GET',
      url: `/wardrobe-share/invite/${inviteToken}`,
      anonymous: true,
    });
    expect(invite.statusCode).toBe(200);
    expectFullPage(invite);
    expect(invite.body).not.toContain(t.owner.email);
  });

  it('GET /wardrobe as an htmx fragment is only #wardrobe-body', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/wardrobe?keyword=Blazer',
      headers: HX_FRAGMENT,
    });
    expect(res.statusCode).toBe(200);
    expectFragment(res);
    expect(res.headers.vary).toContain('HX-Request');
    expect(res.body).toContain('Black Linen Blazer');
    expect(res.body).not.toContain('drawer navbar');
    expect(res.body).not.toContain("class='dock'");
  });

  it('GET /styling/garments is a bare page of a strip', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/styling/garments?role=none&before=2147483647',
      headers: HX_FRAGMENT,
    });
    expect(res.statusCode).toBe(200);
    expectFragment(res);
  });

  it('GET /.well-known/* answers anyone without rendering a page', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/.well-known/assetlinks.json',
      anonymous: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });

  // OAuth off (no MCP_PUBLIC_URL, #1289): a discovering client must read
  // "no OAuth here", never the catch-all's `{}` as broken metadata.
  it.each([
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
  ])('GET %s is a JSON 404 with OAuth off', async (url) => {
    const res = await t.inject({ method: 'GET', url, anonymous: true });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.json()).toEqual({
      error: 'not_found',
      error_description: 'Not Found',
    });
  });

  it('POST /oauth/token is the same JSON 404 with OAuth off, and stores nothing (#1291)', async () => {
    const res = await t.inject({
      method: 'POST',
      url: '/oauth/token',
      anonymous: true,
      sameOrigin: false,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'grant_type=refresh_token&refresh_token=closet_rt_x&client_id=x',
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      error: 'not_found',
      error_description: 'Not Found',
    });
  });

  it('an unknown garment renders the error page', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe/999999' });
    expect(res.statusCode).toBe(404);
    expectFullPage(res);
  });

  it('anonymous visitors see every public page', async () => {
    const publicPages = routes().filter((route) => route.public);
    for (const { url } of publicPages) {
      const res = await t.inject({ method: 'GET', url, anonymous: true });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
      expectFullPage(res);
    }
  });

  it('anonymous visitors are sent to login from every other page', async () => {
    const protectedPages = routes().filter((route) => !route.public);
    expect(protectedPages.length).toBeGreaterThan(10);
    for (const { url } of protectedPages) {
      const res = await t.inject({ method: 'GET', url, anonymous: true });
      expect({
        url,
        status: res.statusCode,
        location: res.headers.location,
      }).toEqual({ url, status: 302, location: loginUrl(url) });
    }
  });
});
