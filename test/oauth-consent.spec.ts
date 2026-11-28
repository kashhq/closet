import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './support/fixtures';
import { E2E_PASSWORD, signIn, signUpHeaders } from './support/e2e-session';
import {
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_REDIRECT,
} from './support/oauth-client-stub';
import { pageErrors } from './support/page-errors';

/**
 * The OAuth consent's Allow (#1290; src/web/oauth/AGENTS.md), as the agent
 * app's browser sheet shows it at phone width. What only a real browser
 * shows: the form posts natively, not boosted (a boosted post would follow
 * the 303 to another origin by XHR and never leave the page), and the
 * page's CSP `form-action` admits the redirect after the submit, so the
 * top-level navigation reaches the client's loopback redirect URI. The
 * proof, the code, the refusals and the budgets are
 * test/integration/oauth-consent.spec.ts's.
 */
test.use({ viewport: { width: 390, height: 844 } });

test.skip(
  process.env.MCP_PUBLIC_URL === undefined,
  'needs a server started with MCP_PUBLIC_URL (an https SITE_URL)',
);

test('Allow navigates the browser to the client with a code', async ({
  page,
}) => {
  const errors = pageErrors(page);
  const email = await signIn(page, 'oauth-consent');
  // The consent counts on the sign-in's per-address budget: an address of
  // its own, as every sign-up has.
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': signUpHeaders()['x-forwarded-for'],
  });
  // The client's loopback listener, a real one on any port (RFC 8252: the
  // document lists it portless). Not page.route: a redirect's target never
  // reaches a route handler.
  const landed: URL[] = [];
  const listener = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // The browser's own favicon ask is not the client's answer.
    if (url.pathname !== '/callback') return res.writeHead(404).end();
    landed.push(url);
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<!doctype html><title>Back in the agent</title>');
  });
  await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
  const callback = new URL(OAUTH_CLIENT_REDIRECT);
  callback.port = String((listener.address() as AddressInfo).port);

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: callback.href,
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    state: 'e2e-state',
    scope: 'closet:read',
    resource: String(process.env.MCP_PUBLIC_URL),
  });
  await page.goto(`/oauth/authorize?${query}`);
  await expect(page.locator('strong', { hasText: '127.0.0.1' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Allow' }).click();

  await expect(page).toHaveTitle('Back in the agent');
  listener.closeAllConnections();
  listener.close();
  expect(landed).toHaveLength(1);
  const [answer] = landed;
  expect(answer.pathname).toBe(callback.pathname);
  expect(answer.searchParams.get('code')).toMatch(/^closet_code_[\w-]{43}$/);
  expect(answer.searchParams.get('state')).toBe('e2e-state');
  expect(errors).toEqual([]);
});
