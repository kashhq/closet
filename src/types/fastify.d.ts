import type { RequestTiming } from '../metrics/request-timing';
import type { RequestContext } from '../request-context';
import type { TokenAuth } from '../web/auth/personal-tokens';
import type { AuthContext } from '../web/auth/session';
import type { ViewContext } from '../web/view-context';

// What the root hooks (app.ts) and the bearer surfaces add to Fastify's own types.
declare module 'fastify' {
  interface FastifyRequest {
    /** Session resolved once per request by the preValidation hook in app.ts (createSessionResolver, src/web/auth/session.ts). Undefined on static paths and for anonymous requests; requireSession guarantees it on every protected route. Read through sessionUserId(). */
    auth?: AuthContext;
    /** The personal access token a bearer surface (surfaceOf: /mcp, /api) was called with, set by that surface's own hook (/mcp's preValidation, src/web/mcp/routes.ts; /api's onRequest, src/web/api/token-auth.ts), which refuses every request without one. Never set from a cookie. */
    accessToken?: TokenAuth;
    /** Where this request's server time went (Server-Timing, src/metrics/http.ts): requestContext's timing, set by the first onRequest hook (registerRequestContext, src/request-context.ts). Absent only on a request Fastify answered before its hooks (a malformed URL). */
    timing?: RequestTiming;
    /** The request's id and timing as async context carries them (src/request-context.ts): re-entered after the body is read. Absent only before the first onRequest hook. */
    requestContext?: RequestContext;
  }

  interface FastifyReply {
    /** Page context built per request by the root preValidation hook (createViewContextBuilder); absent only on static paths. JSX pages read it through viewContext(reply). */
    locals?: ViewContext;
  }
}
