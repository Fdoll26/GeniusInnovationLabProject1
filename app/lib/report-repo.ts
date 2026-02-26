import { query } from './db';

export type ReportRecord = {
  id: string;
  session_id: string;
  summary_text: string;
  pdf_bytes: Buffer | null;
  email_status: string;
  sent_at: string | null;
  email_error: string | null;
  created_at: string;
};

export type RecentSentReport = {
  session_id: string;
  topic: string;
  state: string;
  sent_at: string;
};

export async function createReport(params: {
  sessionId: string;
  summary: string;
  pdfBuffer: Buffer | null;
  emailStatus: 'pending' | 'sent' | 'failed';
  sentAt?: string | null;
  emailError?: string | null;
}) {
  const rows = await query<ReportRecord>(
    `INSERT INTO reports (session_id, summary_text, pdf_bytes, email_status, sent_at, email_error)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      params.sessionId,
      params.summary,
      params.pdfBuffer,
      params.emailStatus,
      params.sentAt ?? null,
      params.emailError ?? null
    ]
  );
  return rows[0];
}

export async function updateReportEmail(params: {
  reportId: string;
  emailStatus: 'sent' | 'failed';
  sentAt?: string | null;
  emailError?: string | null;
}) {
  await query(
    `UPDATE reports
     SET email_status = $2,
         sent_at = $3,
         email_error = $4
     WHERE id = $1`,
    [params.reportId, params.emailStatus, params.sentAt ?? null, params.emailError ?? null]
  );
}

export async function updateReportContent(params: {
  reportId: string;
  summary: string;
  pdfBuffer: Buffer | null;
}) {
  const rows = await query<ReportRecord>(
    `UPDATE reports
     SET summary_text = $2,
         pdf_bytes = $3
     WHERE id = $1
     RETURNING *`,
    [params.reportId, params.summary, params.pdfBuffer]
  );
  return rows[0] ?? null;
}

export async function claimReportSendForSession(sessionId: string): Promise<string | null> {
  const rows = await query<{ id: string }>(
    `WITH candidate AS (
       SELECT id
       FROM reports
       WHERE session_id = $1
         AND email_status IN ('pending','failed')
       ORDER BY created_at DESC
       LIMIT 1
     ),
     updated AS (
       UPDATE reports
       SET email_status = 'sending'
       WHERE id = (SELECT id FROM candidate)
         AND NOT EXISTS (
           SELECT 1 FROM reports WHERE session_id = $1 AND email_status IN ('sent', 'sending')
         )
       RETURNING id
     )
     SELECT id FROM updated`,
    [sessionId]
  );
  return rows[0]?.id ?? null;
}

export async function getReportBySession(sessionId: string): Promise<ReportRecord | null> {
  const rows = await query<ReportRecord>(
    'SELECT * FROM reports WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1',
    [sessionId]
  );
  return rows[0] ?? null;
}

export async function listRecentSentReports(userId: string, limit = 5): Promise<RecentSentReport[]> {
  const effectiveLimit = Math.max(1, Math.min(limit, 20));
  // Take the most recent *sent* report per session, then return the newest overall by sent_at.
  const rows = await query<RecentSentReport>(
    `SELECT *
     FROM (
       SELECT DISTINCT ON (r.session_id)
         r.session_id,
         s.topic,
         s.state,
         r.sent_at
       FROM reports r
       JOIN research_sessions s ON s.id = r.session_id
       WHERE s.user_id = $1
         AND r.email_status = 'sent'
         AND r.sent_at IS NOT NULL
       ORDER BY r.session_id, r.sent_at DESC
     ) t
     ORDER BY t.sent_at DESC
     LIMIT $2`,
    [userId, effectiveLimit]
  );
  return rows;
}

export async function recordReportTiming(params: {
  sessionId: string;
  completedAt: string;
}) {
  await query(
    `UPDATE research_sessions
     SET completed_at = $2,
         updated_at = now()
     WHERE id = $1`,
    [params.sessionId, params.completedAt]
  );
}

export async function checkReportTiming(sessionId: string, maxMinutes = 15) {
  const rows = await query<{ refined_at: string | null; completed_at: string | null }>(
    'SELECT refined_at, completed_at FROM research_sessions WHERE id = $1',
    [sessionId]
  );
  const record = rows[0];
  if (!record?.refined_at || !record?.completed_at) {
    return null;
  }
  const refinedAt = new Date(record.refined_at).getTime();
  const completedAt = new Date(record.completed_at).getTime();
  const durationMinutes = (completedAt - refinedAt) / 60000;
  return { durationMinutes, withinBudget: durationMinutes <= maxMinutes };
}
