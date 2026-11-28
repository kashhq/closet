import { and, desc, eq, inArray, isNull, ne, type SQL, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { TOKEN_PREFIX, type TokenKind } from '../../credential-names';
import type { Db, Queryable } from '../../db/client';
import { markSecretChecked } from '../../metrics/request-timing';
import {
  personalAccessToken,
  type SharePermission,
  user,
} from '../../db/schema';
import { type ActionDeps, logOp } from '../op-log';
import {
  type Actor,
  type ShareReadAhead,
  sharePermissionSql,
} from '../sharing/access';
import type { SessionUser } from './session';
import { passwordFingerprintSql } from './tokens';

/**
 * Personal access tokens (#33): the bearer credentials, of two kinds (#189):
 * `mcp`, the MCP endpoint's (src/web/mcp), minted on Agent Access, and
 * `device`, a native client's, minted by its sign-in and listed on the
 * profile's Devices. A surface accepts only its own kind (authenticateToken),
 * so a leaked agent token cannot drive the API and a device token cannot
 * call /mcp. A token is `closet_` plus 32 random bytes in base64url, shown
 * once when created; the database keeps its SHA-256 (hex) and a short
 * prefix to tell tokens apart on Agent Access. A fast hash is right here:
 * the token is 256 random bits, so there is nothing to guess, and a slow
 * one would cost every call. A token acts as its user within its scope
 * (TokenScope, an agent token's, fixed at mint: #701); a new
 * password revokes every token of both kinds (revokeTokensStatement, in
 * updatePasswordHash), as it ends every session; so does a database
 * restore (maintenance:after-restore, #908). Sign out everywhere revokes
 * the device tokens only (#700): an agent token is not a sign-in.
 */

/** Characters of the token the profile shows: the fixed prefix and four more. */
const DISPLAY_LENGTH = TOKEN_PREFIX.length + 4;
/** How stale last_used_at may get before a call writes it again. */
const LAST_USED_RESOLUTION_MS = 60_000;
/**
 * A device token unused this long is refused as revoked (#705): a sold
 * phone or a copied backup stops working by itself. So is an OAuth grant
 * (OAUTH_IDLE_DAYS, owner 2026-11-27, #1291): it was minted for a hosted
 * service from a sheet, and reconnecting takes half a minute. Measured from
 * last_used_at, or created_at for one never used; LAST_USED_RESOLUTION_MS
 * is far below it, so a token in use never looks idle. Static agent tokens
 * have no idle expiry: an agent can run monthly, and each is minted behind
 * the password with its own scope and listed on Agent Access.
 */
export const DEVICE_IDLE_DAYS = 90;
export const OAUTH_IDLE_DAYS = 90;

/** Whether a token idles out at all: a device's, or an OAuth grant. */
function idles(token: {
  kind: TokenKind;
  oauthClientId: string | null;
}): boolean {
  return token.kind === 'device' || token.oauthClientId !== null;
}

/**
 * The idle test's one cutoff: a token whose last use (or creation) is at or
 * before it is idle at `now`. Both readers judge by it, on the app's clock
 * that stamps the columns: idleExpired on a row already read, and an OAuth
 * refresh's rotation in its own WHERE (notIdleSql).
 */
function idleCutoff(token: { kind: TokenKind }, now: Date): Date {
  const days = token.kind === 'device' ? DEVICE_IDLE_DAYS : OAUTH_IDLE_DAYS;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Whether a token has gone unused past its idle expiry at `now`: a device
 * token or an OAuth grant. authenticateToken refuses it; Profile › Devices
 * says it is signed out.
 */
export function idleExpired(
  token: {
    kind: TokenKind;
    oauthClientId: string | null;
    createdAt: Date;
    lastUsedAt: Date | null;
  },
  now: Date,
): boolean {
  return (
    idles(token) &&
    (token.lastUsedAt ?? token.createdAt) <= idleCutoff(token, now)
  );
}

/**
 * idleExpired's negation for an OAuth grant's row as SQL, so the refresh's
 * rotation judges idleness in its one statement (src/web/oauth/grants.ts).
 */
export function oauthGrantNotIdleSql(now: Date): SQL<boolean> {
  return sql<boolean>`coalesce(${personalAccessToken.lastUsedAt}, ${personalAccessToken.createdAt}) > ${idleCutoff({ kind: 'mcp' }, now)}`;
}

/**
 * Whether an agent token counts against MAX_ACTIVE_TOKENS at `now`, as SQL:
 * an OAuth grant idle past its days does not, since it opens nothing and
 * must not block a new connection. mintToken counts by idleExpired on the
 * rows it read; the consent's count (grantConsent) by this.
 */
export function countsTowardAgentCapSql(now: Date): SQL<boolean> {
  return sql<boolean>`(${personalAccessToken.oauthClientId} is null or ${oauthGrantNotIdleSql(now)})`;
}
export const TOKEN_NAME_MAX = 100;
/**
 * A household's tokens are a handful; this bounds a runaway script. Counted
 * per kind: agent tokens and devices never crowd each other out.
 */
export const MAX_ACTIVE_TOKENS = 20;

/**
 * What an agent token may do (#701), chosen at mint and never changed (a
 * wider scope is a new token, behind the password again). `readOnly`: no
 * write tool is registered for it (scopedTools, src/web/mcp/tool.ts);
 * `ownWardrobeOnly`: its actor resolves no shared wardrobe
 * (src/web/sharing/access.ts). Device tokens are always FULL_SCOPE.
 */
export interface TokenScope {
  readOnly: boolean;
  ownWardrobeOnly: boolean;
}

/** Every token minted before 0067, and every device token. */
export const FULL_SCOPE: TokenScope = {
  readOnly: false,
  ownWardrobeOnly: false,
};

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface TokenListing {
  id: number;
  kind: TokenKind;
  name: string;
  /** `closet_AbCd`: shown with an ellipsis. */
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  /** Agent Access shows it on each token. */
  readOnly: boolean;
  ownWardrobeOnly: boolean;
  /** An OAuth grant's client (its metadata document's URL); else null. */
  oauthClientId: string | null;
}

const listingColumns = {
  id: personalAccessToken.id,
  kind: personalAccessToken.kind,
  name: personalAccessToken.name,
  prefix: personalAccessToken.tokenPrefix,
  createdAt: personalAccessToken.createdAt,
  lastUsedAt: personalAccessToken.lastUsedAt,
  readOnly: personalAccessToken.readOnly,
  ownWardrobeOnly: personalAccessToken.ownWardrobeOnly,
  oauthClientId: personalAccessToken.oauthClientId,
};

const inForce = (userId: number) =>
  and(
    eq(personalAccessToken.userId, userId),
    isNull(personalAccessToken.revokedAt),
  );

/**
 * Whether the user has an agent token in force, as a scalar for the
 * reader's own statement: "Ask your agent" says when none is (#1286), so a
 * request is known to wait until one connects.
 */
export function agentConnectedSql(userId: number): SQL<boolean> {
  return sql<boolean>`exists (select from ${personalAccessToken} where ${and(
    inForce(userId),
    eq(personalAccessToken.kind, 'mcp'),
  )})`;
}

/**
 * The user's tokens still in force, newest first: of one kind, or every
 * kind for the profile, which shows both and splits them (one statement).
 */
export function listTokens(
  db: Queryable,
  userId: number,
  kind?: TokenKind,
): Promise<TokenListing[]> {
  return db
    .select(listingColumns)
    .from(personalAccessToken)
    .where(
      and(
        inForce(userId),
        kind === undefined ? undefined : eq(personalAccessToken.kind, kind),
      ),
    )
    .orderBy(desc(personalAccessToken.id));
}

/**
 * The device token a sign-in past the cap revokes: the least recently used,
 * where a token never used counts from its creation, and equal times go to
 * the oldest row (the lowest id). `last_used_at` is written at most once a
 * minute (LAST_USED_RESOLUTION_MS), so recency is only that fine; within a
 * minute the order is the ids'. A token minted moments ago is newer than
 * every token idle before it, so of two sign-ins racing at the cap neither
 * evicts the other's.
 */
function leastRecentlyUsed(tokens: readonly TokenListing[]): TokenListing {
  const recency = (token: TokenListing) =>
    (token.lastUsedAt ?? token.createdAt).getTime();
  return tokens.reduce((least, token) =>
    recency(token) < recency(least) ||
    (recency(token) === recency(least) && token.id < least.id)
      ? token
      : least,
  );
}

/**
 * What creating answers: the token in the clear (the only time it exists
 * outside the caller's hands), the list of its kind the page shows, the new
 * token first, and the device it evicted to stay under the cap, if any. A
 * refusal: `too-many` (an agent token at the cap, with the list as it
 * stands) or `password-changed` (the password the caller checked is no
 * longer the account's, or the account is gone).
 */
export type CreateTokenResult =
  | {
      created: true;
      id: number;
      token: string;
      tokens: TokenListing[];
      evictedId?: number;
    }
  | { created: false; reason: 'too-many'; tokens: TokenListing[] }
  | { created: false; reason: 'password-changed' };

export interface NewToken {
  kind: TokenKind;
  /** Already trimmed and bounded (TOKEN_NAME_MAX). */
  name: string;
  /** Agent Access's choice; a device sign-in's is FULL_SCOPE. */
  scope: TokenScope;
  /**
   * What the caller verified the user's password against, rechecked under
   * the lock: a password changed after the check refuses the mint. The full
   * hash, from the row read that did it (sessionAccount on a page), or an
   * OAuth code's fingerprint stamp (`right(password, 8)`, read in the
   * statement that checked the password at consent, #1291).
   */
  verified: { password: string } | { passwordFingerprint: string };
  /** An OAuth grant's (the token exchange's, src/web/oauth/grants.ts). */
  oauth?: OAuthMint;
  /**
   * The address the mint came from (`request.ip`, which TRUSTED_PROXIES
   * governs), the audit trail of a credential issued over the network; left
   * out by the seed CLI.
   */
  address?: string;
}

/**
 * What an OAuth grant's row carries beside an agent token's (#1291). Its
 * mint replaces the user's grant from the same client: the cap is counted
 * without it, and only once the cap allows the mint is it revoked, so a
 * refused mint leaves it standing.
 */
export interface OAuthMint {
  clientId: string;
  refreshTokenHash: string;
  accessExpiresAt: Date;
}

/** A mint inside the caller's transaction: mintToken's answer. */
export type MintResult =
  | {
      created: true;
      id: number;
      token: string;
      tokens: TokenListing[];
      evictedId?: number;
      /** An OAuth mint's: the same client's grants it revoked. */
      replacedIds: number[];
    }
  | { created: false; reason: 'too-many'; tokens: TokenListing[] }
  | { created: false; reason: 'password-changed' };

/**
 * Makes a token. The user's row is locked first, with its password read in
 * the same statement: two creations take turns under the cap, and a new
 * password, whose writer takes the same lock (updatePasswordHash), either
 * commits before (this mint sees the new hash and refuses) or waits until
 * this commits (and then revokes what it minted). Comparing the whole hash,
 * not the session's 8-character fingerprint: a hash is this server's own
 * read, so a plain comparison leaks nothing.
 *
 * The list is read under the lock, where the cap is checked, and handed
 * back with the new row: the page needs it either way, so the cap costs no
 * count of its own and the answer no read after commit (#171). The lock and
 * the list stay two statements: the list must be read after the lock is
 * granted, and a statement's snapshot is taken before its locks are, so a
 * creation waiting on another would count the tokens as they were before
 * that one committed. Only tokens in force count, per kind; at the cap an
 * agent token is refused (the page asks to revoke one) and a device token
 * evicts that kind's least recently used (a native sign-in has no page to
 * ask on), in the same transaction.
 */
export async function createToken(
  { db, logger }: ActionDeps,
  actor: Actor,
  newToken: NewToken,
): Promise<CreateTokenResult> {
  const minted = await db.transaction((tx) => mintToken(tx, actor, newToken));
  if (!minted.created) return minted;
  const { id, token, tokens, evictedId } = minted;
  // After the commit: a rollback must leave no line for a token never minted.
  logOp(logger, actor, 'token.created', {
    tokenId: id,
    kind: newToken.kind,
    readOnly: newToken.scope.readOnly,
    ownWardrobeOnly: newToken.scope.ownWardrobeOnly,
    evictedId,
    address: newToken.address,
  });
  return { created: true, id, token, tokens, evictedId };
}

/**
 * createToken's work inside the caller's transaction `tx`, logging nothing:
 * the OAuth exchange mints in the transaction that claimed its code
 * (src/web/oauth/grants.ts) and logs after its own commit. A refusal
 * writes nothing, so the caller's own writes still commit.
 */
export async function mintToken(
  tx: Queryable,
  { userId }: Actor,
  { kind, name, scope, verified, oauth }: NewToken,
): Promise<MintResult> {
  const [account] = await tx
    .select({
      password: user.password,
      fingerprint: passwordFingerprintSql,
    })
    .from(user)
    .where(eq(user.id, userId))
    .for('update');
  const unchanged =
    account !== undefined &&
    ('password' in verified
      ? account.password === verified.password
      : account.fingerprint === verified.passwordFingerprint);
  if (!unchanged) return { created: false, reason: 'password-changed' };
  let tokens = await listTokens(tx, userId, kind);
  // A reconnect replaces its own grant: it never counts against the cap.
  const replaced = oauth
    ? tokens.filter((token) => token.oauthClientId === oauth.clientId)
    : [];
  // Nor does an OAuth grant idle past its days (countsTowardAgentCapSql, the
  // consent's count): it opens nothing, so it must not block a new
  // connection. Devices idle too, but at their cap the least recently used
  // is evicted, so an idle one goes first anyway.
  const now = new Date();
  const counted = tokens.filter(
    (token) =>
      !replaced.includes(token) &&
      !(token.oauthClientId !== null && idleExpired(token, now)),
  ).length;
  let evictedId: number | undefined;
  if (counted >= MAX_ACTIVE_TOKENS) {
    if (kind === 'mcp') {
      return { created: false, reason: 'too-many', tokens };
    }
    evictedId = leastRecentlyUsed(tokens).id;
    await tx
      .update(personalAccessToken)
      .set({ revokedAt: now })
      .where(eq(personalAccessToken.id, evictedId));
    tokens = tokens.filter((token) => token.id !== evictedId);
  }
  // Only past the cap check: a refused reconnect keeps the grant it has.
  const replacedIds = replaced.map((token) => token.id);
  if (replacedIds.length > 0) {
    await tx
      .update(personalAccessToken)
      .set({ revokedAt: now })
      .where(inArray(personalAccessToken.id, replacedIds));
    tokens = tokens.filter((token) => !replacedIds.includes(token.id));
  }
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const [row] = await tx
    .insert(personalAccessToken)
    .values({
      userId,
      kind,
      name,
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, DISPLAY_LENGTH),
      // The app's clock, not the column's default: idleExpired judges it
      // against the app's `now`, beside last_used_at, which it stamps.
      createdAt: now,
      ...scope,
      ...(oauth && {
        oauthClientId: oauth.clientId,
        refreshTokenHash: oauth.refreshTokenHash,
        accessExpiresAt: oauth.accessExpiresAt,
      }),
    })
    .returning(listingColumns);
  return {
    created: true,
    id: row.id,
    token,
    tokens: [row, ...tokens],
    evictedId,
    replacedIds,
  };
}

/**
 * Revokes the user's token of `kind`; false when it is not theirs, not of
 * that kind, unknown, or revoked already. The routes answer every false
 * alike, a flash on their own page, so an id tells nothing about whose it
 * is, and a stale tab's second tap is no error page.
 */
export async function revokeToken(
  { db, logger }: ActionDeps,
  actor: Actor,
  kind: TokenKind,
  id: number,
): Promise<boolean> {
  const { userId } = actor;
  const revoked = await db
    .update(personalAccessToken)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(personalAccessToken.id, id),
        eq(personalAccessToken.kind, kind),
        inForce(userId),
      ),
    )
    .returning({ id: personalAccessToken.id });
  logOp(logger, actor, 'token.revoked', {
    tokenId: id,
    kind,
    changed: revoked.length > 0,
  });
  return revoked.length > 0;
}

