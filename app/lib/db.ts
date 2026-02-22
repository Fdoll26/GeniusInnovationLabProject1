import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
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

export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  if (!pool) {
    throw new Error('DATABASE_URL is not set');
  }
  const result = await pool.query<T>(text, params);
  return result.rows;
}
