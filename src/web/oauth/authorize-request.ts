import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { isIP } from 'node:net';
import { OAUTH_SCOPES } from './discovery';

/**
 * What `GET /oauth/authorize` asks of a request (#1290; src/web/oauth/
 * AGENTS.md, docs/plans/2026-11-27-mcp-oauth.md 4.2 step 6, 4.3): the
 * `client_id` URL's shape, its Client ID Metadata Document's, the exact
 * `redirect_uri` match, then the rest of the query. Pure: the route fetches
 * the document between `clientIdUrl` and `provenRedirect`.
 *
 * Every cap here also sizes the consent page's signed field
 * (CONSENT_FIELD_MAX), so a request this accepts never fails the POST's
 * body schema.
 */

/** A `client_id` or a `redirect_uri`: Claude's are under 60 characters. */
export const URL_MAX = 512;
/** `state` (RFC 6749 VSCHAR, printable ASCII). */
export const STATE_MAX = 512;
/** RFC 7636 4.1: 43 to 128 unreserved characters. */
const CHALLENGE = /^[A-Za-z0-9\-._~]{43,128}$/;
const STATE = /^[\x20-\x7e]*$/;
/** What the page shows of a client's name, and the longest connection name. */
export const NAME_MAX = 60;
/** The metadata document's `redirect_uris`: a client lists a few. */
const REDIRECT_URIS_MAX = 5;

/**
 * Host names a public client's document never lives at: a name only this
 * network resolves. Address literals (any spelling the URL parser reads as
 * one, `0x7f000001` included) are refused by `isIP` on the parsed host.
 */
const LOCAL_SUFFIXES = ['.localhost', '.internal', '.local', '.home.arpa'];

/**
 * The `client_id` as a URL, or undefined when it cannot be a Client ID
 * Metadata Document's (draft-ietf-oauth-client-id-metadata-document 3):
 * https, a path, and nothing the URL parser would rewrite, so the string
 * compared with the document's `client_id` is the one fetched. No raw `?`,
 * `#`, `@` or `\` at all: a query, a fragment, credentials, and the
 * backslash WHATWG reads as a slash. A host that is an address or a local
 * name is refused before any lookup (the fetcher would refuse a private
 * one anyway; this also refuses a public address literal, which no vendor
 * publishes its document at).
 */
