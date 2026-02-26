import { NextResponse } from 'next/server';
import { requireSession, unauthorizedResponse } from '../../../lib/authz';
import { getUserIdByEmail } from '../../../lib/session-repo';
import { listRecentSentReports } from '../../../lib/report-repo';

export async function GET(_request: Request, { params }: { params: Promise<{ action: string }> }) {
  try {
    const { action } = await params;
    if (action !== 'recent') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const session = await requireSession();
    const userId = await getUserIdByEmail(session.user!.email!);
    const rows = await listRecentSentReports(userId, 5);
    return NextResponse.json(rows);
  } catch (error) {
    const response = unauthorizedResponse(error);
    if (response) return response;
    throw error;
  }
}
