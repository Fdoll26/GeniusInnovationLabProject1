---

description: "Task list template for feature implementation"
---

# Tasks: Multi-API Research

**Input**: Design documents from `/specs/001-multi-api-research/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Tests are REQUIRED for behavior changes per constitution; include per-story tests.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root
- **Web app**: `backend/src/`, `frontend/src/`
- **Mobile**: `api/src/`, `ios/src/` or `android/src/`
- Paths shown below assume single project - adjust based on plan.md structure

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [x] T001 Create Next.js app directory layout in app/ and app/lib/ per plan.md
- [x] T002 Add environment templates in .env.example with auth, API, DB, email keys
- [x] T003 [P] Configure linting/formatting in package.json and .eslintrc.json
- [x] T004 [P] Add minimal global styles in app/styles/globals.css

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T005 Create database connection helper in app/lib/db.ts
- [x] T006 Create initial schema migration in db/migrations/001_init.sql
- [x] T007 Configure NextAuth Google provider in app/api/auth/[...nextauth]/route.ts
- [x] T008 Add auth/session helpers in app/lib/auth.ts
- [x] T009 Add authorization guard helpers in app/lib/authz.ts
- [x] T010 Create state machine helpers in app/lib/session-state.ts
- [x] T011 Create OpenAI client wrapper in app/lib/openai-client.ts
- [x] T012 Create Gemini client wrapper in app/lib/gemini-client.ts
- [x] T013 Create PDF generator returning buffer in app/lib/pdf-report.ts
- [x] T014 Create email sender module in app/lib/email-sender.ts
- [x] T015 Create session repository helpers in app/lib/session-repo.ts
- [x] T016 Create refinement repository helpers in app/lib/refinement-repo.ts
- [x] T017 Create provider result repository helpers in app/lib/provider-repo.ts
- [x] T018 Create report repository helpers in app/lib/report-repo.ts
- [x] T019 Create server-side orchestration helpers in app/lib/orchestration.ts
- [x] T020 Enforce session ownership checks in app/lib/session-repo.ts
- [x] T021 Add auth guards to research API handlers in app/api/research/sessions/route.ts
- [x] T022 Add auth guards to session detail/status handlers in app/api/research/sessions/[sessionId]/route.ts
- [x] T023 Add auth guards to refinement/approve handlers in app/api/research/sessions/[sessionId]/refinement/answer/route.ts

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Start Research (Priority: P1) 🎯 MVP

**Goal**: Submit a research topic from Home and create a session with initial state

**Independent Test**: A signed-in user can submit a topic and see a new session status

### Tests for User Story 1 (REQUIRED) ⚠️

- [x] T024 [P] [US1] Contract test for session create in tests/contract/sessions-create.test.ts
- [x] T025 [P] [US1] Integration test for home submit flow in tests/integration/start-research.test.ts

### Implementation for User Story 1

- [x] T026 [P] [US1] Add Home page layout in app/(research)/page.tsx
- [x] T027 [P] [US1] Add topic input form component in app/(research)/components/TopicForm.tsx
- [x] T028 [US1] Add sign-in UI and session guard in app/(research)/page.tsx
- [x] T029 [US1] Add create-session server action in app/(research)/actions.ts
- [x] T030 [US1] Add API handler for session create/list in app/api/research/sessions/route.ts
- [x] T031 [US1] Persist new session record with user_id in app/lib/session-repo.ts
- [x] T032 [US1] Add session status widget in app/(research)/components/SessionStatus.tsx
- [x] T033 [US1] Add polling hook for status updates in app/(research)/hooks/useSessionStatus.ts

**Checkpoint**: User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - Answer Refinement Questions (Priority: P1)

**Goal**: Present and record refinement questions one at a time

**Independent Test**: A signed-in user can answer refinement questions until completion

### Tests for User Story 2 (REQUIRED) ⚠️

- [x] T034 [P] [US2] Contract test for refinement answer in tests/contract/refinement-answer.test.ts
- [x] T035 [P] [US2] Integration test for refinement flow in tests/integration/refinement-flow.test.ts

### Implementation for User Story 2

- [x] T036 [US2] Add refinement UI panel in app/(research)/components/RefinementPanel.tsx
- [x] T037 [US2] Add API handler for refinement answers in app/api/research/sessions/[sessionId]/refinement/answer/route.ts
- [x] T038 [US2] Add API handler for approve refined prompt in app/api/research/sessions/[sessionId]/approve/route.ts
- [x] T039 [US2] Store refinement Q/A in app/lib/refinement-repo.ts
- [x] T040 [US2] Trigger OpenAI refinement flow in app/lib/orchestration.ts
- [x] T041 [US2] Update session state to refining/running_openai in app/lib/session-repo.ts

**Checkpoint**: User Story 2 should be fully functional and testable independently

---

## Phase 5: User Story 3 - Receive Research Results (Priority: P1)

**Goal**: Run provider research, aggregate results, generate report, and email user

**Independent Test**: A signed-in user receives an emailed report at session completion

### Tests for User Story 3 (REQUIRED) ⚠️

- [x] T042 [P] [US3] Contract test for session status in tests/contract/session-status.test.ts
- [x] T043 [P] [US3] Integration test for report email trigger in tests/integration/report-email.test.ts

### Implementation for User Story 3

- [x] T044 [US3] Add API handler for session status in app/api/research/sessions/[sessionId]/status/route.ts
- [x] T045 [US3] Add API handler for session retry in app/api/research/sessions/[sessionId]/retry/route.ts
- [x] T046 [US3] Persist provider results in app/lib/provider-repo.ts
- [x] T047 [US3] Run OpenAI research on approval in app/lib/orchestration.ts
- [x] T048 [US3] Run Gemini research after OpenAI in app/lib/orchestration.ts
- [x] T049 [US3] Aggregate results and generate report in app/lib/pdf-report.ts
- [x] T050 [US3] Store report metadata in app/lib/report-repo.ts
- [x] T051 [US3] Send report email on terminal state in app/lib/email-sender.ts
- [x] T052 [US3] Update session state to aggregating/completed/partial/failed in app/lib/session-repo.ts
- [x] T053 [US3] Handle partial/failed terminal states in app/lib/orchestration.ts

**Checkpoint**: User Story 3 should be fully functional and testable independently

---

## Phase 6: User Story 4 - Review Research History (Priority: P2)

**Goal**: Show prior sessions with timestamps, status, and details

**Independent Test**: A signed-in user can view history list and session detail

### Tests for User Story 4 (REQUIRED) ⚠️

- [x] T054 [P] [US4] Integration test for history list in tests/integration/history-list.test.ts
- [x] T055 [P] [US4] Integration test for session detail in tests/integration/session-detail.test.ts

### Implementation for User Story 4

- [x] T056 [US4] Add History page layout in app/(research)/history/page.tsx
- [x] T057 [US4] Add history list component in app/(research)/components/HistoryList.tsx
- [x] T058 [US4] Add session detail view in app/(research)/components/SessionDetail.tsx
- [x] T059 [US4] Add session detail API handler in app/api/research/sessions/[sessionId]/route.ts
- [x] T060 [US4] Add history list API handler in app/api/research/sessions/route.ts
- [x] T061 [US4] Wire history data fetching in app/(research)/history/page.tsx

**Checkpoint**: User Story 4 should be fully functional and testable independently

---

## Phase N: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [x] T062 Add error state UI for failed sessions in app/(research)/components/SessionStatus.tsx
- [x] T063 Add retry UI in app/(research)/components/SessionDetail.tsx
- [x] T064 Add basic logging for orchestration failures in app/lib/orchestration.ts
- [x] T065 Add response-time logging for session creation in app/lib/session-repo.ts
- [x] T066 Add report completion timing check in app/lib/report-repo.ts
- [x] T067 Add responsive layout tweaks in app/styles/globals.css
- [x] T068 Update README with setup and flow in README.md
- [x] T069 Add .env.example updates if new keys added in .env.example

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User stories can then proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P2)
- **Polish (Final Phase)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P1)**: Depends on User Story 1 for session creation
- **User Story 3 (P1)**: Depends on User Story 2 for refined prompt approval
- **User Story 4 (P2)**: Depends on User Story 1 for session list, but can run in parallel with US2/US3

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Models/repositories before services/orchestration
- Server handlers before UI integration
- Core implementation before integration
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- Multiple UI components within a story can run in parallel
- US4 can proceed in parallel once session data access is available

---

## Parallel Example: User Story 1

```bash
# Launch UI tasks together:
Task: "Add Home page layout in app/(research)/page.tsx"
Task: "Add topic input form component in app/(research)/components/TopicForm.tsx"

# Launch status updates work in parallel:
Task: "Add session status widget in app/(research)/components/SessionStatus.tsx"
Task: "Add polling hook for status updates in app/(research)/hooks/useSessionStatus.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test User Story 1 independently
5. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Deploy/Demo (MVP!)
3. Add User Story 2 → Test independently → Deploy/Demo
4. Add User Story 3 → Test independently → Deploy/Demo
5. Add User Story 4 → Test independently → Deploy/Demo
6. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 1
   - Developer B: User Story 2
   - Developer C: User Story 4
3. User Story 3 integrates after User Story 2 completion

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence
