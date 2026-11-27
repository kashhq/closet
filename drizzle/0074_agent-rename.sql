-- The agent has no brand (docs/decisions.md 2026-11-27): muse_round is agent_round and
-- user_device.muse_rounds is agent_rounds. Pure renames, so the rows, the foreign keys and
-- the check stay as they were (drizzle-kit's drop and re-add of them would rescan the table);
-- the serial's sequence and the primary key follow, as a fresh create would name them.
-- Nothing else names the old identifiers by text: no trigger, function or view.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "muse_round" RENAME TO "agent_round";--> statement-breakpoint
ALTER SEQUENCE "muse_round_id_seq" RENAME TO "agent_round_id_seq";--> statement-breakpoint
ALTER TABLE "agent_round" RENAME CONSTRAINT "muse_round_pkey" TO "agent_round_pkey";--> statement-breakpoint
ALTER TABLE "agent_round" RENAME CONSTRAINT "muse_round_owner_id_foreign" TO "agent_round_owner_id_foreign";--> statement-breakpoint
ALTER TABLE "agent_round" RENAME CONSTRAINT "muse_round_token_id_foreign" TO "agent_round_token_id_foreign";--> statement-breakpoint
ALTER TABLE "agent_round" RENAME CONSTRAINT "muse_round_summary_check" TO "agent_round_summary_check";--> statement-breakpoint
ALTER INDEX "muse_round_owner_id_finished_at_index" RENAME TO "agent_round_owner_id_finished_at_index";--> statement-breakpoint
ALTER INDEX "muse_round_token_id_index" RENAME TO "agent_round_token_id_index";--> statement-breakpoint
ALTER TABLE "user_device" RENAME COLUMN "muse_rounds" TO "agent_rounds";
