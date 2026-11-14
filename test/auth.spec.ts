import { expect, test } from './support/fixtures';
import { E2E_PASSWORD, signUpHeaders } from './support/e2e-session';
import { pageErrors } from './support/page-errors';

const APP_NAME = process.env.APP_NAME || 'Closet';
/** The refused login's document load: a 401 is a console error in every browser. */
const REFUSED_LOGIN =
  'Failed to load resource: the server responded with a status of 401 (Unauthorized)';

/**
 * The account's whole loop through the real forms: signed out, the root is
 * the login page (no console errors); the registration form signs the new
 * account in, on Today; Profile's sign-out (a POST) ends it; the login form
 * a bounce from the wardrobe opens, with the right password after a wrong
 * one, signs back in on that wardrobe (#661). The account forms post
 * natively (no htmx), which is what lets a browser save the password and
 * what makes a refusal one page, not a page swapped into a page. Every
 * other account route is test/integration/account.spec.ts and auth.spec.ts.
 */
test('register through the form, sign out from Profile, sign back in', async ({
  page,
}) => {
  const errors = pageErrors(page, { console: true });
  // Login and registration are rate limited per address: this browser's
  // posts name a client of their own (signUpHeaders).
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': signUpHeaders()['x-forwarded-for'],
  });

  // Signed out, "/" is a 302 to the login page.
  await page.goto('/');
  await expect(page).toHaveURL(/\/auth\/login$/);
  await expect(page.locator('body')).toContainText(APP_NAME);

  // The signed-out shell at phone width (#662): the mark, no dead dock, the
  // one primary button, nothing wider than the screen.
  const desktop = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
  await expect(page.locator('main img[src^="/assets/icon"]')).toBeVisible();
  await expect(page.locator('.dock')).toHaveCount(0);
  await expect(page.locator('main .btn-primary')).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  if (desktop) await page.setViewportSize(desktop);

  const email = `register-form-${Date.now()}@example.com`;
  await page.goto('/auth/register');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('#confirmPassword').fill(E2E_PASSWORD);
  // Leaving the field runs the inline check (the fieldset's `change`);
  // its answer awaited, so the submit's navigation never cuts it off,
  // which WebKit logs as htmx:sendError (docs/testing-webkit.md).
  const checked = page.waitForResponse(
    (response) =>
      response.url().endsWith('/auth/validate/register') &&
      new URLSearchParams(response.request().postData() ?? '').get(
        'confirmPassword',
      ) === E2E_PASSWORD,
  );
  await page.locator('#confirmPassword').press('Tab');
  await checked;
  await page.getByRole('button', { name: 'Create account' }).click();
  // A plain registration lands on Today (#661).
  await page.waitForURL((url) => url.pathname === '/' && url.search === '');

  // The avatar opens Profile, whose sign-out signs out (#82).
  await page.goto('/wardrobe');
  await expect(page.locator('#avatar')).toHaveText(
    email.charAt(0).toUpperCase(),
  );
  await page.locator('#avatar').click();
  await page
    .locator('#sign-out')
    .getByRole('button', { name: 'Sign out' })
    .click();
  await expect(page).toHaveURL(/\/auth\/login$/);
  // Signed out, the wardrobe bounces to login, which returns there (#661).
  await page.goto('/wardrobe');
  await expect(page).toHaveURL(/\/auth\/login\?returnTo=%2Fwardrobe$/);

  // A refused login is one page with a specific message and the email kept.
  await page.locator('#email').fill(email);
  await page.locator('#password').fill('NotThePassword1');
  const refusal = page.waitForResponse(
    (response) =>
      response.url().endsWith('/auth/login') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sign in' }).click();
  expect((await refusal).status()).toBe(401);
  await expect(page.locator('[role="alert"]')).toHaveText(
    'Incorrect email or password',
  );
  // The confirm sheet's backdrop is a form of every page.
  await expect(page.locator('form:not(.modal-backdrop)')).toHaveCount(1);
  await expect(page.locator('#email')).toHaveValue(email);

  // The refused post's page kept the returnTo: signing in lands on the
  // wardrobe it bounced from.
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/wardrobe$/);
  await expect(page.locator('#avatar')).toHaveText(
    email.charAt(0).toUpperCase(),
  );
  // The refusal's 401 is the only error the page may log; anything else is
  // a page script failing. Chromium logs it once; WebKit logged it twice
  // while the worker relayed the login (until #542), so the spec counts no
  // more than that it is there (docs/testing-webkit.md).
  expect(errors, errors.join('\n')).toContain(REFUSED_LOGIN);
  expect(
    errors.filter((error) => error !== REFUSED_LOGIN),
    errors.join('\n'),
  ).toEqual([]);
});
