import { NextResponse } from 'next/server';
import { requireSession } from '../../../../lib/authz';
import { getUserIdByEmail, listIncompleteSessions } from '../../../../lib/session-repo';

export async function GET(request: Request) {
  const session = await requireSession();
  const userId = await getUserIdByEmail(session.user!.email!);
  const { searchParams } = new URL(request.url);
  const limit = Number(searchParams.get('limit') ?? '20');
  const rows = await listIncompleteSessions(userId, limit);
  return NextResponse.json(rows);
}

