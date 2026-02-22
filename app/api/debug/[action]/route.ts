import { NextResponse } from 'next/server';
import { requireSession } from '../../../lib/authz';
import { buildPdfReport } from '../../../lib/pdf-report';
import { sendReportEmail } from '../../../lib/email-sender';
import { getDebugFlags } from '../../../lib/debug';
import { createReport } from '../../../lib/report-repo';
import { upsertProviderResult } from '../../../lib/provider-repo';
import { createSession, getUserIdByEmail, updateSessionState } from '../../../lib/session-repo';

function notFound() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (process.env.NODE_ENV === 'production') {
    return notFound();
  }

  if (action === 'bypass') {
    const body = await request.json().catch(() => ({}));
    const bypass = Boolean(body?.bypass);
    const stub = Boolean(body?.stub);
    const stubRefiner = Boolean(body?.stubRefiner);
    const stubOpenAI = Boolean(body?.stubOpenAI);
    const stubGemini = Boolean(body?.stubGemini);
    const stubEmail = Boolean(body?.stubEmail);
    const stubPdf = Boolean(body?.stubPdf);
    const skipOpenAI = Boolean(body?.skipOpenAI);
    const skipGemini = Boolean(body?.skipGemini);

    const response = NextResponse.json({
      bypass,
      stub,
      stubRefiner,
      stubOpenAI,
      stubGemini,
      stubEmail,
      stubPdf,
      skipOpenAI,
      skipGemini
    });

    response.cookies.set('dev_bypass', bypass ? '1' : '0', { path: '/' });
    response.cookies.set('dev_stub', stub ? '1' : '0', { path: '/' });
    response.cookies.set('dev_stub_refiner', stubRefiner ? '1' : '0', { path: '/' });
    response.cookies.set('dev_stub_openai', stubOpenAI ? '1' : '0', { path: '/' });
    response.cookies.set('dev_stub_gemini', stubGemini ? '1' : '0', { path: '/' });
    response.cookies.set('dev_stub_email', stubEmail ? '1' : '0', { path: '/' });
    response.cookies.set('dev_stub_pdf', stubPdf ? '1' : '0', { path: '/' });
    response.cookies.set('dev_skip_openai', skipOpenAI ? '1' : '0', { path: '/' });
    response.cookies.set('dev_skip_gemini', skipGemini ? '1' : '0', { path: '/' });
    return response;
  }

  if (action === 'seed-session') {
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

  if (action === 'test-report') {
    const session = await requireSession();
    const body = await request.json().catch(() => ({}));
    const topic = String(body?.topic ?? 'Debug report').trim();
    const openaiText = String(body?.openaiText ?? 'OpenAI debug output');
    const geminiText = String(body?.geminiText ?? 'Gemini debug output');
    const debug = await getDebugFlags();

    const pdfBuffer = await buildPdfReport(
      {
        sessionId: 'debug',
        topic,
        refinedPrompt: body?.refinedPrompt ?? topic,
        openaiText,
        geminiText,
        openaiSources: body?.openaiSources ?? null,
        geminiSources: body?.geminiSources ?? null,
        createdAt: new Date().toISOString()
      },
      { stub: debug.stubPdf || debug.stubExternals }
    );

    await sendReportEmail(
      {
        to: session.user!.email!,
        subject: 'Debug Research Report',
        summary: 'Debug report generated from the debug panel.',
        pdfBuffer
      },
      { stub: debug.stubEmail || debug.stubExternals }
    );

    return NextResponse.json({ ok: true });
  }

  return notFound();
}

