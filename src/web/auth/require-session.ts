import type { FastifyReply, FastifyRequest } from 'fastify';
import { LOGIN_PATH } from './login-path';
import { bounceReturnTo, loginUrl } from './return-to';
import { decideSessionAccess } from './session-access';
import { originOf } from '../security/origin';
import { loggableUrl } from '../loggable-url';
import { surfaceOf } from '../surface';
import type { Logger } from '../../logger';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Reachable without a session (login, the manifest, the about page).
     * Every route is protected unless it says `config: { public: true }`.
     */
    public?: boolean;
    /**
     * The route checks the current password (the step-up rule, Auth): the
     * session lookup then reads the hash with the rest of the row, and the
     * handler takes it from sessionAccount() (session.ts) instead of
     * reading the row again. Every other request's lookup leaves the hash
     * in the database.
     */
    checksPassword?: boolean;
    /**
     * A public page that never reads the session cookie, so it never sets
     * one either (a revoked cookie arriving here is not cleared): the root
     * preValidation hook gives it a signed-out context. Only the OAuth
     * consent's POST (#1290), which signs nobody in and leaves nothing in
     * the agent app's browser sheet. Needs `public`.
     */
    sessionless?: true;
  }
}

/**
 * The session gate, a preValidation hook in the web plugin's scope. It runs
 * after the root hook in app.ts has resolved `req.auth` and before schema
 * validation, so a request without a session is sent to log in rather than
 * told its body is malformed. It answers as decideSessionAccess decides: a
 * page navigation without a session is a 302 to the login page, an htmx
 * fragment or fetch a bodiless 401 with `HX-Redirect`. Both are routine, so
 * they log at debug. Both send the login page the page to come back to
 * (bounceReturnTo, return-to.ts), so a session that ended mid-task returns
 * there after sign-in; the log line names the request through loggableUrl,
 * never the Location, whose returnTo may carry an invite token. When the request's cookie was rejected, the resolver
 * has already set the cleared cookie and Clear-Site-Data on this reply
 * (endSession, session.ts), and both answers keep them: never reset the
 * reply's headers here.
 */
export function createSessionHook(logger: Logger, siteUrl: string) {
  const siteOrigin = originOf(siteUrl);
  return async function requireSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    // /mcp and /api authenticate themselves (a token, never this session).
    if (surfaceOf(request) !== 'page') return;
    const isPublic = request.routeOptions.config.public === true;
    // Answering from an async hook means returning the reply: Fastify then
    // skips the handler.
    const access = decideSessionAccess(request, isPublic);
    if (access === 'allow') return;
    const login = loginUrl(
      bounceReturnTo(request, access === 'redirect-to-login', siteOrigin),
    );
    const returning = login === LOGIN_PATH ? '' : ', returning after sign-in';
    if (access === 'redirect-to-login') {
      logger.debug(`${loggableUrl(request)} -> ${LOGIN_PATH}${returning}`);
      return reply.redirect(login, 302);
    }
    logger.debug(
      `${loggableUrl(request)} -> 401, HX-Redirect ${LOGIN_PATH}${returning}`,
    );
    return loginRequired(reply, login);
  };
}

/**
 * The bodiless 401 a fetch or htmx request without a session gets, its
 * `HX-Redirect` sending the page to log in: the gate's answer (`login`
 * coming back to the page), and a write's that finds its session ended
 * under it (/push/subscribe).
 */
export function loginRequired(
  reply: FastifyReply,
  login: string = LOGIN_PATH,
): FastifyReply {
  return reply.status(401).header('HX-Redirect', login).send();
}

/**
 * The signed-in user's id on a protected route, where requireSession has
 * already refused requests without a session.
 * Calling it from a public route is a programming error.
 */
export function sessionUserId(request: FastifyRequest): number {
  if (!request.auth) {
    throw new Error(
      `sessionUserId() on ${request.method} ${loggableUrl(request)}, which has no session: is the route public?`,
    );
  }
  return request.auth.user.id;
}
