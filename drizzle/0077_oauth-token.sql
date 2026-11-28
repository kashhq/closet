-- OAuth's token exchange and refresh rotation (#1291, #681 A3; docs/plans/2026-11-27-mcp-oauth.md
-- 4.5): personal_access_token.access_expires_at and refresh_token_hash (unique) for an OAuth grant,
-- a check that a row has all three OAuth columns or none, and oauth_retired_refresh_token, every
-- refresh token a grant has retired, so reuse of any earlier generation revokes it (#1295; it
-- replaces the design's single previous_refresh_token_hash).
--
-- A new, empty table and two nullable columns with no default: no rewrite, no backfill. The check
-- validates every row: nothing has written oauth_client_id yet (0076's consent mints nothing), so
-- every row has none of the three. The ALTERs and the unique index take personal_access_token's
-- ACCESS EXCLUSIVE lock for a moment (a few dozen rows); behind a long reader they give up after
-- 5 s and the boot fails and is retried. Rollback: the previous image reads none of it; dropping
-- the table, the constraints and the columns is the inverse.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "oauth_retired_refresh_token" (
	"id" serial PRIMARY KEY NOT NULL,
	"refresh_token_hash" varchar(64) NOT NULL,
	"token_id" integer NOT NULL,
	"retired_at" timestamp with time zone NOT NULL,
	CONSTRAINT "oauth_retired_refresh_token_refresh_token_hash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
ALTER TABLE "personal_access_token" ADD COLUMN "access_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "personal_access_token" ADD COLUMN "refresh_token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "oauth_retired_refresh_token" ADD CONSTRAINT "oauth_retired_refresh_token_token_id_foreign" FOREIGN KEY ("token_id") REFERENCES "public"."personal_access_token"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "oauth_retired_refresh_token_token_id_index" ON "oauth_retired_refresh_token" USING btree ("token_id");--> statement-breakpoint
ALTER TABLE "personal_access_token" ADD CONSTRAINT "personal_access_token_refresh_token_hash_unique" UNIQUE("refresh_token_hash");--> statement-breakpoint
ALTER TABLE "personal_access_token" ADD CONSTRAINT "personal_access_token_oauth_check" CHECK (("personal_access_token"."oauth_client_id" is null and "personal_access_token"."refresh_token_hash" is null and "personal_access_token"."access_expires_at" is null) or ("personal_access_token"."kind" = 'mcp' and "personal_access_token"."oauth_client_id" is not null and "personal_access_token"."refresh_token_hash" is not null and "personal_access_token"."access_expires_at" is not null));