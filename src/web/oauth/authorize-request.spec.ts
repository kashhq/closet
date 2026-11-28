import { describe, expect, it } from 'vitest';
import { formTargetOrigin } from '../security/csp';
import {
  checkAuthorizeQuery,
  type ClientMetadata,
  clientIdUrl,
  displayText,
  NAME_MAX,
  readClientMetadata,
  redirectMatches,
  redirectWith,
  STATE_MAX,
  URL_MAX,
} from './authorize-request';
import { CONSENT_FIELD_MAX, createConsentTokens } from './consent-token';

const CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const RESOURCE = 'https://closet-mcp.example.com/mcp';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('clientIdUrl', () => {
  it('takes an https document URL as written', () => {
    expect(clientIdUrl(CLIENT_ID)?.href).toBe(CLIENT_ID);
  });

  it.each([
    ['http', 'http://claude.ai/oauth/meta'],
    ['no path', 'https://claude.ai/'],
    ['a query', 'https://claude.ai/meta?x=1'],
    ['a bare ?', 'https://claude.ai/meta?'],
    ['a fragment', 'https://claude.ai/meta#x'],
    ['credentials', 'https://user@claude.ai/meta'],
    ['a backslash', 'https://claude.ai\\meta'],
    ['dot segments', 'https://claude.ai/a/../meta'],
    ['an upper-case host the parser rewrites', 'https://Claude.ai/meta'],
    ['an IPv6 literal', 'https://[::1]/meta'],
    ['an IPv4 literal', 'https://127.0.0.1/meta'],
    ['a public IPv4 literal', 'https://8.8.8.8/meta'],
    ['a hex IP', 'https://0x7f000001/meta'],
    ['a decimal IP', 'https://2130706433/meta'],
    ['localhost', 'https://localhost/meta'],
    ['a .localhost name', 'https://app.localhost/meta'],
    ['an .internal name', 'https://metadata.google.internal/meta'],
    ['a .local name', 'https://nas.local/meta'],
    ['a dotless name', 'https://intranet/meta'],
    ['too long', `https://claude.ai/${'a'.repeat(URL_MAX)}`],
  ])('refuses %s', (_label, raw) => {
    expect(clientIdUrl(raw)).toBeUndefined();
  });

  it('refuses a repeated parameter or none', () => {
    expect(clientIdUrl([CLIENT_ID, CLIENT_ID])).toBeUndefined();
    expect(clientIdUrl(undefined)).toBeUndefined();
  });
});

describe('readClientMetadata', () => {
  const url = new URL(CLIENT_ID);
  const doc = (extra: Record<string, unknown> = {}) => ({
    client_id: CLIENT_ID,
    client_name: 'Claude',
    redirect_uris: [CALLBACK],
    ...extra,
  });

  it('reads the name and redirect URIs, ignoring other members', () => {
    expect(
      readClientMetadata(doc({ logo_uri: 'https://x.test/l.png' }), url),
    ).toEqual({
      clientId: CLIENT_ID,
      clientName: 'Claude',
      redirectUris: [CALLBACK],
    });
  });

  it('names a client that gives no name by its host', () => {
    expect(readClientMetadata(doc({ client_name: ' \u200B ' }), url)).toEqual(
      expect.objectContaining({ clientName: 'claude.ai' }),
    );
  });

  it.each([
    ['a client_id that is not its URL', doc({ client_id: `${CLIENT_ID}/` })],
    ['no redirect URIs', doc({ redirect_uris: [] })],
    [
      'six redirect URIs',
      doc({ redirect_uris: Array.from({ length: 6 }, () => CALLBACK) }),
    ],
    [
      'an http redirect off loopback',
      doc({ redirect_uris: ['http://x.test/cb'] }),
    ],
    ['a redirect with a fragment', doc({ redirect_uris: [`${CALLBACK}#x`] })],
    [
      'a redirect past the cap',
      doc({ redirect_uris: [`https://x.test/${'a'.repeat(URL_MAX)}`] }),
    ],
    [
      'a confidential client',
      doc({ token_endpoint_auth_method: 'client_secret_basic' }),
    ],
    ['another flow', doc({ grant_types: ['client_credentials'] })],
    ['not an object', [CALLBACK]],
  ])('refuses %s', (_label, document) => {
    expect(readClientMetadata(document, url)).toHaveProperty('refused');
  });
});

