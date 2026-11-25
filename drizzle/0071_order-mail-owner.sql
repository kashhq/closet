-- #976: the order mail's owner, stored once by id so no boot finds it by email
-- again. Created empty: the first boot with ORDER_MAIL_JMAP_TOKEN adopts the
-- account ORDER_MAIL_OWNER names (adoptOrderMailOwner), as a fresh install's does.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "order_mail_owner" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"user_id" integer,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_mail_owner_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "order_mail_owner_singleton_check" CHECK ("order_mail_owner"."singleton")
);
--> statement-breakpoint
ALTER TABLE "order_mail_owner" ADD CONSTRAINT "order_mail_owner_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE cascade;
