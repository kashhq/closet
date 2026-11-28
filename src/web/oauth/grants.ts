import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { TOKEN_PREFIX } from '../../credential-names';
import type { Queryable } from '../../db/client';
import {
  oauthAuthorizationCode,
  oauthRetiredRefreshToken,
  personalAccessToken,
} from '../../db/schema';
import {
  hashToken,
  mintToken,
  oauthGrantNotIdleSql,
  type TokenScope,
} from '../auth/personal-tokens';
import { type ActionDeps, logOp } from '../op-log';
import type { Actor } from '../sharing/access';
import { CODE_PREFIX } from './codes';
import { OAUTH_SCOPES } from './discovery';

/**
 * OAuth's grants (#1291; src/web/oauth/AGENTS.md, plan 4.5): the token
 * endpoint's two grant types on the agent-token row. A grant is a
 * `personal_access_token` of kind `mcp` with an `oauth_client_id`, so
 * provenance, the feedback cursor, scope, the cap and revocation are an
 * agent token's. Its audience is its kind: an `mcp` token opens /mcp and
 * nothing else, and MCP_PUBLIC_URL is the one resource, so no audience is
 * stored; a second resource would need an audience column on the row,
 * checked at exchange, refresh and authenticateToken.
 *
 * Clocks: a code's times are Postgres's (`grantConsent` wrote them with
 * `now()`); a grant's are the app's `now`, as every token's (createToken,
 * idleExpired), since the clock shift moves only the app's.
 */

/** An access token's life (plan 4.5); a client refreshes before or on the 401. */
export const OAUTH_ACCESS_SECONDS = 60 * 60;
/** `closet_rt_` + 32 random bytes: scrubSecrets' `closet_` shape covers it. */
export const REFRESH_PREFIX = `${TOKEN_PREFIX}rt_`;

/** What a granted exchange or refresh answers, in the clear once. */
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  /** RFC 6749 5.1's `scope`: the grant's, whatever the client asked. */
  scope: string;
}

/**
 * Why a grant opens nothing. `error` is RFC 6749's word; `reason` names
 * the check for the log line, never the answer. `known`: the request named
 * a real grant (a used code, a revoked, idle or reused refresh token),
 * which stays `invalid_grant` past OAUTH_TOKEN_LIMIT so its client learns
 * to reconnect; `full`: the mint met MAX_ACTIVE_TOKENS.
 */
export interface GrantRefusal {
  error: 'invalid_grant' | 'invalid_target';
  reason: string;
  known: boolean;
  full?: true;
}

export type GrantResult =
  | { granted: true; tokens: IssuedTokens }
  | { granted: false; refusal: GrantRefusal };

export interface CodeExchange {
  code: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  /** Checked against MCP_PUBLIC_URL by the route, then against the code's. */
  resource: string;
}

export interface RefreshRequest {
  refreshToken: string;
  clientId: string;
}

const refused = (
  reason: string,
  { error = 'invalid_grant', known = false, full }: Partial<GrantRefusal> = {},
): GrantResult => ({
  granted: false,
  refusal: { error, reason, known, ...(full && { full }) },
});

const newToken = (prefix: string) =>
  `${prefix}${randomBytes(32).toString('base64url')}`;

/** RFC 7636 4.6: BASE64URL(SHA256(verifier)) is the challenge. */
function verifierMatches(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(
    createHash('sha256').update(verifier).digest('base64url'),
  );
  const stored = Buffer.from(challenge);
  return computed.length === stored.length && timingSafeEqual(computed, stored);
}

const scopeWords = (scope: TokenScope): string =>
  (scope.readOnly ? OAUTH_SCOPES.slice(0, 1) : OAUTH_SCOPES).join(' ');

const issued = (
  accessToken: string,
  refreshToken: string,
  scope: TokenScope,
): IssuedTokens => ({
  accessToken,
  refreshToken,
  expiresIn: OAUTH_ACCESS_SECONDS,
  scope: scopeWords(scope),
});

