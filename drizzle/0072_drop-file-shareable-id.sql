-- Nothing reads file.shareable_id since the share preview is keyed by the item's own id (#669).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
DROP INDEX "file_shareable_id_unique";--> statement-breakpoint
ALTER TABLE "file" DROP COLUMN "shareable_id";
