import { NextResponse } from 'next/server';
import { requireSession } from '../../../../../lib/authz';
import { getUserIdByEmail, assertSessionOwnership, getSessionById } from '../../../../../lib/session-repo';
import { regenerateReportForSession } from '../../../../../lib/orchestration';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const session = await requireSession();
  const userId = await getUserIdByEmail(session.user!.email!);
  const { sessionId } = await params;
  await assertSessionOwnership(sessionId, userId);

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
