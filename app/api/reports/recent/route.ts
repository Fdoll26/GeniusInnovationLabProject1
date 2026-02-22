import { NextResponse } from 'next/server';
import { requireSession } from '../../../lib/authz';
import { getUserIdByEmail } from '../../../lib/session-repo';
import { listRecentSentReports } from '../../../lib/report-repo';

export async function GET() {
  const session = await requireSession();
  const userId = await getUserIdByEmail(session.user!.email!);
  const rows = await listRecentSentReports(userId, 5);
  return NextResponse.json(rows);
}

