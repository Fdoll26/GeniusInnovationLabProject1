# Quickstart: Multi-API Research

## Prerequisites

- Node.js LTS
- PostgreSQL instance
- Google OAuth credentials
- OpenAI and Gemini API keys
- SendGrid API key

## Environment

Create `.env.local` from `.env.example` and set:

- `DATABASE_URL`
- `NEXTAUTH_URL`
- `NEXTAUTH_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `SENDGRID_API_KEY`
- `EMAIL_FROM`

## Run

1. Install dependencies
2. Run database migrations
3. Start dev server

## Minimal Flow

1. Sign in with Google on Home.
2. Submit a research topic; status transitions to refining.
3. Answer refinement questions one at a time; approve refined prompt.
4. Session runs OpenAI then Gemini, aggregates results, and completes.
5. PDF report is emailed when the session reaches a terminal state.
6. View prior sessions and details in History.