/**
 * Revokes the user's tokens in force: every one of both kinds, or only
 * `kind`'s, but `keepTokenId` (the token making the change, once a
 * token-authenticated route can change a password; another user's id keeps
 * nothing), returning each revoked token's kind. A new password revokes
 * both kinds, Sign out everywhere only the device tokens (revokeSignIns,
 * queries.ts).
 */
export function revokeTokensStatement(
  db: Queryable,
  userId: number,
  only: { kind?: TokenKind; keepTokenId?: number } = {},
) {
  return db
    .update(personalAccessToken)
    .set({ revokedAt: new Date() })
    .where(
      and(
        inForce(userId),
        only.kind === undefined
          ? undefined
          : eq(personalAccessToken.kind, only.kind),
        only.keepTokenId === undefined
          ? undefined
          : ne(personalAccessToken.id, only.keepTokenId),
      ),
    )
    .returning({ kind: personalAccessToken.kind });
}

/**
 * Every user's tokens in force, of both kinds, revoked in one transaction,
 * per user through revokeTokensStatement (a new password's), keeping
 * none: the post-restore command's (#908). Returns each user's revoked
 * kinds, in id order. No user lock, unlike a password change: a token
 * minted meanwhile is one its owner just stepped up for against the
 * restored database.
 */
export function revokeEveryonesTokens(
  db: Db,
): Promise<{ userId: number; kinds: TokenKind[] }[]> {
  return db.transaction(async (tx) => {
    const holders = await tx
      .selectDistinct({ userId: personalAccessToken.userId })
      .from(personalAccessToken)
      .where(isNull(personalAccessToken.revokedAt))
      .orderBy(personalAccessToken.userId);
    const revoked: { userId: number; kinds: TokenKind[] }[] = [];
    for (const { userId } of holders) {
      const rows = await revokeTokensStatement(tx, userId);
      revoked.push({ userId, kinds: rows.map((row) => row.kind) });
    }
    return revoked;
  });
}

