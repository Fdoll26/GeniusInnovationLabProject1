import { getEnv } from './env';

const geminiApiKey = getEnv('GEMINI_API_KEY');
const geminiApiBase =
  getEnv('GEMINI_API_BASE') ||
  'https://generativelanguage.googleapis.com/v1beta';
const geminiModel = getEnv('GEMINI_MODEL') || 'gemini-1.5-pro-002';
const geminiFastModel = getEnv('GEMINI_FAST_MODEL') || getEnv('GEMINI_MODEL') || 'gemini-2.0-flash';
const GEMINI_DEFAULT_TIMEOUT_MS = 8 * 60_000;
const GEMINI_RPM_LIMIT = 25;
const geminiRequestLog: number[] = [];

export type GeminiResponse = {
  outputText: string;
  sources?: unknown;
};

async function request(path: string, body: unknown, opts?: { timeoutMs?: number }) {
  if (!geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  const controller = new AbortController();
  const timeout = typeof opts?.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : null;
  const timer = timeout
    ? setTimeout(() => controller.abort(new Error('Gemini request timeout')), timeout)
    : null;

  try {
    const response = await fetch(`${geminiApiBase}${path}?key=${geminiApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
      throw new GeminiHttpError(
        `Gemini request failed (${response.status}): ${errorText}`,
        response.status,
        retryAfterMs
      );
    }

    return response.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class GeminiHttpError extends Error {
  status: number;
  retryAfterMs: number | null;

  constructor(message: string, status: number, retryAfterMs: number | null) {
    super(message);
    this.name = 'GeminiHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterMs(retryAfterHeader: string | null): number | null {
  if (!retryAfterHeader) return null;
  const asNumber = Number(retryAfterHeader);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.trunc(asNumber * 1000);
  }
  const asDate = Date.parse(retryAfterHeader);
  if (!Number.isFinite(asDate)) return null;
  return Math.max(0, asDate - Date.now());
}

type RefinementResponse = { questions: string[] };

function parseRefinementOutput(text: string): RefinementResponse {
  const trimmed = text.trim();
  if (!trimmed) {
    return { questions: [] };
  }
  const normalized = trimmed.replace(/\r\n/g, '\n');
  const upper = normalized.toUpperCase();
  if (upper === 'NONE' || upper.startsWith('NONE\n') || upper.startsWith('NONE ')) {
    return { questions: [] };
  }
  const clarificationIndex = upper.indexOf('CLARIFICATION REQUIRED:');
  if (clarificationIndex >= 0) {
    const after = normalized.slice(clarificationIndex + 'CLARIFICATION REQUIRED:'.length).trim();
    const lines = after
      .split('\n')
      .map((line) => line.replace(/^\s*\d+\.\s*/, '').replace(/^[\-\*\s]+/, '').trim())
      .filter(Boolean);
    return { questions: lines.slice(0, 5) };
  }
  return { questions: [] };
}

function extractTextFromGemini(data: unknown): string {
  const typed = data as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; functionCall?: unknown }> };
      finishReason?: string;
      finishMessage?: string;
    }>;
  };
  return typed?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
}

function getGeminiFinishInfo(data: unknown): { finishReason: string | null; finishMessage: string | null } {
  const typed = data as { candidates?: Array<{ finishReason?: unknown; finishMessage?: unknown }> };
  const candidate = typed?.candidates?.[0];
  const finishReason = typeof candidate?.finishReason === 'string' ? candidate.finishReason : null;
  const finishMessage = typeof candidate?.finishMessage === 'string' ? candidate.finishMessage : null;
  return { finishReason, finishMessage };
}

function looksTruncated(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const last = trimmed.slice(-1);
  return !'.?!)]}"\''.includes(last);
}

function sanitizeSchemaForGemini(schema: unknown): unknown {
  if (schema == null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map((item) => sanitizeSchemaForGemini(item));

  const input = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const allowedKeys = new Set([
    'type',
    'properties',
    'required',
    'items',
    'enum',
    'description',
    'nullable',
    'format',
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
    'minimum',
    'maximum'
  ]);

  for (const [key, rawValue] of Object.entries(input)) {
    if (!allowedKeys.has(key)) continue;
    if (key === 'properties' && rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      const properties: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(rawValue as Record<string, unknown>)) {
        properties[propName] = sanitizeSchemaForGemini(propSchema);
      }
      out.properties = properties;
      continue;
    }
    if (key === 'items') {
      out.items = sanitizeSchemaForGemini(rawValue);
      continue;
    }
    out[key] = rawValue;
  }

  return out;
}

type GeminiGroundingMetadata = {
  webSearchQueries?: string[];
  groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
  searchEntryPoint?: { renderedContent?: string; sdkBlob?: string };
  groundingSupports?: Array<{
    segment?: { endIndex?: number };
    groundingChunkIndices?: number[];
    confidenceScores?: number[];
  }>;
};

export type GroundingChunk = {
  uri: string;
  title: string | null;
};

export type GeminiSubcallResult = {
  subquestion: string;
  status: 'completed' | 'failed';
  responseText: string | null;
  groundingMetadata: unknown | null;
  searchEntryPoint: { renderedContent?: string; sdkBlob?: string } | null;
  webSearchQueries: string[];
  groundingChunks: GroundingChunk[];
  groundingSupports: unknown[];
  usageMetadata: unknown | null;
  error: string | null;
};

export type GeminiCoverageMetrics = {
  subcallsPlanned: number;
  subcallsCompleted: number;
  subcallsFailed: number;
  uniqueSources: number;
  uniqueDomains: number;
  webSearchQueryCount: number;
  groundedSegments: number;
  avgConfidence: number | null;
};

export interface RankedSource {
  url: string;
  canonicalUrl: string;
  title: string | null;
  domain: string | null;
  supportCount: number;
  avgConfidence: number | null;
}

function getGeminiGroundingMetadata(data: unknown): GeminiGroundingMetadata | null {
  const typed = data as {
    candidates?: Array<{ groundingMetadata?: unknown }>;
  };
  const md = typed?.candidates?.[0]?.groundingMetadata as GeminiGroundingMetadata | undefined;
  return md && typeof md === 'object' ? md : null;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkGeminiRateLimit(): number {
  const now = Date.now();
  const windowStart = now - 60_000;
  while (geminiRequestLog.length && geminiRequestLog[0]! < windowStart) {
    geminiRequestLog.shift();
  }
  if (geminiRequestLog.length >= GEMINI_RPM_LIMIT) {
    const oldest = geminiRequestLog[0]!;
    return Math.max(0, oldest + 60_000 - now + 100);
  }
  return 0;
}

function recordGeminiRequest() {
  geminiRequestLog.push(Date.now());
}

function shouldRetryGeminiRequest(error: unknown): { retry: boolean; retryAfterMs: number | null } {
  if (error instanceof GeminiHttpError) {
    return {
      retry: error.status === 429 || error.status === 500 || error.status === 503,
      retryAfterMs: error.retryAfterMs
    };
  }
  const text = error instanceof Error ? error.message : String(error);
  const retryableText = /429|500|503|rate limit|temporar|unavailable/i.test(text);
  return { retry: retryableText, retryAfterMs: null };
}

function canonicalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach((p) => url.searchParams.delete(p));
    return url.toString();
  } catch {
    return u;
  }
}

function domainOf(u: string): string | null {
  try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function cleanGroundingChunk(input: unknown): GroundingChunk[] {
  if (!Array.isArray(input)) return [];
  const out: GroundingChunk[] = [];
  for (const item of input) {
    const uri = (item as { web?: { uri?: unknown } })?.web?.uri;
    const title = (item as { web?: { title?: unknown } })?.web?.title;
    if (typeof uri !== 'string' || !/^https?:\/\//i.test(uri)) continue;
    out.push({
      uri,
      title: typeof title === 'string' ? title : null
    });
  }
  return out;
}

function confidenceScoresOfSupport(support: unknown): number[] {
  const scores = (support as { confidenceScores?: unknown })?.confidenceScores;
  if (!Array.isArray(scores)) return [];
  return scores.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1);
}

async function runGeminiGroundedSubcall(params: {
  model: string;
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
}): Promise<unknown> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const waitForRateLimit = checkGeminiRateLimit();
    if (waitForRateLimit > 0) {
      await sleep(waitForRateLimit);
    }

    try {
      recordGeminiRequest();
      return await request(
        `/models/${params.model}:generateContent`,
        {
          tools: [{ google_search: {} }],
          contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
          generationConfig: {
            maxOutputTokens: params.maxOutputTokens
          }
        },
        { timeoutMs: params.timeoutMs }
      );
    } catch (error) {
      const retry = shouldRetryGeminiRequest(error);
      if (!retry.retry || attempt >= maxAttempts) {
        throw error;
      }
      const jitter = Math.floor(Math.random() * 251);
      const exponential = 500 * 2 ** (attempt - 1);
      const retryAfter = retry.retryAfterMs != null ? retry.retryAfterMs : 0;
      await sleep(Math.max(exponential + jitter, retryAfter));
    }
  }
  throw new Error('Unreachable retry state');
}

export function extractGeminiGroundingMetadata(data: unknown): {
  groundingChunks: unknown[];
  groundingSupports: unknown[];
} | null {
  const md = getGeminiGroundingMetadata(data);
  if (!md) return null;
  return {
    groundingChunks: Array.isArray(md.groundingChunks) ? md.groundingChunks : [],
    groundingSupports: Array.isArray(md.groundingSupports) ? md.groundingSupports : []
  };
}

function addInlineUrlCitationsFromGrounding(text: string, md: GeminiGroundingMetadata): string {
  const supports = md.groundingSupports ?? [];
  const chunks = md.groundingChunks ?? [];
  const insertions: Array<{ at: number; snippet: string }> = [];

  for (const support of supports) {
    const endIndex = support.segment?.endIndex;
    if (typeof endIndex !== 'number' || endIndex <= 0) {
      continue;
    }
    const indices = (support.groundingChunkIndices ?? [])
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0)
      .slice(0, 10);
    const urls = indices
      .map((i) => chunks[i]?.web?.uri)
      .filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u));
    const uniqueUrls = Array.from(new Set(urls)).slice(0, 3);
    if (uniqueUrls.length === 0) {
      continue;
    }

    const citationString = uniqueUrls.map((u) => `[${u}]`).join(' ');
    const needsLeadingSpace = endIndex > 0 && !/\s/.test(text[endIndex - 1] ?? '');
    const snippet = `${needsLeadingSpace ? ' ' : ''}${citationString}`;
    insertions.push({ at: endIndex, snippet });
  }

  if (insertions.length === 0) {
    const urls = (md.groundingChunks ?? [])
      .map((c) => c.web?.uri)
      .filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u));
    const unique = Array.from(new Set(urls)).slice(0, 10);
    if (unique.length === 0) {
      return text;
    }
    // If we don't have segment supports, fall back to a source list at the end.
    return `${text.trim()}\n\nSOURCES:\n${unique.map((u) => `[${u}]`).join('\n')}`;
  }

  // Apply from end to start so indices remain valid.
  insertions.sort((a, b) => b.at - a.at);
  let out = text;
  for (const ins of insertions) {
    const at = Math.max(0, Math.min(out.length, ins.at));
    out = `${out.slice(0, at)}${ins.snippet}${out.slice(at)}`;
  }
  return out;
}

function isGeminiToolsNotSupportedError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('google_search') &&
    (text.includes('not supported') || text.includes('unsupported') || text.includes('unknown name') || text.includes('unknown field'))
  );
}

function isGeminiInvalidArgumentError(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes('invalid_argument') || (text.includes('"code": 400') && text.includes('invalid argument'));
}

export async function startRefinementGemini(
  topic: string,
  opts?: { stub?: boolean; timeoutMs?: number }
): Promise<RefinementResponse> {
  if (opts?.stub) {
    return { questions: ['What time range should we focus on?', 'Any geographic focus?'] };
  }

  const data = await request(
    `/models/${geminiModel}:generateContent`,
    {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                'You are a Research Question Refinement Assistant.\n' +
                "Your task is to improve the clarity, specificity, and research-readiness of a user’s research question before it is sent to a deep research model.\n\n" +
                'Your Responsibilities\n\n' +
                '1. Assess the Input Question\n' +
                ' - Determine whether the question is:\n' +
                ' - Clear and specific\n' +
                ' - Too broad\n' +
                '  - Ambiguous\n' +
                ' - Missing important constraints (timeframe, geography, population, context, definitions, etc.)\n\n' +
                '2. If Clarification Is Needed\n' +
                ' - Ask concise, targeted clarifying questions.\n' +
                ' - Only ask questions that materially improve research quality.\n' +
                ' - Limit to 1–5 high-impact clarifying questions.\n' +
                ' - Do NOT explain why you are asking.\n' +
                ' - Do NOT attempt to answer the research question yet.\n\n' +
                '3. If No Clarification Is Needed\n' +
                ' - Output NONE.\n\n' +
                'Output Rules\n' +
                'You must output in ONE of the following two formats:\n\n' +
                'Format A: Clarification Needed\n' +
                'CLARIFICATION REQUIRED:\n' +
                '1. [Question]\n' +
                '2. [Question]\n' +
                '3. [Question]\n\n' +
                'Format B: No Clarification Needed\n' +
                'NONE\n\n' +
                'Do not output anything else.\n' +
                'Do not include explanations.\n' +
                'Do not include commentary.\n' +
                'Do not answer the research question.\n\n' +
                'If the user input is not a research question, reformulate it into one when possible.\n\n' +
                `USER INPUT:\n${topic}`
            }
          ]
        }
      ]
    },
    { timeoutMs: opts?.timeoutMs }
  );

  return parseRefinementOutput(extractTextFromGemini(data));
}

export async function rewritePromptGemini(
  input: { topic: string; draftPrompt: string; clarifications: Array<{ question: string; answer: string }> },
  opts?: { stub?: boolean; timeoutMs?: number }
): Promise<string> {
  if (opts?.stub) {
    return `${input.draftPrompt} (rewritten)`;
  }
  const clarificationsText =
    input.clarifications.length === 0
      ? 'None.'
      : input.clarifications.map((item, index) => `${index + 1}. ${item.question} → ${item.answer}`).join('\n');

  const data = await request(
    `/models/${geminiModel}:generateContent`,
    {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                'Rewrite the user prompt into a clear, detailed research prompt. ' +
                'Include constraints from clarifications. Return only the rewritten prompt.\n\n' +
                `Original topic: ${input.topic}\n` +
                `Draft prompt: ${input.draftPrompt}\n` +
                `Clarifications:\n${clarificationsText}`
            }
          ]
        }
      ]
    },
    { timeoutMs: opts?.timeoutMs }
  );
  return extractTextFromGemini(data).trim();
}

export async function summarizeForReportGemini(
  input: { provider: 'OpenAI' | 'Gemini' | 'Combined'; researchText: string; references: Array<{ n: number; title?: string; url: string }> },
  opts?: { stub?: boolean; timeoutMs?: number; includeRefs?: boolean }
): Promise<string> {
  if (opts?.stub) {
    return `Stub summary for ${input.provider}.`;
  }
  const includeRefs = opts?.includeRefs ?? true;
  const refsText =
    input.references.length === 0
      ? 'None.'
      : input.references.map((ref) => `[${ref.n}] ${ref.title ? `${ref.title} — ` : ''}${ref.url}`).join('\n');

  const basePrompt =
    `Write a thorough summary of the following ${input.provider} research output.\n` +
    `- Use neutral, factual language.\n` +
    `- Aim for 2–4 paragraphs and complete sentences.\n` +
    `- Do NOT cut off mid-sentence.\n` +
    (includeRefs
      ? `- If you make a factual claim that is supported by a reference, add a citation like [3].\n` +
        `- Use ONLY the reference numbers provided below.\n` +
        `- Do NOT invent citations.\n`
      : `- Do NOT include citations.\n`) +
    `- Do NOT include a title or bullet points.\n\n` +
    `REFERENCES:\n${refsText}\n\n` +
    `RESEARCH OUTPUT:\n${input.researchText.trim().slice(0, 12000)}`;

  const call = async (prompt: string, maxOutputTokens: number) => {
    const data = await request(
      `/models/${geminiModel}:generateContent`,
      {
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: { maxOutputTokens }
      },
      { timeoutMs: opts?.timeoutMs }
    );
    const text = extractTextFromGemini(data).trim();
    const finish = getGeminiFinishInfo(data);
    return { text, finishReason: finish.finishReason };
  };

  const first = await call(basePrompt, 2000);
  const truncated =
    (first.finishReason && first.finishReason.toLowerCase().includes('max')) || looksTruncated(first.text);
  if (!truncated) {
    return first.text;
  }

  const tail = first.text.slice(-900);
  const continuationPrompt =
    `Continue the summary without repeating any sentences.\n` +
    `- Return ONLY the continuation text.\n` +
    `- Ensure the final output ends with a complete sentence.\n\n` +
    `PREVIOUS SUMMARY (do not repeat):\n${tail}\n\n` +
    basePrompt;

  const second = await call(continuationPrompt, 1200);
  return `${first.text}\n\n${second.text}`.trim();
}

export async function runGemini(
  refinedPrompt: string,
  opts?: { stub?: boolean; timeoutMs?: number; maxSources?: number; model?: string }
): Promise<GeminiResponse> {
  if (opts?.stub) {
    return { outputText: `Stubbed Gemini result for: ${refinedPrompt}` };
  }
  const selectedModel = opts?.model || geminiModel;
  const maxSources = typeof opts?.maxSources === 'number' ? Math.max(1, Math.min(100, Math.trunc(opts.maxSources))) : 15;
  const sourceBudgetText = `SOURCE BUDGET: Use at most ${maxSources} distinct sources. Prefer primary sources and highly reputable secondary sources.`;
  const depthText =
    'DEPTH & TOOLS: Be as in-depth and thorough as possible, and use all tools available to you that improve accuracy and completeness.';
  const systemText = `${depthText}\n${sourceBudgetText}`;

  const legacyPrompt = `${systemText}\n\n${refinedPrompt}`;
  const safeSystemText =
    systemText +
    '\n\nIMPORTANT TOOLING NOTE:\n' +
    '- If web grounding is available, you MAY use built-in Google Search grounding.\n' +
    '- Do NOT output tool/function-call syntax in your text (e.g., do not write `call:google_search{...}`).\n' +
    '- Produce the final report text directly.\n';

  let data: any;
  const tryRequest = async (params: { systemKey: 'system_instruction' | 'systemInstruction' | null; useTools: boolean; legacy: boolean }) => {
    const tools = params.useTools ? ([{ google_search: {} }] as const) : undefined;
    if (params.legacy) {
      return await request(
        `/models/${selectedModel}:generateContent`,
        {
          ...(tools ? { tools } : {}),
          contents: [{ role: 'user', parts: [{ text: params.systemKey ? `${safeSystemText}\n\nRESEARCH QUESTION (refined):\n${refinedPrompt}` : legacyPrompt }] }],
          generationConfig: { maxOutputTokens: 2500 }
        },
        { timeoutMs: opts?.timeoutMs }
      );
    }
    if (params.systemKey === 'system_instruction') {
      return await request(
        `/models/${selectedModel}:generateContent`,
        {
          ...(tools ? { tools } : {}),
          system_instruction: { parts: [{ text: systemText }] },
          contents: [{ role: 'user', parts: [{ text: refinedPrompt }] }],
          generationConfig: { maxOutputTokens: 2500 }
        },
        { timeoutMs: opts?.timeoutMs }
      );
    }
    if (params.systemKey === 'systemInstruction') {
      return await request(
        `/models/${selectedModel}:generateContent`,
        {
          ...(tools ? { tools } : {}),
          systemInstruction: { parts: [{ text: systemText }] },
          contents: [{ role: 'user', parts: [{ text: refinedPrompt }] }],
          generationConfig: { maxOutputTokens: 2500 }
        },
        { timeoutMs: opts?.timeoutMs }
      );
    }
    return await request(
      `/models/${selectedModel}:generateContent`,
      {
        ...(tools ? { tools } : {}),
        contents: [{ role: 'user', parts: [{ text: legacyPrompt }] }],
        generationConfig: { maxOutputTokens: 2500 }
      },
      { timeoutMs: opts?.timeoutMs }
    );
  };

  try {
    data = await tryRequest({ systemKey: 'system_instruction', useTools: true, legacy: false });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (isGeminiToolsNotSupportedError(msg)) {
      data = await tryRequest({ systemKey: 'system_instruction', useTools: false, legacy: false });
    } else if (!/unknown name|unknown field|invalid json payload/i.test(msg)) {
      throw error;
    } else {
      try {
        data = await tryRequest({ systemKey: 'systemInstruction', useTools: true, legacy: false });
      } catch (error2) {
        const msg2 = error2 instanceof Error ? error2.message : String(error2);
        if (isGeminiToolsNotSupportedError(msg2)) {
          data = await tryRequest({ systemKey: 'systemInstruction', useTools: false, legacy: false });
        } else {
          data = await tryRequest({ systemKey: null, useTools: true, legacy: false });
        }
      }
    }
  }

  const finish = getGeminiFinishInfo(data);
  const finishText = `${finish.finishReason ?? ''}\n${finish.finishMessage ?? ''}`.trim();
  if (
    finish.finishReason === 'MALFORMED_FUNCTION_CALL' ||
    /malformed function call/i.test(finishText) ||
    /call:google_search/i.test(finishText)
  ) {
    // Retry once with explicit instructions to avoid tool/function calling; otherwise Gemini may output a tool call
    // that this app can't execute/ground, resulting in an empty response.
    try {
      data = await request(`/models/${selectedModel}:generateContent`, {
        tools: [{ google_search: {} }],
        system_instruction: { parts: [{ text: safeSystemText }] },
        contents: [{ role: 'user', parts: [{ text: refinedPrompt }] }],
        generationConfig: { maxOutputTokens: 2500 }
      }, { timeoutMs: opts?.timeoutMs });
    } catch {
      data = await request(
        `/models/${selectedModel}:generateContent`,
        {
          contents: [{ role: 'user', parts: [{ text: `${safeSystemText}\n\nRESEARCH QUESTION (refined):\n${refinedPrompt}` }] }],
          generationConfig: { maxOutputTokens: 2500 }
        },
        { timeoutMs: opts?.timeoutMs }
      );
    }
  }

  const rawText = extractTextFromGemini(data);
  const grounding = getGeminiGroundingMetadata(data);
  const outputText = grounding ? addInlineUrlCitationsFromGrounding(rawText, grounding) : rawText;

  return {
    outputText,
    sources: grounding ?? data?.candidates?.[0]?.citationMetadata
  };
}

export async function runGeminiReasoningStep(params: {
  prompt: string;
  maxOutputTokens: number;
  model?: string;
  timeoutMs?: number;
  useSearch?: boolean;
  structuredOutput?: {
    jsonSchema: Record<string, unknown>;
  };
}): Promise<{
  text: string;
  sources?: unknown;
  usage?: unknown;
  groundingMetadata?: { groundingChunks: unknown[]; groundingSupports: unknown[] };
}> {
  const model = params.model || geminiModel;
  const desiredSearch = params.useSearch ?? true;
  const desiredStructured = Boolean(params.structuredOutput);
  const maxOutputTokens = Math.max(200, Math.min(8000, Math.trunc(params.maxOutputTokens)));

  const run = async (opts: { useSearch: boolean; useStructured: boolean }) =>
    request(
      `/models/${model}:generateContent`,
      {
        ...(opts.useSearch ? { tools: [{ google_search: {} }] } : {}),
        contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
        generationConfig: {
          maxOutputTokens,
          ...(opts.useStructured && params.structuredOutput
            ? {
                responseMimeType: 'application/json',
                responseSchema: sanitizeSchemaForGemini(params.structuredOutput.jsonSchema)
              }
            : {})
        }
      },
      { timeoutMs: params.timeoutMs }
    );

  let data: unknown;
  try {
    data = await run({ useSearch: desiredSearch, useStructured: desiredStructured });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!isGeminiInvalidArgumentError(msg)) {
      throw error;
    }

    if (desiredSearch) {
      try {
        data = await run({ useSearch: false, useStructured: desiredStructured });
      } catch (errorNoSearch) {
        const msgNoSearch = errorNoSearch instanceof Error ? errorNoSearch.message : String(errorNoSearch);
        if (!desiredStructured || !isGeminiInvalidArgumentError(msgNoSearch)) {
          throw errorNoSearch;
        }
        data = await run({ useSearch: false, useStructured: false });
      }
    } else if (desiredStructured) {
      data = await run({ useSearch: false, useStructured: false });
    } else {
      throw error;
    }
  }
  const text = extractTextFromGemini(data).trim();
  const grounding = getGeminiGroundingMetadata(data);
  return {
    text: grounding ? addInlineUrlCitationsFromGrounding(text, grounding) : text,
    sources: grounding ?? data,
    usage: (data as { usageMetadata?: unknown }).usageMetadata,
    ...(grounding
      ? {
          groundingMetadata: {
            groundingChunks: grounding.groundingChunks ?? [],
            groundingSupports: grounding.groundingSupports ?? []
          }
        }
      : {})
  };
}

export async function runGeminiReasoningStepFanOut(params: {
  prompt: string;
  queryPack: string[];
  maxOutputTokens: number;
  model?: string;
  timeoutMs?: number;
  maxParallelSubcalls?: number;
  maxSubcalls?: number;
}): Promise<{
  text: string;
  sources?: unknown;
  usage?: unknown;
  subcallResults: GeminiSubcallResult[];
  coverageMetrics: GeminiCoverageMetrics;
  rankedSources: RankedSource[];
}> {
  const model = params.model || geminiFastModel;
  const totalBudgetMs =
    typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : GEMINI_DEFAULT_TIMEOUT_MS;
  const startMs = Date.now();
  const consolidationBudgetMs = Math.max(15_000, Math.floor(totalBudgetMs * 0.3));
  const subcallBudgetMs = Math.max(15_000, totalBudgetMs - consolidationBudgetMs);
  const subcallDeadline = startMs + subcallBudgetMs;
  const maxParallel = Math.max(1, Math.min(10, Math.trunc(params.maxParallelSubcalls ?? 6)));
  const maxSubcalls = Math.max(
    1,
    Math.min(30, Math.trunc(params.maxSubcalls ?? (Array.isArray(params.queryPack) ? params.queryPack.length : 1)))
  );
  const queryPack = (Array.isArray(params.queryPack) ? params.queryPack : [])
    .map((q) => (typeof q === 'string' ? q.trim() : ''))
    .filter(Boolean)
    .slice(0, maxSubcalls);
  const subquestions = queryPack.length > 0 ? queryPack : [params.prompt.slice(0, 300)];
  const subcallResults: GeminiSubcallResult[] = [];
  const masterPromptShort = params.prompt.slice(0, 800);
  // Scout subcalls need a small, fixed budget: enough for 5-10 source citations and
  // 3-4 factual paragraphs, but small enough that 16 parallel calls don't overflow the
  // consolidation context. The user's maxOutputTokens governs the final synthesis output,
  // not each individual grounded scout call.
  const perSubcallMaxTokens = 800;
  const perSubcallBaseTimeoutMs = Math.max(8_000, Math.floor((totalBudgetMs * 0.8) / maxParallel));

  let nextIndex = 0;
  const runWorker = async () => {
    while (true) {
      if (Date.now() >= subcallDeadline) return;
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= subquestions.length) return;
      const subquestion = subquestions[idx]!;
      const remainingToDeadline = Math.max(0, subcallDeadline - Date.now());
      // No padding beyond the remaining subcall budget - ensures consolidation always gets its time slice.
      const timeoutMs = Math.max(5_000, Math.min(perSubcallBaseTimeoutMs, remainingToDeadline));

      const subcallPrompt =
        'You are a web research scout. Your ONLY job is to find as many DISTINCT, HIGH-QUALITY sources as possible on the subquestion below.\n\n' +
        `MASTER RESEARCH QUESTION: ${masterPromptShort}\n\n` +
        `SUBQUESTION FOR THIS SCOUT CALL: ${subquestion}\n\n` +
        'MANDATORY REQUIREMENTS - you will be penalized for missing any of these:\n' +
        '1. You MUST search and cite at least 5 different sources from at least 4 different domains.\n' +
        '2. Each cited source must be from a DIFFERENT website (no two citations from the same domain).\n' +
        '3. Preferred source types IN ORDER: peer-reviewed papers, .gov/.edu sites, official institutional reports, major news outlets, reputable industry analysis.\n' +
        '4. For EACH source you cite: state the specific fact or finding it supports, and include its URL inline as [URL].\n' +
        '5. If a supporting and a contradicting source exist, cite BOTH.\n\n' +
        'OUTPUT FORMAT (strictly follow this):\n' +
        '- Write 1 short paragraph per source (3-4 sentences max per paragraph).\n' +
        '- Each paragraph: state the finding, cite the URL inline as [URL], note source type and date if known.\n' +
        '- Do NOT write a long narrative. Short, dense, citation-rich paragraphs only.\n' +
        '- End with a one-line summary: "Found X sources across Y domains."';

      try {
        const data = await runGeminiGroundedSubcall({
          model,
          prompt: subcallPrompt,
          maxOutputTokens: perSubcallMaxTokens,
          timeoutMs
        });
        const groundingMetadata = getGeminiGroundingMetadata(data);
        const searchEntryPoint =
          groundingMetadata?.searchEntryPoint && typeof groundingMetadata.searchEntryPoint === 'object'
            ? {
                renderedContent:
                  typeof groundingMetadata.searchEntryPoint.renderedContent === 'string'
                    ? groundingMetadata.searchEntryPoint.renderedContent
                    : undefined,
                sdkBlob:
                  typeof groundingMetadata.searchEntryPoint.sdkBlob === 'string'
                    ? groundingMetadata.searchEntryPoint.sdkBlob
                    : undefined
              }
            : null;
        subcallResults.push({
          subquestion,
          status: 'completed',
          responseText: extractTextFromGemini(data).trim(),
          groundingMetadata: groundingMetadata ?? null,
          searchEntryPoint,
          webSearchQueries: Array.isArray(groundingMetadata?.webSearchQueries)
            ? groundingMetadata.webSearchQueries.filter((q): q is string => typeof q === 'string')
            : [],
          groundingChunks: cleanGroundingChunk(groundingMetadata?.groundingChunks),
          groundingSupports: Array.isArray(groundingMetadata?.groundingSupports) ? groundingMetadata.groundingSupports : [],
          usageMetadata: (data as { usageMetadata?: unknown })?.usageMetadata ?? null,
          error: null
        });
      } catch (error) {
        subcallResults.push({
          subquestion,
          status: 'failed',
          responseText: null,
          groundingMetadata: null,
          searchEntryPoint: null,
          webSearchQueries: [],
          groundingChunks: [],
          groundingSupports: [],
          usageMetadata: null,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(maxParallel, subquestions.length) }, () => runWorker()));

  const completed = subcallResults.filter((r) => r.status === 'completed');
  const subcallsPlanned = subquestions.length;
  const subcallsCompleted = completed.length;
  const subcallsFailed = subcallsPlanned - subcallsCompleted;

  const mergedChunks: Array<{ web: { uri: string; title?: string } }> = [];
  const mergedSupports: unknown[] = [];
  const webSearchQueries: string[] = [];
  const chunkIndexByCanonicalUrl = new Map<string, number>();
  const supportStats = new Map<number, { supportCount: number; confidenceTotal: number; confidenceCount: number }>();
  const confidenceAll: number[] = [];

  for (const result of completed) {
    webSearchQueries.push(...result.webSearchQueries);
    const localToMerged = new Map<number, number>();
    result.groundingChunks.forEach((chunk, localIdx) => {
      const canonical = canonicalizeUrl(chunk.uri);
      const existing = chunkIndexByCanonicalUrl.get(canonical);
      if (typeof existing === 'number') {
        localToMerged.set(localIdx, existing);
        return;
      }
      const next = mergedChunks.length;
      chunkIndexByCanonicalUrl.set(canonical, next);
      localToMerged.set(localIdx, next);
      mergedChunks.push({
        web: {
          uri: chunk.uri,
          ...(chunk.title ? { title: chunk.title } : {})
        }
      });
    });

    for (const support of result.groundingSupports) {
      if (!support || typeof support !== 'object') continue;
      const rec = support as { groundingChunkIndices?: unknown };
      const originalIndices = Array.isArray(rec.groundingChunkIndices) ? rec.groundingChunkIndices : [];
      const mapped = Array.from(
        new Set(
          originalIndices
            .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0)
            .map((idx) => localToMerged.get(idx))
            .filter((idx): idx is number => typeof idx === 'number')
        )
      );
      if (mapped.length === 0) continue;

      const confidence = confidenceScoresOfSupport(support);
      for (const score of confidence) confidenceAll.push(score);
      for (const idx of mapped) {
        const curr = supportStats.get(idx) ?? { supportCount: 0, confidenceTotal: 0, confidenceCount: 0 };
        curr.supportCount += 1;
        if (confidence.length > 0) {
          curr.confidenceTotal += confidence.reduce((sum, n) => sum + n, 0);
          curr.confidenceCount += confidence.length;
        }
        supportStats.set(idx, curr);
      }

      mergedSupports.push({
        ...(support as Record<string, unknown>),
        groundingChunkIndices: mapped
      });
    }
  }

  const rankedSources: RankedSource[] = mergedChunks
    .map((chunk, idx) => {
      const url = chunk.web.uri;
      const canonicalUrl = canonicalizeUrl(url);
      const stats = supportStats.get(idx) ?? { supportCount: 0, confidenceTotal: 0, confidenceCount: 0 };
      return {
        url,
        canonicalUrl,
        title: typeof chunk.web.title === 'string' ? chunk.web.title : null,
        domain: domainOf(canonicalUrl),
        supportCount: stats.supportCount,
        avgConfidence: stats.confidenceCount > 0 ? stats.confidenceTotal / stats.confidenceCount : null
      };
    })
    .sort((a, b) => {
      if (b.supportCount !== a.supportCount) return b.supportCount - a.supportCount;
      const aConfidence = a.avgConfidence ?? -1;
      const bConfidence = b.avgConfidence ?? -1;
      return bConfidence - aConfidence;
    });

  const uniqueCanonicalSources = new Set(rankedSources.map((s) => s.canonicalUrl));
  const uniqueDomains = new Set(rankedSources.map((s) => s.domain).filter((d): d is string => Boolean(d)));
  const coverageMetrics: GeminiCoverageMetrics = {
    subcallsPlanned,
    subcallsCompleted,
    subcallsFailed,
    uniqueSources: uniqueCanonicalSources.size,
    uniqueDomains: uniqueDomains.size,
    webSearchQueryCount: webSearchQueries.length,
    groundedSegments: mergedSupports.length,
    avgConfidence:
      confidenceAll.length > 0 ? confidenceAll.reduce((sum, value) => sum + value, 0) / confidenceAll.length : null
  };

  const stepGoalLine =
    params.prompt
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0)?.slice(0, 240) ?? 'Research step synthesis';
  const SUBCALL_TEXT_CHAR_LIMIT = 1200;
  const findings = completed
    .filter((item) => item.responseText)
    .map((item, idx) => {
      const text = item.responseText ?? '';
      const truncated =
        idx < 4
          ? text
          : text.slice(0, SUBCALL_TEXT_CHAR_LIMIT) + (text.length > SUBCALL_TEXT_CHAR_LIMIT ? '... [truncated]' : '');
      const urlList = item.groundingChunks
        .map((c) => c.uri)
        .filter(Boolean)
        .map((u) => `[${u}]`)
        .join(' ');
      const urlAppendix = urlList ? `\nSOURCES FROM THIS SUBCALL: ${urlList}` : '';
      return `---\n[SCOUT ${idx + 1} | subquestion: ${item.subquestion}]\n${truncated}${urlAppendix}\n---`;
    })
    .join('\n');

  let text = '';
  if (!findings.trim()) {
    text = 'No grounded subcall findings were completed within the time budget.';
  } else {
    // System instruction is sent as a dedicated field (not embedded in user content)
    // so the model treats it as a binding directive rather than part of the prompt text.
    const consolidationSystemInstruction =
      'You are a senior research analyst. Your job is to synthesize web research findings into a ' +
      'comprehensive, citation-rich report section. Never drop source URLs - every URL present in ' +
      'the scout reports must appear as an inline citation [URL] in your output. Never truncate or ' +
      'stop early. Cover all findings completely before writing the Sources section.';

    // The user-facing prompt contains only the findings and instructions - no system preamble.
    const consolidationPrompt =
      `RESEARCH STEP GOAL: ${stepGoalLine}\n\n` +
      `SCOUT FINDINGS (${subcallsCompleted} of ${subquestions.length} scouts completed):\n` +
      `${findings}\n\n` +
      'SYNTHESIS INSTRUCTIONS:\n' +
      '1. Write a comprehensive synthesis organized by THEME. Do NOT organize by scout number.\n' +
      '2. For every claim, include its source URL inline as [URL] immediately after the claim.\n' +
      '3. Every URL listed in any "SOURCES FROM THIS SUBCALL" line MUST appear somewhere in your output.\n' +
      '4. When scouts contradict each other, present both sides with their respective citations.\n' +
      '5. Include all statistics, dates, named organizations, and quantitative data from the scouts.\n' +
      '6. Do NOT add any information not present in the scout reports.\n' +
      '7. Write until all findings are covered - do not stop early.\n' +
      '8. After the synthesis prose, write a "## Sources" section listing every unique URL on its own line formatted as: [URL] - Title (if known).';

    const remainingTotalBudget = Math.max(5_000, startMs + totalBudgetMs - Date.now());
    const consolidationTimeoutMs = Math.max(15_000, Math.min(consolidationBudgetMs, remainingTotalBudget));
    // The consolidation synthesis needs tokens proportional to the number of scouts.
    const consolidationOutputTokens = Math.min(8000, Math.max(4000, subcallsCompleted * 300));
    try {
      const consolidationData = await request(
        `/models/${model}:generateContent`,
        {
          system_instruction: {
            parts: [{ text: consolidationSystemInstruction }]
          },
          contents: [{ role: 'user', parts: [{ text: consolidationPrompt }] }],
          generationConfig: { maxOutputTokens: consolidationOutputTokens }
        },
        { timeoutMs: consolidationTimeoutMs }
      );
      text = extractTextFromGemini(consolidationData).trim();
    } catch {
      // Consolidation failed: fall back to scout concatenation and always append all URLs.
      const allUrls = mergedChunks
        .map((c) => c.web.uri)
        .filter(Boolean)
        .map((u) => `[${u}]`)
        .join('\n');
      text =
        completed
          .map((item) => (item.responseText ? `### ${item.subquestion}\n${item.responseText}` : ''))
          .filter(Boolean)
          .join('\n\n') + (allUrls ? `\n\n## Sources\n${allUrls}` : '');
    }
  }

  return {
    text,
    sources: {
      groundingMetadata: {
        webSearchQueries,
        groundingChunks: mergedChunks,
        groundingSupports: mergedSupports
      },
      web_search_call_sources: mergedChunks.map((chunk) => ({
        url: chunk.web.uri,
        title: typeof chunk.web.title === 'string' ? chunk.web.title : null
      }))
    },
    usage: {
      subcallUsage: subcallResults.map((result) => result.usageMetadata),
      subcallsCompleted,
      subcallsFailed
    },
    subcallResults,
    coverageMetrics,
    rankedSources
  };
}
