import { getUserSettings } from './user-settings-repo';
import { pool } from './db';
import {
  createResearchRun,
  getLatestResearchRunBySessionId,
  getLatestResearchRunBySessionProvider,
  getResearchRunById,
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
import { executePipelineStep } from './research-provider';
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

async function withProviderDeepResearchLock<T>(
  provider: 'openai' | 'gemini',
  fn: () => Promise<T>
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  if (!pool) {
    const value = await fn();
    return { acquired: true, value };
  }

  const client = await pool.connect();
  const lockKey = `deep_research_provider:${provider}`;
  try {
    const rows = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [lockKey]);
    if (!rows.rows[0]?.ok) {
      return { acquired: false };
    }
    try {
      const value = await fn();
      return { acquired: true, value };
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
      } catch {
        // best-effort unlock
      }
    }
  } finally {
    client.release();
  }
}

function summarizePriorSteps(steps: Awaited<ReturnType<typeof listResearchSteps>>) {
  return steps
    .slice(-4)
    .map((s) => `Step ${s.step_index + 1} ${s.step_type}: ${(s.output_excerpt || s.raw_output || '').slice(0, 320)}`)
    .join('\n');
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
    targetSourcesPerStep: clamp(settings.research_target_sources_per_step, 1, 25),
    maxTotalSources: clamp(settings.research_max_total_sources, 5, 400),
    maxTokensPerStep: clamp(settings.research_max_tokens_per_step, 300, 8000),
    minWordCount: defaultWordTarget(settings.research_depth)
  });

  await updateResearchRun({
    runId: run.id,
    state: 'PLANNED',
    progress: {
      step_id: null,
      step_index: 0,
      total_steps: STEP_SEQUENCE.length,
      step_label: null,
      gap_loops: 0
    }
  });

  return { runId: run.id, needsClarification: false, clarifyingQuestions: [] };
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
  const totalSteps = STEP_SEQUENCE.length;

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
          step_id: STEP_SEQUENCE[currentIndex - 1],
          step_index: currentIndex - 1,
          total_steps: totalSteps,
          step_label: STEP_LABELS[STEP_SEQUENCE[currentIndex - 1]]
        }
      });
      return { state: 'IN_PROGRESS', done: false };
    }
    const fromStep = STEP_SEQUENCE[currentIndex - 1];
    const toStep = STEP_SEQUENCE[currentIndex];
    if (!canTransitionStep(fromStep, toStep)) {
      await updateResearchRun({
        runId,
        state: 'FAILED',
        errorMessage: `Invalid step transition: ${fromStep} -> ${toStep}`,
        completed: true
      });
      return { state: 'FAILED', done: true };
    }
  }

  const existingCurrent = existingSteps.find((s) => s.step_index === currentIndex);
  if (existingCurrent?.status === 'done') {
    currentIndex += 1;
    await updateResearchRun({
      runId,
      currentStepIndex: currentIndex,
      progress: {
        step_id: currentIndex < totalSteps ? STEP_SEQUENCE[currentIndex] : null,
        step_index: currentIndex,
        total_steps: totalSteps,
        step_label: currentIndex < totalSteps ? STEP_LABELS[STEP_SEQUENCE[currentIndex]] : null
      }
    });
    if (currentIndex >= totalSteps) {
      await updateResearchRun({ runId, state: 'DONE', completed: true });
      return { state: 'DONE', done: true };
    }
  }

  const stepId = STEP_SEQUENCE[currentIndex];
  const stepRecord = await upsertResearchStep({
    runId,
    stepIndex: currentIndex,
    stepType: stepId,
    status: 'running',
    provider: run.provider,
    mode: run.mode,
    stepGoal: `Execute ${stepId.toLowerCase().replace(/_/g, ' ')}`,
    inputsSummary: `step ${currentIndex + 1}/${totalSteps}`,
    started: true
  });

  try {
    const lock = await withProviderDeepResearchLock(run.provider, async () => {
      const stepsNow = await listResearchSteps(runId);
      const plan = parseJson<ResearchPlan | null>(run.research_plan_json, null);
      return executePipelineStep({
        provider: run.provider,
        stepType: stepId,
        question: run.question,
        timeoutMs:
          (run.provider === 'openai' ? settings.openai_timeout_minutes : settings.gemini_timeout_minutes) * 60_000,
        plan,
        priorStepSummary: summarizePriorSteps(stepsNow),
        sourceTarget: clamp(run.target_sources_per_step, 1, 30),
        maxOutputTokens: clamp(run.max_tokens_per_step, 300, 8000),
        maxCandidates: providerCfg.max_candidates,
        shortlistSize: providerCfg.shortlist_size
      });
    });

    if (!lock.acquired) {
      await upsertResearchStep({
        runId,
        stepIndex: currentIndex,
        stepType: stepId,
        status: 'queued',
        provider: run.provider,
        mode: run.mode,
        stepGoal: `Waiting lock: ${stepId}`,
        inputsSummary: 'Provider lock busy; will retry.'
      });
      return { state: 'IN_PROGRESS', done: false };
    }

    const artifact = lock.value;
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
      citationMap: [],
      nextStepProposal: artifact.next_step_hint,
      tokenUsage: artifact.token_usage as Record<string, unknown> | null,
      completed: true
    });

    await persistStepArtifacts({ runId, stepId: completedStep.id, artifact });

    if (stepId === 'DEVELOP_RESEARCH_PLAN') {
      const nextPlan = artifact.updatedPlan ?? parseJson<ResearchPlan | null>(run.research_plan_json, null);
      await updateResearchRun({ runId, plan: nextPlan, state: 'PLANNED' });
    }

    const progress = parseJson<Record<string, unknown>>(run.progress_json, {});
    if (stepId === 'GAP_CHECK' && artifact.structured_output) {
      const severe = Boolean((artifact.structured_output as Record<string, unknown>).severe_gaps);
      const currentLoops = Number(progress.gap_loops ?? 0);
      if (severe && currentLoops < providerCfg.max_gap_loops) {
        await updateResearchRun({
          runId,
          currentStepIndex: 1,
          progress: {
            step_id: STEP_SEQUENCE[1],
            step_index: 1,
            total_steps: totalSteps,
            step_label: STEP_LABELS[STEP_SEQUENCE[1]],
            gap_loops: currentLoops + 1
          }
        });
        return { state: 'IN_PROGRESS', done: false };
      }
    }

    const nextIndex = currentIndex + 1;
    const isDone = nextIndex >= totalSteps;
    await updateResearchRun({
      runId,
      currentStepIndex: nextIndex,
      progress: {
        step_id: isDone ? null : STEP_SEQUENCE[nextIndex],
        step_index: nextIndex,
        total_steps: totalSteps,
        step_label: isDone ? null : STEP_LABELS[STEP_SEQUENCE[nextIndex]],
        gap_loops: Number(progress.gap_loops ?? 0)
      },
      state: isDone ? 'DONE' : 'IN_PROGRESS',
      synthesizedReportMd: stepId === 'SECTION_SYNTHESIS' ? artifact.raw_output_text : undefined,
      synthesizedSources: stepId === 'SECTION_SYNTHESIS' ? (artifact.citations as unknown as Array<Record<string, unknown>>) : undefined,
      completed: isDone
    });

    return { state: isDone ? 'DONE' : 'IN_PROGRESS', done: isDone };
  } catch (error) {
    if (isRetryableResearchError(error)) {
      await upsertResearchStep({
        runId,
        stepIndex: currentIndex,
        stepType: stepId,
        status: 'queued',
        provider: run.provider,
        mode: run.mode,
        errorMessage: error instanceof Error ? error.message : 'Transient research step error'
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
