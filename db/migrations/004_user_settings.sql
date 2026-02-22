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
  CHECK (refine_provider IN ('openai', 'gemini')),
  CHECK (summarize_provider IN ('openai', 'gemini')),
  CHECK (max_sources >= 1 AND max_sources <= 20),
  CHECK (openai_timeout_minutes >= 1 AND openai_timeout_minutes <= 20),
  CHECK (gemini_timeout_minutes >= 1 AND gemini_timeout_minutes <= 20),
  CHECK (reasoning_level IN ('low', 'high')),
  CHECK (report_summary_mode IN ('one', 'two'))
);

