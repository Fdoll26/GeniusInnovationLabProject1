BEGIN;

DROP INDEX IF EXISTS provider_results_session_provider_model_run_idx;

ALTER TABLE provider_results
  DROP CONSTRAINT IF EXISTS provider_results_model_run_scope_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'provider_results_model_run_id_fkey'
      AND conrelid = 'provider_results'::regclass
  ) THEN
    ALTER TABLE provider_results
      ADD CONSTRAINT provider_results_model_run_id_fkey
      FOREIGN KEY (model_run_id)
      REFERENCES research_runs (id)
      ON DELETE SET NULL;
  END IF;
END
$$;

ALTER TABLE research_runs
  DROP CONSTRAINT IF EXISTS research_runs_id_session_provider_key;

COMMIT;
