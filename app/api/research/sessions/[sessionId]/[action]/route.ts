import { NextResponse } from 'next/server';
import { requireSession } from '../../../../../lib/authz';
import { assertSessionOwnership, getSessionById, getUserIdByEmail } from '../../../../../lib/session-repo';
import { finalizeReport, handleRefinementApproval, regenerateReportForSession, runProviders, syncSession } from '../../../../../lib/orchestration';
import { getDebugFlags } from '../../../../../lib/debug';
import { checkRateLimit } from '../../../../../lib/rate-limit';
import { listProviderResults } from '../../../../../lib/provider-repo';
import { listSessionResearchSnapshots } from '../../../../../lib/research-orchestrator';

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string; action: string }> }) {
  const { sessionId, action } = await params;
  if (action !== 'status') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const session = await requireSession();
  const userId = await getUserIdByEmail(session.user!.email!);
  await assertSessionOwnership(sessionId, userId);

  if (process.env.DATABASE_URL) {
    try {
      const debug = await getDebugFlags();
      await syncSession(sessionId, {
        stub: debug.stubExternals,
        stubOpenAI: debug.stubOpenAI,
        stubGemini: debug.stubGemini,
        stubPdf: debug.stubPdf,
        stubEmail: debug.stubEmail,
        skipOpenAI: debug.skipOpenAI,
        skipGemini: debug.skipGemini
      });
    } catch {
      // best-effort; status polling should not hard-fail on sync errors
    }
  }

  const sessionRecord = await getSessionById(sessionId);
  if (!sessionRecord) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const [providerResults, researchRuns] = await Promise.all([
    listProviderResults(sessionId),
    process.env.DATABASE_URL ? listSessionResearchSnapshots(sessionId) : Promise.resolve([])
  ]);
  const researchByProvider = ['openai', 'gemini'].map((provider) => {
    const run = researchRuns.find((item) => item.run?.provider === provider)?.run;
    const entry = researchRuns.find((item) => item.run?.provider === provider);
    if (!run || !entry) return null;
    const progress = (run.progress_json && typeof run.progress_json === 'object'
      ? run.progress_json
      : null) as Record<string, unknown> | null;
    const activeStepIndex =
      progress && typeof progress.step_index === 'number' && Number.isFinite(progress.step_index)
        ? Math.max(0, Math.trunc(progress.step_index))
        : Math.max(0, run.current_step_index);
    const normalizedSteps = entry.steps.map((step: any) => ({ ...step }));
    const hasRunning = normalizedSteps.some((step: any) => step.status === 'running');
    if (run.state === 'IN_PROGRESS' && !hasRunning) {
      const target = normalizedSteps.find((step: any) => Number(step.step_index) === activeStepIndex);
      if (target && target.status !== 'done' && target.status !== 'failed') {
        target.status = 'running';
      }
    }
    return {
      provider,
      runId: run.id,
      state: run.state,
      stepIndex: run.current_step_index,
      maxSteps: run.max_steps,
      mode: run.mode,
      progress: progress
        ? {
            stepId: typeof progress.step_id === 'string' ? progress.step_id : null,
            stepLabel: typeof progress.step_label === 'string' ? progress.step_label : null,
            stepNumber: typeof progress.step_index === 'number' ? progress.step_index : run.current_step_index,
            totalSteps: typeof progress.total_steps === 'number' ? progress.total_steps : run.max_steps
          }
        : null,
      steps: normalizedSteps.map((step: any) => ({
        id: step.id,
        stepIndex: step.step_index,
        stepType: step.step_type,
        status: step.status,
        stepGoal: step.step_goal,
        outputExcerpt: step.output_excerpt,
        errorMessage: step.error_message,
        startedAt: step.started_at,
        completedAt: step.completed_at
      })),
      sourceCount: entry.sources.length
    };
  }).filter(Boolean) as Array<{
    provider: string;
    runId: string;
    state: string;
    stepIndex: number;
    maxSteps: number;
    mode: string;
    progress: { stepId: string | null; stepLabel: string | null; stepNumber: number; totalSteps: number } | null;
    steps: Array<{
      id: string;
      stepIndex: number;
      stepType: string;
      status: string;
      stepGoal: string | null;
      outputExcerpt: string | null;
      errorMessage: string | null;
      startedAt: string | null;
      completedAt: string | null;
    }>;
    sourceCount: number;
  }>;
  return NextResponse.json({
    state: sessionRecord.state,
    updatedAt: sessionRecord.updated_at,
    refinedAt: sessionRecord.refined_at,
    completedAt: sessionRecord.completed_at,
    providers: providerResults.map((result) => ({
      provider: result.provider,
      status: result.status,
      startedAt: result.started_at,
      completedAt: result.completed_at,
      errorMessage: result.error_message
    })),
    research: {
      providers: researchByProvider
    }
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string; action: string }> }) {
  const { sessionId, action } = await params;
  const session = await requireSession();
  const userId = await getUserIdByEmail(session.user!.email!);
  await assertSessionOwnership(sessionId, userId);

  if (action === 'approve') {
    try {
      await checkRateLimit({ userId, action: 'approve_prompt' });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Rate limit exceeded' }, { status: 429 });
    }
    const body = await request.json();
    const refinedPrompt = String(body?.refinedPrompt ?? '').trim();
    if (!refinedPrompt) {
      return NextResponse.json({ error: 'Refined prompt required' }, { status: 400 });
    }

    const sessionRecord = await getSessionById(sessionId);
    if (sessionRecord && sessionRecord.state !== 'refining') {
      return NextResponse.json({ ok: true, skipped: true });
    }

    const debug = await getDebugFlags();
    await handleRefinementApproval(sessionId, refinedPrompt, {
      stub: debug.stubExternals,
      stubRefiner: debug.stubRefiner,
      stubOpenAI: debug.stubOpenAI,
      stubGemini: debug.stubGemini,
      stubEmail: debug.stubEmail,
      stubPdf: debug.stubPdf,
      skipOpenAI: debug.skipOpenAI,
      skipGemini: debug.skipGemini
    });
    return NextResponse.json({ ok: true });
  }

  if (action === 'retry') {
    try {
      await checkRateLimit({ userId, action: 'retry_session' });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Rate limit exceeded' }, { status: 429 });
    }

    const debug = await getDebugFlags();
    const sessionRecord = await getSessionById(sessionId);
    if (sessionRecord?.state === 'aggregating') {
      const results = await listProviderResults(sessionId);
      const openai = results.find((r) => r.provider === 'openai');
      const gemini = results.find((r) => r.provider === 'gemini');
      const openaiFailed = openai?.status === 'failed' || openai?.status === 'skipped';
      const geminiFailed = gemini?.status === 'failed' || gemini?.status === 'skipped';
      await finalizeReport(sessionId, openaiFailed, geminiFailed, {
        stub: debug.stubExternals,
        stubPdf: debug.stubPdf,
        stubEmail: debug.stubEmail
      });
    } else {
      await runProviders(sessionId, {
        stub: debug.stubExternals,
        stubOpenAI: debug.stubOpenAI,
        stubGemini: debug.stubGemini,
        stubEmail: debug.stubEmail,
        stubPdf: debug.stubPdf,
        skipOpenAI: debug.skipOpenAI,
        skipGemini: debug.skipGemini
      });
    }
    return NextResponse.json({ ok: true });
  }

  if (action === 'regenerate-report') {
    const record = await getSessionById(sessionId);
    if (!record) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    if (record.state !== 'completed' && record.state !== 'partial') {
      return NextResponse.json({ error: 'Report regeneration is only available for completed sessions.' }, { status: 400 });
    }
    const result = await regenerateReportForSession(sessionId);
    return NextResponse.json({ ok: true, reportId: result.reportId });
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}
