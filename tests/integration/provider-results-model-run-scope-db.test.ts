// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

function pgCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

describeDb('provider_results model_run_id scoped foreign key', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('rejects model_run_id values that do not match session_id/provider scope', async () => {
    const client = await pool.connect();
    try {
      const constraintRows = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_constraint
           WHERE conname = 'provider_results_model_run_scope_fkey'
         ) AS exists`
      );
      expect(constraintRows.rows[0]?.exists).toBe(true);

      await client.query('BEGIN');
      const seed = Date.now().toString(36);

      const user = await client.query<{ id: string }>(
        `INSERT INTO users (email, name)
         VALUES ($1, $2)
         RETURNING id`,
        [`scope-fk-${seed}@example.test`, 'scope-fk-user']
      );
      const userId = user.rows[0]!.id;

      const s1 = await client.query<{ id: string }>(
        `INSERT INTO research_sessions (user_id, topic, state)
         VALUES ($1, $2, 'running_research')
         RETURNING id`,
        [userId, 'Scoped FK Topic A']
      );
      const s2 = await client.query<{ id: string }>(
        `INSERT INTO research_sessions (user_id, topic, state)
         VALUES ($1, $2, 'running_research')
         RETURNING id`,
        [userId, 'Scoped FK Topic B']
      );
      const sessionA = s1.rows[0]!.id;
      const sessionB = s2.rows[0]!.id;

      const openAiRunA = await insertRun(client, sessionA, 'openai', `OpenAI run A ${seed}`);
      const geminiRunA = await insertRun(client, sessionA, 'gemini', `Gemini run A ${seed}`);
      const openAiRunB = await insertRun(client, sessionB, 'openai', `OpenAI run B ${seed}`);

      await client.query(
        `INSERT INTO provider_results (session_id, provider, status, model_run_id)
         VALUES ($1, 'openai', 'queued', $2)`,
        [sessionA, openAiRunA]
      );

      await expectScopeViolation(async () => {
        await client.query(
          `UPDATE provider_results
           SET model_run_id = $1
           WHERE session_id = $2
             AND provider = 'openai'`,
          [geminiRunA, sessionA]
        );
      });

      await expectScopeViolation(async () => {
        await client.query(
          `UPDATE provider_results
           SET model_run_id = $1
           WHERE session_id = $2
             AND provider = 'openai'`,
          [openAiRunB, sessionA]
        );
      });
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        // no-op
      }
      client.release();
    }
  });
});

async function insertRun(
  client: PoolClient,
  sessionId: string,
  provider: 'openai' | 'gemini',
  question: string
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO research_runs (session_id, provider, mode, depth, question, state)
     VALUES ($1, $2, 'custom', 'standard', $3, 'PLANNED')
     RETURNING id`,
    [sessionId, provider, question]
  );
  return result.rows[0]!.id;
}

async function expectScopeViolation(fn: () => Promise<unknown>) {
  try {
    await fn();
    throw new Error('Expected scoped foreign key violation');
  } catch (error) {
    expect(pgCode(error)).toBe('23503');
  }
}
