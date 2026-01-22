CREATE TYPE "public"."playback_policy" AS ENUM('public', 'signed');--> statement-breakpoint
ALTER TABLE "video" ALTER COLUMN "size" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "playback_policy" "playback_policy" DEFAULT 'public';--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "uploaded_by" text NOT NULL;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "resolutions" text;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "metadata" text;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "generate_subtitle" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "subtitle_status" text;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "subtitle_url" text;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video" ADD CONSTRAINT "video_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;