BEGIN;

ALTER TABLE provider_results
  ADD COLUMN IF NOT EXISTS model_run_id uuid REFERENCES research_runs(id) ON DELETE SET NULL;

COMMIT;
