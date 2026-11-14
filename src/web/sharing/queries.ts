import { and, eq, gt, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../../db/client';
import { markSecretChecked } from '../../metrics/request-timing';
import { isUniqueViolation } from '../../db/errors';
import {
  type SharePermission,
  SHARE_GRANTEE_UNIQUE,
  user,
  wardrobeShare,
} from '../../db/schema';
import { type SessionStamp, sessionStillOpenSql } from '../auth/tokens';
import { NotFound } from '../refusals';
import type { Actor } from './access';

/**
 * Wardrobe shares. A row is either an open invite (invite_token set, no
 * grantee, not accepted; the UI only makes these), an invite addressed to
 * a user (token and grantee set, not accepted), or an accepted share
 * (grantee and accepted_at set, token cleared). (grantor, grantee) is
 * unique, so a user holds at most one row per wardrobe.
 *
 * An unanswered invite lives INVITE_LIFETIME_MS from created_at (#668),
 * derived, not stored: created_at is stamped by createInvite from the app's
 * clock, and every check compares it with a cutoff from that clock
 * (inviteCutoff), never Postgres now(), so the harness clock and its shift
 * move both. Accepted shares never expire.
 */

/** How long an unanswered invite can be accepted (#668). */
export const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** An unanswered invite created at or before this instant has expired. */
export function inviteCutoff(now: Date): Date {
  return new Date(now.getTime() - INVITE_LIFETIME_MS);
}

function expiredAt(createdAt: Date, cutoff: Date): boolean {
  return createdAt.getTime() <= cutoff.getTime();
}

export interface ShareParty {
  id: number;
  email: string | null;
  firstName: string | null;
}

export interface ShareView {
  id: number;
  permission: SharePermission;
  inviteToken: string | null;
  acceptedAt: Date | null;
  /** An unanswered invite past its lifetime: listed, never offered (#668). */
  expired: boolean;
  grantor: ShareParty;
  grantee: ShareParty | null;
}

const grantor = alias(user, 'grantor');
const grantee = alias(user, 'grantee');

function selectShares(db: Db) {
  return db
    .select({
      id: wardrobeShare.id,
      permission: wardrobeShare.permission,
      inviteToken: wardrobeShare.inviteToken,
      acceptedAt: wardrobeShare.acceptedAt,
      createdAt: wardrobeShare.createdAt,
      grantor: {
        id: grantor.id,
        email: grantor.email,
        firstName: grantor.firstName,
      },
      grantee: {
        id: grantee.id,
        email: grantee.email,
        firstName: grantee.firstName,
      },
    })
    .from(wardrobeShare)
    .innerJoin(grantor, eq(grantor.id, wardrobeShare.grantorId))
    .leftJoin(grantee, eq(grantee.id, wardrobeShare.granteeId))
    .orderBy(wardrobeShare.id);
}

/**
 * Everything Profile › Sharing lists for a user, from one statement (#170;
 * it was three): every row the user is a party to, sorted into
 * - `outbound`: wardrobes this user shares, accepted shares and open invites;
 * - `inbound`: wardrobes shared with this user;
 * - `pending`: invites addressed to this user, not yet answered.
 * An expired invite stays in its list, marked `expired`, so its grantor sees
 * a link went out and can withdraw it.
 */
export async function sharesOf(
  db: Db,
  userId: number,
  now = new Date(),
): Promise<{
  outbound: ShareView[];
  inbound: ShareView[];
  pending: ShareView[];
}> {
  const cutoff = inviteCutoff(now);
  const rows = (
    await selectShares(db).where(
      or(
        eq(wardrobeShare.grantorId, userId),
        eq(wardrobeShare.granteeId, userId),
      ),
    )
  ).map(({ createdAt, ...row }) => ({
    ...row,
    expired: row.acceptedAt === null && expiredAt(createdAt, cutoff),
  }));
  const received = rows.filter((row) => row.grantee?.id === userId);
  return {
    outbound: rows.filter((row) => row.grantor.id === userId),
    inbound: received.filter((row) => row.acceptedAt !== null),
    pending: received.filter((row) => row.acceptedAt === null),
  };
}

/** What the invite landing shows: the permission offered, and who offers it. */
export interface InviteView {
  permission: SharePermission;
  grantor: { firstName: string | null };
  /** Past its lifetime: the landing says so and offers no Accept (#668). */
  expired: boolean;
}

/**
 * The invite landing's read. The page is public (opened before signing in,
 * fetched by link previews), so the query reads the inviter's first name
 * alone, never an email, and nothing of the grantee. An accepted invite
 * has no token, so it is not found.
 */
export async function findInvite(
  db: Db,
  token: string,
  now = new Date(),
): Promise<InviteView | undefined> {
  markSecretChecked();
  const [row] = await db
    .select({
      permission: wardrobeShare.permission,
      createdAt: wardrobeShare.createdAt,
      grantor: { firstName: user.firstName },
    })
    .from(wardrobeShare)
    .innerJoin(user, eq(user.id, wardrobeShare.grantorId))
    .where(eq(wardrobeShare.inviteToken, token));
  if (!row) return undefined;
  const { createdAt, ...invite } = row;
  return { ...invite, expired: expiredAt(createdAt, inviteCutoff(now)) };
}

/**
 * Makes an open invite, or undefined, storing nothing, when the session
 * that asked has ended: one insert-select from the grantor's own row,
 * locked, only while it still opens `session` (the session's stamp,
 * sessionStamp: its fingerprint and session version), as upsertDevice does
 * (#512). Without a `session` (the seed and spec fixtures: no session) the
 * row is still locked and nothing is checked; a missing grantor is
 * NotFound('account'). The lock is the one a new password's writer and
 * Sign out everywhere take (updatePasswordHash, endOtherSessions), so they
 * take turns: an invite committed first is deleted by the password's
 * revocations, read after their own wait (Sign out everywhere keeps
 * invites: revokeSignIns); a bump committed first moves the stamp and
 * this inserts nothing. `no key update`: it conflicts
 * with the password's update without holding up the household's foreign
 * key checks. wardrobe_share is not a synced table (src/db/sync-tables.ts),
 * so the user row lock is the only lock here, never the owner lock.
 * created_at comes from the app's clock (`now`), what expiry compares.
 * Raw SQL: Drizzle's insert-select must select the serial id (insertUser).
 */
export interface NewInvite {
  id: number;
  inviteToken: string;
}
export function createInvite(
  db: Queryable,
  grantorId: number,
  permission: SharePermission,
  options: { session: SessionStamp; now?: Date },
): Promise<NewInvite | undefined>;
export function createInvite(
  db: Queryable,
  grantorId: number,
  permission: SharePermission,
  options?: { now?: Date },
): Promise<NewInvite>;
export async function createInvite(
  db: Queryable,
  grantorId: number,
  permission: SharePermission,
  { session, now = new Date() }: { session?: SessionStamp; now?: Date } = {},
): Promise<NewInvite | undefined> {
  const stillOpen =
    session === undefined ? sql`` : sql` and ${sessionStillOpenSql(session)}`;
  const { rows } = await db.execute<{ id: number; invite_token: string }>(sql`
    insert into ${wardrobeShare} (grantor_id, permission, invite_token, created_at)
    select ${user.id}, ${permission}, ${randomUUID()}, ${now}
    from ${user}
    where ${user.id} = ${grantorId}${stillOpen}
    for no key update
    returning id, invite_token`);
  const [row] = rows;
  if (row) return { id: row.id, inviteToken: row.invite_token };
  if (session !== undefined) return undefined;
  throw new NotFound('account', { logDetail: `user ${grantorId}` });
}

/**
 * Deletes every invite `grantorId` sent that nobody accepted (open links
 * and addressed invites alike); accepted shares and the invites others sent
 * them stay. A data-modifying CTE of the new password's revocation
 * statement (updatePasswordHash, #668), read after its row lock, so an
 * invite minted while it waited goes too (createInvite).
 */
export function revokeOpenInvitesStatement(db: Queryable, grantorId: number) {
  return db
    .delete(wardrobeShare)
    .where(
      and(
        eq(wardrobeShare.grantorId, grantorId),
        isNull(wardrobeShare.acceptedAt),
      ),
    )
    .returning({ id: wardrobeShare.id });
}

/** Why an invite could not be accepted; each has its message on the manage page. */
export type AcceptRefusal =
  | 'not-found'
  | 'expired'
  | 'own-invite'
  | 'wrong-recipient'
  | 'already-shared';

export type AcceptResult =
  | { accepted: true; shareId: number; grantorId: number }
  | { accepted: false; reason: AcceptRefusal };

/**
 * Accepts an invite for `granteeId` in two statements (#170; it was a
 * transaction of five): the invite with the share its grantor already gave
 * this user, if any, then one write guarded by the token, so an invite
 * accepted, declined or withdrawn in between is "not found" and nothing
 * changes. An accepted invite has no token any more, so "already accepted"
 * is "not found" too. A second invite from a wardrobe the user already has
 * folds into the existing share (upgrading VIEW to MANAGE) and is deleted.
 * A pending addressed invite from the same grantor collides with the
 * (grantor, grantee) constraint: that is "already shared".
 *
 * Expiry is one cutoff from `now`, checked on the read ("expired") and
 * again in the write's guard, so an invite that expires between the two is
 * "gone meanwhile" ("not-found") and nothing changes: valid only while
 * created_at is after the cutoff, with no instant between the checks.
 */
export async function acceptInvite(
  db: Db,
  token: string,
  granteeId: number,
  now = new Date(),
): Promise<AcceptResult> {
  markSecretChecked();
  const cutoff = inviteCutoff(now);
  const existing = alias(wardrobeShare, 'existing');
  const [invite] = await db
    .select({
      id: wardrobeShare.id,
      grantorId: wardrobeShare.grantorId,
      granteeId: wardrobeShare.granteeId,
      permission: wardrobeShare.permission,
      createdAt: wardrobeShare.createdAt,
      existing: { id: existing.id, permission: existing.permission },
    })
    .from(wardrobeShare)
    .leftJoin(
      existing,
      and(
        eq(existing.grantorId, wardrobeShare.grantorId),
        eq(existing.granteeId, granteeId),
        isNotNull(existing.acceptedAt),
      ),
    )
    .where(
      and(
        eq(wardrobeShare.inviteToken, token),
        isNull(wardrobeShare.acceptedAt),
      ),
    );
  if (!invite) return { accepted: false, reason: 'not-found' };
  const refusal = refusalOf(invite, granteeId);
  if (refusal) return { accepted: false, reason: refusal };
  if (expiredAt(invite.createdAt, cutoff)) {
    return { accepted: false, reason: 'expired' };
  }
  // The invite as read: still holding its token, so still unanswered, and
  // still inside its lifetime (the claim's and the fold's one guard).
  const unanswered = and(
    eq(wardrobeShare.id, invite.id),
    eq(wardrobeShare.inviteToken, token),
    gt(wardrobeShare.createdAt, cutoff),
  );
  const held = invite.existing;
  const outcome = held
    ? await foldInvite(db, unanswered, {
        shareId: held.id,
        upgrade: invite.permission === 'MANAGE' && held.permission === 'VIEW',
      })
    : await claimInvite(db, unanswered, granteeId);
  return typeof outcome === 'number'
    ? { accepted: true, shareId: outcome, grantorId: invite.grantorId }
    : { accepted: false, reason: outcome };
}

/** Why `granteeId` may not accept the invite as read, if they may not. */
function refusalOf(
  invite: { grantorId: number; granteeId: number | null },
  granteeId: number,
): AcceptRefusal | undefined {
  if (invite.grantorId === granteeId) return 'own-invite';
  if (invite.granteeId !== null && invite.granteeId !== granteeId) {
    return 'wrong-recipient';
  }
  return undefined;
}

/**
 * Makes the invite `granteeId`'s share: its id, or why not (gone meanwhile,
 * or the (grantor, grantee) constraint: another invite of theirs).
 */
async function claimInvite(
  db: Db,
  unanswered: SQL | undefined,
  granteeId: number,
): Promise<number | 'not-found' | 'already-shared'> {
  try {
    const [claimed] = await db
      .update(wardrobeShare)
      .set({ granteeId, acceptedAt: new Date(), inviteToken: null })
      .where(unanswered)
      .returning({ id: wardrobeShare.id });
    return claimed?.id ?? 'not-found';
  } catch (error) {
    if (isUniqueViolation(error, SHARE_GRANTEE_UNIQUE)) return 'already-shared';
    throw error;
  }
}

/**
 * Deletes an invite into the share its grantor already gave the user, in
 * one statement: the delete and, with `upgrade`, the share raised to MANAGE
 * only if the delete found the invite (data-modifying CTEs, which Postgres
 * runs whether or not the outer select reads them). The share's id, or
 * 'not-found' when the invite was answered meanwhile.
 */
async function foldInvite(
  db: Db,
  unanswered: SQL | undefined,
  into: { shareId: number; upgrade: boolean },
): Promise<number | 'not-found'> {
  const folded = db
    .$with('folded')
    .as(
      db
        .delete(wardrobeShare)
        .where(unanswered)
        .returning({ id: wardrobeShare.id }),
    );
  const upgraded = db.$with('upgraded').as(
    db
      .update(wardrobeShare)
      .set({ permission: 'MANAGE' })
      .where(
        and(
          eq(wardrobeShare.id, into.shareId),
          sql`exists (select 1 from ${folded})`,
        ),
      )
      .returning({ id: wardrobeShare.id }),
  );
  const [row] = await db
    .with(...(into.upgrade ? [folded, upgraded] : [folded]))
    .select({ found: sql<number>`count(*)::int` })
    .from(folded);
  return row.found > 0 ? into.shareId : 'not-found';
}

/**
 * Deletes an unanswered invite in one statement: the addressee declining
 * it, or the grantor withdrawing an open link (the invite's answerer:
 * its grantee, else its grantor). Anyone else is refused (false, nothing
 * deleted), so an open link survives for the person it was meant for.
 */
export async function declineInvite(
  db: Db,
  token: string,
  userId: number,
): Promise<boolean> {
  markSecretChecked();
  const deleted = await db
    .delete(wardrobeShare)
    .where(
      and(
        eq(wardrobeShare.inviteToken, token),
        eq(
          sql`coalesce(${wardrobeShare.granteeId}, ${wardrobeShare.grantorId})`,
          userId,
        ),
      ),
    )
    .returning({ id: wardrobeShare.id });
  return deleted.length > 0;
}

/**
 * Removes a share (or an outstanding invite) the actor is a party to, in
 * one statement: the grantor revoking it or the grantee leaving. Any other
 * share, one between two other people included, is NotFound('share'), so
 * share ids reveal nothing; a share the actor holds of the wardrobe gives
 * no say over its other rows.
 */
export async function removeShare(
  db: Db,
  actor: Actor,
  shareId: number,
): Promise<void> {
  const removed = await db
    .delete(wardrobeShare)
    .where(
      and(
        eq(wardrobeShare.id, shareId),
        or(
          eq(wardrobeShare.grantorId, actor.userId),
          eq(wardrobeShare.granteeId, actor.userId),
        ),
      ),
    )
    .returning({ id: wardrobeShare.id });
  if (removed.length === 0) {
    throw new NotFound('share', {
      logDetail: `share ${shareId} is not user ${actor.userId}'s`,
    });
  }
}
