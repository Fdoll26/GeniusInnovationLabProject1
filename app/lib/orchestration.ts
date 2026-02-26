import './debug-errors';
import { getResponseOutputText, getResponseSources, pollDeepResearch, startResearchJob, startRefinement, rewritePrompt, summarizeForReport } from './openai-client';
import { runGemini, rewritePromptGemini, startRefinementGemini, summarizeForReportGemini } from './gemini-client';
import { createQuestions, getNextQuestion, listQuestions } from './refinement-repo';
import { updateSessionState, getSessionById } from './session-repo';
import { listProviderResults, upsertProviderResult } from './provider-repo';
import { buildPdfReport } from './pdf-report';
import { claimReportSendForSession, createReport, getReportBySession, updateReportContent, updateReportEmail, checkReportTiming } from './report-repo';
import { sendReportEmail } from './email-sender';
import type { SessionState } from './session-state';
import { getUserSettings } from './user-settings-repo';
import { pool } from './db';
import { getResearchSnapshotByRunId, getSessionResearchSnapshot, getSessionResearchSnapshotByProvider, startRun, tick } from './research-orchestrator';
import { parseDeepResearchJobPayload, type DeepResearchJobPayload } from './deep-research-job';
import {
  claimQueuedResearchRun,
  createResearchRun,
  initializePlannedResearchSteps,
  markResearchRunQueued,
  updateResearchRun,
  upsertResearchStep
} from './research-run-repo';
import { enqueueOpenAiLaneJob } from './queue/openai';
import { enqueueGeminiLaneJob } from './queue/gemini';
import { buildFallbackResearchPlan } from './research-plan-schema';
import { STEP_LABELS, STEP_SEQUENCE } from './research-types';

const inMemorySessionLocks = new Set<string>();

async function withSessionRunLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T | null> {
  const lockKey = `session_run:${sessionId}`;
  if (pool) {
    const client = await pool.connect();
    try {
      const result = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [lockKey]);
      if (!result.rows[0]?.ok) {
        return null;
      }
      try {
        return await fn();
      } finally {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
        } catch {
          // best-effort
        }
      }
    } finally {
      client.release();
    }
  }

  if (inMemorySessionLocks.has(lockKey)) {
    return null;
  }
  inMemorySessionLocks.add(lockKey);
  try {
    return await fn();
  } finally {
    inMemorySessionLocks.delete(lockKey);
  }
}

