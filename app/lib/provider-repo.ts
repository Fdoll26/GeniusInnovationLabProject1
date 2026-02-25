import { query } from './db';

export type ProviderResultRecord = {
  id: string;
  session_id: string;
  model_run_id?: string | null;
  provider: string;
  status: string;
  output_text: string | null;
  sources_json: unknown | null;
  queued_at?: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  external_id?: string | null;
  external_status?: string | null;
  last_polled_at?: string | null;
};

export async function upsertProviderResult(params: {
  sessionId: string;
  modelRunId?: string | null;
  provider: 'openai' | 'gemini';
  status: string;
  outputText?: string | null;
  sources?: unknown | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  queuedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  externalId?: string | null;
  externalStatus?: string | null;
  lastPolledAt?: string | null;
}) {
  try {
    const rows = await query<{ id: string }>(
      `INSERT INTO provider_results
       (session_id, model_run_id, provider, status, output_text, sources_json, error_code, error_message, queued_at, started_at, completed_at, external_id, external_status, last_polled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (session_id, provider)
       DO UPDATE SET
         model_run_id = COALESCE(EXCLUDED.model_run_id, provider_results.model_run_id),
         status = EXCLUDED.status,
         output_text = COALESCE(EXCLUDED.output_text, provider_results.output_text),
         sources_json = COALESCE(EXCLUDED.sources_json, provider_results.sources_json),
         error_code = COALESCE(EXCLUDED.error_code, provider_results.error_code),
         error_message = COALESCE(EXCLUDED.error_message, provider_results.error_message),
         queued_at = COALESCE(EXCLUDED.queued_at, provider_results.queued_at),
         started_at = COALESCE(EXCLUDED.started_at, provider_results.started_at),
         completed_at = COALESCE(EXCLUDED.completed_at, provider_results.completed_at),
         external_id = COALESCE(EXCLUDED.external_id, provider_results.external_id),
         external_status = COALESCE(EXCLUDED.external_status, provider_results.external_status),
         last_polled_at = COALESCE(EXCLUDED.last_polled_at, provider_results.last_polled_at)
       WHERE EXCLUDED.model_run_id IS NULL
         OR provider_results.model_run_id IS NULL
         OR provider_results.model_run_id = EXCLUDED.model_run_id
       RETURNING id`,
      [
        params.sessionId,
        params.modelRunId ?? null,
        params.provider,
        params.status,
        params.outputText ?? null,
        params.sources ?? null,
        params.errorCode ?? null,
        params.errorMessage ?? null,
        params.queuedAt ?? null,
        params.startedAt ?? null,
        params.completedAt ?? null,
        params.externalId ?? null,
        params.externalStatus ?? null,
        params.lastPolledAt ?? null
      ]
    );
    if (!rows[0]) {
      throw new Error(
        `Provider result write blocked: model_run_id mismatch for ${params.provider} session ${params.sessionId}`
      );
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const lower = msg.toLowerCase();
    if (
      (lower.includes('external_id') && lower.includes('does not exist')) ||
      (lower.includes('model_run_id') && lower.includes('does not exist'))
    ) {
      await query(
        `INSERT INTO provider_results
         (session_id, provider, status, output_text, sources_json, error_code, error_message, queued_at, started_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (session_id, provider)
         DO UPDATE SET
           status = EXCLUDED.status,
           output_text = COALESCE(EXCLUDED.output_text, provider_results.output_text),
           sources_json = COALESCE(EXCLUDED.sources_json, provider_results.sources_json),
           error_code = COALESCE(EXCLUDED.error_code, provider_results.error_code),
           error_message = COALESCE(EXCLUDED.error_message, provider_results.error_message),
           queued_at = COALESCE(EXCLUDED.queued_at, provider_results.queued_at),
           started_at = COALESCE(EXCLUDED.started_at, provider_results.started_at),
           completed_at = COALESCE(EXCLUDED.completed_at, provider_results.completed_at)`,
        [
          params.sessionId,
          params.provider,
          params.status,
          params.outputText ?? null,
          params.sources ?? null,
          params.errorCode ?? null,
          params.errorMessage ?? null,
          params.queuedAt ?? null,
          params.startedAt ?? null,
          params.completedAt ?? null
        ]
      );
      return;
    }
    throw error;
  }
}

export async function listProviderResults(sessionId: string): Promise<ProviderResultRecord[]> {
  return query<ProviderResultRecord>(
    'SELECT * FROM provider_results WHERE session_id = $1 ORDER BY provider',
    [sessionId]
  );
}

export async function getRunningProviderResult(provider: 'openai' | 'gemini'): Promise<ProviderResultRecord | null> {
  const rows = await query<ProviderResultRecord>(
    `SELECT *
     FROM provider_results
     WHERE provider = $1
       AND status = 'running'
     ORDER BY started_at ASC NULLS LAST, id ASC
     LIMIT 1`,
    [provider]
  );
  return rows[0] ?? null;
}

export async function getNextQueuedProviderResult(provider: 'openai' | 'gemini'): Promise<ProviderResultRecord | null> {
  const rows = await query<ProviderResultRecord>(
    `SELECT *
     FROM provider_results
     WHERE provider = $1
       AND status = 'queued'
     ORDER BY queued_at ASC NULLS FIRST, id ASC
     LIMIT 1`,
    [provider]
  );
  return rows[0] ?? null;
}
