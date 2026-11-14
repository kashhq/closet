import type { Static, TSchema } from '@sinclair/typebox';
import type { Db, Queryable } from '../../db/client';
import {
  SYNC_ROOTS,
  SYNC_STAMPS,
  type SyncResource,
} from '../../db/sync-tables';
import {
  SyncedCalendarEntry,
  toSyncedCalendarEntry,
} from '../calendar/entry-resource';
import { entriesByIds } from '../calendar/queries';
import { capsulesByIds } from '../capsules/queries';
import { SyncedCapsule, toSyncedCapsule } from '../capsules/capsule-resource';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { outfitsByIds } from '../outfits/queries';
import { SyncedOutfit, toSyncedOutfit } from '../outfits/outfit-resource';
import { selfiesByIds } from '../selfies/queries';
import { SyncedSelfie, toSyncedSelfie } from '../selfies/selfie-resource';
import type { Actor } from '../sharing/access';
import { brandSizesByIds, measurementsByUserIds } from '../sizes/queries';
import {
  BrandSizeResource,
  SyncedMeasurements,
  toBrandSizeResource,
  toSyncedMeasurements,
} from '../sizes/sizes-resource';
import { styleProfilesByUserIds } from '../style/queries';
import {
  SyncedStyleProfile,
  toSyncedStyleProfile,
} from '../style/style-resource';
import { tripsByIds } from '../trips/queries';
import { SyncedTrip, toSyncedTrip } from '../trips/trip-resource';
import { SyncedGarment, toSyncedGarment } from '../wardrobe/garment-resource';
import { garmentsByIds } from '../wardrobe/queries';
import { wearsByIds } from '../wears/queries';
import { SyncedWear, toSyncedWear } from '../wears/wear-resource';
import { weekPlansByIds } from '../week-plan/queries';
import { weekTemplatesByUserIds } from '../week-plan/template';
import {
  toWeekTemplate,
  WeekTemplate,
} from '../week-plan/week-template-resource';
import {
  SyncedWeekPlan,
  toSyncedWeekPlan,
} from '../week-plan/week-plan-resource';
import {
  type ChangesCursor,
  endOf,
  isCurrentEpoch,
  isExpired,
  KIND,
  type Position,
  readChangesCursor,
  startOf,
  writeChangesCursor,
} from './cursor';
import {
  type FeedItem,
  type FeedRoot,
  type FeedStamp,
  feedItems,
  feedWardrobes,
  inFeedSnapshot,
  type WardrobeRead,
} from './queries';

/**
 * The changes feed (#196b-1, GET /api/v1/changes; src/web/sync/AGENTS.md):
 * every synced row and deletion after a cursor, across the caller's own
 * wardrobe and each one shared with them, a page at a time.
 */

/** A resource's part of the feed: its name, who may read it, and its batched reader. */
export interface FeedEntry {
  /** The API's name for it: a change's `resource`. */
  name: string;
  /** Carried in a grantee's feed too (src/web/sharing/AGENTS.md's share-aware list). */
  shared: boolean;
  /** Its `data`'s schema (titled: the spec's component). */
  schema: TSchema;
  /**
   * The rows with these ids as `data`, in one statement whatever their
   * owners: the page's ids come from wardrobes `viewerId` may see, read in
   * the same snapshot, so every id is there. A share's rows in the grantee
   * shape (the viewer is not their owner).
   */
  read(
    db: Queryable,
    ids: readonly number[],
    viewerId: number,
    cutoutsEnabled: boolean,
  ): Promise<{ id: number; data: unknown }[]>;
}

/** An entry whose reader answers its schema's shape. */
function feedEntry<S extends TSchema>(entry: {
  name: string;
  shared: boolean;
  schema: S;
  read(
    db: Queryable,
    ids: readonly number[],
    viewerId: number,
    cutoutsEnabled: boolean,
  ): Promise<{ id: number; data: Static<S> }[]>;
}): FeedEntry {
  return entry;
}