/** What the exchange reads of the code it claimed. */
const claimedColumns = {
  id: oauthAuthorizationCode.id,
  userId: oauthAuthorizationCode.userId,
  clientId: oauthAuthorizationCode.clientId,
  redirectUri: oauthAuthorizationCode.redirectUri,
  codeChallenge: oauthAuthorizationCode.codeChallenge,
  resource: oauthAuthorizationCode.resource,
  name: oauthAuthorizationCode.name,
  readOnly: oauthAuthorizationCode.readOnly,
  ownWardrobeOnly: oauthAuthorizationCode.ownWardrobeOnly,
  passwordFingerprint: oauthAuthorizationCode.passwordFingerprint,
};
type ClaimedCode = Pick<
  typeof oauthAuthorizationCode.$inferSelect,
  keyof typeof claimedColumns
>;

/**
 * `grant_type=authorization_code` (RFC 6749 4.1.3, RFC 7636 4.6). One
 * transaction, which commits on every path: the code is claimed first
 * (`used_at`, only while unused and unexpired), so **a code is one
 * attempt**: a wrong verifier, client, redirect or resource, a password
 * changed since consent, or Agent Access full each burn it, and a retry is
 * a replay. Then the checks against the claimed row, then the mint inside
 * the same transaction (mintToken: the user's lock, the fingerprint
 * recheck, the cap without this client's grant, and only then that grant
 * revoked), and the code pointed at its grant (`token_id`).
 *
 * A code that claims nothing is judged in a statement of its own, after the
 * transaction, on a fresh snapshot: a used one is **replay** (RFC 6749
 * 4.1.2's SHOULD), whose grant is revoked. A concurrent second use waits on
 * the claim's row lock, finds the code used once the first commits, and so
 * revokes what the first just minted. Accepted risk (decisions
 * 2026-11-28): a leaked code lets its holder end the grant, never use it.
 *
 * Lock order: the code row, then the user row; no writer takes them the
 * other way (a new password locks the user and never touches a code).
 */
export async function exchangeCode(
  { db, logger }: ActionDeps<Queryable>,
  exchange: CodeExchange,
  now = new Date(),
): Promise<GrantResult> {
  if (!exchange.code.startsWith(CODE_PREFIX)) return refused('not a code');
  const codeHash = hashToken(exchange.code);
  const refreshToken = newToken(REFRESH_PREFIX);
  const outcome = await db.transaction(async (tx) => {
    const [code] = await tx
      .update(oauthAuthorizationCode)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(oauthAuthorizationCode.codeHash, codeHash),
          isNull(oauthAuthorizationCode.usedAt),
          gt(oauthAuthorizationCode.expiresAt, sql`now()`),
        ),
      )
      .returning(claimedColumns);
    if (!code) return undefined;
    const actor: Actor = { userId: code.userId, surface: 'oauth' };
    const refusal = mismatchOf(code, exchange);
    if (refusal) return { code, actor, result: refusal };
    const scope: TokenScope = {
      readOnly: code.readOnly,
      ownWardrobeOnly: code.ownWardrobeOnly,
    };
    const minted = await mintToken(tx, actor, {
      kind: 'mcp',
      name: code.name,
      scope,
      verified: { passwordFingerprint: code.passwordFingerprint },
      oauth: {
        clientId: code.clientId,
        refreshTokenHash: hashToken(refreshToken),
        accessExpiresAt: new Date(now.getTime() + OAUTH_ACCESS_SECONDS * 1000),
      },
    });
    if (!minted.created) {
      return {
        code,
        actor,
        result:
          minted.reason === 'too-many'
            ? refused('Agent Access full', { full: true })
            : refused('password changed since consent'),
      };
    }
    await tx
      .update(oauthAuthorizationCode)
      .set({ tokenId: minted.id })
      .where(eq(oauthAuthorizationCode.id, code.id));
    return {
      code,
      actor,
      tokenId: minted.id,
      replacedIds: minted.replacedIds,
      result: {
        granted: true,
        tokens: issued(minted.token, refreshToken, scope),
      } satisfies GrantResult,
    };
  });
  if (outcome === undefined) {
    return unclaimedCode({ db, logger }, codeHash, now);
  }
  const { code, actor, result } = outcome;
  if (result.granted && 'tokenId' in outcome) {
    // After the commit: a rollback must leave no line for a grant never minted.
    logOp(logger, actor, 'oauth.grant.minted', {
      tokenId: outcome.tokenId,
      codeId: code.id,
      clientHost: new URL(code.clientId).hostname,
      replacedIds: outcome.replacedIds,
      readOnly: code.readOnly,
      ownWardrobeOnly: code.ownWardrobeOnly,
    });
  }
  return result;
}

