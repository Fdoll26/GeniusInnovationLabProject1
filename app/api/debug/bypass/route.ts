import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

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
