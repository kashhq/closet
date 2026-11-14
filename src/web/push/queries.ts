import { and, eq, inArray, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db, Queryable } from '../../db/client';
import { pushReminder, user, userDevice } from '../../db/schema';
import { type SessionStamp, sessionStillOpenSql } from '../auth/tokens';
import type { IsoDate } from '../../calendar-date';
import type {
  DueReminder,
  MinuteOfDay,
  ReminderDevice,
  ReminderKind,
} from '../../push/reminders';

/**
 * user_device: one row per browser push subscription, keyed by its endpoint
 * (unique across users; see the table in src/db/schema.ts).
 */

/** A browser's PushSubscription as the routes accept it (routes.tsx). */
export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface DeviceRow {
  id: number;
  pushEndpoint: string;
  keyP256dh: string;
  keyAuth: string;
}

/**
 * Stores the subscription for this user, keyed by its endpoint: a browser
 * sending it again (every signed-in app start), with renewed keys, or signed
 * in as another account updates the one row instead of colliding with it.
 * The endpoint belongs to whoever is signed in on that browser now; its
 * reminders and Muse's rounds were the previous account's choice, so a
 * move turns them off (opt-in per device and per person).
 *
 * Undefined, storing nothing, when the session that sent it has ended: the
 * row is selected from the user's own, locked, only while it still opens
 * `session` (the session's stamp, sessionStamp: its password fingerprint
 * and session version). The lock is the one a new password's writer and
 * Sign out everywhere take (updatePasswordHash, endOtherSessions), so they
 * take turns (#512, #700): a subscribe holding it commits first and the
 * revocation, read after its own wait, deletes the row; a bump holding it
 * commits first and this statement, re-reading the locked row once
 * granted, finds the stamp moved and inserts nothing.
 * Without the lock the foreign key's check took only a share lock, and a
 * row committed meanwhile outlived the new password. `no key update`, not
 * `update`: it conflicts with the password's update all the same, without
 * holding up the household's inserts that check a foreign key to the user.
 *
 * One statement, as before the lock (the subscribe's budget,
 * auth-statements.spec). Raw SQL: Drizzle's insert-select must select every
 * column, the serial id included (insertUser).
 */
export async function upsertDevice(
  db: Queryable,
  userId: number,
  session: SessionStamp,
  subscription: SubscriptionInput,
  userAgent: string | undefined,
): Promise<number | undefined> {
  const { rows } = await db.execute<{ id: number }>(sql`
    insert into ${userDevice} (user_id, push_endpoint, key_p256dh, key_auth, user_agent)
    select ${user.id}, ${subscription.endpoint}, ${subscription.keys.p256dh}, ${subscription.keys.auth}, ${userAgent ?? null}
    from ${user}
    where ${user.id} = ${userId} and ${sessionStillOpenSql(session)}
    for no key update
    on conflict (push_endpoint) do update set
      user_id = excluded.user_id,
      key_p256dh = excluded.key_p256dh,
      key_auth = excluded.key_auth,
      user_agent = excluded.user_agent,
      updated_at = now(),
      morning_reminder = case when ${userDevice.userId} = excluded.user_id then ${userDevice.morningReminder} end,
      evening_reminder = case when ${userDevice.userId} = excluded.user_id then ${userDevice.eveningReminder} end,
      reminders_set_at = case when ${userDevice.userId} = excluded.user_id then ${userDevice.remindersSetAt} end,
      muse_rounds = ${userDevice.userId} = excluded.user_id and ${userDevice.museRounds}
    returning id`);
  return rows[0]?.id;
}

/**
 * Removes this user's row for the endpoint; another user's is left alone.
 * Returns whether there was one.
 */
export async function deleteDevice(
  db: Db,
  userId: number,
  endpoint: string,
): Promise<boolean> {
  const rows = await db
    .delete(userDevice)
    .where(
      and(eq(userDevice.userId, userId), eq(userDevice.pushEndpoint, endpoint)),
    )
    .returning({ id: userDevice.id });
  return rows.length > 0;
}

/** Every device the user receives notifications on (the profile's test send). */
export async function devicesOf(db: Db, userId: number): Promise<DeviceRow[]> {
  // user_device_user_id_index.
  return db
    .select({
      id: userDevice.id,
      pushEndpoint: userDevice.pushEndpoint,
      keyP256dh: userDevice.keyP256dh,
      keyAuth: userDevice.keyAuth,
    })
    .from(userDevice)
    .where(eq(userDevice.userId, userId))
    .orderBy(userDevice.id);
}

