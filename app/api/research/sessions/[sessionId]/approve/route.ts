import { NextResponse } from 'next/server';
import { requireSession } from '../../../../../lib/authz';
import { assertSessionOwnership, getSessionById, getUserIdByEmail } from '../../../../../lib/session-repo';
import { handleRefinementApproval } from '../../../../../lib/orchestration';
import { getDebugFlags } from '../../../../../lib/debug';
import { checkRateLimit } from '../../../../../lib/rate-limit';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const session = await requireSession();
  const userId = await getUserIdByEmail(session.user!.email!);
  await assertSessionOwnership(sessionId, userId);
  try {
    await checkRateLimit({ userId, action: 'approve_prompt' });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Rate limit exceeded' },
      { status: 429 }
    );
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
