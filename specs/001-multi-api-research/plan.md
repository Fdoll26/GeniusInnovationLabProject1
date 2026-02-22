# Implementation Plan: Multi-API Research

**Branch**: `001-multi-api-research` | **Date**: 2026-02-17 | **Spec**: /home/fronk/Interview/GeniusInnovation/multi-api-test-ground/specs/001-multi-api-research/spec.md
**Input**: Feature specification from `/specs/001-multi-api-research/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Build a signed-in research experience that guides users through refinement,
executes OpenAI and Gemini research with a shared refined prompt, tracks status
across a defined state machine, stores history in PostgreSQL, and emails a PDF
report upon terminal completion. The plan emphasizes minimal UI, normalized data
modeling, clear status transitions, and reliable report delivery.

## Technical Context

**Language/Version**: TypeScript (Node.js + browser)  
**Primary Dependencies**: Next.js, React, NextAuth (Google provider), PostgreSQL
client, PDF library (buffer output), email sender module (SendGrid or Mailgun)  
**Storage**: PostgreSQL  
**Testing**: Vitest + React Testing Library + minimal API/route handler tests  
**Target Platform**: Web (modern browsers) + server runtime  
**Project Type**: web (single Next.js app with server actions/route handlers)  
**Performance Goals**: confirm request ≤ 3s; status updates ≤ 15s; report ≤ 15
minutes for 95% of sessions  
**Constraints**: minimal libraries; vanilla HTML/CSS/TS where possible; server
actions/route handlers orchestrate background-ish flows triggered by polling  
**Scale/Scope**: single-tenant app for early usage; tens to low hundreds of
concurrent sessions

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Code Quality: lint/format configured; no new lint errors; public APIs
  documented; error handling reviewed.
- Testing Standards: required unit/integration/contract tests added and
  passing in CI; any waivers justified in spec.
- UX Consistency: user-facing interfaces follow established patterns and
  acceptance scenarios updated.
- Performance Requirements: budgets defined; changes measured and within
  agreed thresholds.

**Gate Evaluation**: PASS. No violations required for this plan.

## Project Structure

### Documentation (this feature)

```text
specs/001-multi-api-research/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
app/
├── (auth)/
├── (research)/
├── api/
│   ├── auth/
│   └── research/
├── components/
├── styles/
└── lib/

db/
└── migrations/

tests/
├── contract/
├── integration/
└── unit/
```

**Structure Decision**: Single Next.js app with app router. API route handlers
live under `app/api`, UI under `app/(research)`, shared helpers under `app/lib`.
Tests follow unit/integration/contract separation.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (none) | (n/a) | (n/a) |
