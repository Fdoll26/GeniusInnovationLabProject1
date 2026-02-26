// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createResearchRun = vi.fn();
const getResearchRunById = vi.fn();
const initializePlannedResearchSteps = vi.fn(async () => undefined);
const listResearchSteps = vi.fn(async () => []);
const updateResearchRun = vi.fn(async () => undefined);
const upsertResearchStep = vi.fn(async () => ({ id: 'step-id' }));
const upsertResearchSource = vi.fn(async () => undefined);
const upsertResearchEvidence = vi.fn(async () => undefined);
const generateResearchPlan = vi.fn(async () => ({
  needsClarification: false,
  clarifyingQuestions: [],
  assumptions: ['a1'],
  plan: {
    version: '1.0',
    refined_topic: 'refined topic',
    assumptions: ['a1'],
    total_budget: { max_steps: 2, max_sources: 10, max_tokens: 2000 },
    steps: [
      {
        step_index: 0,
        step_type: 'DEVELOP_RESEARCH_PLAN',
        title: 'Plan',
        objective: 'Build plan',
        target_source_types: ['government'],
        search_query_pack: ['q1'],
        budgets: { max_sources: 3, max_tokens: 1000, max_minutes: 5 },
        deliverables: ['Plan JSON'],
        done_definition: ['Step complete']
      },
      {
        step_index: 1,
        step_type: 'DISCOVER_SOURCES_WITH_PLAN',
        title: 'Discover',
        objective: 'Find sources',
        target_source_types: ['news'],
        search_query_pack: ['q2'],
        budgets: { max_sources: 4, max_tokens: 1000, max_minutes: 5 },
        deliverables: ['Source list'],
        done_definition: ['Step complete']
      }
    ],
    deliverables: ['Report']
  },
  brief: { scope: 'test' }
}));

vi.mock('../../app/lib/research-run-repo', () => ({
  createResearchRun: (...args: any[]) => createResearchRun(...args),
  getLatestResearchRunBySessionId: vi.fn(),
  getLatestResearchRunBySessionProvider: vi.fn(),
  getResearchRunById: (...args: any[]) => getResearchRunById(...args),
  initializePlannedResearchSteps: (...args: any[]) => initializePlannedResearchSteps(...args),
  listCitationMappings: vi.fn(async () => []),
  listResearchEvidence: vi.fn(async () => []),
  listResearchRunsBySessionId: vi.fn(async () => []),
  listResearchSources: vi.fn(async () => []),
  listResearchSteps: (...args: any[]) => listResearchSteps(...args),
  updateResearchRun: (...args: any[]) => updateResearchRun(...args),
  upsertResearchEvidence: (...args: any[]) => upsertResearchEvidence(...args),
  upsertResearchSource: (...args: any[]) => upsertResearchSource(...args),
  upsertResearchStep: (...args: any[]) => upsertResearchStep(...args)
}));

