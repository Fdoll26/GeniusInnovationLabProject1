import { getUserSettings } from './user-settings-repo';
import {
  createResearchRun,
  getLatestResearchRunBySessionId,
  getLatestResearchRunBySessionProvider,
  getResearchRunById,
  initializePlannedResearchSteps,
  listCitationMappings,
  listResearchEvidence,
  listResearchRunsBySessionId,
  listResearchSources,
  listResearchSteps,
  updateResearchRun,
  upsertResearchEvidence,
  upsertResearchSource,
  upsertResearchStep
} from './research-run-repo';
import { executePipelineStep, generateResearchPlan } from './research-provider';
import { getResearchProviderConfig } from './research-config';
import { STEP_LABELS, STEP_SEQUENCE, type ResearchPlan, type ResearchProviderName } from './research-types';
import { getSessionById } from './session-repo';
import { canTransitionStep } from './research-workflow';

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function deriveCanonicalStepTypesFromPlan(
  plan: ResearchPlan | null,
  maxSteps: number
): Array<(typeof STEP_SEQUENCE)[number]> {
  const fallback = STEP_SEQUENCE.slice(0, clamp(maxSteps, 1, STEP_SEQUENCE.length));
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    return fallback;
  }

  const requestedTypes = new Set<(typeof STEP_SEQUENCE)[number]>();
  for (const step of plan.steps) {
    if (
      step &&
      typeof step === 'object' &&
      typeof step.step_type === 'string' &&
      STEP_SEQUENCE.includes(step.step_type as (typeof STEP_SEQUENCE)[number])
    ) {
      requestedTypes.add(step.step_type as (typeof STEP_SEQUENCE)[number]);
    }
  }

  if (requestedTypes.size === 0) {
    return fallback;
  }
  // Once the plan is accepted, execution always runs in canonical order.
  return STEP_SEQUENCE.slice(0, clamp(maxSteps, 1, STEP_SEQUENCE.length));
}

function getExecutionStepSequence(run: NonNullable<Awaited<ReturnType<typeof getResearchRunById>>>): Array<(typeof STEP_SEQUENCE)[number]> {
  const plan = parseJson<ResearchPlan | null>(run.research_plan_json, null);
  return deriveCanonicalStepTypesFromPlan(plan, run.max_steps);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function defaultWordTarget(depth: 'light' | 'standard' | 'deep') {
  if (depth === 'deep') return 6000;
  if (depth === 'light') return 1200;
  return 2500;
}

function isRetryableResearchError(error: unknown): boolean {
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (isHardQuotaExhaustionError(error)) {
    return false;
  }
  return (
    text.includes('429') ||
    text.includes('rate limit') ||
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('temporary failure') ||
    text.includes('enotfound') ||
    text.includes('eai_again') ||
    text.includes('fetch failed') ||
    text.includes('connection') ||
    text.includes('try again')
  );
}

function isHardQuotaExhaustionError(error: unknown): boolean {
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    (text.includes('quota exceeded') || text.includes('resource_exhausted')) &&
    (text.includes('per_day') ||
      text.includes('generate_requests_per_model_per_day') ||
      text.includes('plan and billing') ||
      text.includes('check your plan and billing'))
  );
}

const MAX_RETRYABLE_STEP_ERRORS = Number.parseInt(process.env.RESEARCH_STEP_MAX_RETRYABLE_ERRORS ?? '3', 10);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getRetryableErrorCount(providerNative: unknown): number {
  const record = asRecord(providerNative);
  const count = Number(record?.retryable_error_count);
  if (!Number.isFinite(count) || count < 0) {
    return 0;
  }
  return Math.trunc(count);
}

function summarizePriorSteps(steps: Awaited<ReturnType<typeof listResearchSteps>>) {
  const sorted = [...steps].sort((a, b) => a.step_index - b.step_index);
  return sorted
    .map((s, idx) => {
      const isLatest = idx === sorted.length - 1;
      const isPrevious = idx === sorted.length - 2;
      const charLimit = isLatest ? 24000 : isPrevious ? 16000 : 8000;
      const text = (s.raw_output || s.output_excerpt || '').slice(0, charLimit);
      return `Step ${s.step_index + 1} [${s.step_type}]:\n${text}`;
    })
    .join('\n\n---\n\n');
}