export async function regenerateReportForSession(
  sessionId: string,
  opts?: { stub?: boolean; stubPdf?: boolean; stubEmail?: boolean }
): Promise<{ reportId: string }> {
  const session = await getSessionById(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  if (session.state !== 'completed' && session.state !== 'partial') {
    throw new Error('Report regeneration is only available for completed sessions.');
  }
  const settings = await getUserSettings(session.user_id);

  const results = await listProviderResults(sessionId);
  const openaiResult = results.find((result) => result.provider === 'openai');
  const geminiResult = results.find((result) => result.provider === 'gemini');

  const summary = `OpenAI: ${openaiResult?.status ?? 'unknown'} | Gemini: ${geminiResult?.status ?? 'unknown'}`;

  const accessedAt = new Date().toISOString();
  const openaiSources = extractLinksFromText(openaiResult?.output_text ?? '');
  const geminiSourcesRaw = extractLinksFromText(geminiResult?.output_text ?? '');

  const globalRefMap = new Map<string, number>();
  const openaiRefs = openaiSources.map((source, index) => {
    const n = index + 1;
    globalRefMap.set(source.url, n);
    return { n, ...source, accessedAt };
  });
  const geminiRefs: Array<{ n: number; url: string; title?: string; accessedAt: string }> = [];
  for (const source of geminiSourcesRaw) {
    if (globalRefMap.has(source.url)) {
      continue;
    }
    const n = globalRefMap.size + 1;
    globalRefMap.set(source.url, n);
    geminiRefs.push({ n, ...source, accessedAt });
  }

  const openaiTextWithRefs = openaiResult?.output_text ? replaceLinksWithRefs(openaiResult.output_text, globalRefMap) : null;
  const geminiTextWithRefs = geminiResult?.output_text ? replaceLinksWithRefs(geminiResult.output_text, globalRefMap) : null;

  const includeRefs = false;
  type SummaryRef = { n: number; title?: string; url: string; accessedAt?: string };
  const summarize = async (provider: 'OpenAI' | 'Gemini' | 'Combined', text: string, refs: SummaryRef[]) => {
    const cleanText = stripSourcesSections(text);
    if (settings.summarize_provider === 'gemini') {
      return summarizeForReportGemini(
        { provider, researchText: cleanText, references: refs },
        { stub: opts?.stub ?? false, timeoutMs: settings.gemini_timeout_minutes * 60_000, includeRefs }
      );
    }
    return summarizeForReport(
      { provider: provider === 'Combined' ? 'OpenAI' : provider, researchText: cleanText, references: refs },
      { stub: opts?.stub ?? false, timeoutMs: settings.openai_timeout_minutes * 60_000, includeRefs }
    );
  };

  let finalOpenaiSummary = 'No OpenAI result available.';
  let finalGeminiSummary = 'No Gemini result available.';

  if (settings.report_summary_mode === 'one') {
    const combinedText = [openaiTextWithRefs, geminiTextWithRefs].filter(Boolean).join('\n\n');
    const combinedRefs = [...openaiRefs, ...geminiRefs];
    finalOpenaiSummary = combinedText ? await summarize('Combined', combinedText, combinedRefs) : 'No research result available.';
    finalGeminiSummary = '';
  } else {
    finalOpenaiSummary = openaiTextWithRefs ? await summarize('OpenAI', openaiTextWithRefs, openaiRefs) : finalOpenaiSummary;
    finalGeminiSummary = geminiTextWithRefs ? await summarize('Gemini', geminiTextWithRefs, geminiRefs) : finalGeminiSummary;
  }

  const pdfBuffer = await buildPdfReport(
    {
      sessionId,
      topic: session.topic,
      refinedPrompt: session.refined_prompt,
      summaryMode: settings.report_summary_mode,
      openaiSummary: finalOpenaiSummary,
      geminiSummary: finalGeminiSummary,
      references: {
        openai: openaiRefs,
        gemini: geminiRefs
      },
      openaiText: openaiTextWithRefs ?? null,
      geminiText: geminiTextWithRefs ?? null,
      openaiSources: openaiResult?.sources_json ?? null,
      geminiSources: geminiResult?.sources_json ?? null,
      createdAt: session.created_at
    },
    { stub: opts?.stubPdf ?? opts?.stub }
  );

  // Do not overwrite previously sent reports. Create a fresh report row for this resend.
  const report = await createReport({ sessionId, summary, pdfBuffer, emailStatus: 'pending' });

  const email = await resolveUserEmail(sessionId);
  try {
    await sendReportEmail(
      {
        to: email,
        subject: 'Your Research Report',
        summary: report.summary_text || summary,
        pdfBuffer
      },
      { stub: opts?.stubEmail ?? opts?.stub }
    );
    try {
      await updateReportEmail({
        reportId: report.id,
        emailStatus: 'sent',
        sentAt: new Date().toISOString()
      });
    } catch (markSentError) {
      console.error('Regenerated report delivered but failed to mark as sent', markSentError);
    }
  } catch (error) {
    console.error('Regenerated report email send failed', error);
    await updateReportEmail({
      reportId: report.id,
      emailStatus: 'failed',
      emailError: error instanceof Error ? error.message : 'Email error'
    });
    throw error instanceof Error ? error : new Error('Email send failed');
  }

  return { reportId: report.id };
}

export async function runRefinement(
  sessionId: string,
  topic: string,
  opts?: { stub?: boolean; stubRefiner?: boolean }
) {
  const session = await getSessionById(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  const settings = await getUserSettings(session.user_id);

  const refinement =
    settings.refine_provider === 'gemini'
      ? await startRefinementGemini(topic, { stub: opts?.stubRefiner ?? opts?.stub, timeoutMs: settings.gemini_timeout_minutes * 60_000 })
      : await startRefinement(topic, { stub: opts?.stubRefiner ?? opts?.stub, timeoutMs: settings.openai_timeout_minutes * 60_000 });
  if (refinement.questions.length > 0) {
    await createQuestions({ sessionId, questions: refinement.questions });
    await updateSessionState({ sessionId, state: 'refining' });
    return;
  }

  let refinedPrompt = topic;
  try {
    if (settings.refine_provider === 'gemini') {
      refinedPrompt = await rewritePromptGemini(
        { topic, draftPrompt: topic, clarifications: [] },
        { stub: opts?.stubRefiner ?? opts?.stub, timeoutMs: settings.gemini_timeout_minutes * 60_000 }
      );
    } else {
      refinedPrompt = await rewritePrompt(
        { topic, draftPrompt: topic, clarifications: [] },
        { stub: opts?.stubRefiner ?? opts?.stub, timeoutMs: settings.openai_timeout_minutes * 60_000 }
      );
    }
  } catch (error) {
    console.error('Prompt rewrite failed, using original topic', error);
  }
  await updateSessionState({
    sessionId,
    state: 'refining',
    refinedPrompt
  });
}

export async function handleRefinementApproval(
  sessionId: string,
  refinedPrompt: string,
  opts?: {
    stub?: boolean;
    stubRefiner?: boolean;
    stubOpenAI?: boolean;
    stubGemini?: boolean;
    stubEmail?: boolean;
    stubPdf?: boolean;
    skipOpenAI?: boolean;
    skipGemini?: boolean;
  }
) {
  const questions = await listQuestions(sessionId);
  const clarifications = questions
    .filter((question) => question.answer_text)
    .map((question) => ({
      question: question.question_text,
      answer: question.answer_text as string
    }));
  let finalPrompt = refinedPrompt;
  try {
    const session = await getSessionById(sessionId);
    if (session) {
      const settings = await getUserSettings(session.user_id);
      if (settings.refine_provider === 'gemini') {
        finalPrompt = await rewritePromptGemini(
          {
            topic: session.topic,
            draftPrompt: refinedPrompt,
            clarifications
          },
          { stub: opts?.stubRefiner ?? opts?.stub, timeoutMs: settings.gemini_timeout_minutes * 60_000 }
        );
      } else {
        finalPrompt = await rewritePrompt(
          {
            topic: session.topic,
            draftPrompt: refinedPrompt,
            clarifications
          },
          { stub: opts?.stubRefiner ?? opts?.stub, timeoutMs: settings.openai_timeout_minutes * 60_000 }
        );
      }
    }
  } catch (error) {
    console.error('Prompt rewrite failed, using draft prompt', error);
  }

  await updateSessionState({
    sessionId,
    state: 'running_research',
    refinedPrompt: finalPrompt,
    refinedAt: new Date().toISOString()
  });

  await runProviders(sessionId, opts);
}

type SourceRef = { title?: string; url: string };

function stripTrailingPunctuation(url: string) {
  // Keep this conservative; we only want to remove punctuation that is very commonly adjacent.
  const match = url.match(/^(.*?)([)\],.?!:;"']+)?$/);
  if (!match) {
    return { url, suffix: '' };
  }
  const core = match[1] ?? url;
  const suffix = match[2] ?? '';
  return { url: core, suffix };
}

function extractLinksFromText(text: string, maxItems = 40): SourceRef[] {
  const out: SourceRef[] = [];
  const seen = new Set<string>();
  const regex = /https?:\/\/[^\s<>"']+/g;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    if (!raw) {
      continue;
    }
    const { url } = stripTrailingPunctuation(raw);
    if (!/^https?:\/\//i.test(url)) {
      continue;
    }
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    out.push({ url });
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

function replaceLinksWithRefs(text: string, refMap: Map<string, number>) {
  // Handle markdown links first: [label](https://example.com) -> [n]
  const markdownLinked = text.replace(/\[[^\]]+\]\((https?:\/\/[^\s<>"')]+)\)/g, (whole, url: string) => {
    const { url: cleanUrl } = stripTrailingPunctuation(url);
    const n = refMap.get(cleanUrl);
    return n ? `[${n}]` : whole;
  });

  // First handle bracketed URLs like: [https://example.com] -> [n]
  // This avoids creating doubled brackets like: [[n]].
  const bracketed = markdownLinked.replace(/\[(https?:\/\/[^\s<>"'\]]+)\]/g, (_whole, url: string) => {
    const { url: cleanUrl } = stripTrailingPunctuation(url);
    const n = refMap.get(cleanUrl);
    return n ? `[${n}]` : `[${cleanUrl}]`;
  });

  const regex = /https?:\/\/[^\s<>"']+/g;
  return bracketed.replace(regex, (raw) => {
    const { url, suffix } = stripTrailingPunctuation(raw);
    const n = refMap.get(url);
    if (!n) {
      return raw;
    }
    return `[${n}]${suffix}`;
  });
}

type DeepResearchTransitionContext = {
  topicId: string;
  modelRunId: string;
  provider: 'openai' | 'gemini';
  stepId: string | null;
  jobId: string;
  attempt: number;
  providerResponseId?: string | null;
  status?: string;
  message?: string;
};

function extractStepId(progress: unknown): string | null {
  if (!progress || typeof progress !== 'object') return null;
  const stepId = (progress as Record<string, unknown>).step_id;
  return typeof stepId === 'string' && stepId.trim() ? stepId : null;
}

function logDeepResearchTransition(event: string, context: DeepResearchTransitionContext) {
  console.info(
    JSON.stringify({
      event: `deep_research.${event}`,
      topicId: context.topicId,
      modelRunId: context.modelRunId,
      provider: context.provider,
      stepId: context.stepId,
      jobId: context.jobId,
      attempt: context.attempt,
      providerResponseId: context.providerResponseId ?? null,
      status: context.status ?? null,
      message: context.message ?? null
    })
  );
}

function buildDeepResearchJob(params: {
  topicId: string;
  modelRunId: string;
  provider: 'openai' | 'gemini';
  attempt: number;
}): DeepResearchJobPayload {
  return parseDeepResearchJobPayload({
    topicId: params.topicId,
    modelRunId: params.modelRunId,
    provider: params.provider,
    attempt: params.attempt,
    jobId: `${params.provider}:${params.modelRunId}:${params.attempt}`,
    idempotencyKey: `${params.provider}:${params.modelRunId}:${params.attempt}`
  });
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function defaultWordTarget(depth: 'light' | 'standard' | 'deep') {
  if (depth === 'deep') return 6000;
  if (depth === 'light') return 1200;
  return 2500;
}

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

function stripSourcesSections(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const markers = ['\n## Unified Sources', '\n## Sources', '\n# Sources', '\nSources\n'];
  let cut = -1;
  for (const marker of markers) {
    const idx = normalized.indexOf(marker);
    if (idx >= 0 && (cut < 0 || idx < cut)) {
      cut = idx;
    }
  }
  return cut < 0 ? normalized : normalized.slice(0, cut).trim();
}

function sanitizeSourcesForProviderResult(sources: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(sources)) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const rec = source as Record<string, unknown>;
    const url = typeof rec.url === 'string' ? rec.url.trim() : '';
    if (!url) continue;
    const row: Record<string, unknown> = { url };
    if (typeof rec.citation_id === 'string' && rec.citation_id.trim()) row.citation_id = rec.citation_id;
    if (typeof rec.title === 'string' || rec.title == null) row.title = rec.title ?? null;
    if (typeof rec.publisher === 'string' || rec.publisher == null) row.publisher = rec.publisher ?? null;
    if (typeof rec.accessed_at === 'string' && rec.accessed_at.trim()) row.accessed_at = rec.accessed_at;
    if (Array.isArray(rec.reliability_tags)) {
      row.reliability_tags = rec.reliability_tags.filter((tag): tag is string => typeof tag === 'string');
    }
    out.push(row);
  }
  return out;
}

async function ensureStubResearchRun(params: {
  sessionId: string;
  userId: string;
  provider: 'openai' | 'gemini';
  question: string;
  existingModelRunId?: string | null;
}) {
  let snapshot =
    params.existingModelRunId
      ? await getResearchSnapshotByRunId(params.existingModelRunId)
      : await getSessionResearchSnapshotByProvider(params.sessionId, params.provider);
  if (snapshot && (snapshot.run.session_id !== params.sessionId || snapshot.run.provider !== params.provider)) {
    snapshot = null;
  }
  if (snapshot && snapshot.run.state !== 'FAILED' && snapshot.run.state !== 'DONE') {
    return snapshot.run.id;
  }

  const settings = await getUserSettings(params.userId);
  const maxSteps = STEP_SEQUENCE.length;
  const targetSourcesPerStep = clamp(settings.research_target_sources_per_step, 1, 25);
  const maxTotalSources = clamp(settings.research_max_total_sources, 5, 400);
  const maxTokensPerStep = clamp(settings.research_max_tokens_per_step, 300, 8000);
  const plan = buildFallbackResearchPlan({
    refinedTopic: params.question,
    sourceTarget: targetSourcesPerStep,
    maxTokensPerStep,
    maxTotalSources
  });
  const run = await createResearchRun({
    sessionId: params.sessionId,
    provider: params.provider,
    mode: settings.research_mode,
    depth: settings.research_depth,
    question: params.question,
    maxSteps,
    targetSourcesPerStep,
    maxTotalSources,
    maxTokensPerStep,
    minWordCount: defaultWordTarget(settings.research_depth)
  });
  await updateResearchRun({
    runId: run.id,
    state: 'PLANNED',
    plan,
    assumptions: plan.assumptions,
    brief: {
      audience: 'General',
      scope: 'Stubbed provider lane',
      depth: settings.research_depth
    },
    progress: {
      step_id: STEP_SEQUENCE[0],
      step_index: 0,
      total_steps: STEP_SEQUENCE.length,
      step_label: STEP_LABELS[STEP_SEQUENCE[0]],
      gap_loops: 0
    }
  });
  await initializePlannedResearchSteps({
    runId: run.id,
    provider: run.provider,
    mode: run.mode,
    steps: plan.steps.map((step, idx) => ({
      stepIndex: step.step_index ?? idx,
      stepType: step.step_type,
      stepGoal: step.objective,
      inputsSummary: `planned queries=${step.search_query_pack.length} source_types=${step.target_source_types.length}`
    }))
  });
  return run.id;
}

async function completeStubRun(params: {
  runId: string;
  provider: 'openai' | 'gemini';
  refinedPrompt: string;
}) {
  const snapshot = await getResearchSnapshotByRunId(params.runId);
  if (!snapshot) {
    throw new Error(`ModelRun ${params.runId} not found for stub completion`);
  }
  const run = snapshot.run;
  const baseMessage = `Stubbed ${params.provider} lane via DEV_STUB_${params.provider.toUpperCase()} for prompt: ${params.refinedPrompt}`;
  const plan = parseJson<{ steps?: Array<{ step_type?: string }> } | null>(run.research_plan_json, null);
  const plannedTypes = (plan?.steps ?? [])
    .map((step) => step?.step_type)
    .filter((value): value is (typeof STEP_SEQUENCE)[number] => STEP_SEQUENCE.includes(value as (typeof STEP_SEQUENCE)[number]));
  const stepTypes = plannedTypes.length > 0 ? plannedTypes : [...STEP_SEQUENCE];

  for (let idx = 0; idx < stepTypes.length; idx += 1) {
    const stepType = stepTypes[idx];
    await upsertResearchStep({
      runId: run.id,
      stepIndex: idx,
      stepType,
      status: 'done',
      provider: run.provider,
      mode: run.mode,
      stepGoal: `Stubbed: ${STEP_LABELS[stepType]}`,
      inputsSummary: 'Skipped external API call in stub mode',
      rawOutput: `${baseMessage}. Step "${STEP_LABELS[stepType]}" marked stubbed.`,
      outputExcerpt: `${baseMessage}.`,
      toolsUsed: [],
      providerNative: { stubbed: true, provider: params.provider, stepType },
      completed: true,
      started: true
    });
  }

  const synthesizedReport = `${baseMessage}\n\nNo external API calls were made for this provider lane.`;
  await updateResearchRun({
    runId: run.id,
    state: 'DONE',
    currentStepIndex: stepTypes.length,
    progress: {
      step_id: null,
      step_index: stepTypes.length,
      total_steps: stepTypes.length,
      step_label: null
    },
    synthesizedReportMd: synthesizedReport,
    synthesizedSources: [],
    completed: true
  });
  return synthesizedReport;
}

async function processDeepResearchJob(params: {
  job: DeepResearchJobPayload;
}) {
  const { job } = params;
  const logContext: DeepResearchTransitionContext = {
    topicId: job.topicId,
    modelRunId: job.modelRunId,
    provider: job.provider,
    stepId: null,
    jobId: job.jobId,
    attempt: job.attempt
  };

  logDeepResearchTransition('received', { ...logContext, status: 'running' });
  try {
    const snapshot = await getResearchSnapshotByRunId(job.modelRunId);
    const stepId = snapshot ? extractStepId(snapshot.run.progress_json) : null;
    const runLogContext = { ...logContext, stepId };

    if (!snapshot) {
      const errorMessage = `ModelRun ${job.modelRunId} not found for job ${job.jobId}`;
      await upsertProviderResult({
        sessionId: job.topicId,
        modelRunId: job.modelRunId,
        provider: job.provider,
        status: 'failed',
        errorMessage,
        completedAt: new Date().toISOString(),
        lastPolledAt: new Date().toISOString()
      });
      logDeepResearchTransition('failed', { ...runLogContext, status: 'failed', message: errorMessage });
      return { terminal: true as const };
    }

    const mismatch: string[] = [];
    if (snapshot.run.session_id !== job.topicId) {
      mismatch.push(`topic_id mismatch: run.session_id=${snapshot.run.session_id}, job.topicId=${job.topicId}`);
    }
    if (snapshot.run.provider !== job.provider) {
      mismatch.push(`provider mismatch: run.provider=${snapshot.run.provider}, job.provider=${job.provider}`);
    }
    if (mismatch.length > 0) {
      const errorMessage = `PAYLOAD_RUN_MISMATCH: ${mismatch.join('; ')}`;
      await updateResearchRun({
        runId: job.modelRunId,
        state: 'FAILED',
        errorMessage,
        completed: true
      });
      await upsertProviderResult({
        sessionId: job.topicId,
        modelRunId: job.modelRunId,
        provider: job.provider,
        status: 'failed',
        errorMessage,
        completedAt: new Date().toISOString(),
        lastPolledAt: new Date().toISOString()
      });
      logDeepResearchTransition('guard_failed', { ...runLogContext, status: 'failed', message: errorMessage });
      return { terminal: true as const };
    }

    const claimed = await claimQueuedResearchRun(job.modelRunId);
    if (!claimed) {
      logDeepResearchTransition('duplicate_noop', {
        ...runLogContext,
        status: 'skipped',
        message: 'model run already claimed or not queued'
      });
      return { terminal: true as const };
    }

    const nowIso = new Date().toISOString();
    await upsertProviderResult({
      sessionId: job.topicId,
      modelRunId: job.modelRunId,
      provider: job.provider,
      status: 'running',
      startedAt: nowIso,
      lastPolledAt: nowIso
    });
    logDeepResearchTransition('running', { ...runLogContext, status: 'running' });

    const tickResult = await tick(job.modelRunId);
    const completedSnapshot = await getResearchSnapshotByRunId(job.modelRunId);
    const nextStepId = completedSnapshot ? extractStepId(completedSnapshot.run.progress_json) : null;

    if (tickResult.done) {
      const synthesized = completedSnapshot?.run?.synthesized_report_md;
      const hasSynthesis = typeof synthesized === 'string' && synthesized.trim().length > 0;
      const terminalFailed = tickResult.state === 'FAILED' || !hasSynthesis;
      const terminalErrorMessage =
        tickResult.state === 'FAILED'
          ? completedSnapshot?.run?.error_message ?? 'Provider run failed'
          : 'Provider completed without synthesized output';
      await upsertProviderResult({
        sessionId: job.topicId,
        modelRunId: job.modelRunId,
        provider: job.provider,
        status: terminalFailed ? 'failed' : 'completed',
        outputText: hasSynthesis ? synthesized : null,
        sources: sanitizeSourcesForProviderResult(completedSnapshot?.sources ?? null),
        errorMessage: terminalFailed ? terminalErrorMessage : null,
        completedAt: new Date().toISOString(),
        lastPolledAt: new Date().toISOString()
      });
      logDeepResearchTransition('terminal', {
        ...runLogContext,
        stepId: nextStepId,
        status: terminalFailed ? 'failed' : 'completed',
        message: terminalFailed ? terminalErrorMessage : undefined
      });
      return { terminal: true as const };
    }

    await upsertProviderResult({
      sessionId: job.topicId,
      modelRunId: job.modelRunId,
      provider: job.provider,
      status: 'running',
      lastPolledAt: new Date().toISOString()
    });
    logDeepResearchTransition('progressed', { ...runLogContext, stepId: nextStepId, status: 'running' });
    return { terminal: false as const };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Provider lane execution failed';
    const nowIso = new Date().toISOString();
    const isModelRunMismatch = errorMessage.toLowerCase().includes('model_run_id mismatch');
    await Promise.allSettled([
      updateResearchRun({
        runId: job.modelRunId,
        state: 'FAILED',
        errorMessage,
        completed: true
      }),
      upsertProviderResult({
        sessionId: job.topicId,
        modelRunId: job.modelRunId,
        provider: job.provider,
        status: 'failed',
        errorMessage,
        completedAt: nowIso,
        lastPolledAt: nowIso
      }),
      ...(isModelRunMismatch
        ? ([
            upsertProviderResult({
              sessionId: job.topicId,
              modelRunId: null,
              provider: job.provider,
              status: 'failed',
              errorMessage,
              completedAt: nowIso,
              lastPolledAt: nowIso
            })
          ] as const)
        : [])
    ]);
    logDeepResearchTransition('failed', {
      ...logContext,
      status: 'failed',
      message: isModelRunMismatch ? `${errorMessage} (stale row recovered)` : errorMessage
    });
    return { terminal: true as const };
  }
}

async function advanceProviderFromQueue(params: {
  provider: 'openai' | 'gemini';
  sessionId: string;
  modelRunId?: string | null;
  refinedPrompt: string;
  userId: string;
  opts?: {
    stub?: boolean;
    stubOpenAI?: boolean;
    stubGemini?: boolean;
    skipOpenAI?: boolean;
    skipGemini?: boolean;
  };
}) {
  const nowIso = new Date().toISOString();
  const skip = params.provider === 'openai' ? params.opts?.skipOpenAI : params.opts?.skipGemini;
  const stub = params.provider === 'openai' ? params.opts?.stubOpenAI ?? params.opts?.stub : params.opts?.stubGemini ?? params.opts?.stub;
  if (skip) {
    logDeepResearchTransition('terminal', {
      topicId: params.sessionId,
      modelRunId: params.modelRunId ?? 'skip:no-model-run',
      provider: params.provider,
      stepId: null,
      jobId: `${params.provider}:${params.sessionId}:skip`,
      attempt: 1,
      status: 'skipped'
    });
    await upsertProviderResult({
      sessionId: params.sessionId,
      modelRunId: params.modelRunId ?? null,
      provider: params.provider,
      status: 'skipped',
      outputText: `${params.provider} run skipped (debug)`,
      completedAt: nowIso,
      lastPolledAt: nowIso
    });
    return { terminal: true as const };
  }

  if (stub && process.env.DATABASE_URL) {
    try {
      const runId = await ensureStubResearchRun({
        sessionId: params.sessionId,
        userId: params.userId,
        provider: params.provider,
        question: params.refinedPrompt,
        existingModelRunId: params.modelRunId ?? null
      });
      const outputText = await completeStubRun({
        runId,
        provider: params.provider,
        refinedPrompt: params.refinedPrompt
      });
      await upsertProviderResult({
        sessionId: params.sessionId,
        modelRunId: runId,
        provider: params.provider,
        status: 'stubbed',
        outputText,
        sources: [],
        startedAt: nowIso,
        completedAt: nowIso,
        lastPolledAt: nowIso
      });
      logDeepResearchTransition('terminal', {
        topicId: params.sessionId,
        modelRunId: runId,
        provider: params.provider,
        stepId: null,
        jobId: `${params.provider}:${runId}:stubbed`,
        attempt: 1,
        status: 'stubbed'
      });
      return { terminal: true as const };
    } catch (error) {
      await upsertProviderResult({
        sessionId: params.sessionId,
        modelRunId: params.modelRunId ?? null,
        provider: params.provider,
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Stub provider error',
        completedAt: new Date().toISOString(),
        lastPolledAt: new Date().toISOString()
      });
      return { terminal: true as const };
    }
  }

  if (!process.env.DATABASE_URL) {
    const settings = await getUserSettings(params.userId);
    const legacyJobId = `${params.provider}:${params.sessionId}:legacy`;
    const legacyContext: DeepResearchTransitionContext = {
      topicId: params.sessionId,
      modelRunId: 'legacy:no-model-run',
      provider: params.provider,
      stepId: null,
      jobId: legacyJobId,
      attempt: 1
    };
    try {
      if (params.provider === 'openai') {
        const started = await startResearchJob(params.refinedPrompt, {
          stub: params.opts?.stubOpenAI ?? params.opts?.stub,
          timeoutMs: settings.openai_timeout_minutes * 60_000,
          maxSources: settings.max_sources,
          reasoningLevel: settings.reasoning_level
        });
        await upsertProviderResult({
          sessionId: params.sessionId,
          provider: 'openai',
          status: 'completed',
          outputText: getResponseOutputText(started.data),
          sources: getResponseSources(started.data) ?? null,
          completedAt: new Date().toISOString(),
          lastPolledAt: new Date().toISOString()
        });
        logDeepResearchTransition('terminal', {
          ...legacyContext,
          providerResponseId: started.responseId,
          status: 'completed'
        });
      } else {
        const out = await runGemini(params.refinedPrompt, {
          stub: params.opts?.stubGemini ?? params.opts?.stub,
          timeoutMs: settings.gemini_timeout_minutes * 60_000,
          maxSources: settings.max_sources
        });
        await upsertProviderResult({
          sessionId: params.sessionId,
          provider: 'gemini',
          status: 'completed',
          outputText: out.outputText,
          sources: out.sources ?? null,
          completedAt: new Date().toISOString(),
          lastPolledAt: new Date().toISOString()
        });
        logDeepResearchTransition('terminal', { ...legacyContext, status: 'completed' });
      }
      return { terminal: true as const };
    } catch (error) {
      await upsertProviderResult({
        sessionId: params.sessionId,
        provider: params.provider,
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Provider error',
        completedAt: new Date().toISOString(),
        lastPolledAt: new Date().toISOString()
      });
      logDeepResearchTransition('failed', {
        ...legacyContext,
        status: 'failed',
        message: error instanceof Error ? error.message : 'Provider error'
      });
      return { terminal: true as const };
    }
  }

  let snapshot =
    params.modelRunId
      ? await getResearchSnapshotByRunId(params.modelRunId)
      : await getSessionResearchSnapshotByProvider(params.sessionId, params.provider);
  if (snapshot && (snapshot.run.session_id !== params.sessionId || snapshot.run.provider !== params.provider)) {
    snapshot = null;
  }
  const shouldStart =
    !snapshot ||
    snapshot.run.state === 'FAILED' ||
    snapshot.run.state === 'DONE';
  if (shouldStart) {
    await startRun({
      sessionId: params.sessionId,
      userId: params.userId,
      question: params.refinedPrompt,
      provider: params.provider,
      allowClarifications: false
    });
    snapshot = await getSessionResearchSnapshotByProvider(params.sessionId, params.provider);
  }
  if (!snapshot) {
    await upsertProviderResult({
      sessionId: params.sessionId,
      modelRunId: params.modelRunId ?? null,
      provider: params.provider,
      status: 'failed',
      errorMessage: 'Failed to initialize provider research run',
      completedAt: nowIso,
      lastPolledAt: nowIso
    });
    return { terminal: true as const };
  }
  const job = buildDeepResearchJob({
    topicId: params.sessionId,
    modelRunId: snapshot.run.id,
    provider: params.provider,
    attempt: 1
  });

  return processDeepResearchJob({
    job
  });
}

async function runProvidersLegacy(
  sessionId: string,
  opts?: {
    stub?: boolean;
    stubOpenAI?: boolean;
    stubGemini?: boolean;
    stubEmail?: boolean;
    stubPdf?: boolean;
    skipOpenAI?: boolean;
    skipGemini?: boolean;
  }
) {
  const nowIso = new Date().toISOString();
  const existingResults = await listProviderResults(sessionId);
  const existingByProvider = new Map(existingResults.map((r) => [r.provider, r]));
  const session = await getSessionById(sessionId);

  const ensureModelRunId = async (provider: 'openai' | 'gemini', existingModelRunId?: string | null) => {
    if (!process.env.DATABASE_URL) {
      return null;
    }
    const providerStub = provider === 'openai' ? opts?.stubOpenAI ?? opts?.stub : opts?.stubGemini ?? opts?.stub;
    if (existingModelRunId) {
      const existingSnapshot = await getResearchSnapshotByRunId(existingModelRunId);
      if (existingSnapshot && existingSnapshot.run.session_id === sessionId && existingSnapshot.run.provider === provider) {
        return existingSnapshot.run.id;
      }
    }
    const latest = await getSessionResearchSnapshotByProvider(sessionId, provider);
    if (latest && latest.run.state !== 'FAILED' && latest.run.state !== 'DONE') {
      return latest.run.id;
    }
    if (!session?.refined_prompt) {
      return null;
    }
    if (providerStub) {
      return ensureStubResearchRun({
        sessionId,
        userId: session.user_id,
        provider,
        question: session.refined_prompt,
        existingModelRunId: existingModelRunId ?? null
      });
    }
    await startRun({
      sessionId,
      userId: session.user_id,
      question: session.refined_prompt,
      provider,
      allowClarifications: false
    });
    const created = await getSessionResearchSnapshotByProvider(sessionId, provider);
    return created?.run.id ?? null;
  };

  const existingOpenAi = existingByProvider.get('openai');
  const laneJobs: Array<Promise<{ terminal: boolean }>> = [];

  if (existingOpenAi?.status !== 'completed' && existingOpenAi?.status !== 'running' && existingOpenAi?.status !== 'stubbed' && !opts?.skipOpenAI) {
    const modelRunId = await ensureModelRunId('openai', existingOpenAi?.model_run_id ?? null);
    await upsertProviderResult({
      sessionId,
      modelRunId,
      provider: 'openai',
      status: 'queued',
      queuedAt: nowIso,
      lastPolledAt: nowIso
    });
    if (session?.refined_prompt) {
      if (modelRunId) {
        await markResearchRunQueued(modelRunId);
      }
      const job = buildDeepResearchJob({
        topicId: sessionId,
        modelRunId: modelRunId ?? `legacy:openai:${sessionId}`,
        provider: 'openai',
        attempt: 1
      });
      laneJobs.push(
        enqueueOpenAiLaneJob({
          job,
          task: () =>
            advanceProviderFromQueue({
              provider: 'openai',
              sessionId,
              modelRunId,
              refinedPrompt: session.refined_prompt as string,
              userId: session.user_id,
              opts
            })
        })
      );
    }
  } else if (existingOpenAi?.status === 'running' && !opts?.skipOpenAI && session?.refined_prompt) {
    const modelRunId = await ensureModelRunId('openai', existingOpenAi?.model_run_id ?? null);
    if (modelRunId) {
      await markResearchRunQueued(modelRunId);
    }
    const job = buildDeepResearchJob({
      topicId: sessionId,
      modelRunId: modelRunId ?? `legacy:openai:${sessionId}`,
      provider: 'openai',
      attempt: 1
    });
    laneJobs.push(
      enqueueOpenAiLaneJob({
        job,
        task: () =>
          advanceProviderFromQueue({
            provider: 'openai',
            sessionId,
            modelRunId,
            refinedPrompt: session.refined_prompt as string,
            userId: session.user_id,
            opts
          })
      })
    );
  }

  if (opts?.skipOpenAI && existingOpenAi?.status !== 'completed' && existingOpenAi?.status !== 'stubbed') {
    const modelRunId = await ensureModelRunId('openai', existingOpenAi?.model_run_id ?? null);
    await upsertProviderResult({
      sessionId,
      modelRunId,
      provider: 'openai',
      status: 'skipped',
      outputText: 'OpenAI run skipped (debug)',
      completedAt: nowIso,
      lastPolledAt: nowIso
    });
  }

  const existingGemini = existingByProvider.get('gemini');
  if (existingGemini?.status !== 'completed' && existingGemini?.status !== 'running' && existingGemini?.status !== 'stubbed' && !opts?.skipGemini) {
    const modelRunId = await ensureModelRunId('gemini', existingGemini?.model_run_id ?? null);
    await upsertProviderResult({
      sessionId,
      modelRunId,
      provider: 'gemini',
      status: 'queued',
      queuedAt: nowIso,
      lastPolledAt: nowIso
    });
    if (session?.refined_prompt) {
      if (modelRunId) {
        await markResearchRunQueued(modelRunId);
      }
      const job = buildDeepResearchJob({
        topicId: sessionId,
        modelRunId: modelRunId ?? `legacy:gemini:${sessionId}`,
        provider: 'gemini',
        attempt: 1
      });
      laneJobs.push(
        enqueueGeminiLaneJob({
          job,
          task: () =>
            advanceProviderFromQueue({
              provider: 'gemini',
              sessionId,
              modelRunId,
              refinedPrompt: session.refined_prompt as string,
              userId: session.user_id,
              opts
            })
        })
      );
    }
  } else if (existingGemini?.status === 'running' && !opts?.skipGemini && session?.refined_prompt) {
    const modelRunId = await ensureModelRunId('gemini', existingGemini?.model_run_id ?? null);
    if (modelRunId) {
      await markResearchRunQueued(modelRunId);
    }
    const job = buildDeepResearchJob({
      topicId: sessionId,
      modelRunId: modelRunId ?? `legacy:gemini:${sessionId}`,
      provider: 'gemini',
      attempt: 1
    });
    laneJobs.push(
      enqueueGeminiLaneJob({
        job,
        task: () =>
          advanceProviderFromQueue({
            provider: 'gemini',
            sessionId,
            modelRunId,
            refinedPrompt: session.refined_prompt as string,
            userId: session.user_id,
            opts
          })
      })
    );
  }

  if (opts?.skipGemini && existingGemini?.status !== 'completed' && existingGemini?.status !== 'stubbed') {
    const modelRunId = await ensureModelRunId('gemini', existingGemini?.model_run_id ?? null);
    await upsertProviderResult({
      sessionId,
      modelRunId,
      provider: 'gemini',
      status: 'skipped',
      outputText: 'Gemini run skipped (debug)',
      completedAt: nowIso,
      lastPolledAt: nowIso
    });
  }
  await Promise.all(laneJobs);
}

async function syncSessionLegacy(
  sessionId: string,
  session: NonNullable<Awaited<ReturnType<typeof getSessionById>>>,
  opts?: { stub?: boolean; stubPdf?: boolean; stubEmail?: boolean }
) {
  const settings = await getUserSettings(session.user_id);
  const nowIso = new Date().toISOString();
  const queuedStaleMs = Math.max(settings.openai_timeout_minutes, settings.gemini_timeout_minutes) * 60_000 + 5 * 60_000;
  const results = await listProviderResults(sessionId);
  const openai = results.find((r) => r.provider === 'openai');
  const gemini = results.find((r) => r.provider === 'gemini');

  const maybeRepairQueued = async (
    provider: 'openai' | 'gemini',
    result?: { status?: string; model_run_id?: string | null; started_at?: string | null; last_polled_at?: string | null }
  ) => {
    if (!result || result.status !== 'queued') return;
    if (result.started_at) return;
    const sinceRaw = result.last_polled_at ?? session.updated_at ?? session.created_at ?? null;
    const sinceMs = sinceRaw ? new Date(sinceRaw).getTime() : NaN;
    if (!Number.isFinite(sinceMs)) return;
    if (Date.now() - sinceMs <= queuedStaleMs) return;
    await upsertProviderResult({
      sessionId,
      modelRunId: result?.model_run_id ?? null,
      provider,
      status: 'failed',
      errorMessage: 'Provider work was queued too long (likely interrupted). Retry to run again.',
      completedAt: nowIso,
      lastPolledAt: nowIso
    });
  };

  await Promise.all([
    maybeRepairQueued('openai', openai),
    maybeRepairQueued('gemini', gemini)
  ]);

  const updatedResults = await listProviderResults(sessionId);
  const stillInFlight = updatedResults.some((r) => r.status === 'running' || r.status === 'queued');
  const terminal = new Set(['completed', 'failed', 'skipped', 'stubbed']);
  const allTerminal = updatedResults.length > 0 && updatedResults.every((r) => terminal.has(r.status));
  if (!stillInFlight && allTerminal) {
    await updateSessionState({ sessionId, state: 'aggregating' });
    const openai2 = updatedResults.find((r) => r.provider === 'openai');
    const gemini2 = updatedResults.find((r) => r.provider === 'gemini');
    const openaiFailed = openai2?.status === 'failed' || openai2?.status === 'skipped';
    const geminiFailed = gemini2?.status === 'failed' || gemini2?.status === 'skipped';
    await finalizeReport(sessionId, openaiFailed, geminiFailed, opts);
  }
  // Legacy sync path only performs queued-stale repair and terminal aggregation checks.
}

export async function runProviders(
  sessionId: string,
  opts?: {
    stub?: boolean;
    stubOpenAI?: boolean;
    stubGemini?: boolean;
    stubEmail?: boolean;
    stubPdf?: boolean;
    skipOpenAI?: boolean;
    skipGemini?: boolean;
  }
) {
  const didRun = await withSessionRunLock(sessionId, async () => {
    await runProvidersLegacy(sessionId, opts);
  });
  if (didRun === null) return;

  const results = await listProviderResults(sessionId);
  const terminal = new Set(['completed', 'failed', 'skipped', 'stubbed']);
  const allTerminal = results.length >= 2 && results.every((r) => terminal.has(r.status));
  const stillInFlight = results.some((r) => r.status === 'running' || r.status === 'queued');
  if (!stillInFlight && allTerminal) {
    await updateSessionState({ sessionId, state: 'aggregating' });
    const openai = results.find((r) => r.provider === 'openai');
    const gemini = results.find((r) => r.provider === 'gemini');
    const openaiFailed = openai?.status === 'failed' || openai?.status === 'skipped';
    const geminiFailed = gemini?.status === 'failed' || gemini?.status === 'skipped';
    await finalizeReport(sessionId, openaiFailed, geminiFailed, opts);
  }
}

export async function syncSession(
  sessionId: string,
  opts?: {
    stub?: boolean;
    stubOpenAI?: boolean;
    stubGemini?: boolean;
    stubPdf?: boolean;
    stubEmail?: boolean;
    skipOpenAI?: boolean;
    skipGemini?: boolean;
  }
) {
  const session = await getSessionById(sessionId);
  if (!session) {
    return;
  }
  if (session.state === 'aggregating') {
    const results = await listProviderResults(sessionId);
    const openai = results.find((r) => r.provider === 'openai');
    const gemini = results.find((r) => r.provider === 'gemini');
    const openaiFailed = openai?.status === 'failed' || openai?.status === 'skipped';
    const geminiFailed = gemini?.status === 'failed' || gemini?.status === 'skipped';
    await finalizeReport(sessionId, openaiFailed, geminiFailed, opts);
    return;
  }
  if (!process.env.DATABASE_URL) {
    await syncSessionLegacy(sessionId, session, opts);
    return;
  }
  if (session.state === 'running_research') {
    await runProviders(sessionId, opts);
  }
}

export async function finalizeReport(
  sessionId: string,
  openaiFailed: boolean,
  geminiFailed: boolean,
  opts?: { stub?: boolean; stubPdf?: boolean; stubEmail?: boolean }
) {
  if (process.env.DATABASE_URL) {
    try {
      const { query } = await import('./db');
      const lockKey = `finalize:${sessionId}`;
      const rows = await query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockKey]);
      if (!rows[0]?.locked) {
        return;
      }
      try {
        return await finalizeReportUnlocked(sessionId, openaiFailed, geminiFailed, opts);
      } finally {
        try {
          await query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
        } catch {
          // ignore
        }
      }
    } catch {
      // If locking fails for any reason, continue without it.
    }
  }

  return finalizeReportUnlocked(sessionId, openaiFailed, geminiFailed, opts);
}

async function finalizeReportUnlocked(
  sessionId: string,
  openaiFailed: boolean,
  geminiFailed: boolean,
  opts?: { stub?: boolean; stubPdf?: boolean; stubEmail?: boolean }
) {
  const session = await getSessionById(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  const settings = await getUserSettings(session.user_id);

  const existingReport = await getReportBySession(sessionId);
  if (existingReport?.email_status === 'sent') {
    // If an email was already sent but the session got stuck in "aggregating", make it terminal.
    const finalState: SessionState =
      openaiFailed && geminiFailed ? 'failed' : openaiFailed || geminiFailed ? 'partial' : 'completed';
    if (session.state !== 'completed' && session.state !== 'partial' && session.state !== 'failed') {
      const { query } = await import('./db');
      await query(
        `UPDATE research_sessions
         SET state = $2,
             completed_at = COALESCE(completed_at, now()),
             updated_at = now()
         WHERE id = $1`,
        [sessionId, finalState]
      );
    }
    return;
  }

  const results = await listProviderResults(sessionId);
  const openaiResult = results.find((result) => result.provider === 'openai');
  const geminiResult = results.find((result) => result.provider === 'gemini');

  const summary = `OpenAI: ${openaiResult?.status ?? 'unknown'} | Gemini: ${geminiResult?.status ?? 'unknown'}`;
  let finalState: SessionState =
    openaiFailed && geminiFailed ? 'failed' : openaiFailed || geminiFailed ? 'partial' : 'completed';

  const [openaiResearch, geminiResearch] = await Promise.all([
    getSessionResearchSnapshotByProvider(sessionId, 'openai'),
    getSessionResearchSnapshotByProvider(sessionId, 'gemini')
  ]);
  const runReportOpenai = openaiResearch?.run?.synthesized_report_md ?? null;
  const runReportGemini = geminiResearch?.run?.synthesized_report_md ?? null;
  const openaiRunSourcesRaw = (openaiResearch?.sources ?? []).map((s) => ({ url: s.url || '', title: s.title || undefined }));
  const geminiRunSourcesRaw = (geminiResearch?.sources ?? []).map((s) => ({ url: s.url || '', title: s.title || undefined }));

  const accessedAt = new Date().toISOString();
  const openaiSources = runReportOpenai ? openaiRunSourcesRaw : extractLinksFromText(openaiResult?.output_text ?? '');
  const geminiSourcesRaw = runReportGemini ? geminiRunSourcesRaw : extractLinksFromText(geminiResult?.output_text ?? '');

  const globalRefMap = new Map<string, number>();
  const openaiRefs = openaiSources
    .filter((source) => source.url)
    .map((source, index) => {
      const n = index + 1;
      globalRefMap.set(source.url, n);
      return { n, ...source, accessedAt };
    });
  const geminiRefs: Array<{ n: number; url: string; title?: string; accessedAt: string }> = [];
  for (const source of geminiSourcesRaw) {
    if (!source.url || globalRefMap.has(source.url)) {
      continue;
    }
    const n = globalRefMap.size + 1;
    globalRefMap.set(source.url, n);
    geminiRefs.push({ n, ...source, accessedAt });
  }

  const openaiTextWithRefs = runReportOpenai
    ? replaceLinksWithRefs(runReportOpenai, globalRefMap)
    : openaiResult?.output_text
      ? replaceLinksWithRefs(openaiResult.output_text, globalRefMap)
      : null;
  const geminiTextWithRefs = runReportGemini
    ? replaceLinksWithRefs(runReportGemini, globalRefMap)
    : geminiResult?.output_text
      ? replaceLinksWithRefs(geminiResult.output_text, globalRefMap)
      : null;

  const hasResearchMaterial = Boolean(
    (runReportOpenai && runReportOpenai.trim()) ||
      (runReportGemini && runReportGemini.trim()) ||
      (openaiTextWithRefs && openaiTextWithRefs.trim()) ||
      (geminiTextWithRefs && geminiTextWithRefs.trim())
  );

  if (!hasResearchMaterial) {
    finalState = 'failed';
    const emptySummary = 'Research failed before any usable output was generated.';
    const report =
      existingReport && existingReport.email_status !== 'sent'
        ? ((await updateReportContent({ reportId: existingReport.id, summary: emptySummary, pdfBuffer: null })) ?? existingReport)
        : await createReport({
            sessionId,
            summary: emptySummary,
            pdfBuffer: null,
            emailStatus: 'failed'
          });

    await updateSessionState({
      sessionId,
      state: finalState,
      completedAt: new Date().toISOString()
    });
    await updateReportEmail({
      reportId: report.id,
      emailStatus: 'failed',
      emailError: 'No research output generated; report email skipped.'
    });
    return;
  }

  const includeRefs = false;
  type SummaryRef = { n: number; title?: string; url: string; accessedAt?: string };
  const summarize = async (provider: 'OpenAI' | 'Gemini' | 'Combined', text: string, refs: SummaryRef[]) => {
    const cleanText = stripSourcesSections(text);
    if (settings.summarize_provider === 'gemini') {
      return summarizeForReportGemini(
        { provider, researchText: cleanText, references: refs },
        { stub: opts?.stub ?? false, timeoutMs: settings.gemini_timeout_minutes * 60_000, includeRefs }
      );
    }
    return summarizeForReport(
      { provider: provider === 'Combined' ? 'OpenAI' : provider, researchText: cleanText, references: refs },
      { stub: opts?.stub ?? false, timeoutMs: settings.openai_timeout_minutes * 60_000, includeRefs }
    );
  };

  let finalOpenaiSummary = 'No OpenAI result available.';
  let finalGeminiSummary = 'No Gemini result available.';

  if (settings.report_summary_mode === 'one') {
    const combinedText = [openaiTextWithRefs, geminiTextWithRefs].filter(Boolean).join('\n\n');
    const combinedRefs = [...openaiRefs, ...geminiRefs];
    finalOpenaiSummary = combinedText
      ? await summarize('Combined', combinedText, combinedRefs)
      : 'No research result available.';
    finalGeminiSummary = '';
  } else {
    finalOpenaiSummary = openaiTextWithRefs ? await summarize('OpenAI', openaiTextWithRefs, openaiRefs) : finalOpenaiSummary;
    finalGeminiSummary = geminiTextWithRefs ? await summarize('Gemini', geminiTextWithRefs, geminiRefs) : finalGeminiSummary;
  }

  let pdfBuffer: Buffer | null = null;
  let pdfError: string | null = null;
  try {
    pdfBuffer = await buildPdfReport(
      {
        sessionId,
        topic: session.topic,
        refinedPrompt: session.refined_prompt,
        summaryMode: settings.report_summary_mode,
        openaiSummary: finalOpenaiSummary,
        geminiSummary: finalGeminiSummary,
        openaiStartedAt: openaiResult?.started_at ?? null,
        openaiCompletedAt: openaiResult?.completed_at ?? null,
        geminiStartedAt: geminiResult?.started_at ?? null,
        geminiCompletedAt: geminiResult?.completed_at ?? null,
        references: {
          openai: openaiRefs,
          gemini: geminiRefs
        },
        openaiText: openaiTextWithRefs ?? null,
        geminiText: geminiTextWithRefs ?? null,
        openaiSources: openaiResult?.sources_json ?? null,
        geminiSources: geminiResult?.sources_json ?? null,
        createdAt: session.created_at
      },
      { stub: opts?.stubPdf ?? opts?.stub }
    );
  } catch (error) {
    pdfError = error instanceof Error ? error.message : 'PDF error';
    pdfBuffer = null;
    if (finalState === 'completed') {
      finalState = 'partial';
    }
  }

  const report =
    existingReport && existingReport.email_status !== 'sent'
      ? ((await updateReportContent({ reportId: existingReport.id, summary, pdfBuffer })) ?? existingReport)
      : await createReport({
          sessionId,
          summary,
          pdfBuffer,
          emailStatus: 'pending'
        });

  await updateSessionState({
    sessionId,
    state: finalState,
    completedAt: new Date().toISOString()
  });

  const timing = await checkReportTiming(sessionId);
  if (timing) {
    console.info(`report timing minutes=${timing.durationMinutes} within=${timing.withinBudget}`);
  }

  if (!pdfBuffer) {
    await updateReportEmail({
      reportId: report.id,
      emailStatus: 'failed',
      emailError: pdfError ? `PDF generation failed: ${pdfError}` : 'PDF generation failed'
    });
    return;
  }

  const email = await resolveUserEmail(sessionId);
  const claimedReportId = await claimReportSendForSession(sessionId);
  if (!claimedReportId) {
    return;
  }
  if (claimedReportId !== report.id) {
    // Ensure the claimed row has the latest content.
    await updateReportContent({ reportId: claimedReportId, summary, pdfBuffer });
  }
  try {
    await sendReportEmail({
      to: email,
      subject: 'Your Research Report',
      summary: report.summary_text || summary,
      pdfBuffer
    }, { stub: opts?.stubEmail ?? opts?.stub });
    try {
      await updateReportEmail({
        reportId: claimedReportId,
        emailStatus: 'sent',
        sentAt: new Date().toISOString()
      });
    } catch (markSentError) {
      // Do not mark failed after successful delivery; avoids duplicate resend on DB hiccups.
      console.error('Email delivered but failed to mark report as sent', markSentError);
    }
  } catch (error) {
    console.error('Email send failed', error);
    await updateReportEmail({
      reportId: claimedReportId,
      emailStatus: 'failed',
      emailError: error instanceof Error ? error.message : 'Email error'
    });
  }
}

export async function resolveUserEmail(sessionId: string): Promise<string> {
  const rows = await listSessionUserEmail(sessionId);
  if (!rows[0]) {
    throw new Error('User email not found');
  }
  return rows[0].email;
}

async function listSessionUserEmail(sessionId: string): Promise<{ email: string }[]> {
  const { query } = await import('./db');
  return query<{ email: string }>(
    `SELECT users.email
     FROM research_sessions
     JOIN users ON users.id = research_sessions.user_id
     WHERE research_sessions.id = $1`,
    [sessionId]
  );
}

export async function getCurrentQuestion(sessionId: string) {
  return getNextQuestion(sessionId);
}

export async function getAllQuestions(sessionId: string) {
  return listQuestions(sessionId);
}