vi.mock('../../app/lib/session-repo', () => ({
  getSessionById: vi.fn(async () => ({ id: 's1', user_id: 'u1' }))
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

vi.mock('../../app/lib/research-provider', () => ({
  generateResearchPlan: (...args: any[]) => generateResearchPlan(...args),
  executePipelineStep: vi.fn(async () => ({
    step_goal: 'gap check',
    inputs_summary: 'summary',
    raw_output_text: 'raw',
    citations: [],
    evidence: [],
    tools_used: ['web_search_preview'],
    token_usage: null,
    model_used: 'gpt-4.1-mini',
    next_step_hint: null,
    structured_output: {
      severe_gaps: true,
      follow_up_queries: ['q1']
    },
    updatedPlan: null
  }))
}));

import { startRun, tick } from '../../app/lib/research-orchestrator';

describe('research-orchestrator gap loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createResearchRun.mockResolvedValue({
      id: 'run0',
      session_id: 's1',
      provider: 'openai',
      mode: 'custom'
    });
  });

  it('persists plan_json and inserts planned steps at run start', async () => {
    const out = await startRun({
      sessionId: 's1',
      userId: 'u1',
      question: 'refined topic',
      provider: 'openai'
    });

    expect(out.runId).toBe('run0');
    expect(generateResearchPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'refined topic',
        provider: 'openai'
      })
    );
    expect(updateResearchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run0',
        state: 'PLANNED',
        plan: expect.objectContaining({
          version: '1.0'
        })
      })
    );
    expect(initializePlannedResearchSteps).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run0',
        steps: expect.arrayContaining([
          expect.objectContaining({
            stepIndex: 0,
            stepType: 'DEVELOP_RESEARCH_PLAN'
          })
        ])
      })
    );
  });

  it('does not loop back when max gap loops already reached', async () => {
    getResearchRunById.mockResolvedValueOnce({
      id: 'run1',
      session_id: 's1',
      state: 'IN_PROGRESS',
      provider: 'openai',
      mode: 'custom',
      depth: 'standard',
      question: 'q',
      clarifying_questions_json: null,
      assumptions_json: null,
      clarifications_json: null,
      research_brief_json: null,
      research_plan_json: null,
      progress_json: { gap_loops: 1 },
      current_step_index: 6,
      max_steps: 8,
      target_sources_per_step: 5,
      max_total_sources: 40,
      max_tokens_per_step: 1800,
      min_word_count: 2500,
      synthesized_report_md: null,
      synthesized_sources_json: null,
      synthesized_citation_map_json: null,
      error_message: null,
      created_at: '2026-02-20T00:00:00.000Z',
      updated_at: '2026-02-20T00:00:00.000Z',
      completed_at: null
    });
    listResearchSteps.mockResolvedValueOnce([
      { id: 's0', step_index: 0, status: 'done', step_type: 'DEVELOP_RESEARCH_PLAN' },
      { id: 's1', step_index: 1, status: 'done', step_type: 'DISCOVER_SOURCES_WITH_PLAN' },
      { id: 's2', step_index: 2, status: 'done', step_type: 'SHORTLIST_RESULTS' },
      { id: 's3', step_index: 3, status: 'done', step_type: 'DEEP_READ' },
      { id: 's4', step_index: 4, status: 'done', step_type: 'EXTRACT_EVIDENCE' },
      { id: 's5', step_index: 5, status: 'done', step_type: 'COUNTERPOINTS' }
    ]);

    const result = await tick('run1');

    expect(result.done).toBe(false);
    expect(updateResearchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run1',
        currentStepIndex: 7,
        state: 'IN_PROGRESS'
      })
    );
    expect(updateResearchRun).not.toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run1',
        currentStepIndex: 1
      })
    );
  });

  it('does not advance to next stage until prior stage is done', async () => {
    getResearchRunById.mockResolvedValueOnce({
      id: 'run2',
      session_id: 's1',
      state: 'IN_PROGRESS',
      provider: 'openai',
      mode: 'custom',
      depth: 'standard',
      question: 'q',
      clarifying_questions_json: null,
      assumptions_json: null,
      clarifications_json: null,
      research_brief_json: null,
      research_plan_json: null,
      progress_json: {},
      current_step_index: 2,
      max_steps: 8,
      target_sources_per_step: 5,
      max_total_sources: 40,
      max_tokens_per_step: 1800,
      min_word_count: 2500,
      synthesized_report_md: null,
      synthesized_sources_json: null,
      synthesized_citation_map_json: null,
      error_message: null,
      created_at: '2026-02-20T00:00:00.000Z',
      updated_at: '2026-02-20T00:00:00.000Z',
      completed_at: null
    });
    listResearchSteps.mockResolvedValueOnce([
      { id: 'step0', step_index: 0, status: 'done', step_type: 'DEVELOP_RESEARCH_PLAN' },
      { id: 'step1', step_index: 1, status: 'running', step_type: 'DISCOVER_SOURCES_WITH_PLAN' }
    ]);

    const result = await tick('run2');

    expect(result.done).toBe(false);
    expect(updateResearchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run2',
        currentStepIndex: 1
      })
    );
  });

  it('fails when section synthesis returns empty output', async () => {
    getResearchRunById.mockResolvedValueOnce({
      id: 'run3',
      session_id: 's1',
      state: 'IN_PROGRESS',
      provider: 'openai',
      mode: 'custom',
      depth: 'standard',
      question: 'q',
      clarifying_questions_json: null,
      assumptions_json: null,
      clarifications_json: null,
      research_brief_json: null,
      research_plan_json: {
        steps: [
          { step_index: 0, step_type: 'DEEP_READ' },
          { step_index: 1, step_type: 'SECTION_SYNTHESIS' }
        ]
      },
      progress_json: {},
      current_step_index: 1,
      max_steps: 8,
      target_sources_per_step: 5,
      max_total_sources: 40,
      max_tokens_per_step: 1800,
      min_word_count: 2500,
      synthesized_report_md: null,
      synthesized_sources_json: null,
      synthesized_citation_map_json: null,
      error_message: null,
      created_at: '2026-02-20T00:00:00.000Z',
      updated_at: '2026-02-20T00:00:00.000Z',
      completed_at: null
    });
    listResearchSteps.mockResolvedValue([
      { id: 's0', step_index: 0, status: 'done', step_type: 'DEEP_READ' }
    ]);

    const { executePipelineStep } = await import('../../app/lib/research-provider');
    vi.mocked(executePipelineStep).mockResolvedValueOnce({
      step_goal: 'section synthesis',
      inputs_summary: 'summary',
      raw_output_text: '   ',
      output_text_with_refs: '   ',
      citations: [],
      evidence: [],
      tools_used: ['web_search_preview'],
      token_usage: null,
      model_used: 'gpt-4.1-mini',
      next_step_hint: null,
      structured_output: null
    } as any);

    const result = await tick('run3');

    expect(result).toEqual({ state: 'FAILED', done: true });
    expect(updateResearchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run3',
        state: 'FAILED',
        errorMessage: 'Empty synthesis output from provider',
        completed: true
      })
    );
  });

  it('fails a step after retryable-error retry limit is exceeded', async () => {
    getResearchRunById.mockResolvedValueOnce({
      id: 'run4',
      session_id: 's1',
      state: 'IN_PROGRESS',
      provider: 'openai',
      mode: 'custom',
      depth: 'standard',
      question: 'q',
      clarifying_questions_json: null,
      assumptions_json: null,
      clarifications_json: null,
      research_brief_json: null,
      research_plan_json: null,
      progress_json: {},
      current_step_index: 1,
      max_steps: 8,
      target_sources_per_step: 5,
      max_total_sources: 40,
      max_tokens_per_step: 1800,
      min_word_count: 2500,
      synthesized_report_md: null,
      synthesized_sources_json: null,
      synthesized_citation_map_json: null,
      error_message: null,
      created_at: '2026-02-20T00:00:00.000Z',
      updated_at: '2026-02-20T00:00:00.000Z',
      completed_at: null
    });
    listResearchSteps.mockResolvedValueOnce([
      { id: 's0', step_index: 0, status: 'done', step_type: 'DEVELOP_RESEARCH_PLAN' },
      {
        id: 's1',
        step_index: 1,
        status: 'queued',
        step_type: 'DISCOVER_SOURCES_WITH_PLAN',
        provider_native_json: { retryable_error_count: 3 }
      }
    ]);

    const { executePipelineStep } = await import('../../app/lib/research-provider');
    vi.mocked(executePipelineStep).mockRejectedValueOnce(new Error('timeout while waiting for provider'));

    const result = await tick('run4');

    expect(result).toEqual({ state: 'FAILED', done: true });
    expect(updateResearchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run4',
        state: 'FAILED',
        completed: true
      })
    );
    expect(upsertResearchStep).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run4',
        stepIndex: 1,
        status: 'failed'
      })
    );
  });
});
