/**
 * The synced tables (docs/plans/2026-11-12-json-api.md section 7; #196a):
 * what the sync triggers (drizzle/0052_sync-triggers.sql) stamp, as data.
 * The migration's SQL is frozen once shipped; this list is what
 * test/integration/sync-triggers.spec.ts holds `pg_trigger` to, so a table
 * added here without its triggers (or the reverse) fails there. Read by
 * schema.ts for sync_tombstone's resource check, and by the changes feed
 * (src/web/sync/feed.ts), whose resources are the roots and the stamps.
 * Inspiration (#22) is not synced (owner decision, 2026-11-13).
 */

/** A root: its own revision and updated_at, a tombstone when deleted. */
export interface SyncRoot {
  table: string;
  /** The owner's column: `owner_id`, or `user_id` for the per-user tables. */
  owner: 'owner_id' | 'user_id';
  /** The tombstone's resource_id: the primary key (the user for the one-row-per-user tables). */
  id: 'id' | 'user_id';
  /** Whether it has a `client_id` (an offline create's id, #563): the feed answers it. */
  clientId: boolean;
}

/**
 * A child: no revision of its own; a statement that writes it touches
 * each parent row it names once (`updated_at = now()`), and the parent's
 * own trigger stamps it. A garment's photo is the garment's child: only
 * its version and cutout status count (a lease change touches nothing),
 * and a photo no garment shows (a selfie's, a look's) touches nothing.
 */
export interface SyncChild {
  table: string;
  /** The child's column naming the parent... */
  key: string;
  parent: string;
  /** ...matched against this column of the parent. */
  match: string;
  /**
   * The parent is a one-row-per-user table its child may come before (rules
   * without a style profile): the touch inserts the missing parent row
   * (closet_sync_touch_or_create, drizzle/0069), so it needs a parent whose
   * every other column has a default or is nullable, `match` its primary key.
   */
  createsParent?: true;
}

export const SYNC_ROOTS = [
  { table: 'garment', owner: 'owner_id', id: 'id', clientId: true },
  { table: 'outfit', owner: 'owner_id', id: 'id', clientId: true },
  { table: 'outfit_calendar', owner: 'owner_id', id: 'id', clientId: true },
  { table: 'garment_wear', owner: 'owner_id', id: 'id', clientId: true },
  { table: 'selfie', owner: 'owner_id', id: 'id', clientId: false },
  { table: 'capsule', owner: 'owner_id', id: 'id', clientId: true },
  { table: 'trip', owner: 'owner_id', id: 'id', clientId: true },
  { table: 'week_plan', owner: 'owner_id', id: 'id', clientId: false },
  { table: 'brand_size', owner: 'user_id', id: 'id', clientId: true },
  { table: 'style_profile', owner: 'user_id', id: 'user_id', clientId: false },
  {
    table: 'body_measurements',
    owner: 'user_id',
    id: 'user_id',
    clientId: false,
  },
] as const satisfies readonly SyncRoot[];

export const SYNC_CHILDREN = [
  { table: 'outfit_slot', key: 'outfit_id', parent: 'outfit', match: 'id' },
  { table: 'trip_item', key: 'trip_id', parent: 'trip', match: 'id' },
  { table: 'trip_outfit', key: 'trip_id', parent: 'trip', match: 'id' },
  { table: 'trip_garment_packed', key: 'trip_id', parent: 'trip', match: 'id' },
  {
    table: 'capsule_garment',
    key: 'capsule_id',
    parent: 'capsule',
    match: 'id',
  },
  {
    table: 'week_plan_entry',
    key: 'week_plan_id',
    parent: 'week_plan',
    match: 'id',
  },
  {
    table: 'garment_repair',
    key: 'garment_id',
    parent: 'garment',
    match: 'id',
  },
  { table: 'file', key: 'id', parent: 'garment', match: 'photo_id' },
  // A rule is part of its owner's style profile (#716): the feed's
  // styleProfile carries the rules.
  {
    table: 'outfit_rule',
    key: 'owner_id',
    parent: 'style_profile',
    match: 'user_id',
    createsParent: true,
  },
] as const satisfies readonly SyncChild[];

/**
 * A stamp: a synced resource with no row of its own (the week template: a
 * user's set of weekday occasions, replaced whole). A write to its table
 * stamps the owner's `user` row's `revision` column with the owner's
 * revision (closet_sync_week_template, 0052), and the feed reads it from
 * there, one per user, the change's id the user's. Never deleted, so never
 * tombstoned: emptied, it is a change like any other.
 */
export interface SyncStamp {
  /** The resource's name in the feed and its cursor (the written table's). */
  resource: string;
  /** The `user` column holding its revision. */
  revision: string;
}

export const SYNC_STAMPS = [
  { resource: 'week_template', revision: 'week_template_revision' },
] as const satisfies readonly SyncStamp[];

/** Every resource the changes feed carries: a root's table or a stamp's resource. */
export type SyncResource =
  | (typeof SYNC_ROOTS)[number]['table']
  | (typeof SYNC_STAMPS)[number]['resource'];
