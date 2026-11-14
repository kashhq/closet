import { sql } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { user } from '../../db/schema';

/**
 * The session token's claims. The format is the one @nestjs/jwt issued
 * before the port (HS256, the same claims, 365 days), so cookies set before
 * a deploy stay valid after it.
 */
interface SessionClaims {
  userId: number;
  email: string | null;
  /**
   * Password fingerprint: the last 8 characters of the user's bcrypt hash.
   * The session resolver compares it on every request, so changing the
   * password ends every session issued before the change.
   */
  pwf: string;
  /**
   * The database's restore epoch the token was issued under
   * (restoreEpochSql), absent while it was never restored. The session
   * resolver compares it on every request, so the post-restore command's
   * bump ends every session issued before the restore (#908), which the
   * fingerprint cannot: the restore brings back the old hashes too.
   */
  sep?: string;
  /**
   * The user's session version the token was issued under (the
   * `session_version` column). Absent in tokens issued before #700, which
   * verify() reads as 0, the column's default, so the deploy signed nobody
   * out. "Sign out everywhere" and a new password bump it, so the resolver
   * refuses every token issued before, without a session table.
   */
  sv: number;
}

/** A token's lifetime; the cookie's Max-Age is the same span in seconds. */
export const SESSION_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

/**
 * How many trailing characters of the bcrypt hash a token carries as `pwf`.
 * The session lookup computes the same suffix in SQL (passwordFingerprintSql),
 * so the hash itself never leaves the database on a request.
 */
const PASSWORD_FINGERPRINT_LENGTH = 8;

export function passwordFingerprint(passwordHash: string): string {
  return passwordHash.slice(-PASSWORD_FINGERPRINT_LENGTH);
}

/**
 * passwordFingerprint in SQL, over the `user` row in scope: what the session
 * lookup reads (findSessionAccount) and what a write that must not outlive
 * its session rechecks under the user's row lock (upsertDevice).
 */
export const passwordFingerprintSql = sql<string>`right(${user.password}, ${PASSWORD_FINGERPRINT_LENGTH})`;

/**
 * What a session was opened with, for a write that must not outlive it: its
 * token's password fingerprint and session version. sessionStillOpenSql
 * rechecks both against the `user` row it locked.
 */
export interface SessionStamp {
  fingerprint: string;
  version: number;
}

/**
 * Whether the `user` row in scope still opens a session stamped `stamp`:
 * the password and the session version unchanged since it was issued. The
 * writes that recheck their session under the user's row lock take it
 * (upsertDevice, createInvite), so a bump committed while they waited
 * stores nothing.
 */
export function sessionStillOpenSql(stamp: SessionStamp) {
  return sql`(${passwordFingerprintSql} = ${stamp.fingerprint} and ${user.sessionVersion} = ${stamp.version})`;
}

/** An optional claim: absent, or of its type. A claim of another type is a forged or garbled token. */
function absentOr(value: unknown, valid: (value: unknown) => boolean): boolean {
  return value === undefined || valid(value);
}

const isString = (value: unknown): value is string => typeof value === 'string';

export interface SessionTokens {
  /**
   * `user` is a row its caller read or wrote in the statement that decided
   * the session (a sign-in's lookup, the insert, a bump's RETURNING), so a
   * token always carries the version current at that statement.
   */
  issue(user: {
    id: number;
    email: string | null;
    password: string;
    sessionEpoch: string | null;
    sessionVersion: number;
  }): string;
  /** The claims of a valid, unexpired token signed with our secret; else undefined. */
  verify(token: string): SessionClaims | undefined;
}

/**
 * Signs and verifies session tokens with ACCESS_TOKEN_SECRET. Built once by
 * createApp() and shared by the session resolver (every request) and the
 * routes that sign someone in.
 */
export function createSessionTokens(secret: string): SessionTokens {
  return {
    issue(user) {
      const claims: SessionClaims = {
        userId: user.id,
        email: user.email,
        pwf: passwordFingerprint(user.password),
        ...(user.sessionEpoch === null ? {} : { sep: user.sessionEpoch }),
        sv: user.sessionVersion,
      };
      return jwt.sign(claims, secret, {
        algorithm: 'HS256',
        expiresIn: SESSION_LIFETIME_SECONDS,
      });
    },
    verify(token) {
      let decoded: string | jwt.JwtPayload;
      try {
        // Pinned to the one algorithm we sign with, so a token cannot pick
        // its own verification.
        decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
      } catch {
        return undefined;
      }
      if (
        typeof decoded === 'string' ||
        typeof decoded.userId !== 'number' ||
        typeof decoded.pwf !== 'string' ||
        !absentOr(decoded.sep, isString) ||
        !absentOr(decoded.sv, Number.isInteger)
      ) {
        return undefined;
      }
      return {
        userId: decoded.userId,
        email: typeof decoded.email === 'string' ? decoded.email : null,
        pwf: decoded.pwf,
        ...(typeof decoded.sep === 'string' ? { sep: decoded.sep } : {}),
        sv: typeof decoded.sv === 'number' ? decoded.sv : 0,
      };
    },
  };
}
