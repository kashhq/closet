import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../db/client';
import { SESSION_COOKIE } from '../../credential-names';
import { SYNC_EPOCH_MISSING } from '../../db/sync-epoch';
import { isFragmentRequest } from '../../htmx/fragment-request';
import type { Logger } from '../../logger';
import { isStaticPath } from '../../static-prefixes';
import { loggableUrl } from '../loggable-url';
import { SESSION_ENDED_HEADER } from '../page-cache';
import {
  rememberShareReadAhead,
  type ShareReadAhead,
  shareToReadAhead,
} from '../sharing/access';
import { type AccountRow, findSessionAccount } from './queries';
import {
  SESSION_LIFETIME_SECONDS,
  type SessionStamp,
  type SessionTokens,
} from './tokens';

/** The signed-in user as every route and page sees it: never the hash. */
export interface SessionUser {
  id: number;
  email: string | null;
}

export interface AuthContext {
  user: SessionUser;
}

/**
 * A session cookie's verdict: its session (and, on a `checksPassword` route,
 * the account row with its hash; on a request addressing another user's
 * wardrobe, that share), or why it no longer opens one.
 */
type CookieVerdict =
  | {
      auth: AuthContext;
      stamp: SessionStamp;
      account?: AccountRow;
      share?: ShareReadAhead;
    }
  | { rejected: string };

/**
 * The stamp each request's session was judged by (its token's `pwf` and
 * `sv`, equal to the row's when it was read), by request: kept off
 * `request.auth` with the hash, as accountsWithHash.
 */
const sessionStamps = new WeakMap<FastifyRequest, SessionStamp>();

/**
 * The stamp the request's session was opened with, for a write that must
 * not outlive the session: it rechecks it under the user's row lock
 * (sessionStillOpenSql), which a new password's writer and Sign out
 * everywhere take too (upsertDevice, createInvite; updatePasswordHash,
 * endOtherSessions), since the session lookup read the row before that
 * lock. Calling it on a request without a session is a programming error.
 */
export function sessionStamp(request: FastifyRequest): SessionStamp {
  const stamp = sessionStamps.get(request);
  if (stamp === undefined) {
    throw new Error(
      `sessionStamp() on ${request.method} ${loggableUrl(request)}, which has no session`,
    );
  }
  return stamp;
}

/**
 * The account rows the session lookup read with their hash, by request: kept
 * off `request.auth`, which the views and logs see, so a hash has no path
 * into a page or a log line. Filled only for `checksPassword` routes.
 */
const accountsWithHash = new WeakMap<FastifyRequest, AccountRow>();

/**
 * The signed-in account with its password hash, on a route that says
 * `config: { checksPassword: true }`: the session lookup read it, so the
 * route's password check costs no second read of the row. Read from the
 * same statement that checked the session's fingerprint, so the hash it
 * verifies against is the one that session was judged by. Calling it
 * anywhere else is a programming error.
 */
export function sessionAccount(request: FastifyRequest): AccountRow {
  const account = accountsWithHash.get(request);
  if (!account) {
    throw new Error(
      `sessionAccount() on ${request.method} ${loggableUrl(request)}, which has no session or no config.checksPassword`,
    );
  }
  return account;
}

/**
 * Resolves a request's session once: cookie -> JWT -> user row -> password
 * fingerprint, restore epoch and session version. The root preValidation hook in app.ts calls it for every
 * non-static request and stores the result as `request.auth`;
 * requireSession, sessionUserId() and the page context only read that.
 *
 * One statement, every request, never cached (src/web/security/AGENTS.md):
 * the row is read fresh because comparing its fingerprint is the
 * revocation. It reads the id, the email (the app bar, the order mail's
 * owner) and the hash's 8-character suffix, not the hash (#171); a
 * `checksPassword` route's lookup reads the hash too, for sessionAccount(),
 * and a request whose `?ownerId=` names another user's wardrobe reads the
 * share with it, for the access check (#170, shareToReadAhead).
 *
 * A cookie that no longer opens a session is ended here, on whatever route
 * it arrives (endSession: the cookie cleared, Clear-Site-Data sent). That
 * covers every way a session ends away from this device: a password changed
 * on another one or by `user:set-password` (the fingerprint), a database
 * restore (`maintenance:after-restore`'s epoch bump: `sep`, #908), Sign out
 * everywhere and a new password (the session version's bump: `sv`, #700), the
 * account deleted elsewhere (no row), a rotated ACCESS_TOKEN_SECRET or a garbled
 * token (the signature), and expiry. This is the one place such a device is
 * noticed, so it is where it drops the account's HTTP cache (selfies,
 * pages); the session gate's redirect or 401 then carries both headers (and
 * the relay's marker, so the page it lands on repeats the clear: #244), and
 * the login page it lands on drops the browser's push subscription
 * (PushSignedOut, src/web/push/settings.tsx). A request without the cookie
 * gets neither header: nothing was signed in there.
 */
