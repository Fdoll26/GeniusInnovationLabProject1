# API & Dependency Setup

This app needs PostgreSQL plus (optionally) credentials for Google OAuth, OpenAI, Gemini, and SendGrid. All configuration is via `.env.local` (see `.env.example`).

## PostgreSQL (Required)

1. Create a database and user (or use an existing one).
2. Set `DATABASE_URL` in `.env.local`.
3. Initialize schema:

```bash
psql "$DATABASE_URL" -f db/init.sql
```

Optional dev seed:

```bash
psql "$DATABASE_URL" -f db/seed/seed.sql
```

## NextAuth (Required for real sign-in)

Set:
- `NEXTAUTH_URL` (e.g. `http://localhost:3000`)
- `NEXTAUTH_SECRET` (any long random string)

## Google OAuth (Required unless using `DEV_BYPASS_AUTH=true`)

Create OAuth credentials for a “Web application” and set:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

For local dev, the callback must be allowed:
- Authorized redirect URI: `http://localhost:3000/api/auth/callback/google`

## OpenAI (Required unless stubbing/skipping OpenAI)

Set:
- `OPENAI_API_KEY`

Optional:
- `OPENAI_API_BASE` (defaults to `https://api.openai.com/v1`)
- `OPENAI_REFINER_MODEL` (refinement)
- `OPENAI_SUMMARY_MODEL` (report summaries)
- `OPENAI_DEEP_RESEARCH_MODEL` + `OPENAI_DEEP_RESEARCH_FALLBACK_MODEL`
- Reliability tuning: `OPENAI_*_TIMEOUT_MS`, `OPENAI_FETCH_RETRIES`, `OPENAI_FETCH_RETRY_BASE_DELAY_MS`
- Concurrency tuning: `OPENAI_DEEP_RESEARCH_CONCURRENCY`

Note: Deep Research calls require tools to be enabled in the request (the code uses a web search tool where available).

## Gemini (Required unless stubbing/skipping Gemini)

Set:
- `GEMINI_API_KEY`

Optional:
- `GEMINI_API_BASE` (defaults to `https://generativelanguage.googleapis.com/v1beta`)
- `GEMINI_MODEL` (legacy fallback; defaults to `gemini-2.5-pro`)
- `GEMINI_DEEP_MODEL` (deep/synthesis steps; defaults to `GEMINI_MODEL`)
- `GEMINI_FAST_MODEL` (fast/scout steps; defaults to `gemini-2.0-flash`)
- `GEMINI_SUBCALL_MODEL` (fan-out subcalls; defaults to `GEMINI_FAST_MODEL`)

## SendGrid (Required unless stubbing email)

Set:
- `SENDGRID_API_KEY`
- `EMAIL_FROM` (must be a verified sender identity in your SendGrid account)

## Local Dev Without External APIs

To run most flows without real provider credentials:
- `DEV_BYPASS_AUTH=true`
- `DEV_STUB_EXTERNALS=true`

You still need PostgreSQL (`DATABASE_URL`) for persistence.