/**
 * Every resource the feed carries, by its table or stamp
 * (src/db/sync-tables.ts): a new synced root or stamp fails tsc here until
 * it is registered; coverage.ts then says which reads it backs. Adding one is an
 * entry: its batched by-id reader beside its per-id one, and its feed shape
 * beside its API resource. `shared` follows src/web/sharing/AGENTS.md's
 * share-aware list: everything but garments and capsules is the owner's.
 */
export const FEED: Readonly<Record<SyncResource, FeedEntry>> = {
  garment: feedEntry({
    name: 'garment',
    shared: true,
    schema: SyncedGarment,
    read: async (db, ids, viewerId, cutoutsEnabled) =>
      (await garmentsByIds(db, viewerId, ids)).map((row) => ({
        id: row.id,
        data: toSyncedGarment(row, cutoutsEnabled),
      })),
  }),
  garment_wear: feedEntry({
    name: 'wear',
    shared: false,
    schema: SyncedWear,
    read: async (db, ids) =>
      (await wearsByIds(db, ids)).map((row) => ({
        id: row.id,
        data: toSyncedWear(row),
      })),
  }),
  capsule: feedEntry({
    name: 'capsule',
    shared: true,
    schema: SyncedCapsule,
    read: async (db, ids) =>
      (await capsulesByIds(db, ids)).map((row) => ({
        id: row.id,
        data: toSyncedCapsule(row),
      })),
  }),
  // Muse's proposals included: the owner's to react to (decided on #607).
  outfit: feedEntry({
    name: 'outfit',
    shared: false,
    schema: SyncedOutfit,
    read: async (db, ids) =>
      (await outfitsByIds(db, ids)).map((row) => ({
        id: row.id,
        data: toSyncedOutfit(row),
      })),
  }),
  outfit_calendar: feedEntry({
    name: 'calendarEntry',
    shared: false,
    schema: SyncedCalendarEntry,
    read: async (db, ids) =>
      (await entriesByIds(db, ids)).map((row) => ({
        id: row.id,
        data: toSyncedCalendarEntry(row),
      })),
  }),
  selfie: feedEntry({
    name: 'selfie',
    shared: false,
    schema: SyncedSelfie,
    read: async (db, ids) =>
      (await selfiesByIds(db, ids)).map((row) => ({
        id: row.id,
        data: toSyncedSelfie(row),
      })),
  }),
  trip: feedEntry({
    name: 'trip',
    shared: false,
    schema: SyncedTrip,
    read: async (db, ids) =>
      (await tripsByIds(db, ids)).map((row) => ({
        id: row.id,
        data: toSyncedTrip(row),
      })),
  }),
  week_plan: feedEntry({
    name: 'weekPlan',
    shared: false,
    schema: SyncedWeekPlan,
    read: async (db, ids) =>
      (await weekPlansByIds(db, ids)).map((row) => ({
        id: row.id,
        data: toSyncedWeekPlan(row),
      })),
  }),
  brand_size: feedEntry({
    name: 'brandSize',
    shared: false,
    schema: BrandSizeResource,
    read: async (db, ids) =>
      (await brandSizesByIds(db, ids)).map((row) => ({
        id: row.id,
        data: toBrandSizeResource(row),
      })),
  }),
  // The one-row-per-user tables and the stamp: the change's id is the user's.
  // A rule's write stamps the profile (SYNC_CHILDREN), so it carries them.
  style_profile: feedEntry({
    name: 'styleProfile',
    shared: false,
    schema: SyncedStyleProfile,
    read: async (db, ids) =>
      (await styleProfilesByUserIds(db, ids)).map(
        ({ userId, rules, ...profile }) => ({
          id: userId,
          data: toSyncedStyleProfile(profile, rules),
        }),
      ),
  }),
  // Every user has one, empty until set: never deleted, never tombstoned.
  week_template: feedEntry({
    name: 'weekTemplate',
    shared: false,
    schema: WeekTemplate,
    read: async (db, ids) =>
      (await weekTemplatesByUserIds(db, ids)).map(({ userId, slots }) => ({
        id: userId,
        data: toWeekTemplate(slots),
      })),
  }),
  body_measurements: feedEntry({
    name: 'measurements',
    shared: false,
    schema: SyncedMeasurements,
    read: async (db, ids) =>
      (await measurementsByUserIds(db, ids)).map((row) => ({
        id: row.userId,
        data: toSyncedMeasurements(row),
      })),
  }),
};