/** A device as a batch of sends reads it: whose it is, and what it opted in to. */
export interface UserDeviceRow extends DeviceRow {
  userId: number;
  morningReminder: boolean;
  /** Muse's round notification (#337). */
  museRounds: boolean;
}

/**
 * Every device of `userIds`, in one statement: the sender's batch
 * (PushSender.sendEach), which picks each message's devices from them. Read
 * at send time, never earlier in a job: a device signed in as someone else
 * or revoked (#73) since the job started receives nothing of this user's.
 * user_device_user_id_index.
 */
export async function devicesOfUsers(
  db: Db,
  userIds: readonly number[],
): Promise<UserDeviceRow[]> {
  if (userIds.length === 0) return [];
  return db
    .select({
      id: userDevice.id,
      userId: userDevice.userId,
      pushEndpoint: userDevice.pushEndpoint,
      keyP256dh: userDevice.keyP256dh,
      keyAuth: userDevice.keyAuth,
      morningReminder: sql<boolean>`${userDevice.morningReminder} is not null`,
      museRounds: userDevice.museRounds,
    })
    .from(userDevice)
    .where(inArray(userDevice.userId, [...new Set(userIds)]))
    .orderBy(userDevice.id);
}

/**
 * The one remover of an account's devices when its sessions are revoked: a
 * signed-out device receives nobody's notifications, and a device signed
 * out away from itself would otherwise keep getting the account's reminders
 * (which name planned outfits on its lock screen) until its push service
 * said 410. `keep` is the endpoint of the device making the change (the
 * change-password form posts it), which stays signed in and keeps its row
 * and reminders; an endpoint that is not one of this user's keeps nothing.
 * The devices' reminder claims go with them (push_reminder cascades).
 *
 * The statement, returning a row per device removed. Callers:
 * updatePasswordHash (the change-password route and `user:set-password`),
 * as a CTE of the revocation statement in the password's transaction,
 * and revokeDevices.
 */
export function revokeDevicesStatement(
  db: Queryable,
  userId: number,
  keep?: string,
) {
  // user_device_user_id_index.
  return db
    .delete(userDevice)
    .where(
      and(
        eq(userDevice.userId, userId),
        keep === undefined ? undefined : ne(userDevice.pushEndpoint, keep),
      ),
    )
    .returning({ id: userDevice.id });
}

/**
 * revokeDevicesStatement run on its own, for `push:revoke-all` (after an
 * ACCESS_TOKEN_SECRET rotation). Returns how many were removed.
 */
export async function revokeDevices(
  tx: Queryable,
  userId: number,
): Promise<number> {
  return (await revokeDevicesStatement(tx, userId)).length;
}

/** The users with at least one device: whose `push:revoke-all` revokes. */
export async function usersWithDevices(tx: Queryable): Promise<number[]> {
  const rows = await tx
    .selectDistinct({ userId: userDevice.userId })
    .from(userDevice)
    .orderBy(userDevice.userId);
  return rows.map((row) => row.userId);
}

/** Drops a device its push service reports gone (404/410). */
export async function deleteDeviceById(db: Db, id: number): Promise<void> {
  await db.delete(userDevice).where(eq(userDevice.id, id));
}

/** A device's reminder times (null when off), and whether it takes Muse's rounds (#337). */
export interface ReminderSettings {
  morning: MinuteOfDay | null;
  evening: MinuteOfDay | null;
  museRounds: boolean;
}

/**
 * The reminders of this user's device at `endpoint` (the browser names its
 * own subscription), or undefined when the endpoint is not one of theirs:
 * never registered, removed, or signed in as someone else since.
 */
export async function findReminderSettings(
  db: Db,
  userId: number,
  endpoint: string,
): Promise<ReminderSettings | undefined> {
  const [row] = await db
    .select({
      morning: userDevice.morningReminder,
      evening: userDevice.eveningReminder,
      museRounds: userDevice.museRounds,
    })
    .from(userDevice)
    .where(
      and(eq(userDevice.userId, userId), eq(userDevice.pushEndpoint, endpoint)),
    );
  return row;
}

/** The row as it was before an update: joined to itself, it reads the statement's snapshot. */
const deviceBefore = alias(userDevice, 'before');

