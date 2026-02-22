// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const listProviderResults = vi.fn();
const upsertProviderResult = vi.fn(async () => undefined);

vi.mock('../../app/lib/session-repo', () => ({
  getSessionById: vi.fn(async () => ({
    id: 's1',
    user_id: 'u1',
    refined_prompt: 'Prompt',
    state: 'running_research',
    updated_at: '2026-02-22T00:00:00.000Z',
    created_at: '2026-02-21T00:00:00.000Z'
  })),
  updateSessionState: vi.fn(async () => undefined)
}));

vi.mock('../../app/lib/user-settings-repo', () => ({
  getUserSettings: vi.fn(async () => ({
    user_id: 'u1',
    refine_provider: 'openai',
    summarize_provider: 'openai',
    max_sources: 5,
    openai_timeout_minutes: 1,
    gemini_timeout_minutes: 1,
    reasoning_level: 'low',
    report_summary_mode: 'two',
    report_include_refs_in_summary: true,
    theme: 'light'
  }))
}));

vi.mock('../../app/lib/provider-repo', () => ({
  listProviderResults: (...args: any[]) => listProviderResults(...args),
  upsertProviderResult: (...args: any[]) => upsertProviderResult(...args)
}));

vi.mock('../../app/lib/openai-client', () => ({
  getResponseOutputText: vi.fn(() => ''),
  getResponseSources: vi.fn(() => null),
  pollDeepResearch: vi.fn(async () => ({ status: 'completed', data: {} })),
  runResearch: vi.fn(async () => ({ outputText: 'openai', sources: null, responseId: 'r1' })),
  startRefinement: vi.fn(async () => ({ questions: [] })),
  rewritePrompt: vi.fn(async () => 'rewritten'),
  summarizeForReport: vi.fn(async () => 'summary')
}));

vi.mock('../../app/lib/gemini-client', () => ({
  runGemini: vi.fn(async () => ({ outputText: 'gemini', sources: null })),
  rewritePromptGemini: vi.fn(async () => 'rewritten'),
  startRefinementGemini: vi.fn(async () => ({ questions: [] })),
  summarizeForReportGemini: vi.fn(async () => 'summary')
}));

import { syncSession } from '../../app/lib/orchestration';

describe('syncSession', () => {
  it('marks long-queued provider results as failed', async () => {
    const realNow = Date.now;
    Date.now = () => new Date('2026-02-22T00:30:00.000Z').getTime();
    try {
      listProviderResults.mockResolvedValueOnce([
        { provider: 'openai', status: 'queued', started_at: null, last_polled_at: '2026-02-22T00:00:00.000Z' },
        { provider: 'gemini', status: 'queued', started_at: null, last_polled_at: '2026-02-22T00:00:00.000Z' }
      ]);
      listProviderResults.mockResolvedValueOnce([
        { provider: 'openai', status: 'queued', started_at: null, last_polled_at: '2026-02-22T00:00:00.000Z' },
        { provider: 'gemini', status: 'queued', started_at: null, last_polled_at: '2026-02-22T00:00:00.000Z' }
      ]);

      await syncSession('s1');

      expect(upsertProviderResult).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai', status: 'failed' })
      );
      expect(upsertProviderResult).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'gemini', status: 'failed' })
      );
    } finally {
      Date.now = realNow;
    }
  });
});
