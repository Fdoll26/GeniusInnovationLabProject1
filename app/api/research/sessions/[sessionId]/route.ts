import { NextResponse } from 'next/server';
import { requireSession } from '../../../../lib/authz';
import { assertSessionOwnership, deleteSessionById, getSessionById, getUserIdByEmail } from '../../../../lib/session-repo';
import { listQuestions } from '../../../../lib/refinement-repo';
import { listProviderResults } from '../../../../lib/provider-repo';
import { getReportBySession } from '../../../../lib/report-repo';
import { syncSession } from '../../../../lib/orchestration';
import { getSessionResearchSnapshot } from '../../../../lib/research-orchestrator';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const session = await requireSession();
  const userId = await getUserIdByEmail(session.user!.email!);
  await assertSessionOwnership(sessionId, userId);
  if (process.env.DATABASE_URL) {
    try {
      await syncSession(sessionId);
    } catch {
      // best-effort; detail fetch should still succeed even if sync fails
    }
  }
  const sessionRecord = await getSessionById(sessionId);
  if (!sessionRecord) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const [questions, providerResults, report, research] = await Promise.all([
    listQuestions(sessionId),
    listProviderResults(sessionId),
    getReportBySession(sessionId),
    getSessionResearchSnapshot(sessionId)
  ]);
  return NextResponse.json({
    session: sessionRecord,
    refinementQuestions: questions,
    providerResults,
    report,
    research
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const session = await requireSession();
  const userId = await getUserIdByEmail(session.user!.email!);
  await assertSessionOwnership(sessionId, userId);

  const record = await getSessionById(sessionId);
  if (!record) {
    return NextResponse.json({ ok: true, deleted: false });
  }

  // Avoid deleting in-flight work; otherwise background calls may continue without a tracked session.
  if (record.state === 'running_research' || record.state === 'aggregating') {
    return NextResponse.json({ error: 'Cannot delete a session while it is in progress.' }, { status: 409 });
  }

  const deleted = await deleteSessionById(userId, sessionId);
  return NextResponse.json({ ok: true, deleted });
}
