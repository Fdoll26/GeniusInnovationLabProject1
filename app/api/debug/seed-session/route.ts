import { NextResponse } from 'next/server';
import { requireSession } from '../../../lib/authz';
import { createSession, getUserIdByEmail, updateSessionState } from '../../../lib/session-repo';
import { upsertProviderResult } from '../../../lib/provider-repo';
import { createReport } from '../../../lib/report-repo';

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const session = await requireSession();
  const userId = await getUserIdByEmail(session.user!.email!);
  const body = await request.json().catch(() => ({}));
  const topic = String(body?.topic ?? 'Debug session').trim();

  const newSession = await createSession({ userId, topic, state: 'completed' });
  await updateSessionState({
    sessionId: newSession.id,
    state: 'completed',
    refinedPrompt: body?.refinedPrompt ?? topic,
    refinedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });

  await upsertProviderResult({
    sessionId: newSession.id,
    provider: 'openai',
    status: 'completed',
    outputText: body?.openaiText ?? 'OpenAI debug output',
    completedAt: new Date().toISOString()
  });
  await upsertProviderResult({
    sessionId: newSession.id,
    provider: 'gemini',
    status: 'completed',
    outputText: body?.geminiText ?? 'Gemini debug output',
    completedAt: new Date().toISOString()
  });

  await createReport({
    sessionId: newSession.id,
    summary: 'Debug report',
    pdfBuffer: null,
    emailStatus: 'sent',
    sentAt: new Date().toISOString()
  });

  return NextResponse.json({ ok: true, sessionId: newSession.id });
}
