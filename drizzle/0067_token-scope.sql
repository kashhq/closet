-- An agent token's scope (#701): read-only (no write tool is registered for
-- it) and own wardrobe only (no shared wardrobe resolves for it). Fixed at
-- mint. Every token before this keeps full power (false, false), so no
-- connected agent breaks on deploy; device tokens never read either.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "personal_access_token" ADD COLUMN "read_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_access_token" ADD COLUMN "own_wardrobe_only" boolean DEFAULT false NOT NULL;
