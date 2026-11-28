import { sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { TOKEN_PREFIX } from '../../credential-names';
import {
  oauthAuthorizationCode,
  personalAccessToken,
  user,
} from '../../db/schema';
import { hashToken, MAX_ACTIVE_TOKENS } from '../auth/personal-tokens';
import type { TokenScope } from '../auth/personal-tokens';
import { passwordFingerprintSql } from '../auth/tokens';
import { type ActionDeps, logOp } from '../op-log';
import type { Actor } from '../sharing/access';
import type { ConsentRequest } from './authorize-request';

/**
 * The one-time authorization code a consent writes (#1290; plan 4.5):
 * `closet_code_` + 32 random bytes, so scrubSecrets' `closet_` shape
 * already filters it from any text. Stored only as its hash.
 */
const CODE_PREFIX = `${TOKEN_PREFIX}code_`;
/** RFC 6749 4.1.2 recommends at most ten minutes; the exchange is at once. */
export const CODE_LIFETIME_SECONDS = 2 * 60;

export interface Consent {
  request: ConsentRequest;
  /** MCP_PUBLIC_URL: the resource the code, and so its grant, is for. */
  resource: string;
  /** "Name this connection", already displayText'd. */
  name: string;
  scope: TokenScope;
  /** The full hash checkSignIn verified the password against. */
  verifiedPassword: string;
}

export type ConsentResult =
  | { granted: true; code: string }
  | { granted: false; reason: 'password-changed' | 'too-many' };

/**
 * Writes the code in one statement that is also its checks: the password
 * still the one verified (a new password committed since writes nothing,
 * and its fingerprint is stamped on the row, so one committed after is
 * caught at the exchange, #1291) and Agent Access not full, counting the
 * user's live agent tokens but their grant from this same client, which
 * the exchange's mint replaces. Unlocked: the mint rechecks both under the
 * user's lock (createToken), so this only spares a code that cannot mint.
 */
export async function grantConsent(
  { db, logger }: ActionDeps,
  actor: Actor,
  consent: Consent,
): Promise<ConsentResult> {
  const { request, scope } = consent;
  const code = `${CODE_PREFIX}${randomBytes(32).toString('base64url')}`;
  const { rows } = await db.execute<{
    unchanged: boolean;
    active: number;
    code_id: number | null;
  }>(sql`
    with account as (
      select ${user.id} as id,
        ${user.password} = ${consent.verifiedPassword} as unchanged,
        ${passwordFingerprintSql} as fingerprint,
        (select count(*)::int from ${personalAccessToken} p
          where p.user_id = ${user.id} and p.kind = 'mcp'
            and p.revoked_at is null
            and p.oauth_client_id is distinct from ${request.clientId}) as active
      from ${user} where ${user.id} = ${actor.userId}
    ), code as (
      insert into ${oauthAuthorizationCode} (code_hash, user_id, client_id,
        redirect_uri, code_challenge, resource, name, read_only,
        own_wardrobe_only, password_fingerprint, expires_at)
      select ${hashToken(code)}, account.id, ${request.clientId},
        ${request.redirectUri}, ${request.codeChallenge}, ${consent.resource},
        ${consent.name}, ${scope.readOnly}, ${scope.ownWardrobeOnly},
        account.fingerprint, now() + make_interval(secs => ${CODE_LIFETIME_SECONDS})
      from account where account.unchanged and account.active < ${MAX_ACTIVE_TOKENS}
      returning id
    )
    select account.unchanged, account.active, (select id from code) as code_id
    from account
  `);
  const [row] = rows;
  if (!row?.unchanged) return { granted: false, reason: 'password-changed' };
  if (row.code_id === null) return { granted: false, reason: 'too-many' };
  logOp(logger, actor, 'oauth.consent.granted', {
    codeId: row.code_id,
    clientHost: new URL(request.clientId).hostname,
    redirectHost: new URL(request.redirectUri).hostname,
    readOnly: scope.readOnly,
    ownWardrobeOnly: scope.ownWardrobeOnly,
  });
  return { granted: true, code };
}
