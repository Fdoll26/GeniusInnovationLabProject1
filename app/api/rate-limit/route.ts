import { NextResponse } from 'next/server';
import { requireSession, unauthorizedResponse } from '../../lib/authz';
import { getUserIdByEmail } from '../../lib/session-repo';
import { getRateLimitStatus } from '../../lib/rate-limit';

const CREATE_SESSION_WINDOW_SECONDS = 60 * 60;
const CREATE_SESSION_MAX_REQUESTS = 5;

export async function GET(request: Request) {
  try {
    const session = await requireSession();
    const userId = await getUserIdByEmail(session.user!.email!);
    const { searchParams } = new URL(request.url);
    const action = String(searchParams.get('action') ?? 'create_session');

    const overrides =
      action === 'create_session'
        ? { windowSeconds: CREATE_SESSION_WINDOW_SECONDS, maxRequests: CREATE_SESSION_MAX_REQUESTS }
        : undefined;

    const status = await getRateLimitStatus({
      userId,
      action,
      windowSeconds: overrides?.windowSeconds,
      maxRequests: overrides?.maxRequests
    });

    return NextResponse.json(status);
  } catch (error) {
    const response = unauthorizedResponse(error);
    if (response) return response;
    throw error;
  }
}
