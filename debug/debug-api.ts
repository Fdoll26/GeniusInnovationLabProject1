import { buildPdfReport, type ReportInput } from '../app/lib/pdf-report';
import { getResearchSnapshotByRunId } from '../app/lib/research-orchestrator';
import { executePipelineStep } from '../app/lib/research-provider';
import { getResearchProviderConfig } from '../app/lib/research-config';
import { query } from '../app/lib/db';
import { getResearchRunById, listResearchRunsBySessionId, listResearchSteps } from '../app/lib/research-run-repo';
import { getSessionById } from '../app/lib/session-repo';
import { STEP_LABELS, STEP_SEQUENCE, type ResearchPlan, type ResearchProviderName, type StepType } from '../app/lib/research-types';

export type RunFromStepRequest = {
  provider: ResearchProviderName;
  startStepType: StepType;
  question: string;
  priorSummary: string;
  sourceTarget: number;
  maxOutputTokens: number;
  timeoutMs: number;
  existingRunId?: string | null;
  useDbInputs?: boolean;
};

export type StepResult = {
  stepType: StepType;
  stepLabel: string;
  status: 'done' | 'failed';
  rawOutput: string;
  citations: Array<{ url: string; title?: string | null }>;
  error?: string;
  durationMs: number;
};

export type DebugRunResponse = {
  steps: StepResult[];
  totalDurationMs: number;
};

export type DebugRunRow = {
  id: string;
  session_id: string;
  provider: string;
  state: string;
  question: string;
  current_step_index: number;
  created_at: string;
  stepCount: number;
  doneSteps: number;
  steps: Array<{
    step_index: number;
    step_type: string;
    status: string;
    output_excerpt: string;
  }>;
};

function parseProvider(raw: unknown): ResearchProviderName {
  if (raw === 'gemini') return 'gemini';
  return 'openai';
}

function parseStepType(raw: unknown): StepType | null {
  const s = String(raw ?? '');
  if ((STEP_SEQUENCE as readonly string[]).includes(s)) {
    return s as StepType;
  }
  return null;
}

function parsePlan(run: { research_plan_json?: unknown }): ResearchPlan | null {
  const raw = run.research_plan_json;
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as ResearchPlan;
    } catch {
      return null;
    }
  }
  return raw as ResearchPlan;
}

async function buildPriorSummaryFromRun(runId: string, upToStepType: StepType): Promise<string> {
  const steps = await listResearchSteps(runId);
  const startIdx = STEP_SEQUENCE.indexOf(upToStepType as (typeof STEP_SEQUENCE)[number]);
  const priorSteps = steps.filter((s) => s.step_index < startIdx);
  return priorSteps
    .slice(-4)
    .map((s) => `Step ${s.step_index + 1} ${s.step_type}: ${(s.output_excerpt || s.raw_output || '').slice(0, 320)}`)
    .join('\n');
}

export async function listDebugRuns(): Promise<{ runs: DebugRunRow[] }> {
  const rows = await query<{
    id: string;
    session_id: string;
    provider: string;
    state: string;
    question: string;
    current_step_index: number;
    created_at: string;
  }>(
    `SELECT id, session_id, provider, state, question, current_step_index, created_at
     FROM research_runs
     ORDER BY created_at DESC
     LIMIT 50`
  );

  const enriched = await Promise.all(
    rows.map(async (row) => {
      const steps = await listResearchSteps(row.id);
      return {
        ...row,
        stepCount: steps.length,
        doneSteps: steps.filter((s) => s.status === 'done').length,
        steps: steps.map((s) => ({
          step_index: s.step_index,
          step_type: s.step_type,
          status: s.status,
          output_excerpt: (s.output_excerpt || '').slice(0, 200)
        }))
      };
    })
  );

  return { runs: enriched };
}

