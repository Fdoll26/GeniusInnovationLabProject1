BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'research_runs_id_session_provider_key'
      AND conrelid = 'research_runs'::regclass
  ) THEN
    ALTER TABLE research_runs
      ADD CONSTRAINT research_runs_id_session_provider_key UNIQUE (id, session_id, provider);
  END IF;
END
$$;

-- Keep historical rows but clear mismatched pointers before adding scoped FK.
UPDATE provider_results pr
SET model_run_id = NULL
WHERE pr.model_run_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM research_runs rr
    WHERE rr.id = pr.model_run_id
      AND rr.session_id = pr.session_id
      AND rr.provider = pr.provider
  );

ALTER TABLE provider_results
  DROP CONSTRAINT IF EXISTS provider_results_model_run_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'provider_results_model_run_scope_fkey'
      AND conrelid = 'provider_results'::regclass
  ) THEN
    ALTER TABLE provider_results
      ADD CONSTRAINT provider_results_model_run_scope_fkey
      FOREIGN KEY (model_run_id, session_id, provider)
      REFERENCES research_runs (id, session_id, provider)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS provider_results_session_provider_model_run_idx
  ON provider_results (session_id, provider, model_run_id);

COMMIT;
