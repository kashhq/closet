import type {
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
  RouteOptions,
} from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { loggableUrl } from '../loggable-url';
import { sendOAuthError, sendProblem } from '../errors';
import { type Surface, surfaceOf } from '../surface';
import type { Logger } from '../../logger';
import { originOf, requestOrigin } from './origin';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The route writes nothing and answers only a redirect, so a post with
     * no Origin (and no Referer) may reach it: the same-origin hook's one
     * exemption for pages. Allowed only on STATELESS_ROUTES
     * (assertStatelessRoute stops the boot otherwise).
     */
    stateless?: true;
  }
}

/**
 * The only routes that may say `stateless`. The manifest's share target
 * (#22d, src/web/inspiration/routes.tsx): Android posts it as a navigation
 * with no Origin, and when no service worker answers it (storage cleared,
 * not yet installed) it reaches the server, which must show a page, not
 * this hook's 403. It changes nothing and reads only the share's fields,
 * under its size cap, to choose a redirect a cross-site page could link to
 * anyway (test/integration/inspiration.spec.ts). Each entry is reviewed
 * like a CSRF exemption, because it is one.
 */
export const STATELESS_ROUTES: ReadonlySet<string> = new Set([
  'POST /inspiration/share',
]);

/**
 * A root onRoute hook (createApp adds it before any route): a route that
 * says `stateless` and is not in STATELESS_ROUTES stops the boot.
 */
export function assertStatelessRoute(route: RouteOptions): void {
  if (!route.config?.stateless) return;
  for (const method of [route.method].flat()) {
    const key = `${method} ${route.url}`;
    if (!STATELESS_ROUTES.has(key)) {
      throw new Error(
        `${key} says stateless, the same-origin exemption, but is not in STATELESS_ROUTES`,
      );
    }
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CROSS_ORIGIN_REFUSED = 'Cross-origin request refused';

/**
 * The origin a browser says a request comes from: the Origin header, which
 * every current browser sends on POST/PUT/PATCH/DELETE (fetch, XHR and form
 * submissions alike), else the origin of the Referer. Undefined when there
 * is neither, or when Origin is the opaque `null` (sandboxed frames,
 * cross-origin redirects).
 */
function claimedOrigin(headers: IncomingHttpHeaders): string | undefined {
  if (typeof headers.origin === 'string') return originOf(headers.origin);
  if (typeof headers.referer === 'string') return originOf(headers.referer);
  return undefined;
}

/**
 * A request that may come with no Origin (and no Referer). A bearer surface
 * (/mcp, /api: the route's config, or the not-found config of an unmatched
 * /api path, surfaceOf) and OAuth's (`oauth`: the token endpoint, which an
 * agent vendor's server calls) are called by programs, which send no Origin. The
 * cookie is never read there and a page cannot attach the Authorization
 * header cross-site without a CORS preflight, which is never answered, so
 * an absent Origin is no CSRF. A `stateless` route (STATELESS_ROUTES)
 * writes nothing: an OS share sheet's post has no Origin. A present foreign
 * Origin is refused on both: the MCP spec's defence against DNS rebinding.
 */
function mayOmitOrigin(request: FastifyRequest, surface: Surface): boolean {
  return surface !== 'page' || request.routeOptions.config.stateless === true;
}

/**
 * CSRF protection for every route: a root onRequest hook that createApp()
 * adds before any route is registered, so it runs ahead of all of them,
 * before the body is read. A
 * state-changing request must name, in Origin (or Referer when Origin is
 * absent), either the origin it was sent to (requestOrigin: the Host as
 * Fastify trusts it) or SITE_URL's origin (the canonical https name, which a
 * proxy missing from TRUSTED_PROXIES reports as plain http). Anything else,
 * including neither header, is a 403; only a bearer surface (/mcp, /api),
 * the `oauth` surface and a `stateless` route (STATELESS_ROUTES) accept neither header.
 *
 * The session cookie is SameSite=Lax as well (session-cookie.ts); this
 * check does not depend on the browser's cookie policy, and it covers the
 * routes that need no session (login and registration are CSRF targets too).
 */
export function createSameOriginHook(options: {
  siteUrl: string;
  logger: Logger;
}): onRequestAsyncHookHandler {
  const siteOrigin = originOf(options.siteUrl);
  const { logger } = options;
  return async function requireSameOrigin(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    if (!UNSAFE_METHODS.has(request.method)) return;
    const claimed = claimedOrigin(request.headers);
    const own = requestOrigin(request);
    if (claimed !== undefined && (claimed === own || claimed === siteOrigin)) {
      return;
    }
    const surface = surfaceOf(request);
    if (claimed === undefined && mayOmitOrigin(request, surface)) return;
    logger.warn(
      `Refused ${request.method} ${loggableUrl(request)} from origin ${claimed ?? 'none'} (accepts ${own} and ${siteOrigin ?? 'no SITE_URL'})`,
    );
    return refuseCrossOrigin(request, reply, surface);
  };
}

/** The 403, in the surface's own error shape. */
function refuseCrossOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  surface: Surface,
): FastifyReply {
  switch (surface) {
    case 'api':
      return sendProblem(request, reply, {
        status: 403,
        message: CROSS_ORIGIN_REFUSED,
        code: 'forbidden',
      });
    case 'oauth':
      return sendOAuthError(reply, 403, 'forbidden', CROSS_ORIGIN_REFUSED);
    case 'mcp':
    case 'page':
      return reply
        .status(403)
        .type('text/plain; charset=utf-8')
        .send(CROSS_ORIGIN_REFUSED);
  }
}
