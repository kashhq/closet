import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { type Static, Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { BearerRefusalLimit } from '../auth/bearer-gate';
import { sendOAuthError } from '../errors';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { NotServed } from '../refusals';
import {
  countAgainst,
  OAUTH_TOKEN_LIMIT,
  tooManyAttempts,
} from '../security/rate-limit';
import { URL_MAX } from './authorize-request';
import { TOKEN_PATH } from './discovery';
import {
  type CodeExchange,
  exchangeCode,
  type GrantResult,
  type IssuedTokens,
  refreshGrant,
  type RefreshRequest,
} from './grants';

/**
 * Every parameter: one string (a repeat is the form parser's array, which
 * the schema refuses, RFC 6749 3.2), at most URL_MAX (the longest is a
 * client_id or redirect_uri, which the consent capped there), and no
 * control character: Postgres refuses a NUL in text, so `%00` would be a
 * 500, and none belongs in any value here.
 */
const Param = Type.String({
  maxLength: URL_MAX,
  pattern: '^[^\\u0000-\\u001F\\u007F]*$',
});

// Unknown parameters are allowed and ignored (RFC 6749 3.2); `scope` too:
// the answer states the grant's, never wider (RFC 6749 5.1).
const TokenBody = Type.Object({
  grant_type: Type.Optional(Param),
  code: Type.Optional(Param),
  code_verifier: Type.Optional(Param),
  redirect_uri: Type.Optional(Param),
  client_id: Type.Optional(Param),
  resource: Type.Optional(Param),
  refresh_token: Type.Optional(Param),
  client_secret: Type.Optional(Param),
  client_assertion: Type.Optional(Param),
  client_assertion_type: Type.Optional(Param),
});

/** RFC 7636 4.1: 43 to 128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const FORM = 'application/x-www-form-urlencoded';
// RFC 6749 5.1 and 5.2: no cache keeps a token or a refusal.
const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };
// A body holds a few short parameters; a client document's longest is URL_MAX.
const BODY_LIMIT = 8 * 1024;

type TokenError =
  | 'invalid_request'
  | 'invalid_client'
  | 'unsupported_grant_type'
  | 'invalid_grant'
  | 'invalid_target';

interface TokenRefusal {
  error: TokenError;
  /** For the log line only, never the answer. */
  reason: string;
  /** A real grant's refusal: past the budget it stays this, never the 429. */
  known?: boolean;
  /** Agent Access full: its own description. */
  full?: true;
  /** Client authentication sent in `Authorization` (RFC 6749 5.2's MUST). */
  basicChallenge?: true;
}

const STATUS: Record<TokenError, number> = {
  invalid_request: 400,
  invalid_client: 401,
  unsupported_grant_type: 400,
  invalid_grant: 400,
  invalid_target: 400,
};

function description(refusal: TokenRefusal): string {
  if (refusal.full) return t('oauth.TOKEN_FULL');
  switch (refusal.error) {
    case 'invalid_request':
      return t('oauth.TOKEN_INVALID_REQUEST');
    case 'invalid_client':
      return t('oauth.TOKEN_CLIENT_AUTHENTICATION');
    case 'unsupported_grant_type':
      return t('oauth.TOKEN_UNSUPPORTED_GRANT');
    case 'invalid_target':
      return t('oauth.TOKEN_INVALID_TARGET');
    case 'invalid_grant':
      return t('oauth.TOKEN_INVALID_GRANT');
  }
}

const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;

function grantLabel(grantType: string | undefined): string {
  if (grantType === undefined) return 'none';
  return (GRANT_TYPES as readonly string[]).includes(grantType)
    ? grantType
    : 'unsupported';
}

/** The media type alone, in any case: `; charset=UTF-8` and the like are fine. */
function isForm(contentType: string | undefined): boolean {
  return contentType?.split(';', 1)[0].trim().toLowerCase() === FORM;
}

type TokenBody = Static<typeof TokenBody>;

/** The body unread: not a form, or parameters the schema refused. */
function requestRefusal(request: FastifyRequest): TokenRefusal | undefined {
  if (!isForm(request.headers['content-type'])) {
    return { error: 'invalid_request', reason: 'not a form body' };
  }
  // ajv's message names the parameter and the rule, never the value.
  if (request.validationError) {
    return {
      error: 'invalid_request',
      reason: `malformed parameters: ${request.validationError.message}`,
    };
  }
  return undefined;
}

/** Client authentication (public clients send none), then a grant type at all. */
function clientRefusal(
  authorization: string | undefined,
  body: TokenBody,
): TokenRefusal | undefined {
  if (authorization !== undefined) {
    return {
      error: 'invalid_client',
      reason: 'client authentication in Authorization',
      basicChallenge: true,
    };
  }
  if (
    body.client_secret !== undefined ||
    body.client_assertion !== undefined ||
    body.client_assertion_type !== undefined
  ) {
    return {
      error: 'invalid_client',
      reason: 'client authentication in the body',
    };
  }
  if (body.grant_type === undefined) {
    return { error: 'invalid_request', reason: 'no grant_type' };
  }
  return undefined;
}

const MISSING: TokenRefusal = {
  error: 'invalid_request',
  reason: 'a required parameter missing',
};
const OTHER_RESOURCE: TokenRefusal = {
  error: 'invalid_target',
  reason: 'resource is not MCP_PUBLIC_URL',
};

