import { NextResponse } from 'next/server';
import { requireSession } from '../../../../../lib/authz';
import { assertSessionOwnership, getSessionById, getUserIdByEmail } from '../../../../../lib/session-repo';
import { finalizeReport, handleRefinementApproval, regenerateReportForSession, runProviders, syncSession } from '../../../../../lib/orchestration';
import { getDebugFlags } from '../../../../../lib/debug';
import { checkRateLimit } from '../../../../../lib/rate-limit';
import { listProviderResults } from '../../../../../lib/provider-repo';

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
      await syncSession(sessionId);
    } catch {
      // best-effort; status polling should not hard-fail on sync errors
    }
  }

  const sessionRecord = await getSessionById(sessionId);
  if (!sessionRecord) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const providerResults = await listProviderResults(sessionId);
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
    }))
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
