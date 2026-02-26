import { NextResponse } from 'next/server';
import { requireSession, unauthorizedResponse } from '../../../../lib/authz';
import { getUserIdByEmail, listIncompleteSessions } from '../../../../lib/session-repo';

export async function GET(request: Request) {
  try {
    const session = await requireSession();
    const userId = await getUserIdByEmail(session.user!.email!);
    const { searchParams } = new URL(request.url);
    const limit = Number(searchParams.get('limit') ?? '20');
    const rows = await listIncompleteSessions(userId, limit);
    return NextResponse.json(rows);
  } catch (error) {
    const response = unauthorizedResponse(error);
    if (response) return response;
    throw error;
  }
}