export interface TokenAuth {
  user: SessionUser;
  /** The token's row id: what logs and the rate limit name, never the token. */
  tokenId: number;
  /** Read with the token, so a scope costs no statement (#701). */
  scope: TokenScope;
}

/**
 * Why a presented token opens nothing. `revoked`, `expired` and `wrong
 * kind` match a real row (a device signed out or idle past
 * DEVICE_IDLE_DAYS, an OAuth grant revoked or idle, an OAuth access token
 * past its hour, an agent token on /api): the bearer gate always answers
 * those with the 401 that says sign in again or refresh, never its 429
 * (src/web/auth/bearer-gate.ts). `unknown` is everything else, a deleted
 * user's token and an OAuth access token a refresh replaced included.
 */
export interface TokenRefusal {
  refused: 'unknown' | 'revoked' | 'expired' | 'wrong kind';
}

/**
 * The user a presented token of `kind` acts as, or why it opens nothing
 * (the caller answers each with the same 401, and a refused token's use is
 * never recorded). One indexed read, by the hash alone, so a revoked or
 * other-kind row is told from an unknown one; a second statement records
 * the use when the last one is a minute old. A device token or OAuth grant
 * idle past its days (idleExpired) is refused as revoked, and an OAuth
 * access token past its hour as expired, judged on the same row, so
 * neither costs a statement. `shareOf` (shareToReadAhead)
 * reads the token user's share of that wardrobe in the same read, as the
 * session statement does (#170): `share` then answers it, unless the
 * wardrobe is the user's own.
 */
