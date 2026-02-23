# Design Decisions

This file captures the “why” behind the current architecture and implementation choices.

## Speckit / Specification-Driven Development (with Codex)

This repo uses Speckit-style specs in `specs/001-multi-api-research/` as the source of truth for product and system behavior.

- **Why specs first**: the orchestration problem (multi-provider runs, retries, partial failures, reporting) has enough edge cases that writing a spec up front reduces churn and prevents “UI-led” logic drift.
- **How Codex fits**: Codex is used to implement, refactor, and test against the spec. In practice that means:
  - using the spec to define endpoints, state transitions, and data model before coding
  - keeping “contract” behaviors stable via tests that reflect the spec surface area
  - iterating on implementation details while preserving spec-defined UX/API semantics
- **Living alignment**: the app guide (`docs/APP_GUIDE.md`) documents the current implementation, while the Speckit specs represent intended behavior; when they diverge, the spec is the place to decide whether to update “intent” or to bring code back into compliance.

## Architecture

- **Single Next.js app (App Router) for UI + API**: keeps deployment simple (one process) while still allowing a clean separation between `app/(research)` (UI), `app/api` (endpoints), and `app/lib` (server-side modules).
- **PostgreSQL as the source of truth**: sessions, refinement questions/answers, provider runs, reports, user settings, and rate limits are persisted so the UI can recover after refresh/redeploy.
- **Minimal server-side layering**: route handlers do auth + input validation and delegate to focused `app/lib/*` modules (repos, orchestration, provider clients, PDF/email).

## Auth & Access Control

- **NextAuth (Google) for real sign-in**: standard, low-effort OAuth integration.
- **Dev “bypass auth” mode**: speeds up local iteration without requiring Google OAuth setup (still uses the DB so behavior stays close to production).
- **Ownership checks on session routes**: prevents cross-user access for session/status/report operations.

## Orchestration (No Worker)

- **No dedicated job worker / queue service**: avoids operational overhead for a small app. Instead, session progress is driven by:
  - browser polling (status checks)
  - best-effort server-side `syncSession()` during status requests
- **Tradeoff**: progress can stall if nobody polls; the system is optimized for “interactive” usage rather than offline batch processing.

## Provider Queueing & Concurrency

- **Provider-level queue** (`provider_results.status='queued' | 'running' | ...`): keeps session state simple and lets providers progress independently.
- **Postgres advisory locks** for provider queues: serializes “deep research” work per provider across instances without an extra queue system.
- **In-memory fallback locks**: keeps local/dev and no-DB execution paths predictable (though the app still expects Postgres for persistence).
- **OpenAI treated as async**: stores a response id and polls until terminal; prevents blocking request lifetimes on long runs.
- **Gemini treated as sync**: runs and completes in the same queue pass in most cases.
- **In-process OpenAI concurrency cap**: protects against spiky usage per instance (`OPENAI_DEEP_RESEARCH_CONCURRENCY`).

## Reliability & Idempotency

- **Session run locks**: prevent overlapping retries/polls from double-starting provider work for the same session.
- **Queued/running repair**: if a queued item sits too long (likely deploy restart), the provider result is marked failed with a retry hint.
- **Finalize lock + “already sent” guard**: `finalizeReport()` uses an advisory lock and will not re-send a previously sent report email.

## Reporting

- **PDF generation with `pdf-lib`**: pure JS, no native binaries required, deterministic output for tests.
- **Email via SendGrid API**: straightforward attachment support; `sendReportEmail()` uses `fetch` so it’s easy to stub/mock.
- **Report resend creates a new report row**: avoids overwriting previously emailed artifacts and makes auditing/debugging simpler.

## Debug & Stubbing

- **Feature-flagged debug panel**: hidden by default; explicit opt-in via `NEXT_PUBLIC_DEBUG_PANEL`.
- **Stub/skip flags**: allow testing flows without external APIs (OpenAI/Gemini/PDF/email) while keeping orchestration logic intact.

## Testing Strategy

- **Contract tests**: exercise route handler behavior (inputs/outputs/state changes) with mocks.
- **Integration tests**: cover end-to-end UI flows in jsdom where valuable.
- **Unit tests for PDF/email**: verify key orchestration-adjacent utilities without requiring external services.
