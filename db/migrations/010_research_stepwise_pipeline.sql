BEGIN;

UPDATE research_steps
SET status = CASE
  WHEN status = 'pending' THEN 'queued'
  WHEN status = 'completed' THEN 'done'
  ELSE status
END
WHERE status IN ('pending', 'completed');

ALTER TABLE research_steps
  ALTER COLUMN status SET DEFAULT 'queued';

ALTER TABLE research_steps
  DROP CONSTRAINT IF EXISTS research_steps_status_check;

ALTER TABLE research_steps
  ADD CONSTRAINT research_steps_status_check
  CHECK (status IN ('queued','running','done','failed'));

COMMIT;