export async function authenticateToken(
  db: Db,
  token: string,
  kind: TokenKind,
  { shareOf, now = new Date() }: { shareOf?: number; now?: Date } = {},
): Promise<(TokenAuth & { share?: ShareReadAhead }) | TokenRefusal> {
  markSecretChecked();
  if (!token.startsWith(TOKEN_PREFIX)) return { refused: 'unknown' };
  const [row] = await db
    .select({
      tokenId: personalAccessToken.id,
      kind: personalAccessToken.kind,
      revokedAt: personalAccessToken.revokedAt,
      createdAt: personalAccessToken.createdAt,
      lastUsedAt: personalAccessToken.lastUsedAt,
      oauthClientId: personalAccessToken.oauthClientId,
      accessExpiresAt: personalAccessToken.accessExpiresAt,
      readOnly: personalAccessToken.readOnly,
      ownWardrobeOnly: personalAccessToken.ownWardrobeOnly,
      userId: user.id,
      email: user.email,
      ...(shareOf === undefined
        ? {}
        : { share: sharePermissionSql(shareOf, user.id) }),
    })
    .from(personalAccessToken)
    .innerJoin(user, eq(user.id, personalAccessToken.userId))
    .where(eq(personalAccessToken.tokenHash, hashToken(token)));
  if (!row) return { refused: 'unknown' };
  const refusal = refusalOf(row, kind, now);
  if (refusal) return refusal;
  if (usedLongAgo(row.lastUsedAt, now)) {
    await db
      .update(personalAccessToken)
      .set({ lastUsedAt: now })
      .where(eq(personalAccessToken.id, row.tokenId));
  }
  const share = shareReadAhead(shareOf, row);
  return {
    user: { id: row.userId, email: row.email },
    tokenId: row.tokenId,
    scope: { readOnly: row.readOnly, ownWardrobeOnly: row.ownWardrobeOnly },
    ...(share && { share }),
  };
}

