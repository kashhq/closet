import { describe, expect, it } from 'vitest';
import {
  authorizationServerMetadata,
  mcpChallenge,
  oauthDiscovery,
  protectedResourceMetadata,
} from './discovery';

const on = oauthDiscovery(
  'https://Closet-MCP.example.com/mcp',
  'https://closet.example.com/app',
)!;

describe('oauthDiscovery', () => {
  it('is off without MCP_PUBLIC_URL', () => {
    expect(oauthDiscovery(undefined, 'https://closet.example.com')).toBe(
      undefined,
    );
  });

  it('takes the resource as given, its origin as the issuer, and authorizes on SITE_URL', () => {
    expect(on).toEqual({
      resource: 'https://closet-mcp.example.com/mcp',
      issuer: 'https://closet-mcp.example.com',
      resourceMetadataUrl:
        'https://closet-mcp.example.com/.well-known/oauth-protected-resource/mcp',
      authorizationEndpoint: 'https://closet.example.com/oauth/authorize',
      tokenEndpoint: 'https://closet-mcp.example.com/oauth/token',
    });
  });
});

describe('the documents', () => {
  it('names the resource and its one authorization server (RFC 9728)', () => {
    expect(protectedResourceMetadata(on)).toEqual({
      resource: 'https://closet-mcp.example.com/mcp',
      authorization_servers: ['https://closet-mcp.example.com'],
      scopes_supported: ['closet:read', 'closet:write'],
      bearer_methods_supported: ['header'],
      resource_name: 'Closet',
    });
  });

  it('advertises CIMD, public clients and S256 only, with no registration endpoint (RFC 8414)', () => {
    const metadata = authorizationServerMetadata(on);
    expect(metadata).toEqual({
      issuer: 'https://closet-mcp.example.com',
      authorization_endpoint: 'https://closet.example.com/oauth/authorize',
      token_endpoint: 'https://closet-mcp.example.com/oauth/token',
      scopes_supported: ['closet:read', 'closet:write'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(metadata).not.toHaveProperty('registration_endpoint');
  });
});

describe('mcpChallenge', () => {
  it('is the bare realm with OAuth off', () => {
    expect(mcpChallenge(undefined)).toBe('Bearer realm="closet"');
  });

  it('points at the resource metadata and the scopes with OAuth on', () => {
    expect(mcpChallenge(on)).toBe(
      'Bearer realm="closet", resource_metadata="https://closet-mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="closet:read closet:write"',
    );
  });

  it('says invalid_token before the pointer for a refused token', () => {
    expect(mcpChallenge(undefined, { invalidToken: true })).toBe(
      'Bearer realm="closet", error="invalid_token"',
    );
    expect(mcpChallenge(on, { invalidToken: true })).toBe(
      'Bearer realm="closet", error="invalid_token", resource_metadata="https://closet-mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="closet:read closet:write"',
    );
  });
});
