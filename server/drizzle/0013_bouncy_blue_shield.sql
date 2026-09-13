CREATE TABLE "storage_cleanup_job" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" uuid NOT NULL,
	"organization_id" text,
	"raw_key" text,
	"prefix" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"objects_deleted" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"reclaimed_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "storage_cleanup_status_notbefore_idx" ON "storage_cleanup_job" USING btree ("status","not_before");--> statement-breakpoint
CREATE INDEX "storage_cleanup_video_idx" ON "storage_cleanup_job" USING btree ("video_id");
--> statement-breakpoint
-- Backstop for deletion paths application code cannot see.
--
-- `video.organization_id` and `video.uploaded_by` are both ON DELETE CASCADE,
-- so deleting an organization or a user removes video rows inside the database
-- with no route handler running. Nine hard-delete call sites exist in the API;
-- this trigger covers those *and* every cascade, present and future.
--
-- Only the identity and the raw key are captured. Buckets are resolved from
-- configuration when the job runs, so renaming a bucket needs no data change.
CREATE OR REPLACE FUNCTION enqueue_storage_cleanup() RETURNS trigger AS $$
BEGIN
  INSERT INTO storage_cleanup_job (id, video_id, organization_id, raw_key, prefix)
  VALUES (
    'scj_' || gen_random_uuid()::text,
    OLD.id,
    OLD.organization_id,
    OLD.raw_key,
    'videos/' || OLD.id::text || '/'
  );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS video_enqueue_storage_cleanup ON video;
--> statement-breakpoint
CREATE TRIGGER video_enqueue_storage_cleanup
  AFTER DELETE ON video
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_storage_cleanup();
