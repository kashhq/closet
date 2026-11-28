import type { FastifyRequest } from 'fastify';
import type { TokenKind } from '../../credential-names';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import type { HttpError } from '../errors';
import { loggableUrl } from '../loggable-url';
import {
  countAgainst,
  type RateLimitChecker,
  tooManyAttempts,
} from '../security/rate-limit';
import { rememberShareReadAhead, shareToReadAhead } from '../sharing/access';
import { type PresentedBearer, presentedBearer } from './bearer';
import { authenticateToken, type TokenRefusal } from './personal-tokens';
import type { RefusalSummaries } from './refusal-summaries';

/**
 * BEARER_REFUSAL_LIMIT's one checker (src/web/security/rate-limit.ts),
 * built in webPlugin and handed to both bearer surfaces, so an address has
 * one refusal budget between /mcp and /api.
 */
export interface BearerRefusalLimit {
  bearerRefusalLimit: RateLimitChecker;
  /** What an address is refused past that budget, one line per window (#940). */
  refusalSummaries: RefusalSummaries;
}

/**
 * The one credential check of the bearer surfaces (#667): /api's for every
 * non-public route (apiPlugin), /mcp's for its routes. An onRequest hook,
 * after the root same-origin check and before Fastify reads or parses the
 * body, so a refused caller is the 401 whatever it sent (never a 400 for
 * malformed JSON or a 413 for a body past the limit) and its body is never
 * read. A missing, malformed or duplicate header costs no statement; a
 * `closet_` value one indexed read (authenticateToken), plus the last-use
 * write once a minute.
 *
 * Every refusal is charged to the address's BEARER_REFUSAL_LIMIT but an
 * expired OAuth access token, and only a refusal: a token that opens is
 * never counted there, so a household behind one address keeps working
 * while a stranger probes. An expired token is a healthy client's hourly
 * refresh cue, from a vendor's shared egress addresses, so it never spends
 * the budget (#1291). Past the budget, a missing, malformed or unknown
 * credential is the 429; a revoked, expired or other-kind token stays
 * `refusal()` (a signed-out device must still learn to sign in again). Logs the reason and the client address, never
 * the token: a refusal within the budget is a line of its own, those past
 * it are counted into one summary line per address per window
 * (RefusalSummaries), so a flood is not a log flood (#940).
 */
export function createBearerGate({
  db,
  logger,
  label,
  kind,
  refusalLimit,
  refusalSummaries,
  refusal,
  readsShare = false,
}: {
  db: Db;
  logger: Logger;
  /** The log lines' first word: `API`, `MCP`. */
  label: string;
  kind: TokenKind;
  refusalLimit: RateLimitChecker;
  refusalSummaries: RefusalSummaries;
  /**
   * The surface's 401; the root error handler adds WWW-Authenticate.
   * `presented`: a token was sent and refused (RFC 6750 3.1's
   * `invalid_token`), not missing or unreadable.
   */
  refusal: (presented: boolean) => HttpError;
  /** /api: a grantee's `?ownerId=` share rides in the token's read (#170). */
  readsShare?: boolean;
}) {
  /** Throws the refusal's answer, charged and logged as the rule above says. */
  async function refuse(
    request: FastifyRequest,
    refused: Refused,
    tokenRefused: boolean,
  ): Promise<never> {
    const reason = refusalReason(refused, kind);
    const line = `${label} ${request.method} ${loggableUrl(request)} refused: ${reason} from ${request.ip}`;
    if (refused === 'expired') {
      logger.info(line);
      throw refusal(tokenRefused);
    }
    refusalSummaries.flushEnded();
    const exceeded = await countAgainst(refusalLimit, request);
    if (!exceeded) {
      logger.warn(line);
      throw refusal(tokenRefused);
    }
    const known = refused === 'revoked' || refused === 'wrong kind';
    refusalSummaries.suppress(
      request.ip,
      known ? reason : `${reason}, 429`,
      exceeded.ttlMs,
    );
    if (!known) throw tooManyAttempts(exceeded.ttlInSeconds, { quiet: true });
    throw refusal(tokenRefused);
  }

  return async function requireBearer(request: FastifyRequest): Promise<void> {
    if (request.routeOptions.config.public === true) return;
    const presented = presentedBearer(request);
    const result =
      'token' in presented
        ? await authenticateToken(db, presented.token, kind, {
            shareOf: readsShare ? shareToReadAhead(request) : undefined,
          })
        : presented;
    if ('refused' in result) {
      await refuse(request, result.refused, 'token' in presented);
      return;
    }
    const { share, ...accessToken } = result;
    request.accessToken = accessToken;
    if (share) rememberShareReadAhead(request, share);
  };
}

type Refused =
  | TokenRefusal['refused']
  | Extract<PresentedBearer, { refused: string }>['refused'];

/** The log line's reason; the answer never says it. */
function refusalReason(refused: Refused, kind: TokenKind): string {
  switch (refused) {
    case 'unknown':
      return 'unknown token';
    case 'revoked':
      return 'revoked token';
    case 'expired':
      return 'expired token';
    case 'wrong kind':
      return `wrong kind of token (wants ${kind})`;
    default:
      return refused;
  }
}
