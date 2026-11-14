import { and, eq, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { TokenKind } from '../../credential-names';
import type { Db, Queryable } from '../../db/client';
import { isLockTimeout, isUniqueViolation } from '../../db/errors';
import { ownerLockCte } from '../../db/owner-lock';
import { restoreEpochSql } from '../../db/sync-epoch';
import {
  file,
  pendingPhoto,
  type SharePermission,
  user,
  USER_EMAIL_UNIQUE,
} from '../../db/schema';
import { OwnerLockTimeout } from '../errors';
import { sharePermissionSql } from '../sharing/access';
import { revokeOpenInvitesStatement } from '../sharing/queries';
import { type StoredPhoto, unkeyedPhoto } from '../files/image-variant';
import { revokeDevicesStatement } from '../push/queries';
import { NotFound } from '../refusals';
import { revokeTokensStatement } from './personal-tokens';
import { passwordFingerprintSql } from './tokens';

/**
 * Account rows. Emails are stored as normalizeEmail writes them (trimmed,
 * lower case; drizzle/0005 converted the older rows) and are unique
 * case-insensitively: the `user_lower_email_unique` index on lower(email),
 * which is also what the lookups below use. The two writers of an address
 * (insertUser, updateEmail) check it is free inside their own statement, so
 * a taken address raises nothing; only a concurrent write that wins the
 * race between that check and the index is the index's unique violation,
 * which they catch by name and answer the same way.
 */

export interface AccountRow {
  id: number;
  email: string | null;
  password: string;
  /**
   * The restore epoch a session issued now carries (restoreEpochSql, #908),
   * read in the same statement as the row, so signing in costs no second.
   */
  sessionEpoch: string | null;
  /**
   * The session version a session issued now carries as `sv` (#700): every
   * mint reads it from its own statement, never from an earlier read.
   */
  sessionVersion: number;
}

const accountColumns = {
  id: user.id,
  email: user.email,
  password: user.password,
  sessionEpoch: restoreEpochSql,
  sessionVersion: user.sessionVersion,
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The session's account as the resolver reads it on every request
 * (createSessionResolver, session.ts): `fingerprint` is the hash's suffix a
 * token carries as `pwf` (passwordFingerprint), cut in SQL so the 60
 * characters of the hash stay in the database. Only a route that checks the
 * current password (`config: { checksPassword: true }`) asks for the hash as
 * well, which then saves that route a second read of the same row; and a
 * request addressing another user's wardrobe (`?ownerId=`) reads its share
 * as `share` (null for none), which saves the access check its round trip
 * (shareToReadAhead, src/web/sharing/access.ts). `sessionEpoch` is what a
 * token's `sep` must equal (restoreEpochSql: a restore ends every session),
 * `sessionVersion` its `sv` (Sign out everywhere and a new password bump it).
 */
export interface SessionAccount {
  id: number;
  email: string | null;
  fingerprint: string;
  sessionEpoch: string | null;
  sessionVersion: number;
  password?: string;
  share?: SharePermission | null;
}

const sessionColumns = {
  id: user.id,
  email: user.email,
  fingerprint: passwordFingerprintSql,
  sessionEpoch: restoreEpochSql,
  sessionVersion: user.sessionVersion,
};

export async function findSessionAccount(
  db: Db,
  id: number,
  read: { withHash: boolean; shareOf?: number },
): Promise<SessionAccount | undefined> {
  const [row] = await db
    .select({
      ...sessionColumns,
      ...(read.withHash ? { password: user.password } : {}),
      ...(read.shareOf === undefined
        ? {}
        : { share: sharePermissionSql(read.shareOf, id) }),
    })
    .from(user)
    .where(eq(user.id, id));
  return row;
}

/** `email` must already be normalized. */
export async function findUserByEmail(
  db: Db,
  email: string,
): Promise<AccountRow | undefined> {
  const [row] = await db
    .select(accountColumns)
    .from(user)
    .where(eq(sql`lower(${user.email})`, email))
    .limit(1);
  return row;
}

/**
 * The new account, or undefined when `email` is taken, in one statement: the
 * insert selects its row only where no account has the address, so a taken
 * one raises nothing (a unique violation is a Postgres ERROR whose DETAIL
 * names the address). A sign-up that commits the same address between that
 * check and the index is the race's unique violation, caught by the index's
 * name and answered the same; any other error is rethrown. `email` must
 * already be normalized. Registration asks for no name; the seed's personas
 * have one (the share page says "Shared by" the first name).
 *
 * Raw SQL: Drizzle's insert-select must select every column, the serial id
 * included, which a select list cannot default.
 */
export async function insertUser(
  db: Queryable,
  email: string,
  passwordHash: string,
  name: { firstName?: string; lastName?: string } = {},
): Promise<AccountRow | undefined> {
  try {
    const { rows } = await db.execute<{
      id: number;
      email: string | null;
      password: string;
      sessionEpoch: string | null;
      sessionVersion: number;
    }>(sql`
      insert into ${user} (email, password, first_name, last_name)
      select ${email}, ${passwordHash}, ${name.firstName ?? null}, ${name.lastName ?? null}
      where not exists (
        select 1 from ${user} where lower(${user.email}) = lower(${email})
      )
      returning id, email, password, ${restoreEpochSql} as "sessionEpoch", session_version as "sessionVersion"`);
    return rows[0];
  } catch (error) {
    if (isUniqueViolation(error, USER_EMAIL_UNIQUE)) return undefined;
    throw error;
  }
}

/** What ending an account's other sign-ins took away, besides their sessions. */
export interface Revocations {
  /** Tokens revoked, by kind: the log lines name both. */
  revokedTokens: Record<TokenKind, number>;
  revokedDevices: number;
  /** Invites the user sent that nobody accepted, deleted (#668). */
  revokedInvites: number;
}

/**
 * The account as its bump left it (its RETURNING, so a reissued cookie
 * carries the hash and session version as they are now), and what went
 * with it.
 */
export interface SessionsEnded extends Revocations {
  account: AccountRow;
}

/** What the device making the change keeps. */
export interface PasswordChangeKeeps {
  /** Its push subscription (revokeDevicesStatement). */
  endpoint?: string;
  /**
   * Its own token, once a token-authenticated route can change a password
   * (the API's, docs/plans/2026-11-12-json-api.md section 3); no caller yet.
   */
  tokenId?: number;
}

/**
 * What goes with the sessions a bump ended: `password`, a new password (how
 * an account is taken back), or `sessions`, Sign out everywhere (#700).
 *
 * Both revoke every device token (a native client's sign-in) and every push
 * subscription but `keep.endpoint`'s, the device making the change: a
 * device signed out must stop receiving the account's notifications at once
 * (revokeDevicesStatement). Only a new password also revokes the agent
 * tokens and the unanswered invites. Those are credentials the user minted
 * behind the password (the step-up rule) and manages on their own pages,
 * not sign-ins: a stolen cookie cannot have made one, and signing out must
 * not break the user's agent or void a link just sent. A new password
 * assumes the password itself was known, so a link a stolen session minted
 * must not outlive it (#668).
 *
 * The second statement of its writer's transaction, after the bump took the
 * user's row lock, and never folded into the bump (#171 did; #189 undid it):
 * a statement's snapshot predates its lock wait, so a CTE of the bump could
 * not see a token a mint committed during the wait, and that token outlived
 * the bump (auth-statements.spec, "a token minted while the password waits").
 */
async function revokeSignIns(
  tx: Queryable,
  id: number,
  keep: PasswordChangeKeeps,
  scope: 'password' | 'sessions',
): Promise<Revocations> {
  const tokens = tx.$with('revoked_tokens').as(
    revokeTokensStatement(tx, id, {
      kind: scope === 'password' ? undefined : 'device',
      keepTokenId: keep.tokenId,
    }),
  );
  const devices = tx
    .$with('revoked_devices')
    .as(revokeDevicesStatement(tx, id, keep.endpoint));
  const invites = tx
    .$with('revoked_invites')
    .as(revokeOpenInvitesStatement(tx, id));
  const ctes =
    scope === 'password' ? [tokens, devices, invites] : [tokens, devices];
  // An aggregate over the revoked tokens: one row even when there are none.
  const [revoked] = await tx
    .with(...ctes)
    .select({
      mcp: sql`count(*) filter (where ${tokens.kind} = 'mcp')`.mapWith(Number),
      device: sql`count(*) filter (where ${tokens.kind} = 'device')`.mapWith(
        Number,
      ),
      devices: sql`(select count(*) from ${devices})`.mapWith(Number),
      invites: (scope === 'password'
        ? sql`(select count(*) from ${invites})`
        : sql`0`
      ).mapWith(Number),
    })
    .from(tokens);
  return {
    revokedTokens: { mcp: revoked.mcp, device: revoked.device },
    revokedDevices: revoked.devices,
    revokedInvites: revoked.invites,
  };
}

/** A session-version bump, in the update that takes the user's row lock. */
const bumpedSessionVersion = sql`${user.sessionVersion} + 1`;

/**
 * The one writer of a password. The new hash ends every session issued
 * before it twice over: the fingerprint (which `user:set-password` and a
 * restore's old hashes rely on) and the session version, bumped in the same
 * update, so "every session before now" has one mechanism (#700); then
 * revokeSignIns' `password` scope. Accepted shares stay; the confirmation
 * lists them.
 *
 * An account that no longer exists is NotFound('account') (the route's
 * page; the CLI prints it), never a half-read row.
 */
export function updatePasswordHash(
  db: Db,
  id: number,
  passwordHash: string,
  keep: PasswordChangeKeeps = {},
): Promise<SessionsEnded> {
  return db.transaction(async (tx) => {
    const [account] = await tx
      .update(user)
      .set({ password: passwordHash, sessionVersion: bumpedSessionVersion })
      .where(eq(user.id, id))
      .returning(accountColumns);
    // The account is gone (deleted between the caller's read and this).
    if (!account) throw new NotFound('account', { logDetail: `user ${id}` });
    return { account, ...(await revokeSignIns(tx, id, keep, 'password')) };
  });
}

/**
 * Sign out everywhere (#700): bumps the session version every session token
 * carries as `sv`, so the resolver refuses each one issued before, then
 * revokeSignIns' `sessions` scope, `keep` being the device making the
 * change. The caller reissues its own cookie from the returned row (the
 * bump's RETURNING, never the request's earlier read), so the acting
 * session continues. The bump serializes with a new password on the row
 * lock.
 */
export function endOtherSessions(
  db: Db,
  id: number,
  keep: PasswordChangeKeeps = {},
): Promise<SessionsEnded> {
  return db.transaction(async (tx) => {
    const [account] = await tx
      .update(user)
      .set({ sessionVersion: bumpedSessionVersion })
      .where(eq(user.id, id))
      .returning(accountColumns);
    if (!account) throw new NotFound('account', { logDetail: `user ${id}` });
    return { account, ...(await revokeSignIns(tx, id, keep, 'sessions')) };
  });
}

/**
 * Moves the account to `email` (already normalized); false when another
 * account has it. One statement, and a taken address raises nothing, as
 * insertUser: the update applies only where no other account holds the
 * address, and the race past that check is the index's violation, caught by
 * name. The account's own address, in any case, is no clash.
 */
export async function updateEmail(
  db: Db,
  id: number,
  email: string,
): Promise<boolean> {
  const other = alias(user, 'other');
  try {
    const updated = await db
      .update(user)
      .set({ email })
      .where(
        and(
          eq(user.id, id),
          notExists(
            db
              .select({ id: other.id })
              .from(other)
              .where(
                and(
                  eq(sql`lower(${other.email})`, sql`lower(${email})`),
                  ne(other.id, id),
                ),
              ),
          ),
        ),
      )
      .returning({ id: user.id });
    return updated.length > 0;
  } catch (error) {
    if (isUniqueViolation(error, USER_EMAIL_UNIQUE)) return false;
    throw error;
  }
}

/**
 * Deletes the user, their File rows and their pending photos' rows in one
 * transaction and answers the stored photos, which the caller unlinks
 * after commit: the database cascade drops rows (garments, outfits,
 * calendar entries, shares), never the photo bytes (AGENTS.md Gotchas).
 * Every file row the account holds is a photo of its own wardrobe (the
 * photo foreign keys pair photo_id with owner_id, #703), so no other
 * wardrobe loses a photo here.
 *
 * The account's lock first, alone (#544), the deletes in the next
 * statement, whose snapshot is taken under the lock: the lock's own
 * statement reads with the snapshot from before its wait, so a save that
 * held the lock and committed meanwhile (a garment's photo, a grantee's
 * claim of their pending photo) was invisible to a delete folded into it,
 * and the user's cascade dropped that `file` row without its bytes.
 */
export async function deleteUserAndFileRows(
  db: Db,
  id: number,
): Promise<StoredPhoto[]> {
  return db.transaction(async (tx): Promise<StoredPhoto[]> => {
    const lock = ownerLockCte(tx, id);
    const [locked] = await tx.with(lock).select({ id: lock.id }).from(lock);
    // Deleted meanwhile: the cascade took their rows, the deleter their bytes.
    if (!locked) return [];
    const { rows } = await tx.execute<{
      files: StoredPhoto[];
      pending: string[];
    }>(sql`
      with files as (
        delete from ${file} where ${file.createdById} = ${id}
        returning ${file.fileName} as file_name, ${file.variantKey} as variant_key
      ), pending as (
        delete from ${pendingPhoto} where ${pendingPhoto.userId} = ${id}
        returning ${pendingPhoto.fileName} as file_name
      )
      select
        (select coalesce(json_agg(json_build_object('fileName', file_name, 'variantKey', variant_key)), '[]') from files) as files,
        (select coalesce(json_agg(file_name), '[]') from pending) as pending
    `);
    const [{ files, pending }] = rows;
    // Link imports never saved (`pending`): their bytes have no `file`
    // row, and the cascade would drop the rows that explain them to
    // reconciliation.
    await tx.delete(user).where(eq(user.id, id));
    return [...files, ...pending.map(unkeyedPhoto)];
  });
}

/**
 * Serializes one owner's writes that must see each other for the rest of
 * the transaction. The lock is on the owner's user row, because what is
 * being decided may have no row of its own to lock yet (a user's first
 * plan, the outfit a double tap would save twice, the entry a re-plan is
 * about to swap). NO KEY UPDATE leaves the row's key alone, so it never
 * blocks another table's foreign key check against the user (a garment
 * insert, a wear), only another such write of the same owner.
 *
 * The same statement bounds every lock wait from here to the end of the
 * transaction by OWNER_LOCK_TIMEOUT_MS, and marks the transaction as
 * holding the lock once it does (ownerLockCte, src/db/owner-lock.ts, which
 * says why each set_config sits where it does). One round trip, not two
 * (#158; production reaches Postgres over a ~114 ms link). owner-lock.spec.ts's
 * #134 case proves the bound holds (a re-plan behind a held lock defers).
 *
 * Writers call it through ownerTransaction; the rule it serves (every
 * writer of a synced table, the owner lock first) is in
 * src/web/calendar/AGENTS.md, Owner lock.
 *
 * No row is NotFound('wardrobe'): the account is gone, typically deleted
 * by deleteAccount while this writer queued behind it. Going on unlocked
 * would fail a foreign key halfway, a 500.
 */
export async function lockOwner(tx: Queryable, ownerId: number): Promise<void> {
  const [locked] = await lockOwnerQuery(tx, ownerId);
  if (!locked) {
    throw new NotFound('wardrobe', { logDetail: `owner ${ownerId} is gone` });
  }
}

/**
 * lockOwner's statement, exported for owner-lock.spec.ts, which EXPLAINs it:
 * the lock timeout's set_config in the scan below LockRows, the mark's
 * above it. Any change here is verified with EXPLAIN (VERBOSE).
 */
export function lockOwnerQuery(tx: Queryable, ownerId: number) {
  const lock = ownerLockCte(tx, ownerId);
  return tx.with(lock).select({ id: lock.id }).from(lock);
}

/**
 * The transactions whose work holds an owner's lock, and whose: a nested
 * ownerTransaction handed one of them joins it (see ownerTransaction).
 * Keyed by Drizzle's transaction object, so a savepoint the work opens on
 * its own (`tx.transaction`) is a new key and takes the lock again.
 */
const lockedFor = new WeakMap<Queryable, number>();

/**
 * `work` in a transaction (a savepoint inside a caller's) that holds the
 * owner lock from its first statement: the one way to write
 * outfit_calendar, the week planner's tables, Muse's needs and
 * suggestions (src/web/calendar/AGENTS.md, Owner lock). The lock comes before
 * any row lock `work` takes (an outfit, a garment, an entry): the re-plan
 * takes those under it too, so taking one first could deadlock. A trip's
 * lock is the one taken before it (src/web/trips). `writer` names the
 * operation for the log (the function's name).
 *
 * Every lock wait from here to the end of the transaction is bounded by
 * OWNER_LOCK_TIMEOUT_MS (lockOwner); a wait past it throws OwnerLockTimeout.
 *
 * **Nested in an ownerTransaction of the same owner** (handed its `tx`:
 * "Wear this" is pickIdea, then wearOutfitOn's insertEntry and
 * setEntryWorn, all in wearIdea's), `work` runs in the caller's
 * transaction as it is: no savepoint, no second lock. Each nesting used to
 * cost four statements (savepoint, lock timeout, lock, release; #158), one
 * round trip each. So a nested writer's failure is its caller's: a caller
 * that must carry on after one catches it inside its own
 * `tx.transaction(...)` savepoint (none does today).
 *
 * Nested inside any other transaction, this is a savepoint and the lock
 * belongs to the outermost transaction once taken. But if this savepoint
 * is the first to take it and then rolls back (`work` throws) while the
 * caller catches and carries on, the lock goes with the savepoint: the rest
 * of the caller's transaction runs unlocked. No caller does that today; one
 * that must keep going after a failed owner write takes lockOwner itself
 * first.
 */
export async function ownerTransaction<T>(
  db: Queryable,
  ownerId: number,
  writer: string,
  work: (tx: Queryable) => Promise<T>,
): Promise<T> {
  try {
    // Joined, the wait is still this writer's: mapped here, so the 503's
    // log names it (pickIdea's garments inside wearIdea), not the caller.
    if (lockedFor.get(db) === ownerId) return await work(db);
    return await db.transaction(async (tx) => {
      await lockOwner(tx, ownerId);
      lockedFor.set(tx, ownerId);
      try {
        return await work(tx);
      } finally {
        lockedFor.delete(tx);
      }
    });
  } catch (error) {
    // The innermost ownerTransaction maps it; the callers pass it on.
    if (!(error instanceof OwnerLockTimeout) && isLockTimeout(error)) {
      throw new OwnerLockTimeout(writer, ownerId);
    }
    throw error;
  }
}
