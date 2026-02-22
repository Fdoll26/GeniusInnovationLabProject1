# Multi-API Research – App Guide

This document explains how the app works, how to run it, and why certain technical choices were made. It is based on the Speckit design docs in `specs/001-multi-api-research/` and the current implementation in `app/`.

## What The App Does

The app lets a signed-in user:

1. Create a research session by submitting a topic/question.
2. Answer refinement questions (if any) to improve the prompt.
3. Approve the refined prompt.
4. Run research with two providers (OpenAI “Deep Research” and Google Gemini) using the same refined prompt.
5. Store session history and provider outputs in PostgreSQL.
6. Generate a PDF report and email it to the user on completion (including “partial” completion when one provider fails).

Key product goals from the spec:
- Minimal UI: Home (create + live status) and History (list + detail).
- Clear states + retries, mobile-friendly.
- Persisted history with timestamps and ownership isolation.

## User-Facing Screens

### Home
Route group: `app/(research)/page.tsx`

- Topic form to start a new session.
- “Active sessions” tabs (up to 3) to switch between in-progress sessions.
- Live status panel + refinement panel for the selected session.
- Dev debug panel (dev-only) to stub providers, bypass auth, etc.

Active session tabs are persisted in `localStorage` so a refresh can restore unfinished work, and completed sessions are removed from the active list.

### History
Route: `app/(research)/history/page.tsx`

- Searchable session list (paginated).
- Session detail modal with provider outputs, report email status, and actions:
  - Retry session (for failed/partial/aggregating/running_research)
  - Regenerate + re-send report email (for completed/partial)

When you press “Retry Session” from History, the app attempts to pin that session back into the Home “active tabs” list if there is capacity (max 3), otherwise it asks you to try again after an active tab completes.

### Incomplete
Route: `app/(research)/incomplete/page.tsx`

Lists sessions that are not terminal and lets you jump back to Home with `/?session=<id>`.

### Settings
Route: `app/(research)/settings/page.tsx`

Allows the user to set provider and report preferences (timeouts, max sources, theme, summary mode, etc.). The server persists this to `user_settings`.

## Session State & Progress Model

The Speckit spec defines a state machine like:
`draft → refining → running_openai → running_gemini → aggregating → completed` plus terminal `partial`/`failed`.

The current implementation uses:
- A session-level state (`research_sessions.state`) primarily for UX and “macro” phases:
  - `draft`, `refining`, `running_research`, `aggregating`, `completed`, `partial`, `failed`
- Provider-level state in `provider_results.status` to track each provider independently:
  - `queued`, `running`, `completed`, `failed`, `skipped`

This split keeps the session state simple while still supporting detailed per-provider progress, retries, and partial completion.

Note: the codebase still defines `running_openai` and `running_gemini` as valid session states (`app/lib/session-state.ts`) but the active orchestration path uses `running_research` as the “provider work is happening” state.

## Backend Flow (High Level)

### 1) Create Session
Endpoint: `POST /api/research/sessions` (`app/api/research/sessions/route.ts`)

- Requires auth (`requireSession`).
- Creates a `research_sessions` row with `state='draft'`.
- Kicks off refinement (`runRefinement`).

### 2) Refinement
Orchestration: `app/lib/orchestration.ts`

- `runRefinement()` calls the configured refiner provider:
  - OpenAI refiner (`app/lib/openai-client.ts`) or
  - Gemini refiner (`app/lib/gemini-client.ts`)
- If questions are returned, they are stored in `refinement_questions` and the session moves to `state='refining'`.
- The client submits answers one at a time:
  - `POST /api/research/sessions/:sessionId/refinement/answer` (`app/api/research/sessions/[sessionId]/refinement/answer/route.ts`)
- When refinement is complete, the user approves the refined prompt:
  - `POST /api/research/sessions/:sessionId/approve` (implemented via `app/api/research/sessions/[sessionId]/[action]/route.ts`)