const OWN_ROOTS: readonly FeedRoot[] = SYNC_ROOTS;
const SHARED_ROOTS = OWN_ROOTS.filter((root) => FEED[root.table].shared);
const OWN_STAMPS: readonly FeedStamp[] = SYNC_STAMPS;
const SHARED_STAMPS = OWN_STAMPS.filter((stamp) => FEED[stamp.resource].shared);

/**
 * Which resources a cursor was answered with, one bit per SYNC_ROOTS entry,
 * then per SYNC_STAMPS entry: a cursor from before a resource joined the
 * feed never saw its rows below its positions, so it is expired (a full
 * sync) rather than silently missing them. #608 registering the last eight
 * moved it once; #716 the week template (whose full sync also gave every
 * cached style profile its rules).
 */
export const FEED_COVERAGE = [...SYNC_ROOTS, ...SYNC_STAMPS].reduce(
  (bits, _resource, index) => bits | (1 << index),
  0,
);

interface Item {
  resource: string;
  ownerId: number;
  id: number;
  clientId?: string;
  revision: number;
}

export interface ChangesPage {
  changes: (Item & { data: unknown })[];
  deletions: Item[];
  cursor: string;
  more: boolean;
  /** Owners in the cursor the caller no longer sees: a share revoked or left. */
  revokedWardrobes: number[];
  /**
   * On every page of a full sync: the wardrobes it covers (the caller's own,
   * then each accepted share). After its last page the client drops every
   * row it was not re-sent and every wardrobe not listed: a cursorless read
   * leaves out deletions at or below the floor and knows no revoked shares.
   */
  snapshot?: { wardrobes: number[] };
}

/** The 410 `cursor_expired`: a deletion the cursor needs may have been pruned. */
function expired(logDetail: string): HttpError {
  return new HttpError(410, t('api.CURSOR_EXPIRED'), {
    code: 'cursor_expired',
    logDetail,
  });
}

/**
 * The page after `cursorText` (none: everything), at most `limit` items.
 * One REPEATABLE READ READ ONLY transaction: the wardrobes, the keyset
 * read, then one statement per resource on the page, so its cost does not
 * grow with `limit`.
 */
export async function readChanges(
  db: Db,
  actor: Actor,
  cursorText: string | undefined,
  limit: number,
  cutoutsEnabled: boolean,
): Promise<ChangesPage> {
  const cursor =
    cursorText === undefined ? undefined : readChangesCursor(cursorText);
  if (cursor && cursor.coverage !== FEED_COVERAGE) {
    throw expired(
      `a cursor of coverage ${cursor.coverage}, not ${FEED_COVERAGE}`,
    );
  }
  if (cursor && cursor.userId !== actor.userId) {
    throw expired(
      `a cursor answered to ${cursor.userId === null ? 'no named user' : `user ${cursor.userId}`}`,
    );
  }
  // A 410 mid-way restarts the full sync: the client syncs from no cursor.
  const fullSync = cursor === undefined || cursor.snapshot;
  return inFeedSnapshot(db, async (tx) => {
    const { epoch, wardrobes } = await feedWardrobes(tx, actor.userId);
    // A restore since (#652): the cursor's revisions and ids are another
    // history's, and the deletions it needs were never written.
    if (cursor && !isCurrentEpoch(cursor.epoch, epoch)) {
      throw expired(
        `a cursor of epoch ${cursor.epoch ?? 'none'}, not ${epoch.epoch}`,
      );
    }
    const reads = wardrobes.map((wardrobe): WardrobeRead => {
      const at =
        cursor?.positions.get(wardrobe.ownerId) ?? startOf(wardrobe.floor);
      // Past the wardrobe's own revision: a restore the epoch missed, whose
      // next writes would reuse the revisions this cursor is past.
      if (at.revision > wardrobe.revision) {
        throw expired(
          `owner ${wardrobe.ownerId} at revision ${at.revision}, above its ${wardrobe.revision}`,
        );
      }
      if (isExpired(at, wardrobe.floor)) {
        throw expired(
          `owner ${wardrobe.ownerId} at revision ${at.revision}, floor ${wardrobe.floor}`,
        );
      }
      return {
        ...wardrobe,
        at,
        ...(wardrobe.ownerId === actor.userId
          ? { roots: OWN_ROOTS, stamps: OWN_STAMPS }
          : { roots: SHARED_ROOTS, stamps: SHARED_STAMPS }),
      };
    });
    const items = await feedItems(tx, reads, limit + 1);
    const page = items.slice(0, limit);
    const data = await hydrate(tx, actor.userId, page, cutoutsEnabled);
    const owners = wardrobes.map((wardrobe) => wardrobe.ownerId);
    const seen = new Set(owners);
    const more = items.length > limit;
    return {
      changes: page
        .filter((item) => item.kind === KIND.row)
        .map((item) => ({ ...itemOf(item), data: dataOf(data, item) })),
      deletions: page
        .filter((item) => item.kind === KIND.tombstone)
        .map(itemOf),
      cursor: writeChangesCursor({
        ...nextCursor(reads, page.at(-1), items[limit]),
        userId: actor.userId,
        epoch: epoch.epoch,
        snapshot: fullSync && more,
      }),
      more,
      revokedWardrobes: cursor
        ? [...cursor.positions.keys()].filter((ownerId) => !seen.has(ownerId))
        : [],
      ...(fullSync && { snapshot: { wardrobes: owners } }),
    };
  });
}

