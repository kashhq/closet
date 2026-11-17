-- #1049: every install id a claim of an unpaired database puts in a marker,
-- recorded before the marker is written, so the next boot knows a marker a
-- lost pairing race left behind as this database's own (claimStorage).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "storage_claim" (
	"install_id" uuid PRIMARY KEY NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
