// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Provider = 'openai' | 'gemini';

const runByTopicProvider: Record<string, string> = {
  'topic-a:openai': 'run-a-openai',
  'topic-a:gemini': 'run-a-gemini',
  'topic-b:openai': 'run-b-openai',
  'topic-b:gemini': 'run-b-gemini'
};

const providerRows = new Map<string, any>();
const providerKey = (sessionId: string, provider: Provider) => `${sessionId}:${provider}`;

const listProviderResults = vi.fn(async (sessionId: string) => {
  return [...providerRows.values()].filter((row) => row.session_id === sessionId);
});
const upsertProviderResult = vi.fn(async (params: any) => {
  const key = providerKey(params.sessionId, params.provider);
  const prev = providerRows.get(key) ?? null;
  if (prev && prev.model_run_id && params.modelRunId && prev.model_run_id !== params.modelRunId) {
    throw new Error(`Provider result write blocked: model_run_id mismatch for ${params.provider} session ${params.sessionId}`);
  }
  providerRows.set(key, {
    id: key,
    session_id: params.sessionId,
    model_run_id: params.modelRunId ?? prev?.model_run_id ?? null,
    provider: params.provider,
    status: params.status,
    output_text: params.outputText ?? prev?.output_text ?? null,
    sources_json: params.sources ?? prev?.sources_json ?? null,
    started_at: params.startedAt ?? prev?.started_at ?? null,
    completed_at: params.completedAt ?? prev?.completed_at ?? null,
    error_message: params.errorMessage ?? prev?.error_message ?? null,
    last_polled_at: params.lastPolledAt ?? prev?.last_polled_at ?? null
  });
});
const getRunningProviderResult = vi.fn(async (provider: Provider) => {
  return [...providerRows.values()].find((row) => row.provider === provider && row.status === 'running') ?? null;
});
const getNextQueuedProviderResult = vi.fn(async (provider: Provider) => {
  return [...providerRows.values()].find((row) => row.provider === provider && row.status === 'queued') ?? null;
});

const tick = vi.fn(async () => ({ state: 'DONE', done: true }));
const getSessionResearchSnapshotByProvider = vi.fn(async (sessionId: string, provider: Provider) => {
  const runId = runByTopicProvider[`${sessionId}:${provider}`];
  return {
    run: {
      id: runId,
      session_id: sessionId,
      provider,
      state: 'IN_PROGRESS',
      progress_json: { step_id: 'DISCOVER_SOURCES_WITH_PLAN' }
    },
    steps: [],
    sources: [],
    evidence: []
  };
});
const getResearchSnapshotByRunId = vi.fn(async (runId: string) => {
  const matched = Object.entries(runByTopicProvider).find(([, v]) => v === runId);
  if (!matched) return null;
  const [key] = matched;
  const [sessionId, provider] = key.split(':');
  return {
    run: {
      id: runId,
      session_id: sessionId,
      provider,
      progress_json: { step_id: 'DISCOVER_SOURCES_WITH_PLAN' },
      synthesized_report_md: `${provider} report`,
      error_message: null
    },
    steps: [],
    sources: [{ url: `https://example.com/${provider}` }],
    evidence: []
  };
});

vi.mock('../../app/lib/session-repo', () => ({
  getSessionById: vi.fn(async (sessionId: string) => ({
    id: sessionId,
    user_id: 'u1',
    refined_prompt: `Prompt for ${sessionId}`,
    topic: sessionId,
    state: 'running_research'
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

vi.mock('../../app/lib/research-orchestrator', () => ({
  getSessionResearchSnapshot: vi.fn(async () => null),
  getSessionResearchSnapshotByProvider: (...args: any[]) => getSessionResearchSnapshotByProvider(...args),
  getResearchSnapshotByRunId: (...args: any[]) => getResearchSnapshotByRunId(...args),
  startRun: vi.fn(),
  tick: (...args: any[]) => tick(...args)
}));

vi.mock('../../app/lib/research-run-repo', () => ({
  updateResearchRun: vi.fn(async () => undefined)
}));

vi.mock('../../app/lib/openai-client', () => ({
  getResponseOutputText: vi.fn(() => ''),
  getResponseSources: vi.fn(() => null),
  pollDeepResearch: vi.fn(async () => ({ status: 'completed', data: {} })),
  startResearchJob: vi.fn(async () => ({ responseId: 'r1', status: 'in_progress', data: {} })),
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

vi.mock('../../app/lib/report-repo', () => ({
  claimReportSendForSession: vi.fn(async () => true),
  createReport: vi.fn(async () => ({ id: 'r1', summary_text: 'summary' })),
  getReportBySession: vi.fn(async () => null),
  updateReportContent: vi.fn(async () => undefined),
  updateReportEmail: vi.fn(async () => undefined),
  checkReportTiming: vi.fn(async () => undefined)
}));

vi.mock('../../app/lib/pdf-report', () => ({
  buildPdfReport: vi.fn(async () => new Uint8Array([1, 2, 3]))
}));

vi.mock('../../app/lib/email-sender', () => ({
  sendReportEmail: vi.fn(async () => undefined)
}));

vi.mock('../../app/lib/db', () => ({
  pool: null,
  query: vi.fn(async () => [{ email: 'user@example.com' }])
}));

import { runProviders } from '../../app/lib/orchestration';

describe('deep research provider isolation', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    providerRows.clear();
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://example/test';
  });

  it('keeps OpenAI and Gemini model runs isolated across concurrent topics', async () => {
    for (let i = 0; i < 3; i += 1) {
      await Promise.all([
        runProviders('topic-a'),
        runProviders('topic-b')
      ]);
    }

    const tickRunIds = tick.mock.calls.map((call) => call[0]);
    expect(tickRunIds).toContain('run-a-openai');
    expect(tickRunIds).toContain('run-a-gemini');
    expect(tickRunIds).toContain('run-b-openai');
    expect(tickRunIds).toContain('run-b-gemini');

    const writes = upsertProviderResult.mock.calls.map((call) => call[0]);
    expect(
      writes.some(
        (write) =>
          write.provider === 'openai' &&
          typeof write.modelRunId === 'string' &&
          write.modelRunId.includes('gemini')
      )
    ).toBe(false);
    expect(
      writes.some(
        (write) =>
          write.provider === 'gemini' &&
          typeof write.modelRunId === 'string' &&
          write.modelRunId.includes('openai')
      )
    ).toBe(false);
  });

  afterAll(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
  });
});
