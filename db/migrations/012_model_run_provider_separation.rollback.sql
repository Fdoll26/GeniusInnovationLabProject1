BEGIN;

DROP INDEX IF EXISTS research_steps_run_id_idx;
DROP INDEX IF EXISTS research_runs_state_provider_idx;
DROP INDEX IF EXISTS research_runs_session_provider_idx;

ALTER TABLE research_runs
  DROP CONSTRAINT IF EXISTS research_runs_session_provider_attempt_key;

ALTER TABLE research_runs
  DROP COLUMN IF EXISTS attempt;

COMMIT;
