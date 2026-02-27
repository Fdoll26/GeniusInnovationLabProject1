// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const listProviderResults = vi.fn();
const upsertProviderResult = vi.fn(async () => undefined);
const getRunningProviderResult = vi.fn(async () => null);
const getNextQueuedProviderResult = vi.fn();

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
    theme: 'light',
    research_provider: 'openai',
    research_mode: 'custom',
    research_depth: 'standard',
    research_max_steps: 8,
    research_target_sources_per_step: 5,
    research_max_total_sources: 40,
    research_max_tokens_per_step: 1800
  }))
}));
vi.mock('../../app/lib/provider-repo', () => ({
  listProviderResults: (...args: any[]) => listProviderResults(...args),
  upsertProviderResult: (...args: any[]) => upsertProviderResult(...args),
  getRunningProviderResult: (...args: any[]) => getRunningProviderResult(...args),
  getNextQueuedProviderResult: (...args: any[]) => getNextQueuedProviderResult(...args)
}));
vi.mock('../../app/lib/openai-client', () => ({
  getResponseOutputText: vi.fn(() => ''),
  getResponseSources: vi.fn(() => null),
  pollDeepResearch: vi.fn(async () => ({ status: 'completed', data: {} })),
  startResearchJob: vi.fn(async () => ({ responseId: 'r1', status: 'in_progress', data: {} })),
  startRefinement: vi.fn(async () => ({ questions: [] })),
  rewritePrompt: vi.fn(async () => 'rewritten'),
  summarizeForReport: vi.fn(async () => 'summary'),
  generateModelComparisonOpenAI: vi.fn(async () => 'comparison')
}));
vi.mock('../../app/lib/gemini-client', () => ({
  runGemini: vi.fn(async () => ({ outputText: 'gemini', sources: null })),
  rewritePromptGemini: vi.fn(async () => 'rewritten'),
  startRefinementGemini: vi.fn(async () => ({ questions: [] })),
  summarizeForReportGemini: vi.fn(async () => 'summary'),
  generateModelComparisonGemini: vi.fn(async () => 'comparison')
}));

import { runProviders } from '../../app/lib/orchestration';
import { startResearchJob } from '../../app/lib/openai-client';
import { runGemini } from '../../app/lib/gemini-client';

describe('runProviders', () => {
  it('does not treat queued provider results as a hard stop', async () => {
    listProviderResults.mockResolvedValue([]);
    let returnedOpenAi = false;
    let returnedGemini = false;
    getNextQueuedProviderResult.mockImplementation(async (provider: 'openai' | 'gemini') => {
      if (provider === 'openai' && !returnedOpenAi) {
        returnedOpenAi = true;
        return { session_id: 's1', provider: 'openai', status: 'queued' };
      }
      if (provider === 'gemini' && !returnedGemini) {
        returnedGemini = true;
        return { session_id: 's1', provider: 'gemini', status: 'queued' };
      }
      return null;
    });

    await runProviders('s1');

    expect(startResearchJob).toHaveBeenCalled();
    expect(runGemini).toHaveBeenCalled();
  });
});
