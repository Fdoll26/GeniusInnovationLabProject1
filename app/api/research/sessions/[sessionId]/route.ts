import { NextResponse } from 'next/server';
import { requireSession, unauthorizedResponse } from '../../../../lib/authz';
import { assertSessionOwnership, deleteSessionById, getSessionById, getUserIdByEmail } from '../../../../lib/session-repo';
import { listQuestions } from '../../../../lib/refinement-repo';
import { listProviderResults } from '../../../../lib/provider-repo';
import { getReportBySession } from '../../../../lib/report-repo';
import { syncSession } from '../../../../lib/orchestration';
import { getSessionResearchSnapshot } from '../../../../lib/research-orchestrator';

const DETAIL_SYNC_THROTTLE_MS = Number.parseInt(process.env.DETAIL_SYNC_THROTTLE_MS ?? '15000', 10);
const lastDetailSyncAttemptBySession = new Map<string, number>();

function shouldAttemptDetailSync(sessionId: string): boolean {
  const now = Date.now();
  const nextAllowedAt = lastDetailSyncAttemptBySession.get(sessionId) ?? 0;
  if (now < nextAllowedAt) {
    return false;
  }
  lastDetailSyncAttemptBySession.set(sessionId, now + Math.max(1000, DETAIL_SYNC_THROTTLE_MS));
  if (lastDetailSyncAttemptBySession.size > 2000) {
    for (const [key, value] of lastDetailSyncAttemptBySession.entries()) {
      if (value < now) {
        lastDetailSyncAttemptBySession.delete(key);
      }
    }
  }
  return true;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await params;
    const session = await requireSession();
    const userId = await getUserIdByEmail(session.user!.email!);
    await assertSessionOwnership(sessionId, userId);
    let sessionRecord = await getSessionById(sessionId);
    if (!sessionRecord) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (
      process.env.DATABASE_URL &&
      (sessionRecord.state === 'running_research' || sessionRecord.state === 'aggregating') &&
      shouldAttemptDetailSync(sessionId)
    ) {
      try {
        await syncSession(sessionId);
        sessionRecord = (await getSessionById(sessionId)) ?? sessionRecord;
      } catch {
        // best-effort; detail fetch should still succeed even if sync fails
      }
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
  } catch (error) {
    const response = unauthorizedResponse(error);
    if (response) return response;
    throw error;
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  try {
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
  } catch (error) {
    const response = unauthorizedResponse(error);
    if (response) return response;
    throw error;
  }
}