export function createSessionResolver(deps: {
  db: Db;
  tokens: SessionTokens;
  logger: Logger;
}) {
  const { db, tokens, logger } = deps;

  const judge = async (
    token: string,
    request: FastifyRequest,
  ): Promise<CookieVerdict> => {
    const claims = tokens.verify(token);
    if (!claims) return { rejected: 'invalid signature, claims or expiry' };
    const shareOf = shareToReadAhead(request, claims.userId);
    const row = await findSessionAccount(db, claims.userId, {
      withHash: request.routeOptions.config.checksPassword === true,
      shareOf,
    });
    if (!row) return { rejected: `unknown user ${claims.userId}` };
    if (row.fingerprint !== claims.pwf) {
      return { rejected: `password fingerprint mismatch for user ${row.id}` };
    }
    if (row.sessionEpoch === SYNC_EPOCH_MISSING) {
      logger.error(
        { userId: row.id },
        'sync_epoch has no row: refusing every session until the schema is repaired',
      );
      return { rejected: `sync_epoch row missing, for user ${row.id}` };
    }
    if ((claims.sep ?? null) !== row.sessionEpoch) {
      return {
        rejected: `issued before the database was restored, for user ${row.id}`,
      };
    }
    if (claims.sv !== row.sessionVersion) {
      return {
        rejected: `session version ${claims.sv}, now ${row.sessionVersion} (signed out everywhere or a new password), for user ${row.id}`,
      };
    }
    const user = { id: row.id, email: row.email };
    return {
      auth: { user },
      stamp: { fingerprint: claims.pwf, version: claims.sv },
      account:
        row.password === undefined
          ? undefined
          : {
              ...user,
              password: row.password,
              sessionEpoch: row.sessionEpoch,
              sessionVersion: row.sessionVersion,
            },
      share:
        shareOf === undefined
          ? undefined
          : { ownerId: shareOf, permission: row.share ?? null },
    };
  };

  return async function resolveSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthContext | undefined> {
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) return undefined;

    const verdict = await judge(token, request);
    if ('auth' in verdict) {
      sessionStamps.set(request, verdict.stamp);
      if (verdict.account) accountsWithHash.set(request, verdict.account);
      if (verdict.share) rememberShareReadAhead(request, verdict.share);
      return verdict.auth;
    }
    endSession(reply);
    logger.info(
      `Rejected access token (${verdict.rejected}): cookie cleared, Clear-Site-Data sent`,
    );
    return undefined;
  };
}

/**
 * The attributes of every cookie this module sets or clears (the session's
 * and the cache-clear marker), derived per request: httpOnly (no script
 * reads them), SameSite=Lax (not sent on cross-site POSTs; the same-origin
 * hook is the other half of the CSRF defence), and Secure exactly when this
 * request arrived over https (#700). `request.protocol` reads
 * X-Forwarded-Proto only from a TRUSTED_PROXIES peer (Fastify trustProxy),
 * so a direct caller cannot claim https, and the HTTP twin and the dev
 * server, plain http, get no Secure: a Secure cookie is never stored over
 * http, and login there would break (AGENTS.md, Conventions). A clear
 * carries the same attributes as its set.
 */
function sessionCookieOptions(request: FastifyRequest) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: request.protocol === 'https',
  } as const;
}

/**
 * The session cookie (sessionCookieOptions). Max-Age is in seconds
 * (@fastify/cookie passes it through as the attribute) and matches the
 * token's own expiry.
 */
export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    ...sessionCookieOptions(reply.request),
    maxAge: SESSION_LIFETIME_SECONDS,
  });
}

/**
 * Signs `userId` in on this browser with a freshly issued `token` (sign-in,
 * registration) and answers whose live session it replaced, if another
 * account's. The login form stays open to a signed-in user, so signing in as
 * B over A's session ends A's on this device as surely as a sign-out: the new
 * cookie replaces A's, and Clear-Site-Data: "cache" drops what the HTTP cache
 * holds for A (its photos and selfies, immutable for a year), as endSession
 * does (#229). The service worker drops its own session caches as the
 * sign-in form posts (data-ends-session, SESSION_ENDING in
 * views/assets/src-sw.ts). The same account signing in
 * again keeps its cache; a dead cookie was already ended by the resolver,
 * header included, so there is no live session to replace.
 */
export function startSession(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: number,
  token: string,
): number | undefined {
  setSessionCookie(reply, token);
  const previous = request.auth?.user.id;
  if (previous === undefined || previous === userId) return undefined;
  clearHttpCache(reply);
  return previous;
}

const CLEAR_SITE_DATA = 'Clear-Site-Data';

