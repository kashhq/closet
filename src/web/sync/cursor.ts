import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  SYNC_ROOTS,
  SYNC_STAMPS,
  type SyncResource,
} from '../../db/sync-tables';
import { literals } from '../api/resource';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { ROW_ID_MAX } from '../schemas';

/**
 * The changes feed's cursor (#196b-1; decisions 2026-11-13, the changes
 * cursor): one keyset position per wardrobe the caller syncs, opaque to the
 * client (base64url JSON).
 *
 * Inside a wardrobe the feed is ordered by (revision, kind, resource, id,
 * seq): one transaction is one revision, so a bulk edit's 200 garments (or
 * the #196a backfill's every row at 0) share one, and a page may end inside
 * it. `kind` puts a revision's deletions before its rows, `resource` (a
 * table name, compared in the "C" collation on both sides) and the row's id
 * order its rows, and `seq` (the tombstone's own id; 0 for a row) makes the
 * order total, so a page boundary never skips or repeats an item.
 */

/** Where an item sorts within its revision; END is past every item of it. */
export const KIND = { tombstone: 0, row: 1, end: 2 } as const;
type Kind = (typeof KIND)[keyof typeof KIND];

export interface Position {
  /** -1 before anything: a wardrobe's first read takes revision 0 too. */
  revision: number;
  kind: Kind;
  /** The table of the last item sent; '' at the start and the end. */
  resource: SyncResource | '';
  id: number;
  seq: number;
  /**
   * The wardrobe's sync_floor when this pass began: its tombstones at or
   * below it were never needed (their rows had gone before the client read
   * any), so a pass that started fresh is not expired by a floor it began
   * above (isExpired).
   */
  floor: number;
}

/** A wardrobe not in the cursor: everything, rows of revision 0 included. */
export function startOf(floor: number): Position {
  return {
    revision: -1,
    kind: KIND.tombstone,
    resource: '',
    id: 0,
    seq: 0,
    floor,
  };
}

/**
 * After every item at `revision`, the snapshot's own: an exclusive end, so
 * a finished wardrobe is never sent its last revision again (a wardrobe
 * still at the backfill's revision 0 would be resent in full forever).
 */
export function endOf(revision: number, floor: number): Position {
  return { revision, kind: KIND.end, resource: '', id: 0, seq: 0, floor };
}

/**
 * Whether the prune (sync_floor, #196b-3) may have dropped a deletion this
 * position has not been sent: past the floor's tombstones (above the floor,
 * or at it among its rows), or a pass begun at or above the floor.
 */
export function isExpired(at: Position, floor: number): boolean {
  if (floor <= at.floor) return false;
  return (
    at.revision < floor || (at.revision === floor && at.kind === KIND.tombstone)
  );
}

/** Which history of the database a page reads (sync_epoch, #652). */
export interface Epoch {
  epoch: string;
  /** Whether it was ever bumped (a restore since epochs shipped). */
  bumped: boolean;
}

/**
 * Whether a cursor's epoch is the database's: the same, or none (answered
 * before epochs) while the epoch was never bumped. Nothing was restored
 * before epochs shipped, so their deploy forces no re-sync; the first bump
 * expires those cursors with the rest.
 */
export function isCurrentEpoch(
  cursorEpoch: string | null,
  now: Epoch,
): boolean {
  return cursorEpoch === null ? !now.bumped : cursorEpoch === now.epoch;
}

export interface ChangesCursor {
  /**
   * The user it was answered to (#617). A cursor presented by anyone else (a
   * device that switched accounts) is expired, never read: its positions
   * are another account's. Null in one answered before the cursor named its
   * user, expired the same way.
   */
  userId: number | null;
  /**
   * The database history it was answered under (sync_epoch, #652): one
   * from another (a restore since) is expired. Null in one answered before
   * epochs, current until the first bump: nothing was restored before it.
   */
  epoch: string | null;
  /** Which resources the feed carried when it answered (feed.ts' FEED_COVERAGE). */
  coverage: number;
  /** By owner id. */
  positions: Map<number, Position>;
  /**
   * A full sync (begun without a cursor) not finished yet: every page of it
   * says so, so the client can drop what it did not re-send (feed.ts).
   */
  snapshot: boolean;
}

const Count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

const PositionJson = Type.Tuple([
  Count,
  literals(Object.values(KIND)),
  literals<SyncResource | ''>([
    '',
    ...SYNC_ROOTS.map((root) => root.table),
    ...SYNC_STAMPS.map((stamp) => stamp.resource),
  ]),
  Type.Integer({ minimum: 0, maximum: ROW_ID_MAX }),
  Type.Integer({ minimum: 0, maximum: ROW_ID_MAX }),
  Count,
]);

const CursorJson = Type.Object(
  {
    v: Type.Literal(1),
    u: Type.Optional(Type.Integer({ minimum: 1, maximum: ROW_ID_MAX })),
    // A pattern, not `format: 'uuid'`: Value.Check fails a format nothing registered.
    e: Type.Optional(
      Type.String({
        pattern:
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      }),
    ),
    c: Count,
    s: Type.Optional(Type.Literal(1)),
    w: Type.Record(Type.String({ pattern: '^[1-9]\\d{0,9}$' }), PositionJson),
  },
  { additionalProperties: false },
);

export function writeChangesCursor(
  cursor: ChangesCursor & { userId: number; epoch: string },
): string {
  const positions = Object.fromEntries(
    [...cursor.positions].map(([ownerId, at]) => [
      ownerId,
      [at.revision, at.kind, at.resource, at.id, at.seq, at.floor],
    ]),
  );
  return Buffer.from(
    JSON.stringify({
      v: 1,
      u: cursor.userId,
      e: cursor.epoch,
      c: cursor.coverage,
      ...(cursor.snapshot && { s: 1 }),
      w: positions,
    }),
  ).toString('base64url');
}

function badCursor(): HttpError {
  return new HttpError(400, t('api.BAD_CURSOR'));
}

/** The cursor a page answered; anything else is a 400 `validation`. */
export function readChangesCursor(text: string): ChangesCursor {
  const json = parsed(Buffer.from(text, 'base64url').toString());
  if (!Value.Check(CursorJson, json)) throw badCursor();
  const positions = new Map<number, Position>();
  for (const [
    owner,
    [revision, kind, resource, id, seq, floor],
  ] of Object.entries(json.w)) {
    const ownerId = Number(owner);
    if (ownerId > ROW_ID_MAX) throw badCursor();
    positions.set(ownerId, { revision, kind, resource, id, seq, floor });
  }
  return {
    userId: json.u ?? null,
    epoch: json.e ?? null,
    coverage: json.c,
    positions,
    snapshot: json.s === 1,
  };
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw badCursor();
  }
}
