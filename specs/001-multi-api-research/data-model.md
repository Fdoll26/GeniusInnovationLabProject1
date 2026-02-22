# Data Model: Multi-API Research

## Entities

### User
- **id** (uuid, pk)
- **email** (string, unique, required)
- **name** (string, optional)
- **image_url** (string, optional)
- **created_at** (timestamp)
- **updated_at** (timestamp)

**Relationships**
- 1 User → many ResearchSessions

### ResearchSession
- **id** (uuid, pk)
- **user_id** (uuid, fk → User.id, required)
- **topic** (string, required)
- **refined_prompt** (text, optional until approved)
- **state** (enum, required)
- **created_at** (timestamp)
- **updated_at** (timestamp)
- **refined_at** (timestamp, optional)
- **completed_at** (timestamp, optional)

**State enum**
- draft
- refining
- running_openai
- running_gemini
- aggregating
- completed
- partial
- failed

**Relationships**
- 1 ResearchSession → many RefinementQuestions
- 1 ResearchSession → many ProviderResults
- 1 ResearchSession → 1 Report (optional until generated)

### RefinementQuestion
- **id** (uuid, pk)
- **session_id** (uuid, fk → ResearchSession.id, required)
- **sequence** (int, required)
- **question_text** (text, required)
- **answer_text** (text, optional)
- **answered_at** (timestamp, optional)
- **is_complete** (boolean, required, default false)

**Validation rules**
- sequence must be unique per session
- is_complete true only when answer_text present

### ProviderResult
- **id** (uuid, pk)
- **session_id** (uuid, fk → ResearchSession.id, required)
- **provider** (enum: openai, gemini)
- **status** (enum: pending, running, completed, failed)
- **output_text** (text, optional)
- **sources_json** (jsonb, optional)
- **started_at** (timestamp, optional)
- **completed_at** (timestamp, optional)
- **error_code** (string, optional)
- **error_message** (text, optional)

**Validation rules**
- provider unique per session

### Report
- **id** (uuid, pk)
- **session_id** (uuid, fk → ResearchSession.id, required)
- **summary_text** (text, required)
- **pdf_bytes** (bytea, optional)
- **email_status** (enum: pending, sent, failed)
- **sent_at** (timestamp, optional)
- **email_error** (text, optional)
- **created_at** (timestamp)

## State Transitions (ResearchSession)

- draft → refining (topic submitted)
- refining → running_openai (refined prompt approved)
- running_openai → running_gemini (OpenAI results ready)
- running_gemini → aggregating (Gemini results ready)
- aggregating → completed (report generated + email sent)
- any → partial (one provider fails, report generated + email sent)
- any → failed (both providers fail or fatal error)
