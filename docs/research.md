# Deep Research Engine

The deep research stage now runs as a persistent orchestrated workflow instead of a single provider blob.

## Workflow States

- `NEW`
- `NEEDS_CLARIFICATION`
- `PLANNED`
- `IN_PROGRESS`
- `SYNTHESIS`
- `DONE`
- `FAILED`

## Persistence Model

The orchestrator persists artifacts into:

- `research_runs`: run-level state, plan, brief, progress, synthesized report
- `research_steps`: per-step status, bounded output, tools, token usage, next-step proposal
- `research_sources`: normalized source records + reliability tags
- `research_evidence`: normalized evidence objects with confidence and source links
- `research_citations`: claim/section anchor to source mapping

## Provider + Mode

User settings now control the research engine:

- `research_provider`: `openai` | `gemini`
- `research_mode`: `native` | `custom`
- `research_depth`: `light` | `standard` | `deep`
- `research_max_steps`
- `research_target_sources_per_step`
- `research_max_total_sources`
- `research_max_tokens_per_step`

In `custom` mode, step types are used (`DISCOVER`, `SHORTLIST`, `DEEP_READ`, `EXTRACT_EVIDENCE`, `COUNTERPOINTS`, `GAPS_CHECK`, `SECTION_SYNTHESIS`).  
In `native` mode, a provider-native deep-research call is normalized into the same artifact store.

## Synthesis Output

The final synthesized report is generated from persisted evidence/source/citation artifacts and includes:

- table of contents
- methodology section
- inline citation markers
- sources section with URLs

This synthesized report is then fed into the existing PDF/email pipeline.

## Resume Behavior

`syncSession()` calls orchestrator `tick()` and can resume a run from DB state after restarts.

