import { eq, type SQL, sql } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import type { Db, Queryable } from '../../db/client';
import { syncEpoch, syncTombstone, user, wardrobeShare } from '../../db/schema';
import type {
  SYNC_ROOTS,
  SYNC_STAMPS,
  SyncResource,
} from '../../db/sync-tables';
import { HttpError } from '../errors';
import { acceptedSharesWith } from '../sharing/access';
import { type Epoch, type Grant, KIND, type Position } from './cursor';

/** A synced root as sync-tables.ts lists it. */
export type FeedRoot = (typeof SYNC_ROOTS)[number];

/** A stamped resource (the week template): its revision a column of the owner's user row. */
export type FeedStamp = (typeof SYNC_STAMPS)[number];

/**
 * The changes feed's statements (feed.ts): the wardrobes, then one keyset
 * read across every resource and the tombstones. Both run in the page's
 * REPEATABLE READ snapshot, so the revision read first bounds every row
 * the second sees: a revision is bumped under the owner lock and commits
 * with its rows, so nothing at or below it is still in flight.
 */

/** `work` in one REPEATABLE READ READ ONLY transaction: a page's one snapshot. */
export function inFeedSnapshot<T>(
  db: Db,
  work: (tx: Queryable) => Promise<T>,
): Promise<T> {
  return db.transaction(work, {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}

/**
 * The database has no `sync_epoch` row (migration 0061 writes it; a hand
 * edit or a partial restore removed it): no cursor can be answered, so
 * every page is a 500, logged once by the root error handler with this
 * message. Fixed by `INSERT INTO sync_epoch DEFAULT VALUES`, then a bump.
 */
class SyncEpochMissingError extends Error {
  constructor() {
    super(
      'The changes feed found no sync_epoch row: the database is misconfigured (migration 0061 writes it)',
    );
    this.name = 'SyncEpochMissingError';
  }
}

export interface FeedWardrobe {
  ownerId: number;
  /** The owner's newest revision in this snapshot: the end of the read. */
  revision: number;
  floor: number;
  /** What the caller may do there: the cursor keeps it beside the position. */
  grant: Grant;
}

/**
 * The caller's own wardrobe, then each one shared with them (the access
 * resolver's accepted shares) by owner id: the order a page fills in, each
 * with its grant (their own, or the share's permission). The epoch rides on
 * every row (its one-row table joined on), so reading it costs no statement
 * and it is the snapshot's own.
 */
export async function feedWardrobes(
  db: Queryable,
  userId: number,
): Promise<{ epoch: Epoch; wardrobes: FeedWardrobe[] }> {
  const columns = {
    ownerId: user.id,
    revision: user.revision,
    floor: user.syncFloor,
    epoch: syncEpoch.epoch,
    bumped: sql<boolean>`${syncEpoch.bumpedAt} is not null`,
  };
  // A left join, so a missing epoch row reads as a null epoch, never as a
  // missing user.
  const rows = await unionAll(
    db
      .select({ ...columns, grant: sql<Grant>`'OWN'` })
      .from(user)
      .leftJoin(syncEpoch, sql`true`)
      .where(eq(user.id, userId)),
    db
      .select({ ...columns, grant: sql<Grant>`${wardrobeShare.permission}` })
      .from(wardrobeShare)
      .innerJoin(user, eq(user.id, wardrobeShare.grantorId))
      .leftJoin(syncEpoch, sql`true`)
      .where(acceptedSharesWith(userId)),
  );
  const own = rows.find((row) => row.ownerId === userId);
  // The account was deleted after its token was checked: the token went
  // with it, so this is the 401 the token check now answers.
  if (!own) throw new HttpError(401);
  if (own.epoch === null) throw new SyncEpochMissingError();
  const wardrobes = rows
    .map(({ ownerId, revision, floor, grant }) => ({
      ownerId,
      revision,
      floor,
      grant,
    }))
    .sort(
      (a, b) =>
        Number(b.ownerId === userId) - Number(a.ownerId === userId) ||
        a.ownerId - b.ownerId,
    );
  return { epoch: { epoch: own.epoch, bumped: own.bumped }, wardrobes };
}

/** One wardrobe's part of a page: where it resumes and what it carries. */
export interface WardrobeRead extends FeedWardrobe {
  at: Position;
  /** The owner's own: every registered resource; a share's: its share-aware ones. */
  roots: readonly FeedRoot[];
  /** Likewise of the stamps (none is share-aware). */
  stamps: readonly FeedStamp[];
}

/** An item of the page in feed order: a row to read, or a deletion. */
export interface FeedItem {
  ownerId: number;
  revision: number;
  kind: typeof KIND.tombstone | typeof KIND.row;
  resource: SyncResource;
  id: number;
  seq: number;
  clientId: string | null;
}

/**
 * The first `take` items after each wardrobe's position, wardrobe by
 * wardrobe in `reads` order, in one statement: a branch per resource and
 * one for the tombstones per wardrobe, each on its `(owner, revision)`
 * index with its own limit (a stamp's, the owner's user row by its key).
 * Tombstones at or below the pass's floor are left out (cursor.ts'
 * Position.floor).
 */
export async function feedItems(
  db: Queryable,
  reads: readonly WardrobeRead[],
  take: number,
): Promise<FeedItem[]> {
  const branches = reads.flatMap((read, rank) => [
    tombstoneBranch(read, rank, take),
    ...read.roots.map((root) => rowBranch(read, rank, root, take)),
    ...read.stamps.map((stamp) => stampBranch(read, rank, stamp)),
  ]);
  const { rows } = await db.execute<
    Omit<FeedItem, 'revision'> & { revision: string }
  >(sql`
    select owner_id as "ownerId", revision, kind, resource, id, seq, client_id as "clientId"
    from (${sql.join(branches, sql` union all `)}) feed
    order by rank, revision, kind, resource collate "C", id, seq
    limit ${take}
  `);
  // bigint arrives as text from a raw statement.
  return rows.map((row) => ({ ...row, revision: Number(row.revision) }));
}

/** The keyset's comparison: after `at`, the resource in one collation on both sides. */
function after(
  at: Position,
  item: { kind: SQL; resource: SQL; id: SQL; seq: SQL },
): SQL {
  return sql`(revision, ${item.kind}, ${item.resource} collate "C", ${item.id}, ${item.seq})
    > (${at.revision}::bigint, ${at.kind}::int, ${at.resource}::text collate "C", ${at.id}::int, ${at.seq}::int)`;
}

/** The bounds every branch shares: the owner, from the position to the snapshot's revision. */
function inWindow(read: WardrobeRead): SQL {
  return sql`revision between ${read.at.revision}::bigint and ${read.revision}::bigint`;
}

function rowBranch(
  read: WardrobeRead,
  rank: number,
  root: FeedRoot,
  take: number,
): SQL {
  const resource = root.table;
  const id = sql`${sql.identifier(root.id)}`;
  const clientId = root.clientId ? sql`client_id` : sql`null::uuid`;
  return sql`(
    select ${rank}::int as rank, ${read.ownerId}::int as owner_id, revision,
      ${KIND.row}::int as kind, ${resource}::text collate "C" as resource,
      ${id} as id, 0 as seq, ${clientId} as client_id
    from ${sql.identifier(root.table)}
    where ${sql.identifier(root.owner)} = ${read.ownerId} and ${inWindow(read)}
      and ${after(read.at, { kind: sql`${KIND.row}::int`, resource: sql`${resource}::text`, id, seq: sql`0` })}
    order by revision, ${id}
    limit ${take}
  )`;
}

/**
 * A stamp's one item: the owner's user row, its id the change's, when the
 * stamp's revision is in the window. A user who never wrote it is at the
 * backfill's 0, so a full sync carries it (empty) too. Never tombstoned.
 */
function stampBranch(read: WardrobeRead, rank: number, stamp: FeedStamp): SQL {
  const resource = stamp.resource;
  return sql`(
    select ${rank}::int as rank, ${read.ownerId}::int as owner_id, revision,
      ${KIND.row}::int as kind, ${resource}::text collate "C" as resource,
      id, 0 as seq, null::uuid as client_id
    from (
      select ${user.id} as id, ${sql.identifier(stamp.revision)} as revision
      from ${user} where ${user.id} = ${read.ownerId}
    ) stamped
    where ${inWindow(read)}
      and ${after(read.at, { kind: sql`${KIND.row}::int`, resource: sql`${resource}::text`, id: sql`id`, seq: sql`0` })}
  )`;
}

function tombstoneBranch(read: WardrobeRead, rank: number, take: number): SQL {
  const resource = sql`resource`;
  return sql`(
    select ${rank}::int as rank, owner_id, revision, ${KIND.tombstone}::int as kind,
      resource collate "C" as resource, resource_id as id, id as seq, client_id
    from ${syncTombstone}
    where owner_id = ${read.ownerId} and ${inWindow(read)}
      and revision > ${read.at.floor}::bigint
      and resource in (${sql.join(
        read.roots.map((root) => sql`${root.table}`),
        sql`, `,
      )})
      and ${after(read.at, { kind: sql`${KIND.tombstone}::int`, resource, id: sql`resource_id`, seq: sql`id` })}
    order by revision, resource collate "C", resource_id, id
    limit ${take}
  )`;
}
