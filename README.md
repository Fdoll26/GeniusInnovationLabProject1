# Multi-API Research

A minimal Next.js app that runs deep research across OpenAI and Gemini, tracks
session history, and emails a PDF report upon completion.

## Setup

1. Copy `.env.example` to `.env.local` and fill in values.
2. Run the SQL migrations against your PostgreSQL instance:
   - `db/migrations/001_init.sql`
   - `db/migrations/002_rate_limit.sql`
   - `db/migrations/003_user_settings.sql`
   - `db/migrations/004_user_settings_theme.sql`
   - `db/migrations/005_provider_results_external.sql`
3. Install dependencies and start the dev server.

## Flow

- Sign in with Google on Home.
- Submit a research topic to create a session.
- Answer refinement questions, approve the refined prompt.
- OpenAI and Gemini run in parallel; results are aggregated into a PDF.
- Email is sent on terminal state (completed/partial/failed).
- View session history in the History screen.

## Debug Panel (dev only)

- Visit `/?debug=1` to auto-enable bypass auth + stubbed externals.
- Or toggle in the Debug Panel on Home.
- Env overrides:
  - `DEV_BYPASS_AUTH=true`
  - `DEV_STUB_EXTERNALS=true`
  - `DEV_STUB_REFINER=true`
  - `DEV_STUB_OPENAI=true`
  - `DEV_STUB_GEMINI=true`
  - `DEV_STUB_EMAIL=true`
  - `DEV_STUB_PDF=true`
  - `DEV_SKIP_OPENAI=true`
  - `DEV_SKIP_GEMINI=true`

## Access Control & Rate Limits

- `ALLOWED_EMAILS` can be a comma-separated list of emails allowed to use the app.
- `RATE_LIMIT_WINDOW_SECONDS` and `RATE_LIMIT_MAX_REQUESTS` apply to session creation,
  prompt approval, and retries.

## OpenAI Deep Research Notes

- Deep research calls require at least one tool (e.g., `web_search_preview`).
- Clarification + prompt rewrite are handled via a refiner model before the deep research call.
