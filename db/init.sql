-- Consolidated schema + updates (idempotent).
-- Run with: psql "$DATABASE_URL" -f db/init.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Core tables
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  name text,
  image_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS research_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic text NOT NULL,
  refined_prompt text,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  refined_at timestamptz,
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS refinement_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  sequence int NOT NULL,
  question_text text NOT NULL,
  answer_text text,
  answered_at timestamptz,
  is_complete boolean NOT NULL DEFAULT false,
  UNIQUE (session_id, sequence)
);

CREATE TABLE IF NOT EXISTS provider_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  model_run_id uuid REFERENCES research_runs(id) ON DELETE SET NULL,
  provider text NOT NULL,
  status text NOT NULL,
  output_text text,
  sources_json jsonb,
  queued_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  external_id text,
  external_status text,
  last_polled_at timestamptz,
  UNIQUE (session_id, provider)
);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  summary_text text NOT NULL,
  pdf_bytes bytea,
  email_status text NOT NULL DEFAULT 'pending',
  sent_at timestamptz,
  email_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS research_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  attempt int NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'NEW',
  provider text NOT NULL,
  mode text NOT NULL,
  depth text NOT NULL DEFAULT 'standard',
  question text NOT NULL,
  clarifying_questions_json jsonb,
  assumptions_json jsonb,
  clarifications_json jsonb,
  research_brief_json jsonb,
  research_plan_json jsonb,
  progress_json jsonb,
  current_step_index int NOT NULL DEFAULT 0,
  max_steps int NOT NULL DEFAULT 8,
  target_sources_per_step int NOT NULL DEFAULT 5,
  max_total_sources int NOT NULL DEFAULT 40,
  max_tokens_per_step int NOT NULL DEFAULT 1800,
  min_word_count int NOT NULL DEFAULT 2500,
  synthesized_report_md text,
  synthesized_sources_json jsonb,
  synthesized_citation_map_json jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT research_runs_state_check CHECK (state IN ('NEW','NEEDS_CLARIFICATION','PLANNED','IN_PROGRESS','SYNTHESIS','DONE','FAILED')),
  CONSTRAINT research_runs_provider_check CHECK (provider IN ('openai','gemini')),
  CONSTRAINT research_runs_mode_check CHECK (mode IN ('native','custom')),
  CONSTRAINT research_runs_depth_check CHECK (depth IN ('light','standard','deep')),
  CONSTRAINT research_runs_session_provider_attempt_key UNIQUE (session_id, provider, attempt)
);

CREATE INDEX IF NOT EXISTS research_runs_session_created_idx
  ON research_runs (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS research_runs_session_provider_idx
  ON research_runs (session_id, provider);

CREATE INDEX IF NOT EXISTS research_runs_state_provider_idx
  ON research_runs (state, provider);

CREATE TABLE IF NOT EXISTS research_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  step_index int NOT NULL,
  step_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  provider text NOT NULL,
  model text,
  mode text NOT NULL,
  step_goal text,
  inputs_summary text,
  tools_used jsonb,
  raw_output text,
  output_excerpt text,
  sources_json jsonb,
  evidence_json jsonb,
  citation_map_json jsonb,
  next_step_proposal text,
  token_usage_json jsonb,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT research_steps_status_check CHECK (status IN ('queued','running','done','failed')),
  CONSTRAINT research_steps_provider_check CHECK (provider IN ('openai','gemini'))
);

CREATE UNIQUE INDEX IF NOT EXISTS research_steps_run_step_idx
  ON research_steps (run_id, step_index);

CREATE INDEX IF NOT EXISTS research_steps_run_id_idx
  ON research_steps (run_id);

CREATE TABLE IF NOT EXISTS research_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  step_id uuid REFERENCES research_steps(id) ON DELETE SET NULL,
  source_id text NOT NULL,
  url text NOT NULL,
  title text,
  publisher text,
  published_date date,
  accessed_at timestamptz NOT NULL DEFAULT now(),
  source_type text,
  reliability_tags_json jsonb,
  metadata_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS research_sources_run_source_id_idx
  ON research_sources (run_id, source_id);

CREATE UNIQUE INDEX IF NOT EXISTS research_sources_run_url_idx
  ON research_sources (run_id, url);

CREATE TABLE IF NOT EXISTS research_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  step_id uuid REFERENCES research_steps(id) ON DELETE SET NULL,
  evidence_id text NOT NULL,
  claim text NOT NULL,
  supporting_snippets_json jsonb,
  source_ids_json jsonb,
  confidence numeric(5,4),
  notes text,
  citation_anchor text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS research_evidence_run_evidence_id_idx
  ON research_evidence (run_id, evidence_id);

CREATE TABLE IF NOT EXISTS research_citations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  step_id uuid REFERENCES research_steps(id) ON DELETE SET NULL,
  claim_anchor text NOT NULL,
  section_name text,
  source_ids_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS research_citations_run_idx
  ON research_citations (run_id, created_at);

