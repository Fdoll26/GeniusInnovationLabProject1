import { NextResponse } from 'next/server';
import { requireSession, unauthorizedResponse } from '../../lib/authz';
import { getUserIdByEmail } from '../../lib/session-repo';
import { getUserSettings, normalizeUserSettingsUpdate, upsertUserSettings } from '../../lib/user-settings-repo';

export async function GET() {
  try {
    const session = await requireSession();
    const userId = await getUserIdByEmail(session.user!.email!);
    const settings = await getUserSettings(userId);
    return NextResponse.json(settings);
  } catch (error) {
    const response = unauthorizedResponse(error);
    if (response) return response;
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const userId = await getUserIdByEmail(session.user!.email!);
    const body = await request.json().catch(() => ({}));
    const update = normalizeUserSettingsUpdate(body);
    const settings = await upsertUserSettings(userId, update);
    return NextResponse.json(settings);
  } catch (error) {
    const response = unauthorizedResponse(error);
    if (response) return response;
    throw error;
  }
}