describe('redirectMatches', () => {
  const loopback = ['http://127.0.0.1/callback', 'http://localhost:8080/cb'];

  it('matches a listed URI exactly', () => {
    expect(redirectMatches([CALLBACK], CALLBACK)).toBe(true);
  });

  it.each([
    ['an extra slash', `${CALLBACK}/`],
    ['an added query', `${CALLBACK}?x=1`],
    ['http for https', CALLBACK.replace('https:', 'http:')],
    [
      'the default port written out',
      'https://claude.ai:443/api/mcp/auth_callback',
    ],
    ['another case', CALLBACK.replace('claude', 'Claude')],
    ['punycode for a listed IDN', new URL('https://claudé.ai/cb').href],
  ])('refuses %s', (_label, presented) => {
    expect(redirectMatches([CALLBACK, 'https://claudé.ai/cb'], presented)).toBe(
      false,
    );
  });

  it('matches a loopback entry on any port, nothing else about it', () => {
    expect(redirectMatches(loopback, 'http://127.0.0.1:53682/callback')).toBe(
      true,
    );
    expect(redirectMatches(loopback, 'http://localhost:1234/cb')).toBe(true);
    expect(redirectMatches(loopback, 'http://localhost/cb')).toBe(true);
    expect(redirectMatches(loopback, 'http://127.0.0.1:5/callback/')).toBe(
      false,
    );
    expect(redirectMatches(loopback, 'http://127.0.0.1:5/callback?x')).toBe(
      false,
    );
    expect(redirectMatches(loopback, 'http://localhost:5/callback')).toBe(
      false,
    );
    expect(redirectMatches(loopback, 'https://127.0.0.1:5/callback')).toBe(
      false,
    );
  });
});

describe('checkAuthorizeQuery', () => {
  const client: ClientMetadata = {
    clientId: CLIENT_ID,
    clientName: 'Claude',
    redirectUris: [CALLBACK],
  };
  const query = (extra: Record<string, unknown> = {}) => ({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'st-1',
    scope: 'closet:read closet:write',
    resource: RESOURCE,
    ...extra,
  });
  const check = (extra?: Record<string, unknown>) =>
    checkAuthorizeQuery(query(extra), client, CALLBACK, RESOURCE);

  it('proves a well-formed request', () => {
    expect(check()).toEqual({
      ok: true,
      request: {
        clientId: CLIENT_ID,
        clientName: 'Claude',
        redirectUri: CALLBACK,
        codeChallenge: CHALLENGE,
        state: 'st-1',
        writeRequested: true,
      },
    });
  });

  it('takes a request without state, and read alone without scope', () => {
    const result = check({ state: undefined, scope: undefined });
    expect(result).toMatchObject({
      ok: true,
      request: { writeRequested: false },
    });
    expect(result.ok && 'state' in result.request).toBe(false);
  });

  it.each([
    [
      'a repeated resource',
      { resource: [RESOURCE, RESOURCE] },
      'invalid_target',
    ],
    ['a repeated state', { state: ['a', 'b'] }, 'invalid_request'],
    [
      'a repeated scope',
      { scope: ['closet:read', 'closet:read'] },
      'invalid_request',
    ],
    [
      'a state past the cap',
      { state: 'a'.repeat(STATE_MAX + 1) },
      'invalid_request',
    ],
    ['a state with a line break', { state: 'a\nb' }, 'invalid_request'],
    [
      'another response type',
      { response_type: 'token' },
      'unsupported_response_type',
    ],
    ['PKCE plain', { code_challenge_method: 'plain' }, 'invalid_request'],
    [
      'no challenge method',
      { code_challenge_method: undefined },
      'invalid_request',
    ],
    ['no challenge', { code_challenge: undefined }, 'invalid_request'],
    [
      'a short challenge',
      { code_challenge: 'a'.repeat(42) },
      'invalid_request',
    ],
    [
      'another resource',
      { resource: 'https://evil.test/mcp' },
      'invalid_target',
    ],
    ['no resource', { resource: undefined }, 'invalid_target'],
    ['an unknown scope', { scope: 'closet:read admin' }, 'invalid_scope'],
  ])('refuses %s', (_label, extra, error) => {
    expect(check(extra)).toMatchObject({ ok: false, error });
  });

  it('keeps a valid state for the error, never an invalid one', () => {
    expect(check({ response_type: 'token' })).toMatchObject({ state: 'st-1' });
    expect(check({ state: 'a\nb' })).not.toHaveProperty('state', 'a\nb');
  });
});