/**
 * "cache", not "storage": "storage" also unregisters the service worker and
 * empties its precache, so the installed app would lose its offline shell
 * (and its push subscription) until a page loaded online registered it
 * again. The worker's session caches, the private things in Cache Storage,
 * are dropped by the worker itself (views/assets/src-sw.ts: as our sign-in
 * and sign-out forms post, SESSION_ENDING, and on the signed-out page a
 * revoked session lands on). Cookies are untouched, so a
 * cookie set on the same answer (startSession) survives it. Ignored outside
 * a secure context (the HTTP twin) and before Safari 17. Most of these
 * answers are redirects, which WebKit does not apply it from: the
 * cache-clear relay below repeats it on the page they land on (#244).
 */
function clearHttpCache(reply: FastifyReply): void {
  reply.header(CLEAR_SITE_DATA, '"cache"');
}

/**
 * The cache-clear relay's marker (#244): "this browser still owes itself a
 * Clear-Site-Data", with the session cookie's attributes
 * (sessionCookieOptions); a minute is ample for a redirect chain to land,
 * and an unconsumed marker costs at most one needless clear.
 */
const CACHE_CLEAR_PENDING_COOKIE = 'cache_clear_pending';
const CACHE_CLEAR_PENDING_SECONDS = 60;

/**
 * Whether an answer is a whole HTML document a load ends on: a page, a
 * boosted page or an error page, never a redirect, an htmx fragment, an
 * image or a bodiless 401.
 */
function isLandingDocument(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const status = reply.statusCode;
  const type = reply.getHeader('Content-Type');
  return (
    (status < 300 || status >= 400) &&
    typeof type === 'string' &&
    type.startsWith('text/html') &&
    !isFragmentRequest(request.headers)
  );
}

/**
 * The root onSend hook (app.ts) that makes Clear-Site-Data reach a document
 * on WebKit (#244). WebKit applies the header only to the response a load
 * ends on (NetworkResourceLoader::didReceiveResponse), never to a redirect it
 * follows, and endSession and startSession answer sign-out, account
 * deletion, a revoked cookie at the session gate and a sign-in over another
 * account with redirects (or a bodiless 401 whose HX-Redirect the page
 * follows). So:
 *
 * - an answer carrying the header that is not a landing document also sets
 *   the marker cookie; the header stays on it, which Chromium and Firefox
 *   apply there;
 * - the next landing document while the marker lives (the login page, the
 *   profile, wherever safeReturnTo or a second redirect led) carries
 *   `Clear-Site-Data: "cache"` and clears the marker, so exactly one page
 *   repeats it, and none after.
 *
 * Decided here, on the finished answer, rather than in endSession, which
 * runs before anyone knows whether the answer is a redirect (the resolver
 * ends a session at preValidation; the gate redirects after). Static paths
 * never take part, so no asset ever clears the cache. The marker cannot be
 * abused: only this server's answers set it, every one already sending the
 * header, and all it can make the browser do is drop its own HTTP cache for
 * this site. The service worker never stores the header with a page
 * (pageStore, src-sw.ts), so no cached copy replays it.
 */
export function createCacheClearRelay(logger: Logger) {
  return function relayCacheClear(
    request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
    done: (err: null, payload: unknown) => void,
  ): void {
    if (!isStaticPath(request.url)) {
      // Undefined when the same-origin hook refused the request at onRequest,
      // before @fastify/cookie parsed it; such an answer carries no header.
      const pending =
        request.cookies?.[CACHE_CLEAR_PENDING_COOKIE] !== undefined;
      if (isLandingDocument(request, reply)) {
        if (pending) {
          clearHttpCache(reply);
          reply.clearCookie(
            CACHE_CLEAR_PENDING_COOKIE,
            sessionCookieOptions(request),
          );
          logger.info(
            `Clear-Site-Data relayed to the landing page ${loggableUrl(request)} (${reply.statusCode})`,
          );
        }
      } else if (reply.hasHeader(CLEAR_SITE_DATA)) {
        reply.setCookie(CACHE_CLEAR_PENDING_COOKIE, '1', {
          ...sessionCookieOptions(request),
          maxAge: CACHE_CLEAR_PENDING_SECONDS,
        });
        logger.debug(
          `Clear-Site-Data on ${loggableUrl(request)} (${reply.statusCode}): marked for the landing page`,
        );
      }
    }
    done(null, payload);
  };
}

/**
 * Ends the session in this browser, and tells it to drop its HTTP cache so
 * the next person on the device cannot page back through this user's
 * wardrobe or its selfies (`private, immutable` for a year). Used by sign-out,
 * account deletion and the session resolver (a cookie that no longer opens a
 * session); every way a session ends on a device goes through here, but for
 * another account signing in over it (startSession).
 */
export function endSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(reply.request));
  clearHttpCache(reply);
  reply.header(SESSION_ENDED_HEADER, '1');
}
