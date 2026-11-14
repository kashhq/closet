-- #716: an outfit rule is part of its owner's style profile in the changes
-- feed, so a rule's write stamps the profile (src/db/sync-tables.ts,
-- SYNC_CHILDREN's createsParent row). Hand-written (drizzle-kit generate
-- --custom) like 0052: test/integration/sync-triggers.spec.ts holds
-- pg_trigger to sync-tables.ts.
--
-- From here on every outfit_rule write needs its owner's lock: the image
-- before this one adds and deletes rules without it, so while it still
-- serves (a rolling deploy's overlap, or a rollback onto this schema) its
-- rule writes fail with "owner lock not held" (a 500) until the swap.
-- Dropping the three closet_sync_touch_* triggers on outfit_rule ends that.
--
-- The CREATE TRIGGERs take outfit_rule's SHARE ROW EXCLUSIVE lock and the
-- backfill its owners' user rows until the boot's migration transaction
-- commits; behind a long writer either gives up after 5 s and the boot fails
-- and is retried (as 0051, 0053), rather than queueing every request behind
-- it. Acceptable: the tables are household-sized.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- A child's statement whose parent is a one-row-per-user table the child
-- may come before (rules saved without a style profile): each parent row it
-- wrote under touched once (updated_at), or inserted when missing, which the
-- parent's own closet_sync_stamp stamps. The parent's other columns must all
-- have defaults or be nullable; TG_ARGV[2] is its primary key. An owner gone
-- (the child deleted in its account's cascade) gets no row: its foreign key
-- would refuse it. TG_ARGV: the child's column, the parent table, the
-- parent's matching column, as closet_sync_touch.
CREATE FUNCTION closet_sync_touch_or_create() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  written text := CASE TG_OP
    WHEN 'INSERT' THEN format('SELECT %I AS owner FROM new_rows', TG_ARGV[0])
    WHEN 'DELETE' THEN format('SELECT %I AS owner FROM old_rows', TG_ARGV[0])
    ELSE format('SELECT %1$I AS owner FROM new_rows UNION SELECT %1$I FROM old_rows', TG_ARGV[0])
  END;
BEGIN
  EXECUTE format(
    'INSERT INTO %1$I (%2$I) SELECT DISTINCT written.owner FROM (%3$s) AS written'
    ' WHERE EXISTS (SELECT 1 FROM "user" WHERE "user".id = written.owner)'
    ' ORDER BY written.owner'
    ' ON CONFLICT (%2$I) DO UPDATE SET updated_at = now()',
    TG_ARGV[1], TG_ARGV[2], written);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_insert AFTER INSERT ON "outfit_rule" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch_or_create('owner_id', 'style_profile', 'user_id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_update AFTER UPDATE ON "outfit_rule" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch_or_create('owner_id', 'style_profile', 'user_id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_delete AFTER DELETE ON "outfit_rule" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch_or_create('owner_id', 'style_profile', 'user_id');
--> statement-breakpoint
-- The backfill: an owner with rules and no profile row gets an empty one, so
-- the full sync this release's feed forces (its new coverage bit) sends their
-- rules. Its insert is a synced write: the owners locked and marked first,
-- ownerLockSelect's statement (src/db/owner-lock.ts) written out as 0053's.
CREATE TEMPORARY TABLE "style_profile_backfill" ON COMMIT DROP AS
SELECT DISTINCT r."owner_id"
FROM "outfit_rule" r
WHERE NOT EXISTS (SELECT 1 FROM "style_profile" p WHERE p."user_id" = r."owner_id");--> statement-breakpoint
SELECT "owner_row"."id",
  set_config(
    'closet.locked_owners',
    coalesce(current_setting('closet.locked_owners', true), '') || ',' || "owner_row"."id" || ',',
    true
  ) AS "marked"
FROM (
  SELECT "id" FROM "user"
  WHERE "id" IN (SELECT "owner_id" FROM "style_profile_backfill")
  ORDER BY "id"
  FOR NO KEY UPDATE OF "user"
) AS "owner_row";--> statement-breakpoint
INSERT INTO "style_profile" ("user_id")
SELECT "owner_id" FROM "style_profile_backfill" ORDER BY "owner_id"
ON CONFLICT ("user_id") DO NOTHING;