describe('displayText', () => {
  it('strips bidi controls, zero-width characters and line breaks, then NFKC', () => {
    expect(displayText('Clau\u202Ede\u2066x\u2069\u200B\u200E\u061C', 60)).toBe(
      'Clau de x',
    );
    expect(displayText('Closet\nsecurity\r\ncheck', 60)).toBe(
      'Closet security check',
    );
    expect(displayText('Ｃｌｏｓｅｔ', 60)).toBe('Closet');
  });

  it('cuts at the cap by characters', () => {
    expect([...displayText('é'.repeat(100), NAME_MAX)]).toHaveLength(NAME_MAX);
  });
});

describe('redirectWith', () => {
  it('adds the parameters to a query the URI already has', () => {
    expect(
      redirectWith('https://app.test/cb?keep=1', {
        code: 'c&d',
        state: undefined,
        iss: 'https://closet-mcp.example.com',
      }),
    ).toBe(
      'https://app.test/cb?keep=1&code=c%26d&iss=https%3A%2F%2Fcloset-mcp.example.com',
    );
  });
});

describe('the signed consent field', () => {
  const tokens = createConsentTokens('a-secret', 'https://closet.example.com');

  it('fits CONSENT_FIELD_MAX with every claim at its cap', () => {
    const field = tokens.sign({
      clientId: `https://claude.ai/${'a'.repeat(URL_MAX - 18)}`,
      clientName: '\u{1F600}'.repeat(NAME_MAX),
      redirectUri: `https://claude.ai/${'"'.repeat(URL_MAX - 18)}`,
      codeChallenge: 'a'.repeat(128),
      state: '"'.repeat(STATE_MAX),
      writeRequested: true,
    });
    expect(field.length).toBeLessThanOrEqual(CONSENT_FIELD_MAX);
  });

  it('refuses another key, another audience and a session token', () => {
    const request = {
      clientId: CLIENT_ID,
      clientName: 'Claude',
      redirectUri: CALLBACK,
      codeChallenge: CHALLENGE,
      writeRequested: false,
    };
    expect(tokens.verify(tokens.sign(request))).toEqual({ ok: true, request });
    const other = createConsentTokens('another', 'https://closet.example.com');
    expect(tokens.verify(other.sign(request))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    const elsewhere = createConsentTokens('a-secret', 'https://evil.test');
    expect(tokens.verify(elsewhere.sign(request)).ok).toBe(false);
    expect(tokens.verify('eyJhbGciOiJub25lIn0.e30.').ok).toBe(false);
  });
});

describe('formTargetOrigin', () => {
  it('is the scheme, host and port alone', () => {
    expect(formTargetOrigin(new URL(CALLBACK))).toBe('https://claude.ai');
    expect(formTargetOrigin(new URL('http://127.0.0.1:5000/cb?x'))).toBe(
      'http://127.0.0.1:5000',
    );
    expect(
      formTargetOrigin(new URL("https://évil.test/;'unsafe-inline'")),
    ).toBe('https://xn--vil-9la.test');
    expect(formTargetOrigin(new URL('https://[::1]:8443/'))).toBe(
      'https://[::1]:8443',
    );
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd'])(
    'refuses %s',
    (raw) => {
      expect(() => formTargetOrigin(new URL(raw))).toThrow();
    },
  );
});
