-- #964: 0064 kept every id minted at insert, so every garment and outfit made
-- before it stayed public until Stop sharing. Owner decision (b): none is public
-- until Share is tapped. Links already sent break, those shared since 0064 too
-- (nothing tells the two apart; accepted). The ids cannot be restored: an owner
-- who wants a link again taps Share and sends the new one.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- The rows this migration stops, fixed before any lock: one shared after it (by
-- a process still serving during the deploy) is a new share and stays.
CREATE TEMPORARY TABLE "legacy_share" ON COMMIT DROP AS
SELECT 'garment'::text AS "kind", "id", "owner_id" FROM "garment" WHERE "shareable_id" IS NOT NULL
UNION ALL
SELECT 'outfit', "id", "owner_id" FROM "outfit" WHERE "shareable_id" IS NOT NULL;--> statement-breakpoint
-- The updates are synced writes, refused by the sync triggers (0052) without the
-- owner lock's mark: ownerLockSelect's statement written out (0053's reason),
-- every owner locked in one statement, in id order. Through the triggers each
-- row gets a new revision, so the changes feed re-sends it without its
-- publicShareUrl and every device and API client drops the link.
SELECT "owner_row"."id",
  set_config(
    'closet.locked_owners',
    coalesce(current_setting('closet.locked_owners', true), '') || ',' || "owner_row"."id" || ',',
    true
  ) AS "marked"
FROM (
  SELECT "id" FROM "user"
  WHERE "id" IN (SELECT "owner_id" FROM "legacy_share")
  ORDER BY "id"
  FOR NO KEY UPDATE OF "user"
) AS "owner_row";--> statement-breakpoint
UPDATE "garment" g SET "shareable_id" = NULL
FROM "legacy_share" l
WHERE l."kind" = 'garment' AND g."id" = l."id";--> statement-breakpoint
UPDATE "outfit" o SET "shareable_id" = NULL
FROM "legacy_share" l
WHERE l."kind" = 'outfit' AND o."id" = l."id";