### 3) Run Provider Research
Orchestration: `runProviders()` in `app/lib/orchestration.ts`

- On approval, the session enters `state='running_research'`.
- OpenAI and Gemini runs are launched (with provider-level status updates in `provider_results`).
- Results are stored as `provider_results.output_text` (+ `sources_json` when available).

### 4) Aggregate + PDF + Email
Orchestration: `finalizeReport()` in `app/lib/orchestration.ts`

- When provider runs reach terminal outcomes, the session enters `state='aggregating'`.
- A PDF is generated via `pdf-lib` (`app/lib/pdf-report.ts`).
- An email is sent with SendGrid (`app/lib/email-sender.ts`) with the PDF attached.
- Session transitions to terminal:
  - `completed` if both providers succeeded
  - `partial` if one failed/skipped
  - `failed` if both failed/skipped or a fatal aggregation/send error occurs

## “Background Jobs” Without A Worker

There is no dedicated job queue/worker process. Instead:
- The browser polls status (`useSessionStatus`, `app/(research)/hooks/useSessionStatus.ts`).
- Status/detail endpoints best-effort “sync” sessions server-side (`syncSession()`), e.g.:
  - polling OpenAI background response ids
  - timing out stale/queued work
  - finalizing “aggregating” sessions

This keeps operational complexity low (single Next.js app), at the cost of relying on polling traffic to drive progress.

## Concurrency & Queueing Decisions

Two different mechanisms are used for different layers:

1) **OpenAI request concurrency** (`app/lib/openai-client.ts`)
   - A small in-process semaphore limits concurrent Deep Research requests to avoid spiky usage.

2) **Provider queue lock** (`app/lib/orchestration.ts`)
   - A PostgreSQL advisory lock (when `DATABASE_URL` is set) serializes provider deep-research work across instances.
   - There is an in-memory queue fallback for the locking/queueing mechanism, but the app still requires PostgreSQL for persistence and most operations.

Additionally, a per-session “run lock” prevents duplicate overlapping retries/polls from double-launching work.

## Database Model

See: `specs/001-multi-api-research/data-model.md`

Tables:
- `users`
- `research_sessions`
- `refinement_questions`
- `provider_results`
- `reports`
- `rate_limits`
- `user_settings`

## API Surface

The OpenAPI contract in `specs/001-multi-api-research/contracts/openapi.yaml` describes the primary session endpoints.

Implementation note: several endpoints are consolidated behind dynamic route segments for maintainability, but URLs remain the same (e.g. `/api/research/sessions/:sessionId/status` is handled via `app/api/research/sessions/[sessionId]/[action]/route.ts` with `action='status'`).

Other notable endpoints:
- Settings: `GET/POST /api/settings` (`app/api/settings/route.ts`)
- Rate limit status: `GET /api/rate-limit` (`app/api/rate-limit/route.ts`)
- Reports “recent”: `GET /api/reports/recent` (implemented via `app/api/reports/[action]/route.ts` with `action='recent'`)

## Running The App (Local)

### Prerequisites
- Node.js LTS
- PostgreSQL
- Google OAuth credentials
- OpenAI API key
- Gemini API key
- SendGrid API key (or use debug stubs)

### 1) Configure Environment
Copy `.env.example` → `.env.local` and set required variables:
- `DATABASE_URL`
- `NEXTAUTH_URL`, `NEXTAUTH_SECRET`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `SENDGRID_API_KEY`, `EMAIL_FROM`

Optional / advanced:
- `ALLOWED_EMAILS` (comma-separated allowlist; enforced for both real auth and dev-bypass)
- `RATE_LIMIT_WINDOW_SECONDS`, `RATE_LIMIT_MAX_REQUESTS`
- OpenAI tuning:
  - `OPENAI_API_BASE`, `OPENAI_REFINER_MODEL`, `OPENAI_DEEP_RESEARCH_MODEL`, `OPENAI_MAX_TOOL_CALLS`
