CREATE TYPE "public"."radar_visibility_mode" AS ENUM('everyone', 'friends', 'hidden');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_visible_on_radar" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "radar_visibility_mode" "radar_visibility_mode" DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "banned" boolean DEFAULT false NOT NULL;