/** The code grant's parameters, each present and well formed. */
function codeExchangeOf(
  body: TokenBody,
  resource: string,
): CodeExchange | TokenRefusal {
  const { code, code_verifier, redirect_uri, client_id } = body;
  if (
    code === undefined ||
    code_verifier === undefined ||
    redirect_uri === undefined ||
    client_id === undefined
  ) {
    return MISSING;
  }
  // Malformed, so refused before the code is claimed: it is not burned.
  if (!VERIFIER.test(code_verifier)) {
    return { error: 'invalid_request', reason: 'malformed code_verifier' };
  }
  // MCP: the client MUST send the resource it wants a token for.
  if (body.resource !== resource) return OTHER_RESOURCE;
  return {
    code,
    verifier: code_verifier,
    redirectUri: redirect_uri,
    clientId: client_id,
    resource,
  };
}

/**
 * The refresh grant's parameters. client_id is required: OAuth 2.1 has a
 * public client send it, and the rotation binds to it. `resource` is
 * optional here, but only ever this one.
 */
function refreshRequestOf(
  body: TokenBody,
  resource: string,
): RefreshRequest | TokenRefusal {
  const { refresh_token, client_id } = body;
  if (refresh_token === undefined || client_id === undefined) return MISSING;
  if (body.resource !== undefined && body.resource !== resource) {
    return OTHER_RESOURCE;
  }
  return { refreshToken: refresh_token, clientId: client_id };
}

/**
 * `POST /oauth/token` (#1291; src/web/oauth/AGENTS.md, plan 4.2 steps 8-9,
 * 4.5, 4.6): the token endpoint, on the `oauth` surface (public MCP host,
 * no cookie, JSON errors), called by an agent vendor's servers. Public
 * clients only (`none`): any client authentication is `invalid_client`.
 * The checks run in order and the first refusal answers: a form body, the
 * schema, no client authentication, the grant type; then the grant's own
 * (grants.ts). Every answer is `no-store`; the route is `secretPath` and
 * the body is never logged.
 *
 * OAUTH_TOKEN_LIMIT counts refusals only, per address, so a healthy
 * client's hourly refresh never spends it; a body the parser refuses (413,
 * 415) is the root handler's `invalid_request` and is not counted.
 */
export const oauthTokenRoutes: FastifyPluginCallbackTypebox<
  WebOptions & BearerRefusalLimit
> = (app, { config, db, logger, refusalSummaries }, done) => {
  const log = logger.child({ logger: 'OAuth' });
  const { oauth } = config;
  const tokenLimit = app.createRateLimit(OAUTH_TOKEN_LIMIT);

  const refuse = async (
    request: FastifyRequest,
    reply: FastifyReply,
    grant: string,
    refusal: TokenRefusal,
  ): Promise<FastifyReply> => {
    refusalSummaries.flushEnded();
    const exceeded = await countAgainst(tokenLimit, request);
    const kind = `OAuth token ${refusal.error}`;
    if (exceeded) {
      refusalSummaries.suppress(
        request.ip,
        refusal.known ? kind : `${kind}, 429`,
        exceeded.ttlMs,
      );
      if (!refusal.known) {
        throw tooManyAttempts(exceeded.ttlInSeconds, { quiet: true });
      }
    } else {
      log.warn(
        `OAuth token request (${grant}) refused: ${refusal.reason} (${refusal.error}) from ${request.ip}`,
      );
    }
    if (refusal.basicChallenge) {
      reply.header('WWW-Authenticate', 'Basic realm="closet"');
    }
    return sendOAuthError(
      reply,
      STATUS[refusal.error],
      refusal.error,
      description(refusal),
    );
  };

  const answer = (tokens: IssuedTokens) => ({
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: tokens.scope,
  });

  const settle = (
    request: FastifyRequest,
    reply: FastifyReply,
    grant: string,
    result: GrantResult,
  ) =>
    result.granted
      ? reply.send(answer(result.tokens))
      : refuse(request, reply, grant, result.refusal);

  app.post(
    TOKEN_PATH,
    {
      config: { public: true, surface: 'oauth', secretPath: true },
      bodyLimit: BODY_LIMIT,
      schema: { body: TokenBody },
      // The handler refuses a schema failure itself, so it is counted.
      attachValidation: true,
      // Before anything can answer, the root handler's errors included.
      onRequest: async (_request, reply) => {
        reply.headers(NO_STORE);
      },
    },
    async (request, reply) => {
      if (oauth === undefined) {
        throw new NotServed({ logDetail: 'OAuth off (MCP_PUBLIC_URL unset)' });
      }
      const unread = requestRefusal(request);
      if (unread) return refuse(request, reply, 'unread', unread);
      const { body } = request;
      // The log line's word for it: never the client's own text.
      const grant = grantLabel(body.grant_type);
      const refusal = clientRefusal(request.headers.authorization, body);
      if (refusal) return refuse(request, reply, grant, refusal);

      if (body.grant_type === 'authorization_code') {
        const exchange = codeExchangeOf(body, oauth.resource);
        if ('error' in exchange) {
          return refuse(request, reply, grant, exchange);
        }
        const result = await exchangeCode({ db, logger: log }, exchange);
        return settle(request, reply, grant, result);
      }
      if (body.grant_type === 'refresh_token') {
        const asked = refreshRequestOf(body, oauth.resource);
        if ('error' in asked) return refuse(request, reply, grant, asked);
        const result = await refreshGrant({ db, logger: log }, asked);
        return settle(request, reply, grant, result);
      }
      return refuse(request, reply, grant, {
        error: 'unsupported_grant_type',
        reason: 'an unsupported grant_type',
      });
    },
  );
  done();
};
