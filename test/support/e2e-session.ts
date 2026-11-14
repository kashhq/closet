import { expect, type Page, type PlaywrightWorkerArgs } from '@playwright/test';

export const E2E_PASSWORD = 'Password123!';

/**
 * playwright.config.ts `baseURL`: the origin every page is served from. The
 * port is the server's own `PORT` (src/config.ts; the webServer inherits the
 * environment), so a worktree can run the specs beside another on :3000.
 */
export const APP_ORIGIN = `http://localhost:${process.env.PORT ?? '3000'}`;

/**
 * The port playwright.config.ts points the server's SENTRY_DSN at, as
 * production points it at Bugsink: nothing listens, so events fail to send
 * and are dropped. Derived from PORT so worktrees running side by side never
 * share one.
 */
const SENTRY_STUB_PORT = Number(process.env.PORT ?? '3000') + 10000;
export const E2E_SENTRY_DSN = `http://publickey@127.0.0.1:${SENTRY_STUB_PORT}/1`;

/**
 * Headers for a POST made through `page.request` (the API context), which,
 * unlike the browser, sends no Origin: the app refuses a state-changing
 * request that does not name the site (the CSRF check,
 * src/web/security/same-origin.ts).
 */
export const SAME_ORIGIN = { origin: APP_ORIGIN };

let clientSeq = 0;

/**
 * SAME_ORIGIN plus a client address of its own. Login and registration are rate limited per address
 * and every spec signs up from 127.0.0.1, which is a trusted proxy by
 * default (TRUSTED_PROXIES), so each sign-up names a different forwarded
 * client instead of sharing one budget.
 */
export function signUpHeaders(): Record<string, string> {
  clientSeq += 1;
  const worker = process.env.TEST_WORKER_INDEX ?? '0';
  return {
    ...SAME_ORIGIN,
    'x-forwarded-for': `198.19.${Number(worker) % 250}.${(clientSeq % 250) + 1}`,
  };
}

/**
 * Registers a fresh user through the real endpoint, which leaves its session
 * cookie in the page's context (page.request shares the context's cookies).
 * Login is always required, so every spec that opens an app page calls this
 * first.
 */
export async function signIn(page: Page, prefix: string): Promise<string> {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await page.request.post('/auth/register', {
    form: { email, password: E2E_PASSWORD, confirmPassword: E2E_PASSWORD },
    headers: signUpHeaders(),
  });
  if (!res.ok()) {
    throw new Error(`Registering ${email} failed: ${res.status()}`);
  }
  return email;
}

/** Registers an account outside this browser; returns its email. */
export async function registerElsewhere(
  playwright: PlaywrightWorkerArgs['playwright'],
  prefix: string,
): Promise<string> {
  const api = await playwright.request.newContext({ baseURL: APP_ORIGIN });
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const registered = await api.post('/auth/register', {
    form: {
      email,
      password: E2E_PASSWORD,
      confirmPassword: E2E_PASSWORD,
    },
    headers: signUpHeaders(),
  });
  expect(registered.ok()).toBe(true);
  await api.dispose();
  return email;
}

/**
 * Signs out through Profile and in again as `email`, in the app: the posts
 * the service worker sees, which drop its session caches.
 */
export async function switchAccount(page: Page, email: string): Promise<void> {
  // Signing out is Profile's, reached through the avatar (#82).
  await page.locator('#avatar').click();
  await page
    .locator('#sign-out')
    .getByRole('button', { name: 'Logout' })
    .click();
  await expect(page).toHaveURL(/\/auth\/login$/);
  await submitLogin(page, email);
  // A plain sign-in lands on Today (#661).
  await page.waitForURL((url) => url.pathname === '/');
}

/**
 * Fills and posts the login form the page shows, as a person does: where it
 * lands is the caller's to assert (Today, or the page its returnTo names).
 */
export async function submitLogin(page: Page, email: string): Promise<void> {
  // The browser posts from the address every spec shares, and login allows
  // 5 a minute per address: the post names a client of its own, as signIn's
  // registration does.
  await page.context().route('**/auth/login', (route) =>
    route.fallback({
      headers: { ...route.request().headers(), ...signUpHeaders() },
    }),
  );
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Login' }).click();
}
