import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './harness';
import { expectFullPage, expectNativePostForms, pageTitle } from './pages';

/**
 * #662: what a visitor without a session sees. No dock (every tab would
 * bounce back to the login page: `Dock` renders nothing signed out), the
 * page's own title as its h1 (the og title is meta only), the app's mark,
 * and one btn-primary action.
 */
describe('the signed-out shell', () => {
  let t: TestApp;
  let inviteToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    const invite = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission: 'VIEW' },
      headers: { 'hx-request': 'true' },
    });
    inviteToken = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
      invite.body,
    )![1];
  });

  afterAll(() => t?.cleanup());

  const signedOut = (url: string) =>
    t.inject({ method: 'GET', url, anonymous: true });

  it.each([
    ['login', '/auth/login', 'Sign in'],
    ['register', '/auth/register', 'Create account'],
  ])('%s: its own h1, the mark, one primary button', async (_, url, title) => {
    const res = await signedOut(url);
    expect(res.statusCode).toBe(200);
    expectFullPage(res);
    expectNativePostForms(res);
    expect(res.body).not.toContain('class="dock"');
    expect(pageTitle(res.body)).toBe(title);
    // The og title stays meta: the document title and previews keep it.
    expect(res.body).toMatch(/<meta property="og:title" content="[^"]*—/);
    expect(res.body).toMatch(/<img src="\/assets\/icon-192\.png"/);
    expect(res.body).toContain('btn btn-primary mt-4');
    expect(res.body).not.toContain('btn-neutral');
  });

  it('the invite landing and the 404 have no dock either', async () => {
    const invite = await signedOut(`/wardrobe-share/invite/${inviteToken}`);
    expect(invite.statusCode).toBe(200);
    expect(invite.body).not.toContain('class="dock"');
    expect(invite.body).toMatch(/<img src="\/assets\/icon-192\.png"/);
    expect(invite.body).toContain('btn btn-primary');

    const missing = await signedOut('/no-such-page');
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain('class="dock"');
  });

  it('the sign-in card frames a bare fieldset; a signed-in form keeps the bordered one', async () => {
    const login = await signedOut('/auth/login');
    expect(login.body).toContain(
      'class="card bg-base-200 w-full max-w-xs p-4"',
    );
    expect(login.body).toContain('<fieldset class="fieldset"');

    const account = await t.inject({
      method: 'GET',
      url: '/auth/change-password',
    });
    expect(account.body).toContain(
      '<fieldset class="fieldset bg-base-200 border-base-300 rounded-box w-full max-w-xs border p-4"',
    );
    expect(account.body).not.toContain('card-body');
  });

  it('a signed-in page still has its dock', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(res.body).toContain('<nav class="dock"');
  });
});
