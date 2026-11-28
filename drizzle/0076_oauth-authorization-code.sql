-- OAuth consent's one-time codes (#1290, #681 A2; docs/plans/2026-11-27-mcp-oauth.md 4.5): the
-- oauth_authorization_code table, and personal_access_token.oauth_client_id, the client an OAuth
-- grant came from (null for every token minted before; the consent's cap check reads it).
--
-- A new, empty table and a nullable column with no default: no rewrite, no backfill. The ALTER
-- takes personal_access_token's ACCESS EXCLUSIVE lock for a moment; behind a long reader it gives
-- up after 5 s and the boot fails and is retried. Rollback: the previous image reads neither;
-- dropping the table and the column is the inverse.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "oauth_authorization_code" (
	"id" serial PRIMARY KEY NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"user_id" integer NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" varchar(128) NOT NULL,
	"resource" text NOT NULL,
	"name" text NOT NULL,
	"read_only" boolean NOT NULL,
	"own_wardrobe_only" boolean NOT NULL,
	"password_fingerprint" varchar(8) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"token_id" integer,
	CONSTRAINT "oauth_authorization_code_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "personal_access_token" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "oauth_authorization_code" ADD CONSTRAINT "oauth_authorization_code_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "oauth_authorization_code" ADD CONSTRAINT "oauth_authorization_code_token_id_foreign" FOREIGN KEY ("token_id") REFERENCES "public"."personal_access_token"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "oauth_authorization_code_user_id_index" ON "oauth_authorization_code" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_authorization_code_token_id_index" ON "oauth_authorization_code" USING btree ("token_id");