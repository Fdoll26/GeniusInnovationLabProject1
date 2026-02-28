CREATE EXTENSION IF NOT EXISTS pgcrypto;

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
  options_json jsonb,
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