function itemOf(item: FeedItem): Item {
  return {
    resource: FEED[item.resource].name,
    ownerId: item.ownerId,
    id: item.id,
    ...(item.clientId !== null && { clientId: item.clientId }),
    revision: item.revision,
  };
}

/** Each resource's rows on the page, by id: one statement per resource. */
async function hydrate(
  db: Queryable,
  viewerId: number,
  page: readonly FeedItem[],
  cutoutsEnabled: boolean,
): Promise<Map<SyncResource, Map<number, unknown>>> {
  const idsOf = new Map<SyncResource, number[]>();
  for (const item of page) {
    if (item.kind !== KIND.row) continue;
    idsOf.set(item.resource, [...(idsOf.get(item.resource) ?? []), item.id]);
  }
  const data = new Map<SyncResource, Map<number, unknown>>();
  for (const [resource, ids] of idsOf) {
    const rows = await FEED[resource].read(db, ids, viewerId, cutoutsEnabled);
    data.set(resource, new Map(rows.map((row) => [row.id, row.data])));
  }
  return data;
}

function dataOf(
  data: Map<SyncResource, Map<number, unknown>>,
  item: FeedItem,
): unknown {
  const row = data.get(item.resource)?.get(item.id);
  if (row === undefined) {
    throw new Error(`${item.resource} ${item.id} was on the page but not read`);
  }
  return row;
}

/**
 * Each wardrobe's position after this page. `next` is the first item past
 * the page (absent: nothing is left anywhere). A wardrobe before next's has
 * been read to its end; next's own resumes after its last item on the page,
 * or where it was if it had none; one after next's is untouched.
 */
function nextCursor(
  reads: readonly WardrobeRead[],
  last: FeedItem | undefined,
  next: FeedItem | undefined,
): Omit<ChangesCursor, 'snapshot' | 'userId' | 'epoch'> {
  const nextRank = next
    ? reads.findIndex((read) => read.ownerId === next.ownerId)
    : reads.length;
  const positions = new Map<number, Position>();
  reads.forEach((read, rank) => {
    if (rank < nextRank) {
      positions.set(read.ownerId, endOf(read.revision, read.at.floor));
    } else if (rank === nextRank && last?.ownerId === read.ownerId) {
      positions.set(read.ownerId, {
        revision: last.revision,
        kind: last.kind,
        resource: last.resource,
        id: last.id,
        seq: last.seq,
        floor: read.at.floor,
      });
    } else if (read.at.revision >= 0) {
      positions.set(read.ownerId, read.at);
    }
    // A wardrobe not reached yet stays out: it starts fresh next time, at
    // the floor of then.
  });
  return { coverage: FEED_COVERAGE, positions };
}
