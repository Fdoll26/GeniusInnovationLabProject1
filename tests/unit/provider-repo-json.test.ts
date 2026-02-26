// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../../app/lib/db', () => ({ query: (...args: any[]) => query(...args) }));

import { upsertProviderResult } from '../../app/lib/provider-repo';

afterEach(() => {
  query.mockReset();
});

describe('upsertProviderResult jsonb serialization', () => {
  it('preserves an existing started_at timestamp on conflict updates', async () => {
    query.mockResolvedValueOnce([{ id: 'row-1' }]);

    await upsertProviderResult({
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
      modelRunId: '123e4567-e89b-12d3-a456-426614174111',
      provider: 'openai',
      status: 'running',
      startedAt: '2026-02-26T00:00:00.000Z'
    });

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('started_at = COALESCE(provider_results.started_at, EXCLUDED.started_at)');
  });

  it('serializes array sources as JSON text', async () => {
    query.mockResolvedValueOnce([{ id: 'row-1' }]);

    await upsertProviderResult({
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
      modelRunId: '123e4567-e89b-12d3-a456-426614174111',
      provider: 'openai',
      status: 'running',
      sources: [{ url: 'https://example.com', title: 'Example' }]
    });

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(typeof params[5]).toBe('string');
    expect(params[5]).toBe(JSON.stringify([{ url: 'https://example.com', title: 'Example' }]));
  });

  it('wraps non-JSON string sources as raw payload', async () => {
    query.mockResolvedValueOnce([{ id: 'row-1' }]);

    await upsertProviderResult({
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
      modelRunId: '123e4567-e89b-12d3-a456-426614174111',
      provider: 'openai',
      status: 'failed',
      sources: 'not-json',
      errorMessage: 'bad payload'
    });

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[5]).toBe(JSON.stringify({ raw: 'not-json' }));
  });
});
