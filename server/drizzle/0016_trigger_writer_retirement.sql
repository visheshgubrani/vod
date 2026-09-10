-- Trigger-created cleanup jobs must respect writer retirement too.
--
-- The trigger omitted `not_before`, so it fell back to the column default
-- (`now()`) and the job became immediately actionable. Combined with hard
-- deletion removing the very video row the reconciler checks for an active
-- attempt, a cascade could reclaim a prefix while an upload or transcode was
-- still running — and because the job is then verified once and considered
-- done, the late writer's objects had no further chance of being noticed.
--
-- `storage_cleanup_job.not_before` is the only protection available here: the
-- video row is gone, so "is an attempt still live?" cannot be asked. The delay
-- must therefore match the application-side writer-retirement window
-- (DEFAULT_CLEANUP_LIMITS.writerRetirementMs, 2 hours), which is deliberately
-- longer than the presigned-upload TTL.
CREATE OR REPLACE FUNCTION enqueue_storage_cleanup() RETURNS trigger AS $$
BEGIN
  INSERT INTO storage_cleanup_job (id, video_id, organization_id, raw_key, prefix, not_before)
  VALUES (
    'scj_' || gen_random_uuid()::text,
    OLD.id,
    OLD.organization_id,
    OLD.raw_key,
    'videos/' || OLD.id::text || '/',
    now() + interval '2 hours'
  )
  ON CONFLICT DO NOTHING;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