/** The claimed code's checks, each a burned code's refusal (RFC 6749 4.1.3). */
function mismatchOf(
  code: ClaimedCode,
  exchange: CodeExchange,
): GrantResult | undefined {
  if (code.clientId !== exchange.clientId) {
    return refused("client_id is not the code's");
  }
  if (code.redirectUri !== exchange.redirectUri) {
    return refused("redirect_uri is not the code's");
  }
  if (code.resource !== exchange.resource) {
    return refused("resource is not the code's", { error: 'invalid_target' });
  }
  if (!verifierMatches(exchange.verifier, code.codeChallenge)) {
    return refused('PKCE verifier does not match');
  }
  return undefined;
}

/**
 * A code the claim did not take: used (replay: its grant revoked, in this
 * one statement), expired, or unknown. Its own statement, after the
 * claim's transaction, so it sees a racing first use's commit.
 */
async function unclaimedCode(
  { db, logger }: ActionDeps<Queryable>,
  codeHash: string,
  now: Date,
): Promise<GrantResult> {
  const { rows } = await db.execute<{
    code_id: number | null;
    used: boolean | null;
    token_id: number | null;
    revoked_id: number | null;
  }>(sql`
    with code as (
      select id, used_at is not null as used, token_id
      from ${oauthAuthorizationCode} where code_hash = ${codeHash}
    ), revoked as (
      update ${personalAccessToken} set revoked_at = ${now}
      where id = (select token_id from code where used) and revoked_at is null
      returning id
    )
    select (select id from code) as code_id, (select used from code) as used,
      (select token_id from code) as token_id,
      (select id from revoked) as revoked_id
  `);
  const [row] = rows;
  if (row.code_id === null) return refused('unknown code');
  if (!row.used) return refused('expired code');
  const revoked = row.revoked_id !== null;
  const state = revoked ? 'revoked' : 'already revoked';
  const outcome =
    row.token_id === null
      ? 'it minted no grant'
      : `grant ${row.token_id} ${state}`;
  logger.warn(
    {
      op: 'oauth.code.replayed',
      codeId: row.code_id,
      tokenId: row.token_id,
      revoked,
    },
    `OAuth code ${row.code_id} used again: ${outcome}`,
  );
  return refused('code used again', { known: true });
}

/**
 * `grant_type=refresh_token` (RFC 6749 6, OAuth 2.1 4.3.1's rotation for a
 * public client). The rotation is one statement keyed by the live refresh
 * token's hash: a new access token (the old one dies, its hash replaced), a
 * new refresh token, a new hour, the use stamped (a refresh is use, so idle
 * is 90 days with neither), and the presented hash added to the grant's
 * family (oauth_retired_refresh_token), only for a grant in force, of this
 * client, not idle (oauthGrantNotIdleSql, idleExpired's cutoff).
 *
 * Nothing rotated: a second statement, on a fresh snapshot, so it sees the
 * family row a racing winner committed. A retired hash of any generation
 * is **reuse**: the grant is revoked, whole, with no grace period (owner
 * 2026-11-27; decisions 2026-11-28), and two refreshes racing on one token
 * are reuse too, since nothing tells a lost answer from a thief. A live
 * one revoked, idle or of another client is refused as it stands; else
 * unknown. Every refusal is `invalid_grant`.
 */