export async function runFromStep(body: RunFromStepRequest): Promise<DebugRunResponse> {
  const provider = parseProvider(body.provider);
  const startStep = parseStepType(body.startStepType);

  if (!startStep) {
    throw new Error(`Invalid startStepType: ${String(body.startStepType)}`);
  }

  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) {
    throw new Error('question is required');
  }

  const sourceTarget = Math.max(1, Math.min(30, Number(body.sourceTarget) || 5));
  const maxOutputTokens = Math.max(300, Math.min(8000, Number(body.maxOutputTokens) || 2000));
  const timeoutMs = Math.max(10_000, Math.min(20 * 60_000, Number(body.timeoutMs) || 5 * 60_000));

  const startIdx = STEP_SEQUENCE.indexOf(startStep as (typeof STEP_SEQUENCE)[number]);
  if (startIdx < 0) {
    throw new Error(`Step ${startStep} not found in STEP_SEQUENCE`);
  }
  const stepsToRun = STEP_SEQUENCE.slice(startIdx);

  let priorSummary = typeof body.priorSummary === 'string' ? body.priorSummary.trim() : '';

  if (body.useDbInputs && body.existingRunId) {
    try {
      const dbPrior = await buildPriorSummaryFromRun(body.existingRunId, startStep);
      if (dbPrior) {
        priorSummary = dbPrior;
      }
    } catch (error) {
      console.warn('[debug] Could not load DB prior summary:', error);
    }
  }

  let plan: ResearchPlan | null = null;
  if (body.existingRunId) {
    try {
      const existingRun = await getResearchRunById(body.existingRunId);
      if (existingRun) {
        plan = parsePlan(existingRun);
      }
    } catch {
      // best effort
    }
  }

  const cfg = getResearchProviderConfig(provider);
  const results: StepResult[] = [];
  const runStart = Date.now();

  for (const stepType of stepsToRun) {
    const stepStart = Date.now();
    try {
      const artifact = await executePipelineStep({
        provider,
        stepType,
        question,
        timeoutMs,
        plan,
        priorStepSummary: priorSummary,
        sourceTarget,
        maxOutputTokens,
        maxCandidates: cfg.max_candidates,
        shortlistSize: cfg.shortlist_size
      });

      const rawOutput = artifact.raw_output_text ?? '';
      const durationMs = Date.now() - stepStart;

      results.push({
        stepType,
        stepLabel: STEP_LABELS[stepType] ?? stepType,
        status: 'done',
        rawOutput,
        citations: (artifact.citations ?? []).map((c) => ({ url: c.url, title: c.title ?? null })),
        durationMs
      });

      priorSummary = `Step ${STEP_LABELS[stepType]}: ${rawOutput.slice(0, 500)}`;

      if (stepType === 'DEVELOP_RESEARCH_PLAN' && artifact.updatedPlan) {
        plan = artifact.updatedPlan;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({
        stepType,
        stepLabel: STEP_LABELS[stepType] ?? stepType,
        status: 'failed',
        rawOutput: '',
        citations: [],
        error: msg,
        durationMs: Date.now() - stepStart
      });
      break;
    }
  }

  return {
    steps: results,
    totalDurationMs: Date.now() - runStart
  };
}

export async function generateDebugReport(input: { runId?: string; sessionId?: string }): Promise<Buffer> {
  const { runId, sessionId } = input;

  if (!runId && !sessionId) {
    throw new Error('runId or sessionId is required');
  }

  let openaiReportMd: string | null = null;
  let geminiReportMd: string | null = null;
  let topic = 'Debug Report';
  let refinedPrompt: string | null = null;
  let createdAt = new Date().toISOString();

  if (runId) {
    const snapshot = await getResearchSnapshotByRunId(runId);
    if (!snapshot) {
      throw new Error(`Run ${runId} not found`);
    }
    const { run } = snapshot;
    const reportMd = run.synthesized_report_md ?? null;

    if (run.provider === 'openai') {
      openaiReportMd = reportMd;
    } else {
      geminiReportMd = reportMd;
    }

    topic = run.question ?? topic;
    createdAt = run.created_at;

    if (run.session_id) {
      const session = await getSessionById(run.session_id);
      if (session) {
        refinedPrompt = session.refined_prompt ?? null;
        topic = session.topic ?? topic;
      }
    }
  } else if (sessionId) {
    const session = await getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    topic = session.topic;
    refinedPrompt = session.refined_prompt ?? null;
    createdAt = session.created_at;

    const runs = await listResearchRunsBySessionId(sessionId);
    for (const run of runs) {
      if (run.synthesized_report_md) {
        if (run.provider === 'openai' && !openaiReportMd) {
          openaiReportMd = run.synthesized_report_md;
        } else if (run.provider === 'gemini' && !geminiReportMd) {
          geminiReportMd = run.synthesized_report_md;
        }
      }
    }
  }

  if (!openaiReportMd && !geminiReportMd) {
    throw new Error('Cannot generate report: no synthesized output available.');
  }

  const reportInput: ReportInput = {
    sessionId: sessionId ?? runId ?? 'debug',
    topic,
    refinedPrompt,
    summaryMode: 'two',
    openaiSummary: openaiReportMd ? '' : 'Not available.',
    geminiSummary: geminiReportMd ? '' : 'Not available.',
    comparisonSection: '',
    openaiText: openaiReportMd,
    geminiText: geminiReportMd,
    references: { openai: [], gemini: [] },
    createdAt
  };

  return buildPdfReport(reportInput);
}