- Gemini tuning:
  - `GEMINI_API_BASE`, `GEMINI_MODEL`

### 2) Initialize DB Schema
Run:

```bash
psql "$DATABASE_URL" -f db/init.sql
```

Optional dev seed:

```bash
psql "$DATABASE_URL" -f db/seed/seed.sql
```

### 3) Install & Start

```bash
npm install
npm run dev
```

### Tests / Lint

```bash
npm test
npm run lint
```

## Debug & Local Development Options

The app includes a dev-only Debug Panel:
- Visit `/?debug=1` to auto-enable “bypass auth” + stub toggles, or toggle them in the UI.
- The debug API endpoints are in `app/api/debug/[action]/route.ts` and are disabled in production.

By default the panel is hidden unless you explicitly enable it:
- Set `NEXT_PUBLIC_DEBUG_PANEL=1` in `.env.local`

Note: even with bypass auth enabled, the app still uses the database (it upserts a `dev@example.com` user), so `DATABASE_URL` must be set for most flows.

Environment toggles:
- `DEV_BYPASS_AUTH`, `DEV_STUB_EXTERNALS`, `DEV_STUB_REFINER`, `DEV_STUB_OPENAI`, `DEV_STUB_GEMINI`, `DEV_STUB_EMAIL`, `DEV_STUB_PDF`
- `DEV_SKIP_OPENAI`, `DEV_SKIP_GEMINI`

## Technical Decisions (And Why)

### Next.js App Router + NextAuth (Google)
Chosen for:
- Minimal auth/session integration that matches the spec requirement (“Google sign-in”).
- Cohesive full-stack codebase (UI + API routes + server logic in one repo).

Alternatives:
- Auth0 / custom OAuth.

### PostgreSQL + Normalized Tables
Chosen for:
- Clean history tracking and ownership isolation.
- Per-provider result storage and retry capability without overwriting data.

Alternatives:
- One “session document” with embedded JSON fields (simpler schema, harder to query/extend).

### Polling-Driven Orchestration (No Worker)
Chosen for:
- Fewer moving parts for a small app (no queue infra).

Alternatives:
- Dedicated job queue (BullMQ/Redis), background worker, cron-based reconciliation.

### SendGrid Email + PDF Attachment
Chosen for:
- Simple transactional email API and reliable delivery.

Alternatives:
- Mailgun, SES, Gmail API.

### PDF Generation via `pdf-lib`
Chosen for:
- Pure-JS, in-memory PDF generation (no external binaries).

Alternatives:
- pdfkit, pdfmake, server-side HTML→PDF tools (often heavier operationally).

## Known Constraints / Tradeoffs

- Polling traffic is what “drives” progress; if nobody polls a session, it may not advance until a later poll.
- Gemini calls are not resumable (no background job id stored), so an interrupted run is treated as failed/stale and must be retried.
- Some session state detail is expressed via provider statuses rather than session states; UIs should rely on the status endpoint for truth.

## Future Improvements & Alternatives

### Reliability / Operations
- Add a real job queue + worker to decouple orchestration from user polling.
- Add a periodic reconciliation job to finalize or clean up stale sessions automatically.
- Store Gemini job identifiers (if available) to support resuming.

### UX
- More explicit progress UI: queued vs running vs finalizing per provider.
- Notifications (email or in-app) for completion instead of relying on polling.
- Better “resume last active session” and clearer “capacity (3 sessions)” messaging.

### Data & Reporting
- Better source extraction and de-duplication (global reference list is already supported for regenerated reports; could be applied to the default report flow).
- Store structured citations per provider (not just free text + sources_json) for consistent report formatting.
- Add export formats (Markdown/HTML) in addition to PDF.

### Security
- Enforce `ALLOWED_EMAILS` and add per-user quotas (beyond current rate-limit table).
- Encrypt or redact sensitive content in stored research outputs if needed for compliance.
