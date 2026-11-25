import { legacySql } from '../legacy-sql';

// Every index the entities declare via @Index() that the Postgres tree never
// had (the SQLite platform auto-indexes foreign keys; Postgres does not).
// Nothing here is hand-added beyond what the entities declare: `migration:up`
// through the CLI rewrites the snapshot from the live database, and the next
// `migration:create` would emit a DROP for any index it cannot find in the
// entity metadata.
//
// Built CONCURRENTLY: a plain CREATE INDEX takes a SHARE lock that blocks
// writes for the duration of the build, and this runs on app boot against the
// live homelab database. CONCURRENTLY cannot run inside a transaction block,
// hence `transactional: false`; IF NOT EXISTS makes a rerun after a
// failed build (which leaves an INVALID index behind) idempotent once the
// invalid index has been dropped.
export const Migration20260925181256 = legacySql(
  [
    `create index concurrently if not exists "user_shareable_id_index" on "user" ("shareable_id");`,
    `create index concurrently if not exists "outfit_shareable_id_index" on "outfit" ("shareable_id");`,
    `create index concurrently if not exists "outfit_owner_id_index" on "outfit" ("owner_id");`,
    `create index concurrently if not exists "outfit_calendar_date_index" on "outfit_calendar" ("date");`,
    `create index concurrently if not exists "outfit_calendar_outfit_id_index" on "outfit_calendar" ("outfit_id");`,
    `create index concurrently if not exists "outfit_calendar_owner_id_index" on "outfit_calendar" ("owner_id");`,
    `create index concurrently if not exists "file_shareable_id_index" on "file" ("shareable_id");`,
    `create index concurrently if not exists "file_created_by_id_index" on "file" ("created_by_id");`,
    `create index concurrently if not exists "garment_shareable_id_index" on "garment" ("shareable_id");`,
    `create index concurrently if not exists "garment_category_index" on "garment" ("category");`,
    `create index concurrently if not exists "garment_owner_id_index" on "garment" ("owner_id");`,
    `create index concurrently if not exists "user_device_user_id_index" on "user_device" ("user_id");`,
    `create index concurrently if not exists "wardrobe_share_grantor_id_index" on "wardrobe_share" ("grantor_id");`,
    `create index concurrently if not exists "wardrobe_share_grantee_id_index" on "wardrobe_share" ("grantee_id");`,
  ],
  { transactional: false },
);
