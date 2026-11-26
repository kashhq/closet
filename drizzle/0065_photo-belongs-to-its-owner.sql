-- A photo's file row belongs to the owner of the row showing it (#703).
-- Before #40 a MANAGE grantee's upload into a shared wardrobe made a file
-- row owned by the grantee, so the grantee's account deletion (file rows
-- cascade from their user) emptied the owner's garment and unlinked its
-- bytes. Each such row moves to the showing row's owner, then each photo
-- foreign key becomes the pair (photo_id, owner_id) against
-- (id, created_by_id), so no row can show another account's photo again.
-- Adding the keys validates every row: one the fix missed fails the boot.
--
-- No owner lock: file is synced only as a garment's child, and
-- closet_sync_touch_photo (0062) touches a garment only when the photo's
-- version, cutout status or missing mark moves, never created_by_id. So
-- this writes no synced row, and the changes feed has nothing to re-send.
--
-- garment's delete action is hand-written: ON DELETE SET NULL ("photo_id")
-- (Postgres 15+), never a plain SET NULL, which would null owner_id too.
-- drizzle-kit cannot write the column list; schema.ts says set null.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- One photo shown by rows of two owners has no right owner to give it.
-- No writer makes one (each table's photo_id is unique, and every writer
-- inserts the file row in the transaction that points at it); refuse
-- rather than pick.
DO $$
DECLARE
  shared text;
BEGIN
  SELECT string_agg(photo_id::text, ', ' ORDER BY photo_id) INTO shared
  FROM (
    SELECT photo_id FROM (
      SELECT photo_id, owner_id FROM garment WHERE photo_id IS NOT NULL
      UNION SELECT photo_id, owner_id FROM selfie
      UNION SELECT photo_id, owner_id FROM inspiration WHERE photo_id IS NOT NULL
    ) AS shown
    GROUP BY photo_id HAVING count(DISTINCT owner_id) > 1
  ) AS ambiguous;
  IF shared IS NOT NULL THEN
    RAISE EXCEPTION 'file rows shown by rows of different owners: %', shared;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "garment" DROP CONSTRAINT "garment_photo_id_foreign";
--> statement-breakpoint
ALTER TABLE "inspiration" DROP CONSTRAINT "inspiration_photo_id_foreign";
--> statement-breakpoint
ALTER TABLE "selfie" DROP CONSTRAINT "selfie_photo_id_foreign";
--> statement-breakpoint
UPDATE "file" f SET "created_by_id" = g."owner_id"
FROM "garment" g
WHERE g."photo_id" = f."id" AND f."created_by_id" <> g."owner_id";
--> statement-breakpoint
UPDATE "file" f SET "created_by_id" = s."owner_id"
FROM "selfie" s
WHERE s."photo_id" = f."id" AND f."created_by_id" <> s."owner_id";
--> statement-breakpoint
UPDATE "file" f SET "created_by_id" = i."owner_id"
FROM "inspiration" i
WHERE i."photo_id" = f."id" AND f."created_by_id" <> i."owner_id";
--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_id_created_by_id_unique" UNIQUE("id","created_by_id");--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_photo_id_owner_id_foreign" FOREIGN KEY ("photo_id","owner_id") REFERENCES "public"."file"("id","created_by_id") ON DELETE SET NULL ("photo_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspiration" ADD CONSTRAINT "inspiration_photo_id_owner_id_foreign" FOREIGN KEY ("photo_id","owner_id") REFERENCES "public"."file"("id","created_by_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selfie" ADD CONSTRAINT "selfie_photo_id_owner_id_foreign" FOREIGN KEY ("photo_id","owner_id") REFERENCES "public"."file"("id","created_by_id") ON DELETE cascade ON UPDATE no action;
