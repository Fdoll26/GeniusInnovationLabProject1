BEGIN;

ALTER TABLE research_runs
  ADD COLUMN IF NOT EXISTS attempt int NOT NULL DEFAULT 1;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY session_id, provider ORDER BY created_at ASC, id ASC) AS next_attempt
  FROM research_runs
)
UPDATE research_runs r
SET attempt = ranked.next_attempt
FROM ranked
WHERE r.id = ranked.id
  AND r.attempt IS DISTINCT FROM ranked.next_attempt;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'research_runs_session_provider_attempt_key'
      AND conrelid = 'research_runs'::regclass
  ) THEN
    ALTER TABLE research_runs
      ADD CONSTRAINT research_runs_session_provider_attempt_key UNIQUE (session_id, provider, attempt);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS research_runs_session_provider_idx
  ON research_runs (session_id, provider);

CREATE INDEX IF NOT EXISTS research_runs_state_provider_idx
  ON research_runs (state, provider);

CREATE INDEX IF NOT EXISTS research_steps_run_id_idx
  ON research_steps (run_id);

COMMIT;
