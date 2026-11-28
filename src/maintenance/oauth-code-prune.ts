import { lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { oauthAuthorizationCode } from '../db/schema';
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
