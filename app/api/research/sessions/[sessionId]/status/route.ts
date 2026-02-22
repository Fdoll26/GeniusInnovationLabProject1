import { NextResponse } from 'next/server';
import { requireSession } from '../../../../../lib/authz';
import { assertSessionOwnership, getSessionById, getUserIdByEmail } from '../../../../../lib/session-repo';
import { listProviderResults } from '../../../../../lib/provider-repo';
import { syncSession } from '../../../../../lib/orchestration';

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
