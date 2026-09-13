ALTER TABLE "transcode_job" ADD COLUMN "completion_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "transcode_job" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "transcode_job_one_runnable_per_video_uidx" ON "transcode_job" USING btree ("video_id") WHERE "transcode_job"."state" IN ('queued', 'claimed', 'running', 'publishing');