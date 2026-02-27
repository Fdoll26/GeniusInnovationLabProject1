# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start Next.js dev server
npm run build        # Production build
npm run lint         # ESLint
npm test             # Run all tests once (vitest)
npm run test:watch   # Vitest in watch mode
```

Run a single test file:
```bash
npx vitest run tests/unit/research-workflow.test.ts
```

Database:
```bash
psql "$DATABASE_URL" -f db/migrations/<file>.sql   # Apply a migration manually
npm run db:rollback                                  # Run rollback script
npm run seed                                         # Seed from db/seed/seed.sql
```

## Environment Setup

Copy `.env.example` to `.env.local`. Required variables:
- `DATABASE_URL` — PostgreSQL connection string
- `NEXTAUTH_URL`, `NEXTAUTH_SECRET` — NextAuth
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — OAuth
- `OPENAI_API_KEY`, `GEMINI_API_KEY` — AI providers
- `SENDGRID_API_KEY`, `EMAIL_FROM` — Email delivery

Dev/debug env vars (all optional, default false):
- `DEV_BYPASS_AUTH=true` — skip Google sign-in
- `DEV_STUB_EXTERNALS=true` — stub all external calls (OpenAI, Gemini, email, PDF)
- Individual stubs: `DEV_STUB_REFINER`, `DEV_STUB_OPENAI`, `DEV_STUB_GEMINI`, `DEV_STUB_EMAIL`, `DEV_STUB_PDF`
- `DEV_SKIP_OPENAI` / `DEV_SKIP_GEMINI` — skip a provider without stubbing
- `NEXT_PUBLIC_DEBUG_PANEL=1` — enable in-browser debug panel UI

Debug flags can also be set via cookies (`dev_bypass`, `dev_stub`, etc.) from the `/debug` page.

## Architecture

This is a **Next.js 16 App Router** application with all business logic in `app/lib/` and routes under `app/api/` and the `(research)` route group.

### Session State Machine

`app/lib/session-state.ts` defines the allowed transitions:
```
draft → refining → running_research → aggregating → completed
                                    → partial
                                    → failed
```
Legacy states `running_openai` / `running_gemini` also exist in the transition table.

### Research Pipeline

Each provider (OpenAI, Gemini) runs an 8-step pipeline defined in `app/lib/research-types.ts`:
```
DEVELOP_RESEARCH_PLAN → DISCOVER_SOURCES_WITH_PLAN → SHORTLIST_RESULTS →
DEEP_READ → EXTRACT_EVIDENCE → COUNTERPOINTS → GAP_CHECK → SECTION_SYNTHESIS
```
`GAP_CHECK` can loop back to `DISCOVER_SOURCES_WITH_PLAN` once for gap remediation. Logic is in `app/lib/research-workflow.ts`.

### Core Flow (how everything connects)

1. **User submits topic** → Next.js Server Action `createSessionAction` (`app/(research)/actions.ts`) creates a DB session and calls `orchestration.ts:runRefinement`.
2. **Refinement** — `app/lib/orchestration.ts` calls OpenAI (or stub) to generate clarification questions, stores them via `refinement-repo.ts`, and transitions the session to `refining`.
3. **User answers questions** — answered via `app/api/research/sessions/[sessionId]/refinement/answer/route.ts`; when complete, orchestration advances to `running_research` and enqueues provider jobs.
4. **Provider queues** — `app/lib/queue/openai.ts` and `app/lib/queue/gemini.ts` hold separate in-process lane queues (`app/lib/queue/lane.ts`) with configurable concurrency. Each job runs a full step pipeline via `app/lib/research-orchestrator.ts`.
5. **Step execution** — `research-orchestrator.ts` drives the pipeline; each step is persisted to `research_runs` / `research_steps` tables via `research-run-repo.ts`. `research-provider.ts` + `openai-client.ts` / `gemini-client.ts` do the actual API calls.
6. **Status streaming** — `app/api/research/[sessionId]/stream/route.ts` is a Server-Sent Events endpoint that polls the DB every 2 s and pushes changes. The client hook `useSessionStatus` (`app/(research)/hooks/useSessionStatus.ts`) opens an `EventSource` to it, with polling fallback.
7. **Completion** — when both providers finish, `orchestration.ts` transitions the session to `aggregating`, generates a PDF via `app/lib/pdf-report.ts` (using `pdf-lib`), and sends email via `app/lib/email-sender.ts` (SendGrid).

### Database

Schema is managed via numbered SQL migrations in `db/migrations/`. The main entities:
- `users` — Google OAuth identities
- `research_sessions` — topic, refined_prompt, state
- `refinement_questions` — ordered Q&A per session
- `provider_results` — per-provider output + status
- `research_runs` / `research_steps` / `research_sources` / `research_evidence` — step-by-step pipeline tracking (added in migration 009–014)
- `reports` — PDF bytes + email delivery status
- `user_settings` — per-user config (theme, max sources, etc.)
- `rate_limit_events` — request rate tracking

DB access uses a singleton `pg.Pool` in `app/lib/db.ts`. All DB calls go through the `query<T>()` helper there or through the `*-repo.ts` files.

### Key lib files

| File | Purpose |
|------|---------|
| `app/lib/orchestration.ts` | Main orchestration: refinement, enqueueing, aggregation, email |
| `app/lib/research-orchestrator.ts` | Step-pipeline execution per provider run |
| `app/lib/research-provider.ts` | `executePipelineStep` dispatcher; `generateResearchPlan` |
| `app/lib/openai-client.ts` | OpenAI API calls (refinement, deep research, polling) |
| `app/lib/gemini-client.ts` | Gemini API calls |
| `app/lib/session-state.ts` | `canTransition()` guard |
| `app/lib/research-types.ts` | All shared types, step constants, artifact shapes |
| `app/lib/debug.ts` | `getDebugFlags()` — reads env + cookies for dev overrides |
| `app/lib/authz.ts` | `requireSession()` / `assertSessionOwnership()` |

### Tests

Tests live in `tests/` split into:
- `tests/unit/` — pure logic, no DB/HTTP
- `tests/integration/` — multi-module flows, often with mocked DB/providers
- `tests/contract/` — HTTP handler tests

Vitest runs in `jsdom` environment; setup file is `tests/setup.ts`. Most external calls (OpenAI, Gemini, DB, email) are mocked via `vi.mock`.