-- Rate limits
CREATE TABLE IF NOT EXISTS rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limits_user_action_created_at
  ON rate_limits (user_id, action, created_at);

-- History indexes
CREATE INDEX IF NOT EXISTS research_sessions_user_created_at
  ON research_sessions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS research_sessions_user_state
  ON research_sessions (user_id, state);

-- User settings
CREATE TABLE IF NOT EXISTS user_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  refine_provider text NOT NULL DEFAULT 'openai',
  summarize_provider text NOT NULL DEFAULT 'openai',
  max_sources int NOT NULL DEFAULT 15,
  openai_timeout_minutes int NOT NULL DEFAULT 10,
  gemini_timeout_minutes int NOT NULL DEFAULT 10,
  reasoning_level text NOT NULL DEFAULT 'low',
  report_summary_mode text NOT NULL DEFAULT 'two',
  report_include_refs_in_summary boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  theme text NOT NULL DEFAULT 'light',
  research_provider text NOT NULL DEFAULT 'openai',
  research_mode text NOT NULL DEFAULT 'custom',
  research_depth text NOT NULL DEFAULT 'standard',
  research_max_steps int NOT NULL DEFAULT 8,
  research_target_sources_per_step int NOT NULL DEFAULT 5,
  research_max_total_sources int NOT NULL DEFAULT 40,
  research_max_tokens_per_step int NOT NULL DEFAULT 1800,
  CHECK (refine_provider IN ('openai', 'gemini')),
  CHECK (summarize_provider IN ('openai', 'gemini')),
  CHECK (max_sources >= 1 AND max_sources <= 50),
  CHECK (openai_timeout_minutes >= 1 AND openai_timeout_minutes <= 20),
  CHECK (gemini_timeout_minutes >= 1 AND gemini_timeout_minutes <= 20),
  CHECK (reasoning_level IN ('low', 'high')),
  CHECK (report_summary_mode IN ('one', 'two')),
  CONSTRAINT user_settings_theme_check CHECK (theme IN ('light', 'dark')),
  CONSTRAINT user_settings_research_provider_check CHECK (research_provider IN ('openai', 'gemini')),
  CONSTRAINT user_settings_research_mode_check CHECK (research_mode IN ('native', 'custom')),
  CONSTRAINT user_settings_research_depth_check CHECK (research_depth IN ('light', 'standard', 'deep')),
  CONSTRAINT user_settings_research_max_steps_check CHECK (research_max_steps >= 3 AND research_max_steps <= 20),
  CONSTRAINT user_settings_research_target_sources_check CHECK (research_target_sources_per_step >= 1 AND research_target_sources_per_step <= 20),
  CONSTRAINT user_settings_research_max_total_sources_check CHECK (research_max_total_sources >= 5 AND research_max_total_sources <= 300),
  CONSTRAINT user_settings_research_max_tokens_per_step_check CHECK (research_max_tokens_per_step >= 300 AND research_max_tokens_per_step <= 8000)
);

-- Backfill updates for existing DBs (safe if already applied)
ALTER TABLE provider_results
  ADD COLUMN IF NOT EXISTS model_run_id uuid REFERENCES research_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS external_status text,
  ADD COLUMN IF NOT EXISTS last_polled_at timestamptz,
  ADD COLUMN IF NOT EXISTS queued_at timestamptz;

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'light';

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

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS research_provider text NOT NULL DEFAULT 'openai',
  ADD COLUMN IF NOT EXISTS research_mode text NOT NULL DEFAULT 'custom',
  ADD COLUMN IF NOT EXISTS research_depth text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS research_max_steps int NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS research_target_sources_per_step int NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS research_max_total_sources int NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS research_max_tokens_per_step int NOT NULL DEFAULT 1800;

ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_theme_check;

ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_theme_check CHECK (theme IN ('light', 'dark'));

ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_research_provider_check;
ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_research_provider_check CHECK (research_provider IN ('openai', 'gemini'));

ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_research_mode_check;
ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_research_mode_check CHECK (research_mode IN ('native', 'custom'));

ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_research_depth_check;
ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_research_depth_check CHECK (research_depth IN ('light', 'standard', 'deep'));

ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_research_max_steps_check;
ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_research_max_steps_check CHECK (research_max_steps >= 3 AND research_max_steps <= 20);

ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_research_target_sources_check;
ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_research_target_sources_check CHECK (research_target_sources_per_step >= 1 AND research_target_sources_per_step <= 20);

ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_research_max_total_sources_check;
ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_research_max_total_sources_check CHECK (research_max_total_sources >= 5 AND research_max_total_sources <= 300);

ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_research_max_tokens_per_step_check;
ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_research_max_tokens_per_step_check CHECK (research_max_tokens_per_step >= 300 AND research_max_tokens_per_step <= 8000);

COMMIT;