function chunkTextForStorage(text: string, maxChars = 4000): Array<{ index: number; text: string }> {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const chunks: Array<{ index: number; text: string }> = [];
  let cursor = 0;
  let index = 0;
  while (cursor < trimmed.length) {
    const next = Math.min(trimmed.length, cursor + maxChars);
    chunks.push({ index, text: trimmed.slice(cursor, next) });
    cursor = next;
    index += 1;
  }
  return chunks;
}

async function persistStepArtifacts(params: {
  runId: string;
  stepId: string;
  artifact: Awaited<ReturnType<typeof executePipelineStep>>;
}) {
  for (const citation of params.artifact.citations) {
    await upsertResearchSource({ runId: params.runId, stepId: params.stepId, source: citation });
  }
  for (const evidence of params.artifact.evidence) {
    await upsertResearchEvidence({ runId: params.runId, stepId: params.stepId, evidence });
  }
}

async function executePlannedStep(params: {
  runId: string;
  run: NonNullable<Awaited<ReturnType<typeof getResearchRunById>>>;
  settings: Awaited<ReturnType<typeof getUserSettings>>;
  providerCfg: ReturnType<typeof getResearchProviderConfig>;
  stepId: (typeof STEP_SEQUENCE)[number];
  currentIndex: number;
  totalSteps: number;
}) {
  const { runId, run, settings, providerCfg, stepId, currentIndex, totalSteps } = params;
  const existingSteps = await listResearchSteps(runId);
  const runStartedAt =
    existingSteps
      .map((s) => s.started_at)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .sort()[0] ?? new Date().toISOString();

  await upsertResearchStep({
    runId,
    stepIndex: currentIndex,
    stepType: stepId,
    status: 'running',
    provider: run.provider,
    mode: run.mode,
    stepGoal: `Execute ${stepId.toLowerCase().replace(/_/g, ' ')}`,
    inputsSummary: `step ${currentIndex + 1}/${totalSteps}`,
    started: true,
    startedAt: runStartedAt
  });
  await updateResearchRun({
    runId,
    state: 'IN_PROGRESS',
    progress: {
      step_id: stepId,
      step_index: currentIndex,
      total_steps: totalSteps,
      step_label: STEP_LABELS[stepId]
    }
  });

  const stepsNow = await listResearchSteps(runId);
  const sortedSteps = [...stepsNow].sort((a, b) => a.step_index - b.step_index);
  const prevStep = sortedSteps.filter((s) => s.step_index < currentIndex && s.status === 'done').slice(-1)[0];
  const prevStepFullOutput = prevStep?.raw_output ?? prevStep?.output_excerpt ?? null;
  const summary = summarizePriorSteps(stepsNow);
  const stepsNeedingFullPrior = new Set<(typeof STEP_SEQUENCE)[number]>([
    'SHORTLIST_RESULTS',
    'EXTRACT_EVIDENCE',
    'COUNTERPOINTS',
    'GAP_CHECK'
  ]);
  const priorStepContext =
    stepsNeedingFullPrior.has(stepId) && prevStepFullOutput
      ? `FULL OUTPUT FROM PREVIOUS STEP [${prevStep?.step_type ?? 'unknown'}]:\n${prevStepFullOutput.slice(0, 32768)}\n\n---\n\nSUMMARY OF EARLIER STEPS:\n${summary}`
      : summary;
  const plan = parseJson<ResearchPlan | null>(run.research_plan_json, null);
  const artifact = await executePipelineStep({
    provider: run.provider,
    stepType: stepId,
    question: run.question,
    timeoutMs: (run.provider === 'openai' ? settings.openai_timeout_minutes : settings.gemini_timeout_minutes) * 60_000,
    plan,
    priorStepSummary: priorStepContext,
    sourceTarget: clamp(run.target_sources_per_step, 1, run.provider === 'gemini' ? 100 : 30),
    maxOutputTokens: clamp(run.max_tokens_per_step, 300, 32768),
    maxCandidates: providerCfg.max_candidates,
    shortlistSize: providerCfg.shortlist_size
  });
  const geminiOutputChunks =
    run.provider === 'gemini'
      ? chunkTextForStorage((artifact.provider_native_output ?? artifact.raw_output_text ?? '').trim())
      : [];
  const completedStep = await upsertResearchStep({
    runId,
    stepIndex: currentIndex,
    stepType: stepId,
    status: 'done',
    provider: run.provider,
    mode: run.mode,
    model: artifact.model_used,
    stepGoal: artifact.step_goal,
    inputsSummary: artifact.inputs_summary,
    toolsUsed: artifact.tools_used,
    rawOutput: artifact.raw_output_text,
    outputExcerpt: artifact.raw_output_text.slice(0, 700),
    sources: artifact.citations as unknown as Array<Record<string, unknown>>,
    evidence: artifact.evidence as unknown as Array<Record<string, unknown>>,
    citationMap: (artifact.references ?? []) as unknown as Array<Record<string, unknown>>,
    nextStepProposal: artifact.next_step_hint,
    tokenUsage: artifact.token_usage as Record<string, unknown> | null,
    providerNative: {
      output_text: artifact.provider_native_output ?? artifact.raw_output_text,
      citation_metadata: artifact.provider_native_citation_metadata ?? null,
      output_text_with_refs: artifact.output_text_with_refs ?? artifact.raw_output_text,
      references: artifact.references ?? [],
      consulted_sources: artifact.consulted_sources ?? [],
      ...(run.provider === 'gemini'
        ? {
            gemini_output_chunks: geminiOutputChunks,
            gemini_output_chunk_count: geminiOutputChunks.length
          }
        : {}),
      ...(artifact.gemini_subcall_results
        ? {
            gemini_subcall_results: artifact.gemini_subcall_results
          }
        : {}),
      ...(artifact.gemini_coverage_metrics
        ? {
            gemini_coverage_metrics: artifact.gemini_coverage_metrics
          }
        : {}),
      ...(artifact.gemini_ranked_sources
        ? {
            gemini_ranked_sources: artifact.gemini_ranked_sources
          }
        : {})
    },
    completed: true
  });

  await persistStepArtifacts({ runId, stepId: completedStep.id, artifact });
  return { status: 'done' as const, artifact };
}

