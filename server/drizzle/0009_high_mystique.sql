ALTER TABLE "video" ADD COLUMN "processing_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "job_attempts" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "last_heartbeat_at" timestamp;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "failure_code" text;--> statement-breakpoint
CREATE INDEX "video_status_updatedAt_idx" ON "video" USING btree ("status","updated_at");