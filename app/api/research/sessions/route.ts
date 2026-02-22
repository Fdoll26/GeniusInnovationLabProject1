import { NextResponse } from 'next/server';
import { requireSession } from '../../../lib/authz';
import { createSession, getUserIdByEmail, listSessions } from '../../../lib/session-repo';
import { runRefinement } from '../../../lib/orchestration';
import { getDebugFlags } from '../../../lib/debug';
import { checkRateLimit } from '../../../lib/rate-limit';

const CREATE_SESSION_WINDOW_SECONDS = 60 * 60;
const CREATE_SESSION_MAX_REQUESTS = 5;

export async function GET(request: Request) {
  const session = await requireSession();
  const userId = await getUserIdByEmail(session.user!.email!);
  const { searchParams } = new URL(request.url);
  const limit = Number(searchParams.get('limit') ?? '10');
  const offset = Number(searchParams.get('offset') ?? '0');
  const q = searchParams.get('q') ?? undefined;
  const sessions = await listSessions({ userId, limit, offset, query: q });
  return NextResponse.json(sessions);
}

export async function POST(request: Request) {
  const session = await requireSession();
  const userId = await getUserIdByEmail(session.user!.email!);
  try {
    await checkRateLimit({
      userId,
      action: 'create_session',
      windowSeconds: CREATE_SESSION_WINDOW_SECONDS,
      maxRequests: CREATE_SESSION_MAX_REQUESTS
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Rate limit exceeded' },
      { status: 429 }
    );
  }
  const body = await request.json();
  const topic = String(body?.topic ?? '').trim();
  if (!topic) {
    return NextResponse.json({ error: 'Topic is required' }, { status: 400 });
  }

  const newSession = await createSession({ userId, topic, state: 'draft' });
  const debug = await getDebugFlags();
  await runRefinement(newSession.id, topic, {
    stub: debug.stubExternals,
    stubRefiner: debug.stubRefiner
  });
  return NextResponse.json(newSession, { status: 201 });
}
