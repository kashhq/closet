import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { OWNER_LOCKED, ownersLockSql } from '../db/owner-lock';
import { syncTombstone, user } from '../db/schema';
import type { Logger } from '../logger';

/**
 * The changes feed's tombstone prune (#196b-3; src/web/sync/AGENTS.md,
 * Expiry): nightly, a row deletion's tombstone older than the retention is
 * deleted and its owner's `sync_floor` raised to the newest revision pruned,
 * in the same statement, so a feed page's snapshot sees both or neither: a
 * cursor below the new floor is a 410 (a full sync), never a delta that
 * silently lacks the deletion.
 *
 * A tombstone carrying a client id is never pruned: it is what refuses a
 * replayed create of the deleted row (closet_sync_stamp's CL410, decisions
 * on #607). Below the floor the feed sends it to no one.
 */

/** How long a deletion stays in the feed: a device offline longer syncs in full. */
const TOMBSTONE_RETENTION_DAYS = 90;

/**
 * Tombstones per statement. Each statement holds its owners' locks only
 * while it deletes its batch, so a writer waits at most one batch.
 */
const PRUNE_BATCH = 1_000;

export interface SyncPrune {
  pruned: number;
  /** The owners whose floor moved. */
  owners: number;
}

type BatchRow = {
  ownerId: number;
  floor: string;
  pruned: number;
};

/**
 * One batch: the oldest prunable tombstones by owner, the owners locked in
 * id order (the owner lock's one global order, before any tombstone's row
 * lock: the floor's UPDATE would take the user row anyway, and taken any
 * other way it could deadlock with a writer of several owners), the batch
 * deleted, each owner's floor raised to its newest revision pruned.
 *
 * OWNER_LOCKED (any owner locked) puts the whole lock CTE ahead of the scan;
 * the per-owner membership is what refuses a tombstone whose owner is not
 * locked (an account deleted since the batch was read: its rows cascade, or
 * are left to the next batch). Such a skip can end the run on a short
 * batch; what remains is the next night's.
 *
 * Age is Postgres's `now()`, the clock that stamped `deleted_at`, never the
 * process's (the gate's clock shift moves only JS's Date).
 */
function pruneBatch(db: Db, batch: number) {
  return db.execute<BatchRow>(sql`
    with batch as (
      select id, owner_id from ${syncTombstone}
      where client_id is null
        and deleted_at < now() - make_interval(days => ${TOMBSTONE_RETENTION_DAYS})
      order by owner_id, revision, id
      limit ${batch}
    ),
    ${ownersLockSql(db, sql`select owner_id from batch`)},
    pruned as (
      delete from ${syncTombstone}
      where id in (select id from batch)
        and ${OWNER_LOCKED}
        and owner_id in (select id from owner_lock)
      returning owner_id, revision
    ),
    per_owner as (
      select owner_id, max(revision) as revision, count(*)::int as pruned
      from pruned group by owner_id
    ),
    raised as (
      update ${user} set sync_floor = greatest(${user.syncFloor}, per_owner.revision)
      from per_owner where ${user.id} = per_owner.owner_id
      returning ${user.id} as owner_id, ${user.syncFloor} as floor
    )
    select raised.owner_id as "ownerId", raised.floor, per_owner.pruned
    from raised join per_owner using (owner_id)
    order by raised.owner_id
  `);
}

/**
 * Every prunable tombstone, a batch per statement until one comes back
 * short (what remains is younger, a client's, or arrived meanwhile: the
 * next night's). Used by server.ts's nightly `sync_prune` job.
 */
export async function pruneSyncTombstones(
  { db, logger }: { db: Db; logger: Logger },
  batch: number = PRUNE_BATCH,
): Promise<SyncPrune> {
  const started = performance.now();
  const owners = new Set<number>();
  let pruned = 0;
  let batches = 0;
  for (;;) {
    const { rows } = await pruneBatch(db, batch);
    batches += 1;
    let inBatch = 0;
    for (const row of rows) {
      owners.add(row.ownerId);
      inBatch += row.pruned;
      logger.debug(
        `Sync floor of user ${row.ownerId} raised to ${row.floor}: ${row.pruned} tombstone(s) pruned`,
      );
    }
    pruned += inBatch;
    if (inBatch < batch) break;
  }
  logger.info(
    `Pruned ${pruned} sync tombstone(s) older than ${TOMBSTONE_RETENTION_DAYS} days of ${owners.size} owner(s) in ${batches} batch(es), ${Math.round(performance.now() - started)} ms`,
  );
  return { pruned, owners: owners.size };
}