/**
 * Why a token's row opens nothing for `kind`, if it does not. An idle
 * device token or OAuth grant is a revoked one to its caller (and so to the
 * bearer gate's 401-never-429 rule): it learns to sign in again. An OAuth
 * access token past `access_expires_at` (the app's clock, which stamped it)
 * is `expired`: the client refreshes.
 */
function refusalOf(
  row: {
    kind: TokenKind;
    revokedAt: Date | null;
    createdAt: Date;
    lastUsedAt: Date | null;
    oauthClientId: string | null;
    accessExpiresAt: Date | null;
  },
  kind: TokenKind,
  now: Date,
): TokenRefusal | undefined {
  if (row.revokedAt !== null || idleExpired(row, now)) {
    return { refused: 'revoked' };
  }
  if (row.kind !== kind) return { refused: 'wrong kind' };
  if (row.accessExpiresAt !== null && row.accessExpiresAt <= now) {
    return { refused: 'expired' };
  }
  return undefined;
}

/** The share the token's read answered: none asked, or the user's own wardrobe. */
function shareReadAhead(
  shareOf: number | undefined,
  row: { userId: number; share?: SharePermission | null },
): ShareReadAhead | undefined {
  if (shareOf === undefined || shareOf === row.userId) return undefined;
  return { ownerId: shareOf, permission: row.share ?? null };
}

/** Whether a use at `now` is worth recording: never used, or not this minute. */
function usedLongAgo(lastUsedAt: Date | null, now: Date): boolean {
  return (
    lastUsedAt === null ||
    now.getTime() - lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS
  );
}
