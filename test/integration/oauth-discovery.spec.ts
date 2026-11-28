import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, recordQueries, type TestApp } from './harness';
import { mcpRequest } from './mcp';

/**
 * OAuth discovery with OAuth on (#1289; docs/plans/2026-11-27-mcp-oauth.md
 * 4.2 steps 2-4), as a hosted client walks it on the public MCP host: the
 * /mcp 401, then the Protected Resource Metadata, then the Authorization
 * Server Metadata. OAuth off is pages.spec.ts's (the JSON 404s) and
 * mcp.spec.ts's (the bare challenge).
 */
const MCP_HOST = 'closet-mcp.example.com';
const RESOURCE = `https://${MCP_HOST}/mcp`;
const ISSUER = `https://${MCP_HOST}`;
const PRM_URL = `${ISSUER}/.well-known/oauth-protected-resource/mcp`;

describe('OAuth discovery for /mcp', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      SITE_URL: 'https://closet.example.com',
      ALLOWED_HOSTS: MCP_HOST,
      MCP_PUBLIC_URL: RESOURCE,
    });
  });

  afterAll(() => t?.cleanup());

  const fetchDocument = (url: string) =>
    t.inject({
      method: 'GET',
      url,
      anonymous: true,
      headers: { host: MCP_HOST },
    });

  it('answers a tokenless /mcp with the 401 that names the metadata and scopes', async () => {
    const res = await mcpRequest(
      t,
      undefined,
      'tools/list',
      {},
      {
        host: MCP_HOST,
      },
    );
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      `Bearer realm="closet", resource_metadata="${PRM_URL}", scope="closet:read closet:write"`,
    );
  });

  it('answers an unknown token with the same pointer', async () => {
    const res = await mcpRequest(t, `closet_${'A'.repeat(43)}`, 'tools/list');
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain(
      `resource_metadata="${PRM_URL}"`,
    );
  });

  it.each([
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-protected-resource',
  ])('serves the Protected Resource Metadata at %s', async (url) => {
    const res = await fetchDocument(url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: ['closet:read', 'closet:write'],
      bearer_methods_supported: ['header'],
      resource_name: 'Closet',
    });
  });

  it('serves the Authorization Server Metadata at the issuer, its consent page on SITE_URL', async () => {
    const res = await fetchDocument('/.well-known/oauth-authorization-server');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      issuer: ISSUER,
      authorization_endpoint: 'https://closet.example.com/oauth/authorize',
      token_endpoint: `${ISSUER}/oauth/token`,
      scopes_supported: ['closet:read', 'closet:write'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  it('is no OpenID provider: a JSON 404, never the catch-all', async () => {
    const res = await fetchDocument('/.well-known/openid-configuration');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: 'not_found',
      error_description: 'Not Found',
    });
  });

  it('reads no session: a signed-in cookie costs no statement', async () => {
    let status = 0;
    const record = await recordQueries(async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/.well-known/oauth-authorization-server',
        headers: { host: MCP_HOST },
      });
      status = res.statusCode;
    });
    expect(status).toBe(200);
    expect(record.statements).toBe(0);
  });
});
