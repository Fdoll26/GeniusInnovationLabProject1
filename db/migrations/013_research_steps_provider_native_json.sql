BEGIN;

ALTER TABLE research_steps
  ADD COLUMN IF NOT EXISTS provider_native_json jsonb;

COMMIT;
