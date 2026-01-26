ALTER TABLE "video" ADD COLUMN "generate_chapters" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "chapters_status" text;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "chapters" jsonb;