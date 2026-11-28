import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { MCP_PATH } from '../page-cache';
import type { WebOptions } from '../plugin';
import { NotServed } from '../refusals';
import { enforceLimit, OAUTH_DISCOVERY_LIMIT } from '../security/rate-limit';
import {
  AUTHORIZATION_SERVER_PATH,
  authorizationServerMetadata,
  OPENID_CONFIGURATION_PATH,
  PROTECTED_RESOURCE_PATH,
  protectedResourceMetadata,
} from './discovery';

// The documents change only with MCP_PUBLIC_URL, at a deploy.
const DISCOVERY_CACHE = 'public, max-age=3600';

/**
 * OAuth's discovery documents (#681, src/web/oauth/AGENTS.md): public on
 * the `oauth` surface, called by an agent vendor's servers through the
 * public MCP host (no session, JSON errors). These exact routes win over
 * the shell's `/.well-known/*` catch-all, so no OAuth name is ever its
 * `{}`: with OAuth off (`config.oauth` undefined) each is a JSON 404, and
 * the OpenID name always is (Closet is no OpenID provider). One
 * OAUTH_DISCOVERY_LIMIT budget per address across them.
 */
export const oauthRoutes: FastifyPluginCallback<WebOptions> = (
  app,
  { config, logger },
  done,
) => {
  const log = logger.child({ logger: 'OAuth' });
  const { oauth } = config;
  const limit = app.createRateLimit(OAUTH_DISCOVERY_LIMIT);
  const route = { config: { public: true, surface: 'oauth' } } as const;

  if (oauth) {
    log.info(
      `OAuth discovery on: resource ${oauth.resource}, issuer ${oauth.issuer}`,
    );
  } else {
    log.info('OAuth off: MCP_PUBLIC_URL is unset, its documents answer 404');
  }

  const serve =
    (document: (() => object) | undefined) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      await enforceLimit(limit, request, { logger: log, who: request.ip });
      if (document === undefined) {
        throw new NotServed({
          logDetail: 'OAuth off or not an OpenID provider',
        });
      }
      return reply.header('Cache-Control', DISCOVERY_CACHE).send(document());
    };

  const resourceMetadata = oauth && (() => protectedResourceMetadata(oauth));
  // RFC 9728 section 3.1's name for the resource `/mcp`, and the bare name
  // MCP clients fall back to (MCP authorization, Protected Resource
  // Metadata Discovery): one resource, so one document at both.
  app.get(
    `${PROTECTED_RESOURCE_PATH}${MCP_PATH}`,
    route,
    serve(resourceMetadata),
  );
  app.get(PROTECTED_RESOURCE_PATH, route, serve(resourceMetadata));
  app.get(
    AUTHORIZATION_SERVER_PATH,
    route,
    serve(oauth && (() => authorizationServerMetadata(oauth))),
  );
  app.get(OPENID_CONFIGURATION_PATH, route, serve(undefined));
  done();
};
