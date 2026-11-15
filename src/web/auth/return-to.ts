import type { FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { scrubSecrets } from '../../secret-text';
import { isReplayRequest } from '../../offline-writes';
import { bypassesWorker } from '../page-cache';
import { safeReturnTo } from '../security/return-to';
import { originOf, requestOrigin } from '../security/origin';
import { LOGIN_PATH } from './login-path';
import { PROFILE_PAGE, PROFILE_PATH } from './urls';

/**
 * Where signing in goes next (#661): the page a signed-out visitor was on
 * or was sent from, carried as `?returnTo=` on the login and registration
 * links, then as a hidden field through both posts. Sign-in lands there,
 * or on Today (`/`) when there is nothing usable to return to.
 *
 * The value can carry a secret (an invite link's token), so the two GET
 * pages that hold it in their URL are `secretPath` (the access line logs
 * the pattern) and `no-store` (no cache, the service worker's included,
 * keeps them), and the posts take it in the body, never the action URL.
 */
export const RETURN_TO_PARAM = 'returnTo';

const HOME = '/';

/** Past this a value is not a page anyone was on: the fallback, never a 400. */
export const MAX_RETURN_TO_LENGTH = 2048;

/**
 * Accept and decline are POST-only: a GET of them is a 404, so they are
 * never somewhere to land. The invite page itself (the token alone) is.
 */
const INVITE_ANSWER = /^\/wardrobe-share\/invite\/[^/?#]+\/(accept|decline)\b/;

/**
 * Page targets only: sign-in lands on a page a person reads, never on the
 * sign-in pages themselves (a loop) or sign-out, a form's validator, a
 * POST-only route or a surface that is not a page (`/api`, `/mcp`, the
 * exports: bypassesWorker's list). Fastify cannot match a concrete path
 * against its route table without its private router, so this is a
 * denylist: a path missed here answers its own 404 page, never a loop.
 * Profile and its settings' pages (PROFILE_PAGE) are the /auth pages
 * sign-in returns to (a session that ended mid-settings); the account's
 * forms behind it are reached from it.
 */
function isLandingPage(path: string): boolean {
  const { pathname } = new URL(path, 'http://return-to.invalid');
  if (pathname.startsWith('/auth/')) {
    return pathname === PROFILE_PATH || PROFILE_PAGE.test(pathname);
  }
  if (pathname === '/auth') return false;
  if (INVITE_ANSWER.test(pathname)) return false;
  return !bypassesWorker({ pathname });
}

/**
 * The one reading of a returnTo, from a query, a body or a header's page:
 * a single same-site page path (safeReturnTo, then the page targets above),
 * else `/`. A repeated parameter (an array), anything past
 * MAX_RETURN_TO_LENGTH and a value carrying a credential shape (a token a
 * client put in a query string, which would otherwise be copied into the
 * login page's URL) are all `/`: URL state, never a 400.
 */
export function signInReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_RETURN_TO_LENGTH) {
    return HOME;
  }
  const path = safeReturnTo(value, HOME);
  if (path === HOME || scrubSecrets(path) !== path) return HOME;
  return isLandingPage(path) ? path : HOME;
}

function withReturnTo(base: string, returnTo: unknown): string {
  const path = signInReturnTo(returnTo);
  return path === HOME
    ? base
    : `${base}?${RETURN_TO_PARAM}=${encodeURIComponent(path)}`;
}

/** The login page, coming back to `returnTo`; plain when that is Today. */
export function loginUrl(returnTo?: unknown): string {
  return withReturnTo(LOGIN_PATH, returnTo);
}

export const REGISTER_PATH = '/auth/register';

/** The registration page, coming back to `returnTo` like loginUrl. */
export function registerUrl(returnTo?: unknown): string {
  return withReturnTo(REGISTER_PATH, returnTo);
}

/**
 * The path (with its query) of an absolute URL a browser sent about the
 * page it is on, when that URL is this site's: its origin is the request's
 * own or SITE_URL's, the two the same-origin hook accepts. Anything else
 * says nothing about where to return.
 */
function ownPage(
  url: string | string[] | undefined,
  request: Pick<FastifyRequest, 'protocol' | 'host'>,
  siteOrigin: string | undefined,
): string | undefined {
  if (typeof url !== 'string') return undefined;
  const origin = originOf(url);
  if (origin === undefined) return undefined;
  if (origin !== requestOrigin(request) && origin !== siteOrigin) {
    return undefined;
  }
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * Where a request the session gate refused should return after sign-in:
 * a GET navigation (a document load, a boosted tap) its own URL; anything
 * else (a native post whose session ended, an htmx fragment, a fetch) the
 * page it was sent from, never the request itself (a POST-only action
 * would be a 404 on return): htmx's `HX-Current-URL`, else the Referer
 * (same-origin requests send the full URL under strict-origin-when-cross-
 * origin). An outbox replay returns nowhere: its 401 is for the outbox,
 * not a person. The answer still goes through signInReturnTo at loginUrl.
 */
export function bounceReturnTo(
  request: Pick<FastifyRequest, 'method' | 'url' | 'protocol' | 'host'> & {
    headers: IncomingHttpHeaders;
  },
  navigation: boolean,
  siteOrigin: string | undefined,
): string | undefined {
  if (isReplayRequest(request.headers)) return undefined;
  if (navigation && (request.method === 'GET' || request.method === 'HEAD')) {
    return request.url;
  }
  const page =
    request.headers['hx-request'] === 'true'
      ? request.headers['hx-current-url']
      : request.headers.referer;
  return ownPage(page, request, siteOrigin);
}
