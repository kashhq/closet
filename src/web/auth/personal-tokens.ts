import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { TOKEN_PREFIX, type TokenKind } from '../../credential-names';
import type { Db, Queryable } from '../../db/client';
import type { Logger } from '../../logger';
import { markSecretChecked } from '../../metrics/request-timing';
import {
  personalAccessToken,
  type SharePermission,
  user,
} from '../../db/schema';
import { type ShareReadAhead, sharePermissionSql } from '../sharing/access';
import type { SessionUser } from './session';

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
 * one would cost every call. A token acts exactly as its user; a new
 * password revokes every token of both kinds (revokeTokensStatement, in
 * updatePasswordHash), as it ends every session; so does a database
 * restore (maintenance:after-restore, #908). Sign out everywhere revokes
 * the device tokens only (#700): an agent token is not a sign-in.
 */

/** Characters of the token the profile shows: the fixed prefix and four more. */
const DISPLAY_LENGTH = TOKEN_PREFIX.length + 4;
/** How stale last_used_at may get before a call writes it again. */
const LAST_USED_RESOLUTION_MS = 60_000;
export const TOKEN_NAME_MAX = 100;
/**
 * A household's tokens are a handful; this bounds a runaway script. Counted
 * per kind: agent tokens and devices never crowd each other out.
 */
export const MAX_ACTIVE_TOKENS = 20;

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
}

const listingColumns = {
  id: personalAccessToken.id,
  kind: personalAccessToken.kind,
  name: personalAccessToken.name,
  prefix: personalAccessToken.tokenPrefix,
  createdAt: personalAccessToken.createdAt,
  lastUsedAt: personalAccessToken.lastUsedAt,
};

const inForce = (userId: number) =>
  and(
    eq(personalAccessToken.userId, userId),
    isNull(personalAccessToken.revokedAt),
  );

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
  userId: number;
  kind: TokenKind;
  /** Already trimmed and bounded (TOKEN_NAME_MAX). */
  name: string;
  /**
   * The full password hash the caller verified the user's password against,
   * from the row read that did it (sessionAccount on a page). Rechecked under
   * the lock: a password changed after the check refuses the mint.
   */
  verifiedPassword: string;
}

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
export function createToken(
  { db, logger }: { db: Db; logger: Logger },
  { userId, kind, name, verifiedPassword }: NewToken,
): Promise<CreateTokenResult> {
  return db.transaction(async (tx) => {
    const [account] = await tx
      .select({ password: user.password })
      .from(user)
      .where(eq(user.id, userId))
      .for('update');
    if (account?.password !== verifiedPassword) {
      return { created: false, reason: 'password-changed' } as const;
    }
    let tokens = await listTokens(tx, userId, kind);
    let evictedId: number | undefined;
    if (tokens.length >= MAX_ACTIVE_TOKENS) {
      if (kind === 'mcp') {
        return { created: false, reason: 'too-many', tokens } as const;
      }
      evictedId = leastRecentlyUsed(tokens).id;
      await tx
        .update(personalAccessToken)
        .set({ revokedAt: new Date() })
        .where(eq(personalAccessToken.id, evictedId));
      tokens = tokens.filter((token) => token.id !== evictedId);
      logger.info(
        `User ${userId} at ${MAX_ACTIVE_TOKENS} device tokens: evicted ${evictedId}, the least recently used`,
      );
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
      })
      .returning(listingColumns);
    return {
      created: true,
      id: row.id,
      token,
      tokens: [row, ...tokens],
      evictedId,
    } as const;
  });
}

/**
 * Revokes the user's token of `kind`; false when it is not theirs, not of
 * that kind, unknown, or revoked already. The routes answer every false
 * alike, a flash on their own page, so an id tells nothing about whose it
 * is, and a stale tab's second tap is no error page.
 */
export async function revokeToken(
  db: Db,
  userId: number,
  kind: TokenKind,
  id: number,
): Promise<boolean> {
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
}

/**
 * Why a presented token opens nothing. `revoked` and `wrong kind` match a
 * real row (a device signed out, an agent token on /api): the bearer gate
 * always answers those with the 401 that says sign in again, never its 429
 * (src/web/auth/bearer-gate.ts). `unknown` is everything else, a deleted
 * user's token included.
 */
export interface TokenRefusal {
  refused: 'unknown' | 'revoked' | 'wrong kind';
}

/**
 * The user a presented token of `kind` acts as, or why it opens nothing
 * (the caller answers each with the same 401, and a refused token's use is
 * never recorded). One indexed read, by the hash alone, so a revoked or
 * other-kind row is told from an unknown one; a second statement records
 * the use when the last one is a minute old. `shareOf` (shareToReadAhead)
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
      lastUsedAt: personalAccessToken.lastUsedAt,
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
  if (row.revokedAt !== null) return { refused: 'revoked' };
  if (row.kind !== kind) return { refused: 'wrong kind' };
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
    ...(share && { share }),
  };
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
