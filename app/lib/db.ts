import { Pool } from 'pg';
import { getEnv } from './env';

const connectionString = getEnv('DATABASE_URL');
const globalForPool = globalThis as unknown as { pool?: Pool };

export const pool: Pool | null =
  globalForPool.pool ??
  (connectionString
    ? new Pool({
        connectionString
      })
    : null);

if (!globalForPool.pool && pool) {
  globalForPool.pool = pool;
}

if (pool) {
  // Prevent idle connection errors from surfacing as uncaught exceptions.
  const poolWithEvents = pool as unknown as { on: (event: string, listener: (error: unknown) => void) => void };
  poolWithEvents.on('error', (error: unknown) => {
    console.error('[db.pool_error]', error);
  });
}

function summarizeParam(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `array(len=${value.length})`;
  if (typeof value === 'object') return `object(${Object.prototype.toString.call(value)})`;
  if (typeof value === 'string') return `string(len=${value.length})`;
  return typeof value;
}

export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  if (!pool) {
    throw new Error('DATABASE_URL is not set');
  }
  try {
    const result = await pool.query<T>(text, params);
    return result.rows;
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : null;
    const message = error instanceof Error ? error.message : String(error);
    if ((code === '22P02' || code === '22023' || message.toLowerCase().includes('type json')) && process.env.NODE_ENV !== 'production') {
      const compactSql = text.replace(/\s+/g, ' ').trim().slice(0, 240);
      const detail = typeof error === 'object' && error && 'detail' in error ? String((error as { detail?: unknown }).detail ?? '') : '';
      const hint = typeof error === 'object' && error && 'hint' in error ? String((error as { hint?: unknown }).hint ?? '') : '';
      console.error(
        '[db.json_error]',
        JSON.stringify({
          code,
          message,
          detail: detail || null,
          hint: hint || null,
          sql: compactSql,
          paramTypes: (params ?? []).map((p) => summarizeParam(p))
        })
      );
    }
    throw error;
  }
}
