// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Provider = 'openai' | 'gemini';

const providerRows = new Map<string, any>();
const runs = new Map<string, any>();
const stepsByRun = new Map<string, any[]>();
let runCounter = 0;

const providerKey = (sessionId: string, provider: Provider) => `${sessionId}:${provider}`;

const listProviderResults = vi.fn(async (sessionId: string) => {
  return [...providerRows.values()].filter((row) => row.session_id === sessionId);
});
const upsertProviderResult = vi.fn(async (params: any) => {
  const key = providerKey(params.sessionId, params.provider);
  const prev = providerRows.get(key) ?? null;
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

const updateSessionState = vi.fn(async () => undefined);
const createReport = vi.fn(async () => ({ id: 'report-1', summary_text: 'summary' }));
const tick = vi.fn(async (runId: string) => {
  const run = runs.get(runId);
  if (run) {
    run.state = 'DONE';
    run.synthesized_report_md = 'OpenAI lane report';
  }
  return { state: 'DONE', done: true as const };
});

vi.mock('../../app/lib/session-repo', () => ({
  getSessionById: vi.fn(async (sessionId: string) => ({
    id: sessionId,
    user_id: 'u1',
    refined_prompt: 'Prompt',
    topic: 'Topic',
    state: 'running_research',
    created_at: '2026-02-01T00:00:00.000Z',
    updated_at: '2026-02-01T00:00:00.000Z'
  })),
  updateSessionState: (...args: any[]) => updateSessionState(...args)
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
  getRunningProviderResult: vi.fn(async () => null),
  getNextQueuedProviderResult: vi.fn(async () => null)
}));

vi.mock('../../app/lib/research-orchestrator', () => ({
  getSessionResearchSnapshot: vi.fn(async () => null),
  getSessionResearchSnapshotByProvider: vi.fn(async (sessionId: string, provider: Provider) => {
    const run = [...runs.values()].find((candidate) => candidate.session_id === sessionId && candidate.provider === provider) ?? null;
    if (!run) return null;
    return {
      run,
      steps: stepsByRun.get(run.id) ?? [],
      sources: [],
      evidence: []
    };
  }),
  getResearchSnapshotByRunId: vi.fn(async (runId: string) => {
    const run = runs.get(runId) ?? null;
    if (!run) return null;
    return {
      run,
      steps: stepsByRun.get(runId) ?? [],
      sources: [],
      evidence: []
    };
  }),
  startRun: vi.fn(async () => ({ runId: 'unused', needsClarification: false, clarifyingQuestions: [] })),
  tick: (...args: any[]) => tick(...args)
}));

vi.mock('../../app/lib/research-run-repo', () => ({
  claimQueuedResearchRun: vi.fn(async () => true),
  createResearchRun: vi.fn(async (params: any) => {
    runCounter += 1;
    const id = `run-${params.provider}-${runCounter}`;
    runs.set(id, {
      id,
      session_id: params.sessionId,
      attempt: runCounter,
      state: 'NEW',
      provider: params.provider,
      mode: params.mode,
      depth: params.depth,
      question: params.question,
      research_plan_json: null,
      progress_json: null,
      current_step_index: 0,
      max_steps: params.maxSteps,
      target_sources_per_step: params.targetSourcesPerStep,
      max_total_sources: params.maxTotalSources,
      max_tokens_per_step: params.maxTokensPerStep,
      min_word_count: params.minWordCount,
      synthesized_report_md: null,
      error_message: null,
      created_at: '2026-02-01T00:00:00.000Z',
      updated_at: '2026-02-01T00:00:00.000Z',
      completed_at: null
    });
    return runs.get(id);
  }),
  initializePlannedResearchSteps: vi.fn(async (params: any) => {
    stepsByRun.set(
      params.runId,
      params.steps.map((step: any) => ({
        id: `${params.runId}:${step.stepIndex}`,
        run_id: params.runId,
        step_index: step.stepIndex,
        step_type: step.stepType,
        status: 'queued'
      }))
    );
  }),
  markResearchRunQueued: vi.fn(async (runId: string) => {
    const run = runs.get(runId);
    if (run) run.state = 'PLANNED';
    return true;
  }),
  updateResearchRun: vi.fn(async (params: any) => {
    const run = runs.get(params.runId);
    if (!run) return;
    if (params.state) run.state = params.state;
    if (params.plan !== undefined) run.research_plan_json = params.plan;
    if (params.progress !== undefined) run.progress_json = params.progress;
    if (params.currentStepIndex !== undefined) run.current_step_index = params.currentStepIndex;
    if (params.synthesizedReportMd !== undefined) run.synthesized_report_md = params.synthesizedReportMd;
    if (params.completed) run.completed_at = '2026-02-01T00:10:00.000Z';
  }),
  upsertResearchStep: vi.fn(async (params: any) => {
    const steps = stepsByRun.get(params.runId) ?? [];
    const existingIdx = steps.findIndex((step: any) => step.step_index === params.stepIndex);
    const next = {
      id: `${params.runId}:${params.stepIndex}`,
      run_id: params.runId,
      step_index: params.stepIndex,
      step_type: params.stepType,
      status: params.status,
      raw_output: params.rawOutput ?? null
    };
    if (existingIdx >= 0) {
      steps[existingIdx] = { ...steps[existingIdx], ...next };
    } else {
      steps.push(next);
    }
    stepsByRun.set(params.runId, steps);
    return next;
  })
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

const runGemini = vi.fn(async () => ({ outputText: 'gemini', sources: null }));
vi.mock('../../app/lib/gemini-client', () => ({
  runGemini: (...args: any[]) => runGemini(...args),
  rewritePromptGemini: vi.fn(async () => 'rewritten'),
  startRefinementGemini: vi.fn(async () => ({ questions: [] })),
  summarizeForReportGemini: vi.fn(async () => 'summary')
}));

vi.mock('../../app/lib/report-repo', () => ({
  claimReportSendForSession: vi.fn(async () => 'report-1'),
  createReport: (...args: any[]) => createReport(...args),
  getReportBySession: vi.fn(async () => null),
  updateReportContent: vi.fn(async () => undefined),
  updateReportEmail: vi.fn(async () => undefined),
  checkReportTiming: vi.fn(async () => null)
}));

vi.mock('../../app/lib/pdf-report', () => ({
  buildPdfReport: vi.fn(async () => new Uint8Array([1, 2, 3]))
}));

vi.mock('../../app/lib/email-sender', () => ({
  sendReportEmail: vi.fn(async () => undefined)
}));

vi.mock('../../app/lib/db', () => ({
  pool: null,
  query: vi.fn(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) {
      return [{ locked: true }];
    }
    if (sql.includes('pg_advisory_unlock')) {
      return [];
    }
    return [{ email: 'user@example.com' }];
  })
}));

import { runProviders } from '../../app/lib/orchestration';

describe('provider lane stub mode', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    providerRows.clear();
    runs.clear();
    stepsByRun.clear();
    runCounter = 0;
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://example/test';

    runs.set('run-openai-1', {
      id: 'run-openai-1',
      session_id: 's1',
      state: 'PLANNED',
      provider: 'openai',
      mode: 'custom',
      depth: 'standard',
      question: 'Prompt',
      research_plan_json: null,
      progress_json: { step_id: 'DISCOVER_SOURCES_WITH_PLAN' },
      current_step_index: 1,
      max_steps: 8,
      target_sources_per_step: 5,
      max_total_sources: 40,
      max_tokens_per_step: 1800,
      min_word_count: 2500,
      synthesized_report_md: null,
      error_message: null
    });
  });

  it('stubs Gemini lane before API execution and still finalizes report after OpenAI completes', async () => {
    await runProviders('s1', { stubGemini: true, stubPdf: true, stubEmail: true });

    expect(tick).toHaveBeenCalledWith('run-openai-1');
    expect(runGemini).not.toHaveBeenCalled();

    const openai = providerRows.get('s1:openai');
    const gemini = providerRows.get('s1:gemini');
    expect(openai?.status).toBe('completed');
    expect(gemini?.status).toBe('stubbed');

    expect(createReport).toHaveBeenCalledTimes(1);
    const geminiRun = [...runs.values()].find((run) => run.provider === 'gemini');
    expect(geminiRun?.completed_at).toBeTruthy();
    expect((stepsByRun.get(geminiRun?.id) ?? []).every((step) => step.status === 'done')).toBe(true);
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
  });
});
