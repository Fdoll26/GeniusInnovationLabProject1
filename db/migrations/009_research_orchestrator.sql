BEGIN;

CREATE TABLE IF NOT EXISTS research_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
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
  CONSTRAINT research_runs_depth_check CHECK (depth IN ('light','standard','deep'))
);

CREATE INDEX IF NOT EXISTS research_runs_session_created_idx
  ON research_runs (session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS research_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  step_index int NOT NULL,
  step_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
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
  CONSTRAINT research_steps_status_check CHECK (status IN ('pending','running','completed','failed')),
  CONSTRAINT research_steps_provider_check CHECK (provider IN ('openai','gemini'))
);

CREATE UNIQUE INDEX IF NOT EXISTS research_steps_run_step_idx
  ON research_steps (run_id, step_index);

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

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS research_provider text NOT NULL DEFAULT 'openai',
  ADD COLUMN IF NOT EXISTS research_mode text NOT NULL DEFAULT 'custom',
  ADD COLUMN IF NOT EXISTS research_depth text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS research_max_steps int NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS research_target_sources_per_step int NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS research_max_total_sources int NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS research_max_tokens_per_step int NOT NULL DEFAULT 1800;

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