export function clientIdUrl(raw: unknown): URL | undefined {
  if (typeof raw !== 'string' || raw.length > URL_MAX) return undefined;
  if (/[?#@\\]/.test(raw)) return undefined;
  const url = URL.parse(raw);
  if (url === null || url.href !== raw || url.protocol !== 'https:') {
    return undefined;
  }
  return url.pathname === '/' || isLocalHost(url.hostname) ? undefined : url;
}

/** An address literal, or a name only this network resolves. */
function isLocalHost(host: string): boolean {
  return (
    host.startsWith('[') ||
    isIP(host) !== 0 ||
    !host.includes('.') ||
    host === 'localhost' ||
    LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

/** RFC 8252 7.3: a loopback redirect, which may be presented on any port. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A document's redirect URI it may list: https, or http on a loopback host,
 * at most URL_MAX, without credentials or a fragment, and written as the
 * URL parser writes it (so the exact match compares what a browser goes to).
 */
function listableRedirect(raw: string): boolean {
  if (raw.length > URL_MAX) return false;
  const url = URL.parse(raw);
  if (url === null || url.href !== raw) return false;
  if (url.username || url.password || url.hash || raw.includes('#')) {
    return false;
  }
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  );
}

/**
 * The Client ID Metadata Document (draft 4.1, RFC 7591 2): what Closet
 * reads, every other member ignored. `logo_uri`, `client_uri`, `tos_uri`
 * and `policy_uri` are never fetched or shown (src/web/oauth/AGENTS.md).
 */
const ClientMetadataDocument = Type.Object({
  client_id: Type.String({ maxLength: URL_MAX }),
  client_name: Type.Optional(Type.String({ maxLength: 1024 })),
  redirect_uris: Type.Array(Type.String({ maxLength: URL_MAX }), {
    minItems: 1,
    maxItems: REDIRECT_URIS_MAX,
  }),
  token_endpoint_auth_method: Type.Optional(Type.String()),
  grant_types: Type.Optional(Type.Array(Type.String())),
  response_types: Type.Optional(Type.Array(Type.String())),
});

export interface ClientMetadata {
  clientId: string;
  /** Sanitised and cut (displayText); the document's host when it gave none. */
  clientName: string;
  redirectUris: readonly string[];
}

/**
 * The document, or why it is refused (for the log line, never the page):
 * the schema, its `client_id` equal to the URL fetched byte for byte, a
 * public client (`none`), the code flow, and every redirect URI listable.
 */
export function readClientMetadata(
  document: unknown,
  clientId: URL,
): ClientMetadata | { refused: string } {
  if (!Value.Check(ClientMetadataDocument, document)) {
    return { refused: 'not a client metadata document' };
  }
  const doc: Static<typeof ClientMetadataDocument> = document;
  if (doc.client_id !== clientId.href) {
    return { refused: 'its client_id is not its URL' };
  }
  if ((doc.token_endpoint_auth_method ?? 'none') !== 'none') {
    return { refused: 'not a public client' };
  }
  if (
    !(doc.grant_types ?? ['authorization_code']).includes(
      'authorization_code',
    ) ||
    !(doc.response_types ?? ['code']).includes('code')
  ) {
    return { refused: 'not the authorization code flow' };
  }
  if (!doc.redirect_uris.every(listableRedirect)) {
    return { refused: 'a redirect URI that is neither https nor loopback' };
  }
  const name = displayText(doc.client_name ?? '', NAME_MAX);
  return {
    clientId: doc.client_id,
    clientName: name === '' ? clientId.hostname : name,
    redirectUris: doc.redirect_uris,
  };
}

/**
 * Whether `presented` is one of the document's redirect URIs: the exact
 * string (no normalisation: an extra slash, a query, a case or an IDN
 * spelled another way is another URI), except that a loopback entry
 * matches the same scheme, host string, path and query on any port
 * (RFC 8252 7.3), never `localhost` for `127.0.0.1`.
 */
export function redirectMatches(
  registered: readonly string[],
  presented: string,
): boolean {
  if (presented.length > URL_MAX) return false;
  if (registered.includes(presented)) return true;
  const url = URL.parse(presented);
  if (url === null || url.href !== presented || !isBare(url)) return false;
  return registered.some((entry) => {
    const listed = new URL(entry);
    return onLoopback(listed) && onLoopback(url) && samePlace(listed, url);
  });
}

function onLoopback(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/** No credentials and no fragment. */
function isBare(url: URL): boolean {
  return url.username === '' && url.password === '' && url.hash === '';
}

/** The same host string, path and query: everything but the port. */
function samePlace(a: URL, b: URL): boolean {
  return (
    a.hostname === b.hostname &&
    a.pathname === b.pathname &&
    a.search === b.search
  );
}

export function isLoopbackRedirect(redirectUri: string): boolean {
  return LOOPBACK_HOSTS.has(new URL(redirectUri).hostname);
}

/**
 * Bidi overrides and isolates (U+202A-E, U+2066-9), the marks
 * (U+200E/F, U+061C), zero-width characters (U+200B-D, U+2060, U+FEFF)
 * and every control character, line breaks included: what would let a
 * client's name read as something else, or as several lines.
 */
const HIDDEN =
  // eslint-disable-next-line no-control-regex -- the control characters are what it removes
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;

/**
 * Text a stranger or the user typed, as the page shows it: the hidden
 * characters removed, NFKC (so a fullwidth or styled letter is the letter),
 * whitespace collapsed, at most `max` characters. Removed before and after
 * NFKC, which can compose new code points but no hidden one from visible
 * ones.
 */
export function displayText(raw: string, max: number): string {
  const text = raw
    .replace(HIDDEN, ' ')
    .normalize('NFKC')
    .replace(HIDDEN, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return [...text].slice(0, max).join('').trim();
}

/** What the consent page and its POST carry: the request, proven. */
export interface ConsentRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  /** Absent when the client sent none (PKCE makes it optional). */
  state?: string;
  /** The client asked for `closet:write`: the page offers "Can make changes". */
  writeRequested: boolean;
}

/** An OAuth error for the redirect URI (RFC 6749 4.1.2.1, RFC 8707). */
export type AuthorizeError =
  | 'invalid_request'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'invalid_target';

export type AuthorizeCheck =
  | { ok: true; request: ConsentRequest }
  | { ok: false; error: AuthorizeError; state?: string };

/**
 * The query's other parameters, once `redirect_uri` is proven (step 6's
 * order): a repeated parameter is `invalid_request` (`invalid_target` for
 * `resource`), then the response type, PKCE S256, the resource and the
 * scope. The page shows the error with a link back (never a redirect of
 * its own: decisions 2026-11-28).
 */
export function checkAuthorizeQuery(
  query: Readonly<Record<string, unknown>>,
  client: ClientMetadata,
  redirectUri: string,
  resource: string,
): AuthorizeCheck {
  const single = (name: string) => {
    const value = query[name];
    return typeof value === 'string' ? value : undefined;
  };
  const repeated = (name: string) => Array.isArray(query[name]);
  const rawState = single('state');
  const state = validState(rawState);
  const refuse = (error: AuthorizeError): AuthorizeCheck => ({
    ok: false,
    error,
    state,
  });
  if (repeated('resource')) return refuse('invalid_target');
  if (Object.keys(query).some(repeated)) return refuse('invalid_request');
  if (rawState !== undefined && state === undefined) {
    return refuse('invalid_request');
  }
  if (single('response_type') !== 'code') {
    return refuse('unsupported_response_type');
  }
  const challenge = s256Challenge(
    single('code_challenge_method'),
    single('code_challenge'),
  );
  if (challenge === undefined) return refuse('invalid_request');
  if (single('resource') !== resource) return refuse('invalid_target');
  // Absent is read alone (the page's default either way).
  const scopes = (single('scope') ?? '').split(' ').filter(Boolean);
  if (!scopes.every(isScope)) return refuse('invalid_scope');
  return {
    ok: true,
    request: {
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUri,
      codeChallenge: challenge,
      ...(state === undefined ? {} : { state }),
      writeRequested: scopes.includes('closet:write'),
    },
  };
}

/** `state` as sent, when it is one RFC 6749 allows and within its cap. */
function validState(raw: string | undefined): string | undefined {
  return raw !== undefined && raw.length <= STATE_MAX && STATE.test(raw)
    ? raw
    : undefined;
}

/** The challenge, when PKCE is S256 (never `plain`) and it is well formed. */
function s256Challenge(
  method: string | undefined,
  challenge: string | undefined,
): string | undefined {
  return method === 'S256' &&
    challenge !== undefined &&
    CHALLENGE.test(challenge)
    ? challenge
    : undefined;
}

function isScope(value: string): boolean {
  return (OAUTH_SCOPES as readonly string[]).includes(value);
}

/**
 * `redirectUri` with the response's parameters added (RFC 6749 4.1.2,
 * RFC 9207's `iss`), encoded by `URLSearchParams` and joined to any query
 * the URI already has, which is kept byte for byte (re-serialising it
 * through `searchParams` would rewrite its `%20` as `+`).
 */
export function redirectWith(
  redirectUri: string,
  params: Readonly<Record<string, string | undefined>>,
): string {
  const url = new URL(redirectUri);
  const added = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) added.append(name, value);
  }
  url.search = url.search === '' ? `${added}` : `${url.search}&${added}`;
  return url.href;
}
