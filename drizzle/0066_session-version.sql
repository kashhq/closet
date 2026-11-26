-- The session version a session token carries as `sv` (#700): "Sign out
-- everywhere" and a new password bump it. Every token issued before has no
-- `sv`, read as 0, so the deploy signs nobody out.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "session_version" integer DEFAULT 0 NOT NULL;
