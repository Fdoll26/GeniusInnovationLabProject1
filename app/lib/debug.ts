import { cookies } from 'next/headers';

export type DebugFlags = {
  bypassAuth: boolean;
  stubExternals: boolean;
  stubRefiner: boolean;
  stubOpenAI: boolean;
  stubGemini: boolean;
  stubEmail: boolean;
  stubPdf: boolean;
  skipOpenAI: boolean;
  skipGemini: boolean;
};

export async function getDebugFlags(): Promise<DebugFlags> {
  const envBypass = process.env.DEV_BYPASS_AUTH === 'true';
  const envStub = process.env.DEV_STUB_EXTERNALS === 'true';
  const envStubRefiner = process.env.DEV_STUB_REFINER === 'true';
  const envStubOpenAI = process.env.DEV_STUB_OPENAI === 'true';
  const envStubGemini = process.env.DEV_STUB_GEMINI === 'true';
  const envStubEmail = process.env.DEV_STUB_EMAIL === 'true';
  const envStubPdf = process.env.DEV_STUB_PDF === 'true';
  const envSkipOpenAI = process.env.DEV_SKIP_OPENAI === 'true';
  const envSkipGemini = process.env.DEV_SKIP_GEMINI === 'true';

  let cookieBypass = false;
  let cookieStub = false;
  let cookieStubRefiner = false;
  let cookieStubOpenAI = false;
  let cookieStubGemini = false;
  let cookieStubEmail = false;
  let cookieStubPdf = false;
  let cookieSkipOpenAI = false;
  let cookieSkipGemini = false;
  try {
    const store = await cookies();
    cookieBypass = store.get('dev_bypass')?.value === '1';
    cookieStub = store.get('dev_stub')?.value === '1';
    cookieStubRefiner = store.get('dev_stub_refiner')?.value === '1';
    cookieStubOpenAI = store.get('dev_stub_openai')?.value === '1';
    cookieStubGemini = store.get('dev_stub_gemini')?.value === '1';
    cookieStubEmail = store.get('dev_stub_email')?.value === '1';
    cookieStubPdf = store.get('dev_stub_pdf')?.value === '1';
    cookieSkipOpenAI = store.get('dev_skip_openai')?.value === '1';
    cookieSkipGemini = store.get('dev_skip_gemini')?.value === '1';
  } catch {
    // Ignore missing request context (e.g., build time).
  }

  return {
    bypassAuth: envBypass || cookieBypass,
    stubExternals: envStub || cookieStub,
    stubRefiner: envStub || envStubRefiner || cookieStubRefiner,
    stubOpenAI: envStub || envStubOpenAI || cookieStubOpenAI,
    stubGemini: envStub || envStubGemini || cookieStubGemini,
    stubEmail: envStub || envStubEmail || cookieStubEmail,
    stubPdf: envStub || envStubPdf || cookieStubPdf,
    skipOpenAI: envSkipOpenAI || cookieSkipOpenAI,
    skipGemini: envSkipGemini || cookieSkipGemini
  };
}
