// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const listProviderResults = vi.fn();
const upsertProviderResult = vi.fn(async () => undefined);

vi.mock('../../app/lib/session-repo', () => ({
  getSessionById: vi.fn(async () => ({ id: 's1', user_id: 'u1', refined_prompt: 'Prompt', state: 'running_research' })),
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
  resumeDeepResearch: vi.fn(async () => ({ outputText: 'resumed', sources: null, responseId: 'r1' })),
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

import { runProviders } from '../../app/lib/orchestration';
import { runResearch } from '../../app/lib/openai-client';
import { runGemini } from '../../app/lib/gemini-client';

describe('runProviders', () => {
  it('does not treat queued provider results as a hard stop', async () => {
    listProviderResults.mockImplementation(async () => [
      { provider: 'openai', status: 'queued', external_id: null },
      { provider: 'gemini', status: 'queued' }
    ]);

    await runProviders('s1');

    expect(runResearch).toHaveBeenCalled();
    expect(runGemini).toHaveBeenCalled();
  });
});

