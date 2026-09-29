ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "street_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "custom_status" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "location_accuracy" double precision;