async function resetStepsFromIndex(params: {
  runId: string;
  run: NonNullable<Awaited<ReturnType<typeof getResearchRunById>>>;
  executionSteps: Array<(typeof STEP_SEQUENCE)[number]>;
  fromIndex: number;
}) {
  const { runId, run, executionSteps, fromIndex } = params;
  for (let idx = fromIndex; idx < executionSteps.length; idx++) {
    const stepType = executionSteps[idx];
    await upsertResearchStep({
      runId,
      stepIndex: idx,
      stepType,
      status: 'queued',
      provider: run.provider,
      mode: run.mode,
      stepGoal: null,
      inputsSummary: null,
      rawOutput: null,
      outputExcerpt: null,
      sources: null,
      evidence: null,
      citationMap: null,
      providerNative: null,
      errorMessage: null
    });
  }
}

export async function startRun(params: {
  sessionId: string;
  userId: string;
  question: string;
  provider: ResearchProviderName;
  allowClarifications?: boolean;
}): Promise<{ runId: string; needsClarification: boolean; clarifyingQuestions: string[] }> {
  const settings = await getUserSettings(params.userId);

  const run = await createResearchRun({
    sessionId: params.sessionId,
    provider: params.provider,
    mode: settings.research_mode,
    depth: settings.research_depth,
    question: params.question,
    maxSteps: STEP_SEQUENCE.length,
    targetSourcesPerStep: clamp(settings.research_target_sources_per_step, 1, params.provider === 'gemini' ? 100 : 25),
    maxTotalSources: clamp(settings.research_max_total_sources, 5, 400),
    maxTokensPerStep: clamp(settings.research_max_tokens_per_step, 300, 32768),
    minWordCount: defaultWordTarget(settings.research_depth)
  });

  const generatedPlan = await generateResearchPlan({
    provider: params.provider,
    question: params.question,
    depth: settings.research_depth,
    maxSteps: STEP_SEQUENCE.length,
    targetSourcesPerStep: clamp(settings.research_target_sources_per_step, 1, params.provider === 'gemini' ? 100 : 25),
    maxTokensPerStep: clamp(settings.research_max_tokens_per_step, 300, 32768),
    timeoutMs: (params.provider === 'openai' ? settings.openai_timeout_minutes : settings.gemini_timeout_minutes) * 60_000
  });
  const canonicalStepsForInit = deriveCanonicalStepTypesFromPlan(generatedPlan.plan, STEP_SEQUENCE.length);
  const planStepByType = new Map(generatedPlan.plan.steps.map((s) => [s.step_type, s] as const));
  const plannedStepCount = canonicalStepsForInit.length > 0 ? canonicalStepsForInit.length : STEP_SEQUENCE.length;

  await updateResearchRun({
    runId: run.id,
    state: 'PLANNED',
    plan: generatedPlan.plan,
    clarifyingQuestions: generatedPlan.clarifyingQuestions,
    assumptions: generatedPlan.assumptions,
    brief: generatedPlan.brief as Record<string, unknown>,
    progress: {
      step_id: null,
      step_index: 0,
      total_steps: plannedStepCount,
      step_label: null,
      gap_loops: 0
    }
  });

  await initializePlannedResearchSteps({
    runId: run.id,
    provider: run.provider,
    mode: run.mode,
    steps: canonicalStepsForInit.map((stepType, idx) => {
      const planStep = planStepByType.get(stepType);
      return {
        stepIndex: idx,
        stepType,
        stepGoal: planStep?.objective ?? `Execute ${stepType.toLowerCase().replace(/_/g, ' ')}`,
        inputsSummary: planStep
          ? `planned queries=${planStep.search_query_pack.length} source_types=${planStep.target_source_types.length}`
          : 'canonical fallback step'
      };
    })
  });

  return {
    runId: run.id,
    needsClarification: generatedPlan.needsClarification,
    clarifyingQuestions: generatedPlan.clarifyingQuestions
  };
}

