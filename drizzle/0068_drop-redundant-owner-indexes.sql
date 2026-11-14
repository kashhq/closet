SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- A composite index leading with owner_id (the sync feed's (owner_id, revision))
-- serves every owner_id lookup and the foreign key's cascade, so the
-- single-column indexes beside it only cost writes. Rollback: CREATE INDEX
-- "<name>" ON "<table>" ("owner_id") for the three.
DROP INDEX "garment_wear_owner_id_index";--> statement-breakpoint
DROP INDEX "outfit_owner_id_index";--> statement-breakpoint
DROP INDEX "week_plan_owner_id_index";
