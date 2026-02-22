# Feature Specification: Multi-API Research

**Feature Branch**: `001-multi-api-research`  
**Created**: 2026-02-17  
**Status**: Draft  
**Input**: User description: "Build a full-stack web application that allows a signed-in user to perform deep multi-API research using both OpenAI’s Deep Research API and Google’s Gemini API. The application will: - Accept a research request (text prompt) from the user. - Use the OpenAI Deep Research API to initiate a search and, if applicable, handle refinement questions interactively. - Once the OpenAI flow is refined and approved, use that final refined prompt to kick off a Gemini research query. - Store the user’s research history. - Email the user a final PDF report containing results from both APIs once the research completes. Functional requirements: Authentication: - Allow users to sign in with Gmail (OAuth-based login). - Maintain basic session state and associate research history with the signed-in user. Research Request Flow: - The user enters a research topic or question. - Your backend calls the OpenAI Deep Research API to start a session. - If OpenAI returns refinement questions, present them to the user one by one. - After refinements are complete, the final refined prompt should be: - Saved in the database. - Passed to the Gemini API as the research input. Execution: - Kick off both research processes: - OpenAI Deep Research (using the refined prompt). - Gemini Research (using the same refined prompt). - Monitor the completion of both and store each result. Report Delivery: - When both results are ready: - Generate a PDF report containing outputs from both APIs (one section per provider). - Email the PDF to the user using their Gmail address. - Include a summary in the email body (e.g., top insights or sources). User Interface: - Simple and mobile-friendly. - Shows: - “New Research” input form. - Progress or pending state (e.g., “Awaiting OpenAI refinements”, “Running Gemini research”). - List of previous research sessions with timestamps and status. Non-functional: - Mobile-friendly and simple UI - Clear error states + retries - Use TypeScript - Provide README + .env.example Suggested stack: - Frontend: Next.js + React + TypeScript - Backend: Node.js / Next API routes or Express (TypeScript) - Database: PostgreSQL Integrations: - Auth: Google OAuth (Gmail sign-in) - Email: Gmail API or SendGrid/Mailgun (your choice) - OpenAI: Deep Research API (use the refinement question flow) - Gemini: Gemini API (no refinement, just execute with the final refined prompt) Report Generation: - Use any PDF library (e.g., pdfkit, reportlab, or pdfmake). - Include clear section titles (“OpenAI Deep Research Results” / “Gemini Results”). - Append timestamps and metadata (duration, query summary, etc.). Hosting: - Publicly hosted and functional (e.g., Vercel, Render, Railway, Firebase, etc.). - Should be usable without local setup."

## Clarifications

### Session 2026-02-17

- Q: What is the exact research session state machine? → A: `draft → refining → running_openai → running_gemini → aggregating → completed` with `failed` and `partial` terminal states.
- Q: What is the minimal UI flow? → A: Two screens: Home (new research + status), History (list + detail).
- Q: What fields should be stored in the DB? → A: Normalized records for Session, RefinementQuestion, ProviderResult, and Report.
- Q: How is the refinement Q/A represented? → A: Ordered list of Q/A entries, one question at a time, with completion flag.
- Q: How/when is email triggered? → A: When the session reaches a terminal state (completed, partial, or failed), send a report with all available results.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start Research (Priority: P1)

As a signed-in user, I want to submit a research topic so I can begin a
multi-provider research session.

**Why this priority**: This is the core entry point that enables all other
capabilities.

**Independent Test**: A signed-in user can submit a topic and sees a new session
created with a visible initial status.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they submit a research topic, **Then** a
   new research session is created and shows a status of “awaiting refinements”
   or “running research.”
2. **Given** the user submits an empty or invalid topic, **When** they submit,
   **Then** the system shows a clear error and does not create a session.
3. **Given** a signed-in user, **When** they open the Home screen, **Then** they
   can start new research and see current session status in the same view.

---

### User Story 2 - Answer Refinement Questions (Priority: P1)

As a signed-in user, I want to answer refinement questions one by one so the
research prompt becomes clear and complete.

**Why this priority**: Refinement is required to produce a high-quality research
result and unlocks the rest of the workflow.

**Independent Test**: A signed-in user receives refinement questions and can
submit responses until the refined prompt is approved.

**Acceptance Scenarios**:

1. **Given** a session awaiting refinements, **When** the user answers a
   refinement question, **Then** the next question is displayed or the flow
   completes.
2. **Given** all refinement questions are answered, **When** the user approves
   the refined prompt, **Then** the system records the final prompt and begins
   research.

---

### User Story 3 - Receive Research Results (Priority: P1)

As a signed-in user, I want to receive a combined research report so I can use
results from multiple providers without manual aggregation.

**Why this priority**: The delivered report is the main user value.

**Independent Test**: A signed-in user receives an emailed report after both
provider results are complete and can view session status updates.

**Acceptance Scenarios**:

1. **Given** a research session in progress, **When** both provider results are
   complete, **Then** a report is generated and emailed to the user.
2. **Given** a provider fails, **When** the session completes with partial data,
   **Then** the user is notified of the failure and the report indicates which
   provider failed.

