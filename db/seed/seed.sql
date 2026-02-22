-- Dummy seed data for local development
-- Run with: psql "$DATABASE_URL" -f db/seed/seed.sql

INSERT INTO users (id, email, name, image_url)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice Example', NULL),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com', 'Bob Example', NULL)
ON CONFLICT (email) DO NOTHING;

INSERT INTO research_sessions (id, user_id, topic, refined_prompt, state, created_at, updated_at, refined_at, completed_at)
VALUES
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '11111111-1111-1111-1111-111111111111',
    'AI in healthcare',
    'AI applications in healthcare: diagnostics, triage, and policy impacts',
    'completed',
    now() - interval '2 days',
    now() - interval '2 days',
    now() - interval '2 days' + interval '10 minutes',
    now() - interval '2 days' + interval '20 minutes'
  ),
  (
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    '22222222-2222-2222-2222-222222222222',
    'Renewable energy policy',
    'Recent renewable energy policy changes in the US and EU',
    'partial',
    now() - interval '1 day',
    now() - interval '1 day',
    now() - interval '1 day' + interval '5 minutes',
    now() - interval '1 day' + interval '25 minutes'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO refinement_questions (id, session_id, sequence, question_text, answer_text, answered_at, is_complete)
VALUES
  (
    'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    1,
    'What time range should we focus on?',
    'Last 5 years',
    now() - interval '2 days' + interval '2 minutes',
    true
  ),
  (
    'd2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    2,
    'Any geographic focus?',
    'Global overview',
    now() - interval '2 days' + interval '4 minutes',
    true
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO provider_results (id, session_id, provider, status, output_text, sources_json, started_at, completed_at)
VALUES
  (
    'e3e3e3e3-e3e3-e3e3-e3e3-e3e3e3e3e3e3',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'openai',
    'completed',
    'OpenAI summary for AI in healthcare...',
    NULL,
    now() - interval '2 days' + interval '12 minutes',
    now() - interval '2 days' + interval '16 minutes'
  ),
  (
    'f4f4f4f4-f4f4-f4f4-f4f4-f4f4f4f4f4f4',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'gemini',
    'completed',
    'Gemini summary for AI in healthcare...',
    NULL,
    now() - interval '2 days' + interval '16 minutes',
    now() - interval '2 days' + interval '20 minutes'
  ),
  (
    'g5g5g5g5-g5g5-g5g5-g5g5-g5g5g5g5g5g5',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'openai',
    'completed',
    'OpenAI summary for renewable policy...',
    NULL,
    now() - interval '1 day' + interval '8 minutes',
    now() - interval '1 day' + interval '15 minutes'
  ),
  (
    'h6h6h6h6-h6h6-h6h6-h6h6-h6h6h6h6h6h6',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'gemini',
    'failed',
    NULL,
    NULL,
    now() - interval '1 day' + interval '12 minutes',
    now() - interval '1 day' + interval '25 minutes'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO reports (id, session_id, summary_text, pdf_bytes, email_status, sent_at, email_error, created_at)
VALUES
  (
    'i7i7i7i7-i7i7-i7i7-i7i7-i7i7i7i7i7i7',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'OpenAI: completed | Gemini: completed',
    NULL,
    'sent',
    now() - interval '2 days' + interval '21 minutes',
    NULL,
    now() - interval '2 days' + interval '21 minutes'
  ),
  (
    'j8j8j8j8-j8j8-j8j8-j8j8-j8j8j8j8j8j8',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'OpenAI: completed | Gemini: failed',
    NULL,
    'sent',
    now() - interval '1 day' + interval '26 minutes',
    NULL,
    now() - interval '1 day' + interval '26 minutes'
  )
ON CONFLICT (id) DO NOTHING;
