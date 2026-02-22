import { NextResponse } from 'next/server';
import { requireSession } from '../../../lib/authz';
import { buildPdfReport } from '../../../lib/pdf-report';
import { sendReportEmail } from '../../../lib/email-sender';
import { getDebugFlags } from '../../../lib/debug';

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

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