export async function refreshGrant(
  { db, logger }: ActionDeps<Queryable>,
  { refreshToken, clientId }: RefreshRequest,
  now = new Date(),
): Promise<GrantResult> {
  if (!refreshToken.startsWith(REFRESH_PREFIX)) {
    return refused('not a refresh token');
  }
  const presented = hashToken(refreshToken);
  const accessToken = newToken(TOKEN_PREFIX);
  const nextRefresh = newToken(REFRESH_PREFIX);
  const expiresAt = new Date(now.getTime() + OAUTH_ACCESS_SECONDS * 1000);
  const { rows } = await db.execute<{
    id: number;
    user_id: number;
    read_only: boolean;
    own_wardrobe_only: boolean;
  }>(sql`
    with rotated as (
      update ${personalAccessToken}
      set token_hash = ${hashToken(accessToken)},
        refresh_token_hash = ${hashToken(nextRefresh)},
        access_expires_at = ${expiresAt}, last_used_at = ${now}
      where ${and(
        eq(personalAccessToken.refreshTokenHash, presented),
        eq(personalAccessToken.kind, 'mcp'),
        isNull(personalAccessToken.revokedAt),
        eq(personalAccessToken.oauthClientId, clientId),
        oauthGrantNotIdleSql(now),
      )}
      returning id, user_id, read_only, own_wardrobe_only
    ), retired as (
      insert into ${oauthRetiredRefreshToken} (refresh_token_hash, token_id, retired_at)
      select ${presented}::varchar, id, ${now}::timestamptz from rotated
    )
    select id, user_id, read_only, own_wardrobe_only from rotated
  `);
  const [grant] = rows;
  if (grant) {
    logOp(
      logger,
      { userId: grant.user_id, surface: 'oauth' },
      'oauth.grant.refreshed',
      {
        tokenId: grant.id,
      },
    );
    return {
      granted: true,
      tokens: issued(accessToken, nextRefresh, {
        readOnly: grant.read_only,
        ownWardrobeOnly: grant.own_wardrobe_only,
      }),
    };
  }
  return unrotated({ db, logger }, presented, clientId, now);
}

/** Why a refresh token rotated nothing, reuse revoking its grant in the same statement. */
async function unrotated(
  { db, logger }: ActionDeps<Queryable>,
  presented: string,
  clientId: string,
  now: Date,
): Promise<GrantResult> {
  const { rows } = await db.execute<{
    family_token_id: number | null;
    revoked_id: number | null;
    live_id: number | null;
    revoked: boolean | null;
    active: boolean | null;
    client_id: string | null;
  }>(sql`
    with family as (
      select token_id from ${oauthRetiredRefreshToken}
      where refresh_token_hash = ${presented}
    ), reused as (
      update ${personalAccessToken} set revoked_at = ${now}
      where id = (select token_id from family) and revoked_at is null
      returning id
    )
    select (select token_id from family) as family_token_id,
      (select id from reused) as revoked_id,
      ${personalAccessToken.id} as live_id,
      ${personalAccessToken.revokedAt} is not null as revoked,
      ${oauthGrantNotIdleSql(now)} as active,
      ${personalAccessToken.oauthClientId} as client_id
    from (select 1) as one
    left join ${personalAccessToken}
      on ${personalAccessToken.refreshTokenHash} = ${presented}
  `);
  const [row] = rows;
  if (row.family_token_id !== null) {
    logger.warn(
      {
        op: 'oauth.grant.reused',
        tokenId: row.family_token_id,
        revoked: row.revoked_id !== null,
      },
      `OAuth refresh token reused: grant ${row.family_token_id} ${
        row.revoked_id === null ? 'already revoked' : 'revoked'
      }`,
    );
    return refused('refresh token reused', { known: true });
  }
  if (row.live_id === null) return refused('unknown refresh token');
  if (row.revoked) return refused('revoked grant', { known: true });
  if (row.client_id !== clientId) {
    return refused("client_id is not the grant's");
  }
  if (!row.active) {
    logger.info(
      { op: 'oauth.grant.idle', tokenId: row.live_id },
      `OAuth grant ${row.live_id} refused: idle past its days`,
    );
    return refused('idle grant', { known: true });
  }
  return refused('unknown refresh token');
}
