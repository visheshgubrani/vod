DROP INDEX "storage_cleanup_video_idx";--> statement-breakpoint
-- Collapse any pre-existing duplicates before enforcing uniqueness, so this
-- migration cannot fail on a database that already ran the un-deduped trigger.
-- Keeps the oldest outstanding job per video; reclaimed jobs are untouched.
DELETE FROM "storage_cleanup_job" AS older
  USING "storage_cleanup_job" AS newer
  WHERE older.video_id = newer.video_id
    AND older.status <> 'reclaimed'
    AND newer.status <> 'reclaimed'
    AND older.created_at > newer.created_at;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_cleanup_one_outstanding_idx" ON "storage_cleanup_job" USING btree ("video_id") WHERE "storage_cleanup_job"."status" <> 'reclaimed';
--> statement-breakpoint
-- The trigger must not abort a delete when an outstanding job already exists.
-- Without ON CONFLICT the new unique index would turn "delete a video whose
-- cleanup is already queued" into a foreign-key-style failure, breaking
-- organization and user cascades.
CREATE OR REPLACE FUNCTION enqueue_storage_cleanup() RETURNS trigger AS $$
BEGIN
  INSERT INTO storage_cleanup_job (id, video_id, organization_id, raw_key, prefix)
  VALUES (
    'scj_' || gen_random_uuid()::text,
    OLD.id,
    OLD.organization_id,
    OLD.raw_key,
    'videos/' || OLD.id::text || '/'
  )
  ON CONFLICT DO NOTHING;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
