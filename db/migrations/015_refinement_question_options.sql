ALTER TABLE refinement_questions
  ADD COLUMN IF NOT EXISTS options_json jsonb;
