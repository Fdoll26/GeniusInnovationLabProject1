CREATE INDEX IF NOT EXISTS research_sessions_user_created_at
  ON research_sessions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS research_sessions_user_state
  ON research_sessions (user_id, state);
