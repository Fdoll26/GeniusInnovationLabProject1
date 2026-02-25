BEGIN;

ALTER TABLE research_steps
  DROP COLUMN IF EXISTS provider_native_json;

COMMIT;
