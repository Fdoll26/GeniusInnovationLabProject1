// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Provider = 'openai' | 'gemini';

type RunRow = {
  id: string;
  session_id: string;
  state: string;
  provider: Provider;
  mode: 'custom';
  depth: 'standard';
  question: string;
  clarifying_questions_json: unknown | null;
  assumptions_json: unknown | null;
  clarifications_json: unknown | null;
  research_brief_json: unknown | null;
  research_plan_json: unknown | null;
  progress_json: unknown | null;
  current_step_index: number;
  max_steps: number;
  target_sources_per_step: number;
  max_total_sources: number;
  max_tokens_per_step: number;
  min_word_count: number;
  synthesized_report_md: string | null;
  synthesized_sources_json: unknown | null;
  synthesized_citation_map_json: unknown | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type StepRow = {
  id: string;
  run_id: string;
  step_index: number;
  step_type: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  provider: Provider;
  mode: 'custom';
  output_excerpt: string | null;
  raw_output: string | null;
  provider_native_json: Record<string, unknown> | null;
};

const runs = new Map<string, RunRow>();
const steps = new Map<string, StepRow[]>();
const stepUpsertCalls: Array<{ runId: string; stepIndex: number; status: string }> = [];

const twoStepPlan = {
  version: '1.0',
  refined_topic: 'topic',
  assumptions: ['a1'],
  total_budget: { max_steps: 2, max_sources: 8, max_tokens: 2000 },
  steps: [
    {
      step_index: 0,
      step_type: 'DEVELOP_RESEARCH_PLAN',
      title: 'Plan',
      objective: 'Create a plan',
      target_source_types: ['government'],
      search_query_pack: ['topic'],
      budgets: { max_sources: 3, max_tokens: 1000, max_minutes: 5 },
      deliverables: ['Plan JSON'],
      done_definition: ['done']
    },
    {
      step_index: 1,
      step_type: 'DISCOVER_SOURCES_WITH_PLAN',
      title: 'Discover',
      objective: 'Find sources',
      target_source_types: ['news'],
      search_query_pack: ['topic data'],
      budgets: { max_sources: 5, max_tokens: 1000, max_minutes: 8 },
      deliverables: ['Source list'],
      done_definition: ['done']
    }
  ],
  deliverables: ['report']
};

const runOpenAiReasoningStep = vi.fn(async () => ({
  text: JSON.stringify(twoStepPlan),
  responseId: 'oa-1',
  usage: null,
  primaryContent: {
    text: '{"openai":"plan"}',
    annotations: [{ type: 'url_citation', url: 'https://openai.example/plan' }]
  }
}));

const startResearchJob = vi.fn(async () => ({
  responseId: null,
  status: 'completed',
  data: {
    output_text: 'openai deep output https://openai.example/discover',
    output: [
      {
        content: [
          {
            text: 'openai deep output https://openai.example/discover',
            annotations: [{ type: 'url_citation', url: 'https://openai.example/discover' }]
          }
        ]
      }
    ],
    sources: [{ url: 'https://openai.example/discover', title: 'OpenAI Source' }]
  }
}));

const runGeminiReasoningStep = vi.fn(async () => ({
  text: JSON.stringify(twoStepPlan),
  sources: null,
  usage: null,
  groundingMetadata: {
    groundingChunks: [{ web: { uri: 'https://gemini.example/plan', title: 'Gemini Plan' } }],
    groundingSupports: [{ groundingChunkIndices: [0] }]
  }
}));

const runGemini = vi.fn(async () => ({
  outputText: 'gemini deep output https://gemini.example/discover',
  sources: {
    groundingChunks: [{ web: { uri: 'https://gemini.example/discover', title: 'Gemini Source' } }],
    groundingSupports: [{ groundingChunkIndices: [0] }]
  }
}));

vi.mock('../../app/lib/openai-client', () => ({
  runOpenAiReasoningStep: (...args: any[]) => runOpenAiReasoningStep(...args),
  startResearchJob: (...args: any[]) => startResearchJob(...args),
  getResponseOutputText: vi.fn((data: any) => String(data?.output_text ?? '')),
  getResponseSources: vi.fn((data: any) => data?.sources ?? null),
  getResponsePrimaryMessageContent: vi.fn((data: any) => {
    const first = data?.output?.[0]?.content?.[0];
    if (!first || typeof first.text !== 'string') return null;
    return { text: first.text, annotations: first.annotations ?? null };
  }),
  generateModelComparisonOpenAI: vi.fn(async () => 'comparison')
}));

vi.mock('../../app/lib/gemini-client', () => ({
  runGeminiReasoningStep: (...args: any[]) => runGeminiReasoningStep(...args),
  runGemini: (...args: any[]) => runGemini(...args),
  extractGeminiGroundingMetadata: vi.fn((data: any) => {
    if (!data || typeof data !== 'object') return null;
    return {
      groundingChunks: Array.isArray(data.groundingChunks) ? data.groundingChunks : [],
      groundingSupports: Array.isArray(data.groundingSupports) ? data.groundingSupports : []
    };
  }),
  generateModelComparisonGemini: vi.fn(async () => 'comparison')
}));

vi.mock('../../app/lib/research-run-repo', () => ({
  createResearchRun: vi.fn(),
  getLatestResearchRunBySessionId: vi.fn(async () => null),
  getLatestResearchRunBySessionProvider: vi.fn(async () => null),
  getResearchRunById: vi.fn(async (runId: string) => runs.get(runId) ?? null),
  markResearchRunQueued: vi.fn(async () => true),
  claimQueuedResearchRun: vi.fn(async () => true),
  listCitationMappings: vi.fn(async () => []),
  listResearchEvidence: vi.fn(async () => []),
  listResearchRunsBySessionId: vi.fn(async () => []),
  listResearchSources: vi.fn(async () => []),
  listResearchSteps: vi.fn(async (runId: string) => [...(steps.get(runId) ?? [])].sort((a, b) => a.step_index - b.step_index)),
  updateResearchRun: vi.fn(async (params: any) => {
    const row = runs.get(params.runId);
    if (!row) return;
    runs.set(params.runId, {
      ...row,
      state: params.state ?? row.state,
      current_step_index: typeof params.currentStepIndex === 'number' ? params.currentStepIndex : row.current_step_index,
      research_plan_json: params.plan ?? row.research_plan_json,
      progress_json: params.progress ?? row.progress_json,
      synthesized_report_md: params.synthesizedReportMd ?? row.synthesized_report_md,
      updated_at: new Date().toISOString()
    });
  }),
  upsertResearchSource: vi.fn(async () => undefined),
  upsertResearchEvidence: vi.fn(async () => undefined),
  initializePlannedResearchSteps: vi.fn(async () => undefined),
  upsertResearchStep: vi.fn(async (params: any) => {
    const rows = steps.get(params.runId) ?? [];
    const idx = rows.findIndex((row) => row.step_index === params.stepIndex);
    const next: StepRow = {
      id: idx >= 0 ? rows[idx]!.id : `step-${params.runId}-${params.stepIndex}`,
      run_id: params.runId,
      step_index: params.stepIndex,
      step_type: params.stepType,
      status: params.status === 'planned' ? 'queued' : params.status,
      provider: params.provider,
      mode: params.mode,
      output_excerpt: params.outputExcerpt ?? (idx >= 0 ? rows[idx]!.output_excerpt : null),
      raw_output: params.rawOutput ?? (idx >= 0 ? rows[idx]!.raw_output : null),
      provider_native_json: params.providerNative ?? (idx >= 0 ? rows[idx]!.provider_native_json : null)
    };
    if (idx >= 0) rows[idx] = next;
    else rows.push(next);
    steps.set(params.runId, rows);
    stepUpsertCalls.push({ runId: params.runId, stepIndex: params.stepIndex, status: params.status });
    return next;
  })
}));

vi.mock('../../app/lib/session-repo', () => ({
  getSessionById: vi.fn(async (sessionId: string) => ({ id: sessionId, user_id: 'u1' }))
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

vi.mock('../../app/lib/db', () => ({
  pool: null,
  query: vi.fn(async () => [])
}));

import { tick } from '../../app/lib/research-orchestrator';

function seedRun(provider: Provider): string {
  const runId = `${provider}-run-1`;
  runs.set(runId, {
    id: runId,
    session_id: 's1',
    state: 'PLANNED',
    provider,
    mode: 'custom',
    depth: 'standard',
    question: 'topic',
    clarifying_questions_json: null,
    assumptions_json: null,
    clarifications_json: null,
    research_brief_json: null,
    research_plan_json: twoStepPlan,
    progress_json: { step_id: null, step_index: 0, total_steps: 2, step_label: null, gap_loops: 0 },
    current_step_index: 0,
    max_steps: 8,
    target_sources_per_step: 5,
    max_total_sources: 40,
    max_tokens_per_step: 1800,
    min_word_count: 2500,
    synthesized_report_md: null,
    synthesized_sources_json: null,
    synthesized_citation_map_json: null,
    error_message: null,
    created_at: '2026-02-25T00:00:00.000Z',
    updated_at: '2026-02-25T00:00:00.000Z',
    completed_at: null
  });
  steps.set(runId, []);
  return runId;
}

describe('step execution engine integration', () => {
  beforeEach(() => {
    runs.clear();
    steps.clear();
    stepUpsertCalls.length = 0;
    vi.clearAllMocks();
  });

  it('executes ordered steps with persistence for openai and gemini lanes', async () => {
    for (const provider of ['openai', 'gemini'] as const) {
      const runId = seedRun(provider);

      const firstTick = await tick(runId);
      expect(firstTick.done).toBe(false);
      expect(runs.get(runId)?.current_step_index).toBe(1);
      const afterFirst = steps.get(runId) ?? [];
      expect(afterFirst.find((row) => row.step_index === 0)?.status).toBe('done');

      const secondTick = await tick(runId);
      expect(secondTick.state).not.toBe('FAILED');
      expect((runs.get(runId)?.current_step_index ?? 0) >= 2).toBe(true);
      const afterSecond = steps.get(runId) ?? [];
      expect(afterSecond.find((row) => row.step_index === 1)?.status).toBe('done');

      const stepTransitions = stepUpsertCalls
        .filter((row) => row.runId === runId)
        .map((row) => `${row.stepIndex}:${row.status}`);
      expect(stepTransitions).toContain('0:running');
      expect(stepTransitions).toContain('0:done');
      expect(stepTransitions).toContain('1:running');
      expect(stepTransitions).toContain('1:done');

      const nativeStep0 = afterSecond.find((row) => row.step_index === 0)?.provider_native_json;
      const nativeStep1 = afterSecond.find((row) => row.step_index === 1)?.provider_native_json;
      expect(nativeStep0).toBeTruthy();
      expect(nativeStep1).toBeTruthy();
      expect(nativeStep0?.output_text).toBeTypeOf('string');
      expect(nativeStep1?.output_text).toBeTypeOf('string');
      expect(nativeStep0?.citation_metadata).toBeTruthy();
      expect(nativeStep1?.citation_metadata).toBeTruthy();
    }

    expect(runOpenAiReasoningStep).toHaveBeenCalledWith(expect.objectContaining({ useWebSearch: false }));
    expect(runGeminiReasoningStep).toHaveBeenCalledWith(
      expect.objectContaining({ useSearch: false, model: 'gemini-2.0-flash' })
    );
  });
});
