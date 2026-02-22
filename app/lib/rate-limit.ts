import { query } from './db';

const windowSeconds = process.env.RATE_LIMIT_WINDOW_SECONDS
  ? Number(process.env.RATE_LIMIT_WINDOW_SECONDS)
  : 60;
const maxRequests = process.env.RATE_LIMIT_MAX_REQUESTS
  ? Number(process.env.RATE_LIMIT_MAX_REQUESTS)
  : 10;

export async function checkRateLimit(params: {
  userId: string;
  action: string;
  windowSeconds?: number;
  maxRequests?: number;
}) {
  const window = params.windowSeconds ?? windowSeconds;
  const limit = params.maxRequests ?? maxRequests;
  if (!Number.isFinite(window) || !Number.isFinite(limit)) {
    return;
  }
  const rows = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM rate_limits
     WHERE user_id = $1
       AND action = $2
       AND created_at > now() - ($3 || ' seconds')::interval`,
    [params.userId, params.action, window]
  );
  const count = rows[0]?.count ?? 0;
  if (count >= limit) {
    throw new Error('Rate limit exceeded');
  }
  await query(
    `INSERT INTO rate_limits (user_id, action)
     VALUES ($1, $2)`,
    [params.userId, params.action]
  );
}

export async function getRateLimitStatus(params: {
  userId: string;
  action: string;
  windowSeconds?: number;
  maxRequests?: number;
}) {
  const window = params.windowSeconds ?? windowSeconds;
  const limit = params.maxRequests ?? maxRequests;
  if (!Number.isFinite(window) || !Number.isFinite(limit)) {
    return { remaining: limit, limit, resetAt: new Date(Date.now() + 3600_000).toISOString(), windowSeconds: window };
  }
  const rows = await query<{ count: number; oldest: string | null }>(
    `SELECT COUNT(*)::int AS count, MIN(created_at)::text AS oldest
     FROM rate_limits
     WHERE user_id = $1
       AND action = $2
       AND created_at > now() - ($3 || ' seconds')::interval`,
    [params.userId, params.action, window]
  );
  const count = rows[0]?.count ?? 0;
  const oldest = rows[0]?.oldest ? new Date(rows[0].oldest).getTime() : null;
  const resetAtMs = oldest ? oldest + window * 1000 : Date.now() + window * 1000;
  const remaining = Math.max(0, limit - count);
  return { remaining, limit, resetAt: new Date(resetAtMs).toISOString(), windowSeconds: window };
}
