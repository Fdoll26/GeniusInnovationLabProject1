# Phase 0 Research: Multi-API Research

## Decision: Authentication via NextAuth Google Provider
**Rationale**: Matches requirement for Google sign-in, minimal setup in a
Next.js app, and consistent session handling.
**Alternatives considered**: Custom OAuth flow, Auth0.

## Decision: Email Delivery via SendGrid
**Rationale**: Simple API for transactional email, reliable deliverability, and
lightweight integration for sending PDF attachments.
**Alternatives considered**: Mailgun, Gmail API.

## Decision: PDF Generation via pdf-lib (buffer output)
**Rationale**: Pure JS library that can generate PDFs in-memory and return a
buffer without external binaries.
**Alternatives considered**: pdfkit, pdfmake.

## Decision: Orchestration via Server Actions + Route Handlers + Polling
**Rationale**: Keeps minimal dependencies while allowing background-ish
processing driven by client polling and server-side status updates.
**Alternatives considered**: Dedicated job queue, cron-based workers.

## Decision: Data Model Normalization (Session + Questions + Results + Report)
**Rationale**: Clean history tracking, clear status separation, and easy retries
without bloating single records.
**Alternatives considered**: Single session record with embedded fields.
