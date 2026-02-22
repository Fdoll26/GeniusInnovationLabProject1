import { NextResponse } from 'next/server';
import { requireSession } from '../../../../../lib/authz';
import { assertSessionOwnership, getSessionById, getUserIdByEmail } from '../../../../../lib/session-repo';
import { finalizeReport, runProviders } from '../../../../../lib/orchestration';
import { getDebugFlags } from '../../../../../lib/debug';
import { checkRateLimit } from '../../../../../lib/rate-limit';
import { listProviderResults } from '../../../../../lib/provider-repo';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const session = await requireSession();
  const userId = await getUserIdByEmail(session.user!.email!);
  await assertSessionOwnership(sessionId, userId);
  try {
    await checkRateLimit({ userId, action: 'retry_session' });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Rate limit exceeded' },
      { status: 429 }
    );
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
