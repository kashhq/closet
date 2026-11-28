import { BEARER_CHALLENGE } from '../errors';

/**
 * OAuth for /mcp (#681; docs/plans/2026-11-27-mcp-oauth.md 4.1, 4.2): the
 * names and documents an MCP client discovers it by. Pure: derived once
 * from MCP_PUBLIC_URL and SITE_URL, which loadConfig has already proved
 * (https both, MCP_PUBLIC_URL the origin plus /mcp on an allowed host).
 */

/** What a grant may do: read the wardrobe, or change it too. */
export const OAUTH_SCOPES = ['closet:read', 'closet:write'] as const;

/** RFC 9728 section 3: the well-known name, then the resource's path. */
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
/** RFC 8414 section 3: the issuer has no path, so nothing follows it. */
export const AUTHORIZATION_SERVER_PATH =
  '/.well-known/oauth-authorization-server';
/** OpenID Connect Discovery's name, which MCP clients try after RFC 8414's. */
export const OPENID_CONFIGURATION_PATH = '/.well-known/openid-configuration';
/** The consent page (#1290), on SITE_URL: the tailnet only. */
export const AUTHORIZE_PATH = '/oauth/authorize';
/** The token endpoint (#1291), on the public MCP host. */
export const TOKEN_PATH = '/oauth/token';

export interface OAuthDiscovery {
  /** MCP_PUBLIC_URL itself: the resource a token is for (RFC 8707). */
  resource: string;
  /** The resource's origin, where the token endpoint and metadata live. */
  issuer: string;
  /** The Protected Resource Metadata's URL, which the 401 names. */
  resourceMetadataUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

/**
 * OAuth's names, or undefined when MCP_PUBLIC_URL is unset: OAuth is off,
 * the documents are 404 and the /mcp 401 points nowhere. The authorization
 * endpoint is on SITE_URL, another host than the issuer, which RFC 8414
 * allows: only the person's browser goes there (plan 4.1).
 */
export function oauthDiscovery(
  mcpPublicUrl: string | undefined,
  siteUrl: string,
): OAuthDiscovery | undefined {
  if (mcpPublicUrl === undefined) return undefined;
  const resource = new URL(mcpPublicUrl);
  const issuer = resource.origin;
  return {
    resource: resource.href,
    issuer,
    resourceMetadataUrl: `${issuer}${PROTECTED_RESOURCE_PATH}${resource.pathname}`,
    authorizationEndpoint: `${new URL(siteUrl).origin}${AUTHORIZE_PATH}`,
    tokenEndpoint: `${issuer}${TOKEN_PATH}`,
  };
}

/** RFC 9728 section 2, answered at both PROTECTED_RESOURCE_PATH names. */
export function protectedResourceMetadata(discovery: OAuthDiscovery) {
  return {
    resource: discovery.resource,
    authorization_servers: [discovery.issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Closet',
  };
}

/**
 * RFC 8414 section 2. Clients register by Client ID Metadata Document only
 * (plan 4.3), so there is no `registration_endpoint`, and public clients
 * with PKCE S256 only. Refresh tokens are always issued, so no
 * `offline_access` scope.
 */
export function authorizationServerMetadata(discovery: OAuthDiscovery) {
  return {
    issuer: discovery.issuer,
    authorization_endpoint: discovery.authorizationEndpoint,
    token_endpoint: discovery.tokenEndpoint,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    // draft-ietf-oauth-client-id-metadata-document, which MCP 2026-07-28
    // says to advertise; RFC 9207 for `iss` on the redirect.
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * /mcp's 401 challenge. With OAuth on it names the Protected Resource
 * Metadata and the scopes to ask for (RFC 9728 section 5.1, MCP's
 * discovery): a client that sent no token learns where to get one. A
 * hosted client reads it only on a 401, never a 200.
 */
export function mcpChallenge(discovery: OAuthDiscovery | undefined): string {
  if (discovery === undefined) return BEARER_CHALLENGE;
  return `${BEARER_CHALLENGE}, resource_metadata="${discovery.resourceMetadataUrl}", scope="${OAUTH_SCOPES.join(' ')}"`;
}