export async function submitClarifications(_params: {
  runId: string;
  answers: Array<{ question: string; answer: string }>;
}) {
  // Clarification flow is handled before deep research.
}

export async function tick(runId: string): Promise<{ state: string; done: boolean }> {
  const run = await getResearchRunById(runId);
  if (!run) throw new Error('Research run not found');
  if (run.state === 'DONE' || run.state === 'FAILED') return { state: run.state, done: true };

  const session = await getSessionById(run.session_id);
  if (!session) {
    await updateResearchRun({ runId, state: 'FAILED', errorMessage: 'Session not found', completed: true });
    return { state: 'FAILED', done: true };
  }
  const settings = await getUserSettings(session.user_id);
  const providerCfg = getResearchProviderConfig(run.provider);
  const executionSteps = getExecutionStepSequence(run);
  const totalSteps = executionSteps.length;

  let currentIndex = clamp(run.current_step_index, 0, totalSteps);
  if (currentIndex >= totalSteps) {
    await updateResearchRun({ runId, state: 'DONE', completed: true });
    return { state: 'DONE', done: true };
  }

  await updateResearchRun({ runId, state: 'IN_PROGRESS' });

  const existingSteps = await listResearchSteps(runId);
  // Strict stage gating: never advance to a step unless the previous step is done.
  if (currentIndex > 0) {
    const prev = existingSteps.find((s) => s.step_index === currentIndex - 1);
    if (!prev || prev.status !== 'done') {
      await updateResearchRun({
        runId,
        currentStepIndex: currentIndex - 1,
        progress: {
          step_id: executionSteps[currentIndex - 1],
          step_index: currentIndex - 1,
          total_steps: totalSteps,
          step_label: STEP_LABELS[executionSteps[currentIndex - 1]]
        }
      });
      return { state: 'IN_PROGRESS', done: false };
    }
    const fromStep = executionSteps[currentIndex - 1];
    const toStep = executionSteps[currentIndex];
    if (!canTransitionStep(fromStep, toStep)) {
      console.warn(
        `[research-orchestrator] Unexpected step transition ${fromStep} -> ${toStep} for run ${runId}; continuing anyway.`
      );
    }
  }

  const existingCurrent = existingSteps.find((s) => s.step_index === currentIndex);
  if (existingCurrent?.status === 'done') {
    currentIndex += 1;
    await updateResearchRun({
      runId,
      currentStepIndex: currentIndex,
      progress: {
        step_id: currentIndex < totalSteps ? executionSteps[currentIndex] : null,
        step_index: currentIndex,
        total_steps: totalSteps,
        step_label: currentIndex < totalSteps ? STEP_LABELS[executionSteps[currentIndex]] : null
      }
    });
    if (currentIndex >= totalSteps) {
      await updateResearchRun({ runId, state: 'DONE', completed: true });
      return { state: 'DONE', done: true };
    }
  }

  const stepId = executionSteps[currentIndex];
  try {
    const execution = await executePlannedStep({
      runId,
      run,
      settings,
      providerCfg,
      stepId,
      currentIndex,
      totalSteps
    });
    const artifact = execution.artifact;
    const synthesizedText = (artifact.output_text_with_refs ?? artifact.raw_output_text ?? '').trim();

    if (stepId === 'DEVELOP_RESEARCH_PLAN') {
      const nextPlan = artifact.updatedPlan ?? parseJson<ResearchPlan | null>(run.research_plan_json, null);
      await updateResearchRun({ runId, plan: nextPlan, state: 'PLANNED' });
    }

    const progress = parseJson<Record<string, unknown>>(run.progress_json, {});
    if (stepId === 'GAP_CHECK' && artifact.structured_output) {
      const severe = Boolean((artifact.structured_output as Record<string, unknown>).severe_gaps);
      const currentLoops = Number(progress.gap_loops ?? 0);
      if (severe && currentLoops < providerCfg.max_gap_loops) {
        const loopBackIndex = 1;
        await resetStepsFromIndex({
          runId,
          run,
          executionSteps,
          fromIndex: loopBackIndex
        });
        await updateResearchRun({
          runId,
          currentStepIndex: loopBackIndex,
          progress: {
            step_id: executionSteps[loopBackIndex],
            step_index: loopBackIndex,
            total_steps: totalSteps,
            step_label: STEP_LABELS[executionSteps[loopBackIndex]],
            gap_loops: currentLoops + 1
          }
        });
        return { state: 'IN_PROGRESS', done: false };
      }
    }

    const nextIndex = currentIndex + 1;
    const isDone = nextIndex >= totalSteps;
    if (stepId === 'SECTION_SYNTHESIS' && !synthesizedText) {
      throw new Error('Empty synthesis output from provider');
    }
    const synthesizedSources: Array<Record<string, unknown>> =
      stepId === 'SECTION_SYNTHESIS'
        ? run.provider === 'gemini' && artifact.gemini_ranked_sources && artifact.gemini_ranked_sources.length > 0
          ? artifact.gemini_ranked_sources.map((s, idx) => ({
              index: idx + 1,
              url: s.url,
              title: s.title ?? s.domain ?? s.url,
              domain: s.domain,
              supportCount: s.supportCount,
              avgConfidence: s.avgConfidence
            }))
          : ((artifact.references ?? []) as unknown as Array<Record<string, unknown>>)
        : [];
    await updateResearchRun({
      runId,
      currentStepIndex: nextIndex,
      progress: {
        step_id: isDone ? null : executionSteps[nextIndex],
        step_index: nextIndex,
        total_steps: totalSteps,
        step_label: isDone ? null : STEP_LABELS[executionSteps[nextIndex]],
        gap_loops: Number(progress.gap_loops ?? 0)
      },
      state: isDone ? 'DONE' : 'IN_PROGRESS',
      synthesizedReportMd: stepId === 'SECTION_SYNTHESIS' ? synthesizedText : undefined,
      synthesizedSources: stepId === 'SECTION_SYNTHESIS' ? synthesizedSources : undefined,
      completed: isDone
    });

    return { state: isDone ? 'DONE' : 'IN_PROGRESS', done: isDone };
  } catch (error) {
    if (isRetryableResearchError(error)) {
      const retryableErrorCount = getRetryableErrorCount(existingCurrent?.provider_native_json) + 1;
      if (retryableErrorCount > Math.max(1, MAX_RETRYABLE_STEP_ERRORS)) {
        const terminalMessage = `Step ${stepId} exceeded retry limit after ${retryableErrorCount - 1} transient errors: ${
          error instanceof Error ? error.message : 'Transient research step error'
        }`;
        await upsertResearchStep({
          runId,
          stepIndex: currentIndex,
          stepType: stepId,
          status: 'failed',
          provider: run.provider,
          mode: run.mode,
          errorMessage: terminalMessage,
          providerNative: {
            retryable_error_count: retryableErrorCount - 1,
            retry_exhausted: true
          },
          completed: true
        });
        await updateResearchRun({
          runId,
          state: 'FAILED',
          errorMessage: terminalMessage,
          completed: true
        });
        return { state: 'FAILED', done: true };
      }

      await upsertResearchStep({
        runId,
        stepIndex: currentIndex,
        stepType: stepId,
        status: 'queued',
        provider: run.provider,
        mode: run.mode,
        errorMessage: error instanceof Error ? error.message : 'Transient research step error',
        providerNative: {
          retryable_error_count: retryableErrorCount,
          last_retryable_error_at: new Date().toISOString()
        }
      });
      return { state: 'IN_PROGRESS', done: false };
    }

    await upsertResearchStep({
      runId,
      stepIndex: currentIndex,
      stepType: stepId,
      status: 'failed',
      provider: run.provider,
      mode: run.mode,
      errorMessage: error instanceof Error ? error.message : 'Step failed',
      completed: true
    });

    await updateResearchRun({
      runId,
      state: 'FAILED',
      errorMessage: error instanceof Error ? error.message : 'Research step failed',
      completed: true
    });

    return { state: 'FAILED', done: true };
  }
}