---

### User Story 4 - Review Research History (Priority: P2)

As a signed-in user, I want to view past research sessions so I can track
results over time.

**Why this priority**: History improves usability and repeat research value.

**Independent Test**: A signed-in user can open the history list and see past
sessions with timestamps and statuses.

**Acceptance Scenarios**:

1. **Given** a user with prior sessions, **When** they open the history view,
   **Then** they see a list of sessions with status and timestamps.
2. **Given** a user selects a session, **When** they open it, **Then** they can
   see the refined prompt and provider result summaries.
3. **Given** a user navigates to History, **When** they select a session,
   **Then** the detail view appears within the History screen.

---

### Edge Cases

- What happens when a user closes the browser during refinement?
- How does the system handle one provider completing while the other stalls?
- What happens when email delivery fails after report generation?
- What happens when a session ends in failed with no provider results?

### UX Consistency Notes *(mandatory for user-facing changes)*

- Status labels use a small, consistent set of terms (e.g., awaiting
  refinements, running OpenAI, running Gemini, aggregating, completed, failed,
  partial).
- Error messages are concise and include a recovery action (retry, edit input,
  or contact support).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST allow users to sign in with their Google account
  and maintain a session.
- **FR-002**: The system MUST associate each research session with the signed-in
  user.
- **FR-003**: The system MUST allow a user to submit a research topic and create
  a new session.
- **FR-004**: The system MUST present refinement questions one at a time and
  store the user’s answers.
- **FR-005**: The system MUST record the final refined prompt and reuse it for
  all provider research.
- **FR-006**: The system MUST run research with two providers using the refined
  prompt and store both outputs.
- **FR-007**: The system MUST display real-time session status updates to the
  user.
- **FR-008**: The system MUST generate a report that includes results from both
  providers when available.
- **FR-009**: The system MUST email the report to the user’s registered email
  address.
- **FR-010**: The system MUST keep a history of research sessions with
  timestamps and statuses.
- **FR-011**: The system MUST provide clear error states and allow retry for
  failed refinement submission, research execution, or email delivery.
- **FR-012**: The system MUST follow a defined session state machine:
  `draft → refining → running_openai → running_gemini → aggregating → completed`,
  with `failed` and `partial` as terminal states.
- **FR-013**: The system MUST provide two screens: Home (new research + current
  status) and History (session list with detail view).
- **FR-014**: The system MUST trigger report email delivery when the session
  enters a terminal state (completed, partial, or failed), including all
  available results.

### Requirement Acceptance Criteria

- **FR-001**: User can sign in with a Google account and remains signed in while
  navigating the app.
- **FR-002**: Each session is visible only to the user who created it.
- **FR-003**: Submitting a valid topic creates a session with an initial status.
- **FR-004**: Refinement questions appear one at a time until completion.
- **FR-005**: The refined prompt is saved and used for all research runs.
- **FR-006**: Both provider results are stored with completion status.
- **FR-007**: Status changes are visible to the user without manual refresh.
- **FR-008**: Report includes separate sections for each provider.
- **FR-009**: The report is emailed to the user’s sign-in email address.
- **FR-010**: History shows prior sessions with timestamps and status.
- **FR-011**: Retry is available for failed steps with a clear error message.
- **FR-012**: The session progresses through the defined states and ends only
  in completed, failed, or partial.
- **FR-013**: Home includes research submission and live status; History
  includes list and detail view for sessions.
- **FR-014**: Email is sent when the session ends in completed, partial, or
  failed, and includes whatever results are available.

### Performance Requirements *(mandatory)*

- **PR-001**: Users MUST see confirmation of a new research request within 3
  seconds of submission.
- **PR-002**: Status updates MUST refresh or be available within 15 seconds of a
  change in session state.
- **PR-003**: The system MUST deliver the final report within 15 minutes of the
  refined prompt being approved for 95% of sessions.

### Key Entities *(include if feature involves data)*

- **User**: Account identity, email address, session metadata.
- **ResearchSession**: Original topic, refined prompt, state, timestamps, owner.
- **RefinementQuestion**: Session reference, question text, user answer,
  sequence order, answered timestamp, completion flag.
- **ProviderResult**: Session reference, provider name, output content,
  completion status, started/completed timestamps, error details if any.
- **Report**: Session reference, generated timestamp, delivery status,
  sent timestamp, summary text.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 95% of signed-in users can complete a research session without
  assistance.
- **SC-002**: 90% of research sessions complete with both provider results
  delivered to the user.
- **SC-003**: 95% of users receive their report within 15 minutes of approving
  the refined prompt.
- **SC-004**: User satisfaction is at least 4.2/5 in post-session feedback.
- **SC-005**: Less than 2% of sessions fail due to email delivery issues.

## Dependencies

- External research providers are available and accept the refined prompt.
- Email delivery service can send to the user’s sign-in email address.
- The application is publicly reachable for users to access the UI.

## Assumptions

- Users consent to receiving reports at their sign-in email address.
- Research results can be stored for later viewing by the same user.
- A “partial completion” report is acceptable if one provider fails.
