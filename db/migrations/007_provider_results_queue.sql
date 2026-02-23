BEGIN;

ALTER TABLE provider_results
  ADD COLUMN IF NOT EXISTS queued_at timestamptz;

COMMIT;