export async function synthesize(runId: string) {
  const run = await getResearchRunById(runId);
  if (!run) throw new Error('Research run not found');
  return {
    report: run.synthesized_report_md ?? '',
    sources: await listResearchSources(runId),
    citations: await listCitationMappings(runId)
  };
}

export async function getSessionResearchSnapshot(sessionId: string) {
  const run = await getLatestResearchRunBySessionId(sessionId);
  if (!run) {
    return null;
  }
  const [steps, sources] = await Promise.all([listResearchSteps(run.id), listResearchSources(run.id)]);
  return { run, steps, sources };
}

export async function getSessionResearchSnapshotByProvider(sessionId: string, provider: ResearchProviderName) {
  const run = await getLatestResearchRunBySessionProvider(sessionId, provider);
  if (!run) return null;
  const [steps, sources, evidence] = await Promise.all([
    listResearchSteps(run.id),
    listResearchSources(run.id),
    listResearchEvidence(run.id)
  ]);
  return { run, steps, sources, evidence };
}

export async function getResearchSnapshotByRunId(runId: string) {
  const run = await getResearchRunById(runId);
  if (!run) return null;
  const [steps, sources, evidence] = await Promise.all([
    listResearchSteps(run.id),
    listResearchSources(run.id),
    listResearchEvidence(run.id)
  ]);
  return { run, steps, sources, evidence };
}

export async function listSessionResearchSnapshots(sessionId: string) {
  const runs = await listResearchRunsBySessionId(sessionId);
  const out: Array<{ run: (typeof runs)[number]; steps: unknown[]; sources: unknown[]; evidence: unknown[] }> = [];
  for (const run of runs) {
    const [steps, sources, evidence] = await Promise.all([
      listResearchSteps(run.id),
      listResearchSources(run.id),
      listResearchEvidence(run.id)
    ]);
    out.push({ run, steps, sources, evidence });
  }
  return out;
}
