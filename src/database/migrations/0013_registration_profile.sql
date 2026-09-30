ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "age" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "interests" text[];
