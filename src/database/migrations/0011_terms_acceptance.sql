ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "terms_accepted_version" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "terms_accepted_ip_hash" text;
