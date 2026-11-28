import { inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  oauthAuthorizationCode,
  oauthRetiredRefreshToken,
  personalAccessToken,
} from '../db/schema';
import type { Logger } from '../logger';

/**
 * The OAuth consent's codes (#1290; src/web/oauth/AGENTS.md): each lives two
 * minutes, so a row a day past its `expires_at` can open nothing and only
 * keeps a client id and a redirect URI around. Kept that day so a late
 * second use still finds its row and revokes its grant (#1291). Age is
 * Postgres's `now()`, the clock that stamped `expires_at`.
 */
export const OAUTH_CODE_RETENTION_DAYS = 1;

/** Used by server.ts's nightly `oauth_code_prune` job. */
export async function pruneOAuthCodes({
  db,
  logger,
}: {
  db: Db;
  logger: Logger;
}): Promise<number> {
  const started = performance.now();
  const pruned = await db
    .delete(oauthAuthorizationCode)
    .where(
      lt(
        oauthAuthorizationCode.expiresAt,
        sql`now() - make_interval(days => ${OAUTH_CODE_RETENTION_DAYS})`,
      ),
    )
    .returning({ id: oauthAuthorizationCode.id });
  logger.info(
    `Pruned ${pruned.length} OAuth authorization code(s) a day past expiry, ${Math.round(performance.now() - started)} ms`,
  );
  return pruned.length;
}

/**
 * The refresh-token families of revoked OAuth grants (#1291;
 * src/web/oauth/grants.ts): a live grant keeps every refresh token it ever
 * retired, so reuse of any generation revokes it (#1295), but a revoked
 * grant opens nothing whatever is presented. Past this, its old tokens are
 * `unknown` instead of `reused`: the same `invalid_grant`. Used by
 * server.ts's nightly `oauth_refresh_prune` job.
 */
export async function pruneRetiredRefreshTokens({
  db,
  logger,
}: {
  db: Db;
  logger: Logger;
}): Promise<number> {
  const started = performance.now();
  const pruned = await db
    .delete(oauthRetiredRefreshToken)
    .where(
      inArray(
        oauthRetiredRefreshToken.tokenId,
        db
          .select({ id: personalAccessToken.id })
          .from(personalAccessToken)
          .where(isNotNull(personalAccessToken.revokedAt)),
      ),
    )
    .returning({ id: oauthRetiredRefreshToken.id });
  logger.info(
    `Pruned ${pruned.length} retired refresh token(s) of revoked OAuth grants, ${Math.round(performance.now() - started)} ms`,
  );
  return pruned.length;
}
