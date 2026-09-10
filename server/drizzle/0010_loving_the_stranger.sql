DROP INDEX "video_organizationId_idx";--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "transcode_attempt_id" text;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "transcode_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "video" ADD COLUMN "deleted_by" text;--> statement-breakpoint
CREATE INDEX "video_org_status_idx" ON "video" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "video_deletedAt_idx" ON "video" USING btree ("deleted_at");