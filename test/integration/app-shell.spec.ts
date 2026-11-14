import { loginUrl } from '../../src/web/auth/return-to';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  TEST_PASSWORD,
  type TestApp,
  unescapeHtml,
} from './harness';
import { expectFullPage, pageTitle } from './pages';

/**
 * The app shell (#82, redesign R2): one app bar on every page (its title is
 * the page's h1, the avatar opens Profile), no drawer, Profile as a
 * sectioned page with Sharing moved in and sign-out at its end, and the old
 * sharing page redirected. The every-page checks (one bar, one h1, the
 * avatar or a way in) run over the whole route table in pages.spec.ts
 * through expectFullPage.
 */
describe('app shell', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  const get = (url: string, cookie?: string) =>
    t.inject({
      method: 'GET',
      url,
      headers: cookie ? { cookie } : {},
    });

  const signUp = async (label: string) => {
    const email = `${label}-${randomUUID().slice(0, 8)}@example.com`;
    return { email, cookie: await t.register(email) };
  };

  describe('every link the drawer held has a home', () => {
    it('signed in: the avatar opens Profile, which holds the account and sign-out', async () => {
      const wardrobe = await get('/wardrobe');
      expect(wardrobe.body).toContain('<a href="/auth/profile" id="avatar"');

      const profile = await get('/auth/profile');
      expect(profile.statusCode).toBe(200);
      expectFullPage(profile);
      expect(pageTitle(profile.body)).toBe('Profile');
      // The drawer's email link is the account section's "Signed in as".
      expect(profile.body).toContain(`Signed in as ${t.owner.email}`);
      // The drawer's sign-out button is Profile's one sign-out form.
      expect(
        profile.body.match(
          /<form id="logout-form" method="post" action="\/auth\/logout"[^>]*>/g,
        ),
      ).toHaveLength(1);
      // On Profile the avatar says where you are.
      expect(profile.body).toMatch(
        /<a href="\/auth\/profile" id="avatar"[^>]*aria-current="page"/,
      );
    });

    it('signed out: Login everywhere, and Register on the login page', async () => {
      const about = await t.inject({
        method: 'GET',
        url: '/about',
        anonymous: true,
      });
      expect(about.body).toMatch(/<a href="\/auth\/login" class="btn[^"]*"/);
      expect(about.body).not.toContain('id="avatar"');
      expect(about.body).toContain('href="/THIRD-PARTY-NOTICES.txt"');

      // Public, no session, and carrying both fonts' OFL text.
      const notices = await t.inject({
        method: 'GET',
        url: '/THIRD-PARTY-NOTICES.txt',
        anonymous: true,
      });
      expect(notices.statusCode).toBe(200);
      expect(notices.headers['content-type']).toContain('text/plain');
      expect(notices.body).toContain('SIL OPEN FONT LICENSE Version 1.1');
      expect(notices.body).toContain('Open-Meteo.com');
      expect(notices.body).not.toMatch(/^htmx\.org@/m);

      const login = await t.inject({
        method: 'GET',
        url: '/auth/login',
        anonymous: true,
      });
      expect(login.body).toMatch(/<a href="\/auth\/register" class="btn[^"]*"/);

      const register = await t.inject({
        method: 'GET',
        url: '/auth/register',
        anonymous: true,
      });
      expect(register.body).toMatch(/<a href="\/auth\/login" class="btn[^"]*"/);
    });

    it('the sign-out form signs out, and the old GET still only asks', async () => {
      const { cookie } = await signUp('shell-logout');
      const asked = await get('/auth/logout', cookie);
      expect(asked.statusCode).toBe(200);
      expect(asked.headers['set-cookie']).toBeUndefined();
      expect(asked.body).toContain('id="logout-form"');

      const res = await t.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/auth/login');
      expect(String(res.headers['set-cookie'])).toMatch(/access_token=;/);
    });
  });

  describe('Profile', () => {
    it('is sectioned, each section an anchor the jump links reach', async () => {
      const res = await get('/auth/profile');
      const body = res.body;
      // PWA and weather are off in the harness: no notifications or
      // weather section, and no jump link to either.
      const sections = [
        'account',
        'sharing',
        'week',
        'style',
        'agent-access',
        'sign-out',
      ];
      for (const id of sections) {
        expect(body).toContain(`<section id="${id}"`);
        expect(body).toContain(`href="#${id}"`);
      }
      expect(body).not.toContain('id="notifications"');
      expect(body).not.toContain('id="weather"');
      // In the plan's order.
      const order = sections.map((id) => body.indexOf(`<section id="${id}"`));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      // The account's forms, the style profile and agent access are linked.
      for (const href of [
        '/auth/update-email',
        '/auth/change-password',
        '/auth/delete-account',
        '/auth/sign-out-everywhere',
        '/auth/profile/style',
        '/auth/tokens',
        '/about',
      ]) {
        expect(body).toContain(`href="${href}"`);
      }
    });

    it("shows the signed-in user's own shares and tokens, nobody else's", async () => {
      const alice = await signUp('shell-alice');
      const bob = await signUp('shell-bob');
      const invite = await t.inject({
        method: 'POST',
        url: '/wardrobe-share/create-invite-link',
        payload: { permission: 'VIEW' },
        headers: { cookie: alice.cookie, 'hx-request': 'true' },
      });
      const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
        invite.body,
      )![1];
      expect(
        (
          await t.inject({
            method: 'POST',
            url: '/auth/tokens',
            payload: { name: 'Alice laptop', currentPassword: TEST_PASSWORD },
            headers: { cookie: alice.cookie },
          })
        ).statusCode,
      ).toBe(200);

      const hers = unescapeHtml(
        (await get('/auth/profile', alice.cookie)).body,
      );
      expect(hers).toContain(`/wardrobe-share/invite/${token}`);
      expect(hers).toContain('Alice laptop');
      expect(hers).toContain(`Signed in as ${alice.email}`);

      const his = unescapeHtml((await get('/auth/profile', bob.cookie)).body);
      expect(his).not.toContain(token);
      expect(his).not.toContain('Alice laptop');
      expect(his).not.toContain(alice.email);
      expect(his).toContain('No wardrobe shares yet.');

      // Once Bob accepts, each sees the share from their own side.
      await t.inject({
        method: 'POST',
        url: `/wardrobe-share/invite/${token}/accept`,
        headers: { cookie: bob.cookie },
      });
      const accepted = unescapeHtml(
        (await get('/auth/profile', bob.cookie)).body,
      );
      expect(accepted).toContain('Shared With You');
      expect(accepted).toContain(alice.email);
      expect(accepted).not.toContain('Alice laptop');
    });

    it('needs a session', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/auth/profile',
        anonymous: true,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(loginUrl('/auth/profile'));
    });

    it('shows a refused invite in Sharing, and ignores an unknown code', async () => {
      const refused = await get('/auth/profile?shareError=own-invite');
      expect(refused.body).toContain('You cannot accept your own invite.');
      for (const code of ['bogus', 'constructor', 'toString']) {
        const res = await get(`/auth/profile?shareError=${code}`);
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain('role="alert"');
      }
    });

    it("the account's forms go back to Profile's account section", async () => {
      for (const url of [
        '/auth/update-email',
        '/auth/change-password',
        '/auth/delete-account',
      ]) {
        const res = await get(url);
        expect(res.body).toMatch(
          /<a href="\/auth\/profile#account" class="btn[^"]*" aria-label="Back"/,
        );
      }
    });
  });

  describe('the sharing page moved into Profile', () => {
    it('redirects the old manage page permanently to Profile › Sharing', async () => {
      const res = await get('/wardrobe-share/manage');
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe('/auth/profile#sharing');
    });

    it('keeps a refusal code through the redirect, and drops an unknown one', async () => {
      const refused = await get('/wardrobe-share/manage?error=already-shared');
      expect(refused.statusCode).toBe(301);
      expect(refused.headers.location).toBe(
        '/auth/profile?shareError=already-shared#sharing',
      );
      for (const code of ['bogus', 'constructor']) {
        const res = await get(`/wardrobe-share/manage?error=${code}`);
        expect(res.headers.location).toBe('/auth/profile#sharing');
      }
    });

    it('still sends a signed-out visitor to log in first', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/wardrobe-share/manage',
        anonymous: true,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(loginUrl('/wardrobe-share/manage'));
    });

    it('keeps the public invite landing working, signed out', async () => {
      const invite = await t.inject({
        method: 'POST',
        url: '/wardrobe-share/create-invite-link',
        payload: { permission: 'VIEW' },
        headers: { 'hx-request': 'true' },
      });
      const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
        invite.body,
      )![1];
      const res = await t.inject({
        method: 'GET',
        url: `/wardrobe-share/invite/${token}`,
        anonymous: true,
      });
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      expect(pageTitle(res.body)).toBe('Wardrobe Invitation');
    });
  });

  // What public/js/back.js reads (#105); test/back-navigation.spec.ts (retired 2026-10-13)
  // proves the behaviour in a browser.
  describe("the app bar's back arrow", () => {
    const header = (html: string) =>
      /<header class="app-bar[^"]*"[^>]*>/.exec(html)![0];

    it('goes back in history, with its href as the fallback', async () => {
      const res = await get('/auth/update-email');
      expect(res.body).toContain('/js/back.js?v=');
      expect(res.body).toMatch(
        /<a href="\/auth\/profile#account" class="btn[^"]*" aria-label="Back" data-history-back=""/,
      );
      expect(header(res.body)).not.toContain('data-form-page');
    });

    it('marks the pages a save is done with', async () => {
      for (const url of ['/wardrobe/new', '/capsules/new', '/trips/new']) {
        const res = await get(url);
        expect(header(res.body), url).toContain('data-form-page=""');
      }
      for (const url of ['/wardrobe', '/auth/profile']) {
        const res = await get(url);
        expect(header(res.body), url).not.toContain('data-form-page');
      }
    });

    it("leaves a destination's own back link fixed", async () => {
      const res = await get('/outfits?for=day:2026-09-28&occasion=evening');
      const destinationLine =
        /<div class="flex items-center gap-2" data-destination-day="[^"]*">\s*<a [^>]*>/.exec(
          res.body,
        )![0];
      expect(destinationLine).toContain('aria-label="Back"');
      expect(destinationLine).not.toContain('data-history-back');
    });
  });
});