/**
 * The one writer of a device's reminders: saves both times (null turns one
 * off) and Muse's rounds on this user's device at `endpoint`, stamped `now`,
 * so a reminder whose time has passed today first goes out tomorrow
 * (dueReminders). The device id and whether a time changed (turned on, off
 * or moved: what the status line's "starts tomorrow" is about, never Muse's
 * toggle), in one statement; undefined when the endpoint is not one of
 * theirs.
 */
export async function saveReminderSettings(
  db: Db,
  userId: number,
  endpoint: string,
  settings: ReminderSettings,
  now: Date,
): Promise<{ deviceId: number; timesChanged: boolean } | undefined> {
  const [row] = await db
    .update(userDevice)
    .set({
      morningReminder: settings.morning,
      eveningReminder: settings.evening,
      museRounds: settings.museRounds,
      remindersSetAt: now,
    })
    .from(deviceBefore)
    .where(
      and(
        eq(deviceBefore.id, userDevice.id),
        eq(userDevice.userId, userId),
        eq(userDevice.pushEndpoint, endpoint),
      ),
    )
    .returning({
      deviceId: userDevice.id,
      timesChanged: sql<boolean>`(${deviceBefore.morningReminder} is distinct from ${settings.morning}::smallint or ${deviceBefore.eveningReminder} is distinct from ${settings.evening}::smallint)`,
    });
  return row;
}

/** Every device with a reminder on, for the scheduler (a household's handful: no index). */
export function reminderDevices(db: Db): Promise<ReminderDevice[]> {
  return db
    .select({
      id: userDevice.id,
      userId: userDevice.userId,
      morning: userDevice.morningReminder,
      evening: userDevice.eveningReminder,
      setAt: userDevice.remindersSetAt,
    })
    .from(userDevice)
    .where(
      or(
        isNotNull(userDevice.morningReminder),
        isNotNull(userDevice.eveningReminder),
      ),
    );
}

/**
 * Claims the due reminders for this process to send, in one statement:
 * each is inserted into push_reminder unless a row for its device, kind and
 * day exists, and only the inserted ones come back. Two servers claiming
 * the same reminder at once (an overlapping deploy) each insert; Postgres
 * makes the second wait on the first's primary key and then skip it, so
 * exactly one of them sends. A device deleted meanwhile fails the foreign
 * key and takes the whole claim with it: the next minute claims the rest.
 */
export async function claimReminders(
  db: Db,
  due: readonly DueReminder[],
  now: Date,
): Promise<{ deviceId: number; kind: ReminderKind; day: IsoDate }[]> {
  if (due.length === 0) return [];
  return db
    .insert(pushReminder)
    .values(
      due.map(({ deviceId, kind, day }) => ({
        deviceId,
        kind,
        day,
        claimedAt: now,
      })),
    )
    .onConflictDoNothing({
      target: [pushReminder.deviceId, pushReminder.kind, pushReminder.day],
    })
    .returning({
      deviceId: pushReminder.deviceId,
      kind: pushReminder.kind,
      day: pushReminder.day,
    });
}

/**
 * Gives back claims this process took and never sent on (the batch's
 * device read failed, src/web/push/reminders.ts): the next minute's run
 * finds them due again, while still within LATE_LIMIT_MINUTES, and claims
 * them afresh. Safe only because nothing was sent on them. Returns how
 * many were released.
 */
export async function releaseReminderClaims(
  db: Db,
  claims: readonly { deviceId: number; kind: ReminderKind; day: IsoDate }[],
): Promise<number> {
  if (claims.length === 0) return 0;
  const released = await db
    .delete(pushReminder)
    .where(
      or(
        ...claims.map((claim) =>
          and(
            eq(pushReminder.deviceId, claim.deviceId),
            eq(pushReminder.kind, claim.kind),
            eq(pushReminder.day, claim.day),
          ),
        ),
      ),
    )
    .returning({ deviceId: pushReminder.deviceId });
  return released.length;
}

/** Removes claims for days before `before`: they only ever guard today. */
export async function pruneReminderClaims(
  db: Db,
  before: IsoDate,
): Promise<number> {
  const deleted = await db
    .delete(pushReminder)
    .where(lt(pushReminder.day, before))
    .returning({ deviceId: pushReminder.deviceId });
  return deleted.length;
}
