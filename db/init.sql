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
  provider text NOT NULL,
  status text NOT NULL,
  output_text text,
  sources_json jsonb,
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
  CHECK (refine_provider IN ('openai', 'gemini')),
  CHECK (summarize_provider IN ('openai', 'gemini')),
  CHECK (max_sources >= 1 AND max_sources <= 20),
  CHECK (openai_timeout_minutes >= 1 AND openai_timeout_minutes <= 20),
  CHECK (gemini_timeout_minutes >= 1 AND gemini_timeout_minutes <= 20),
  CHECK (reasoning_level IN ('low', 'high')),
  CHECK (report_summary_mode IN ('one', 'two')),
  CONSTRAINT user_settings_theme_check CHECK (theme IN ('light', 'dark'))
);

-- Backfill updates for existing DBs (safe if already applied)
ALTER TABLE provider_results
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS external_status text,
  ADD COLUMN IF NOT EXISTS last_polled_at timestamptz;

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'light';

ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_theme_check;

ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_theme_check CHECK (theme IN ('light', 'dark'));

COMMIT;

