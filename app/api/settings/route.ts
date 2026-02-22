import { NextResponse } from 'next/server';
import { requireSession } from '../../lib/authz';
import { getUserIdByEmail } from '../../lib/session-repo';
import { getUserSettings, normalizeUserSettingsUpdate, upsertUserSettings } from '../../lib/user-settings-repo';

export async function GET() {
  const session = await requireSession();
  const userId = await getUserIdByEmail(session.user!.email!);
  const settings = await getUserSettings(userId);
  return NextResponse.json(settings);
}

export async function POST(request: Request) {
  const session = await requireSession();
  const userId = await getUserIdByEmail(session.user!.email!);
  const body = await request.json().catch(() => ({}));
  const update = normalizeUserSettingsUpdate(body);
  const settings = await upsertUserSettings(userId, update);
  return NextResponse.json(settings);
}

