ALTER TABLE "users" ADD COLUMN "terms_accepted_version" text;
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" timestamp with time zone;
ALTER TABLE "users" ADD COLUMN "terms_accepted_ip_hash" text;
