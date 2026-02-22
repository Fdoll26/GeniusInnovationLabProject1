import { query } from './db';
import type { SessionState } from './session-state';

export type ResearchSessionRecord = {
  id: string;
  user_id: string;
  topic: string;
  refined_prompt: string | null;
  state: SessionState;
  created_at: string;
  updated_at: string;
  refined_at: string | null;
  completed_at: string | null;
};

export async function getUserIdByEmail(email: string): Promise<string> {
  const rows = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  if (!rows[0]) {
    throw new Error('User not found');
  }
  return rows[0].id;
}

export async function createSession(params: {
  userId: string;
  topic: string;
  state: SessionState;
}): Promise<ResearchSessionRecord> {
  const start = Date.now();
  const rows = await query<ResearchSessionRecord>(
    `INSERT INTO research_sessions (user_id, topic, state)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [params.userId, params.topic, params.state]
  );
  const durationMs = Date.now() - start;
  console.info(`createSession duration=${durationMs}ms`);
  return rows[0];
}

export async function updateSessionState(params: {
  sessionId: string;
  state: SessionState;
  refinedPrompt?: string | null;
  refinedAt?: string | null;
  completedAt?: string | null;
}) {
  await query(
    `UPDATE research_sessions
     SET state = $2,
         refined_prompt = COALESCE($3, refined_prompt),
         refined_at = COALESCE($4, refined_at),
         completed_at = COALESCE($5, completed_at),
         updated_at = now()
     WHERE id = $1`,
    [
      params.sessionId,
      params.state,
      params.refinedPrompt ?? null,
      params.refinedAt ?? null,
      params.completedAt ?? null
    ]
  );
}

export async function getSessionById(sessionId: string): Promise<ResearchSessionRecord | null> {
  const rows = await query<ResearchSessionRecord>('SELECT * FROM research_sessions WHERE id = $1', [sessionId]);
  return rows[0] ?? null;
}

export async function listSessions(params: {
  userId: string;
  limit?: number;
  offset?: number;
  query?: string;
}): Promise<ResearchSessionRecord[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 10, 50));
  const offset = Math.max(0, params.offset ?? 0);
  const q = params.query?.trim();
  if (!q) {
    return query<ResearchSessionRecord>(
      'SELECT * FROM research_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [params.userId, limit, offset]
    );
  }
  const like = `%${q}%`;
  return query<ResearchSessionRecord>(
    `SELECT *
     FROM research_sessions
     WHERE user_id = $1
       AND (topic ILIKE $2 OR refined_prompt ILIKE $2 OR state ILIKE $2)
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [params.userId, like, limit, offset]
  );
}

export type IncompleteSessionListItem = {
  id: string;
  topic: string;
  state: SessionState;
  updated_at: string;
};

export async function listIncompleteSessions(userId: string, limit = 20): Promise<IncompleteSessionListItem[]> {
  const effectiveLimit = Math.max(1, Math.min(limit, 50));
  return query<IncompleteSessionListItem>(
    `SELECT id, topic, state, updated_at
     FROM research_sessions
     WHERE user_id = $1
       AND state IN ('draft','refining')
     ORDER BY updated_at DESC
     LIMIT $2`,
    [userId, effectiveLimit]
  );
}

export type RecentResultSessionListItem = {
  id: string;
  topic: string;
  state: SessionState;
  updated_at: string;
};

export async function listRecentResultSessions(userId: string, limit = 5): Promise<RecentResultSessionListItem[]> {
  const effectiveLimit = Math.max(1, Math.min(limit, 20));
  return query<RecentResultSessionListItem>(
    `SELECT id, topic, state, updated_at
     FROM research_sessions
     WHERE user_id = $1
       AND state IN ('completed','partial','failed')
     ORDER BY updated_at DESC
     LIMIT $2`,
    [userId, effectiveLimit]
  );
}

export async function assertSessionOwnership(sessionId: string, userId: string) {
  const rows = await query<{ id: string }>(
    'SELECT id FROM research_sessions WHERE id = $1 AND user_id = $2',
    [sessionId, userId]
  );
  if (!rows[0]) {
    throw new Error('Forbidden');
  }
}

export async function deleteSessionById(userId: string, sessionId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM research_sessions
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [sessionId, userId]
  );
  return Boolean(rows[0]?.id);
}
