# Multi-API Research

Next.js app that orchestrates “deep research” across OpenAI + Gemini, stores session history in PostgreSQL, generates a PDF report, and emails it on completion.

## Code Organization

- Frontend (React): `app/(research)/`
- Backend (Next Route Handlers): `app/api/`
- Server-side modules (DB, orchestration, providers, PDF/email): `app/lib/`
- Database schema/migrations: `db/`
- Tests (Vitest): `tests/`

For a deeper technical walkthrough, see `docs/APP_GUIDE.md`.

## Setup (Local)

Prereqs: Node.js LTS, PostgreSQL.

1. Install deps:
   - `npm install`
2. Configure env:
   - Copy `.env.example` → `.env.local`
   - Fill in required values (details in `docs/API_SETUP.md`)
3. Initialize the database schema:
   - `psql "$DATABASE_URL" -f db/init.sql`
4. Start dev server:
   - `npm run dev`
5. (Optional) Seed sample data:
   - `psql "$DATABASE_URL" -f db/seed/seed.sql`

## Running Checks

- `npm test`
- `npm run lint`

## Debug Panel (Dev)

- Visit `/?debug=1` to auto-enable auth bypass + stubbed externals.
- Or toggle in the Debug Panel UI (requires `NEXT_PUBLIC_DEBUG_PANEL=1` or `true`).
- Env overrides (string booleans):
  - `DEV_BYPASS_AUTH=true`
  - `DEV_STUB_EXTERNALS=true`
  - `DEV_STUB_REFINER=true`
  - `DEV_STUB_OPENAI=true`
  - `DEV_STUB_GEMINI=true`
  - `DEV_STUB_EMAIL=true`
  - `DEV_STUB_PDF=true`
  - `DEV_SKIP_OPENAI=true`
  - `DEV_SKIP_GEMINI=true`

## Rate Limits

`RATE_LIMIT_WINDOW_SECONDS` and `RATE_LIMIT_MAX_REQUESTS` apply to session creation, prompt approval, and retries.

## OpenAI Deep Research Notes

- Deep research calls require at least one tool (e.g., `web_search_preview`).
- Clarification + prompt rewrite run before deep research via the configured refiner model.
