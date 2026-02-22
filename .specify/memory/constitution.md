<!--
Sync Impact Report
- Version change: N/A → 1.0.0
- Modified principles:
  - Template Principle 1 → Code Quality & Maintainability
  - Template Principle 2 → Testing Standards (Non-Negotiable)
  - Template Principle 3 → User Experience Consistency
  - Template Principle 4 → Performance Requirements
- Added sections:
  - Quality Gates
  - Development Workflow
- Removed sections:
  - Template Principle 5 (unused placeholder)
- Templates requiring updates (✅ updated / ⚠ pending):
  - ✅ .specify/templates/plan-template.md
  - ✅ .specify/templates/spec-template.md
  - ✅ .specify/templates/tasks-template.md
  - ⚠ .specify/templates/commands/ (not present)
- Follow-up TODOs:
  - TODO(RATIFICATION_DATE): original adoption date unknown
-->
# Multi API Test Ground Constitution

## Core Principles

### Code Quality & Maintainability
All production code MUST be readable, modular, and consistent with the agreed
style and lint rules. Changes MUST avoid dead code, unused paths, and
unjustified complexity. Public APIs MUST include clear docstrings or usage
notes, and error handling MUST be explicit and user-focused.

### Testing Standards (Non-Negotiable)
Every change that adds or modifies behavior MUST include automated tests that
prove the new behavior and protect against regression. Tests MUST be
deterministic, cover critical paths, and run in CI. Any test waiver MUST be
explicitly justified in the spec and approved during review.

### User Experience Consistency
All user-facing interfaces (UI, CLI, API responses, error messages) MUST follow
established interaction patterns, terminology, and formatting. Changes that
alter user workflows MUST include updated acceptance scenarios and a brief UX
impact note.

### Performance Requirements
Each feature MUST define measurable performance budgets (latency, throughput,
startup, memory, or payload size as applicable) in the spec or plan. Changes
MUST NOT regress agreed budgets without an approved exception and a mitigation
plan, supported by measurements or benchmarks.

## Quality Gates

- Linting/formatting MUST pass with no new warnings or errors.
- Required tests MUST be added and passing; flaky tests MUST be fixed or
  quarantined with an owner and timeline.
- Acceptance scenarios MUST be verified for any user-facing change.
- Performance budgets MUST be validated when a change could impact them.

## Development Workflow

- Specs MUST include testing and performance expectations before implementation.
- Reviews MUST verify compliance with all Core Principles and Quality Gates.
- Merge requires documented rationale for any exceptions or temporary waivers.

## Governance

- This constitution supersedes other development guidance.
- Amendments require a documented proposal, rationale, and version bump using
  semantic versioning (MAJOR for breaking governance changes, MINOR for new or
  expanded requirements, PATCH for clarifications).
- All plans, specs, and task lists MUST include a Constitution Check and record
  compliance or approved exceptions.
- Compliance is reviewed at plan approval and again before merge.

**Version**: 1.0.0 | **Ratified**: TODO(RATIFICATION_DATE): original adoption date unknown | **Last Amended**: 2026-02-17
