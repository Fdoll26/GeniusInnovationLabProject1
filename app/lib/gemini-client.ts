import { getEnv } from './env';

const geminiApiKey = getEnv('GEMINI_API_KEY');
const geminiApiBase =
  getEnv('GEMINI_API_BASE') ||
  'https://generativelanguage.googleapis.com/v1beta';
const geminiModel = getEnv('GEMINI_MODEL') || 'gemini-2.5-pro';
const geminiDeepModel = getEnv('GEMINI_DEEP_MODEL') || geminiModel;
const geminiFastModel = getEnv('GEMINI_FAST_MODEL') || 'gemini-2.0-flash';
const geminiSubcallModel = getEnv('GEMINI_SUBCALL_MODEL') || geminiFastModel;
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

type RefinementResponse = { questions: Array<{ question: string; options: string[] }> };

function fallbackOptionsForQuestion(question: string): string[] {
  const lower = question.toLowerCase();
  if (/(time|date|year|recent|latest|range|period|historical)/.test(lower)) {
    return ['Past 12 months', 'Past 5 years', 'Since 2020', 'All time'];
  }
  if (/(geo|geographic|region|country|market|location)/.test(lower)) {
    return ['United States', 'Global', 'Europe', 'Asia-Pacific'];
  }
  if (/(depth|technical|detail|level)/.test(lower)) {
    return ['High-level', 'Balanced depth', 'Technical deep dive'];
  }
  if (/(audience|stakeholder|who is this for)/.test(lower)) {
    return ['Executives', 'Practitioners', 'General audience'];
  }
  return ['Most recent', 'US focus', 'Balanced depth'];
}

function normalizeRefinementQuestions(raw: unknown): Array<{ question: string; options: string[] }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ question: string; options: string[] }> = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const question = item.trim();
      if (!question) continue;
      out.push({ question, options: fallbackOptionsForQuestion(question) });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const question = String(rec.question ?? '').trim();
    if (!question) continue;
    const options = Array.isArray(rec.options)
      ? rec.options
          .map((opt) => String(opt ?? '').trim())
          .filter(Boolean)
          .slice(0, 4)
      : [];
    out.push({ question, options: options.length ? options : fallbackOptionsForQuestion(question) });
  }
  return out.slice(0, 5);
}

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
  const jsonCandidate = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(jsonCandidate) as { questions?: unknown };
    const normalizedQuestions = normalizeRefinementQuestions(parsed?.questions);
    if (normalizedQuestions.length) {
      return { questions: normalizedQuestions };
    }
  } catch {
    // fall back to legacy format
  }
  const clarificationIndex = upper.indexOf('CLARIFICATION REQUIRED:');
  if (clarificationIndex >= 0) {
    const after = normalized.slice(clarificationIndex + 'CLARIFICATION REQUIRED:'.length).trim();
    const lines = after
      .split('\n')
      .map((line) => line.replace(/^\s*\d+\.\s*/, '').replace(/^[\-\*\s]+/, '').trim())
      .filter(Boolean);
    return {
      questions: lines.slice(0, 5).map((question) => ({
        question,
        options: fallbackOptionsForQuestion(question)
      }))
    };
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

export function looksTruncated(text: string): boolean {
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
  const numericConstraintKeys = new Set(['minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum']);

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
    if (numericConstraintKeys.has(key)) {
      const asNumber = typeof rawValue === 'string' ? Number(rawValue) : rawValue;
      out[key] = typeof asNumber === 'number' && Number.isFinite(asNumber) ? asNumber : rawValue;
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
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const waitForRateLimit = checkGeminiRateLimit();
    if (waitForRateLimit > 0) {
      await sleep(waitForRateLimit);
    }

    try {
      recordGeminiRequest();
      const data = await request(
        `/models/${params.model}:generateContent`,
        {
          system_instruction: {
            parts: [
              {
                text:
                  'You are a web research scout. Use Google Search grounding internally. ' +
                  'Return only plain research text. Never emit tool-call syntax like call:google_search{...}.'
              }
            ]
          },
          tools: [{ google_search: {} }],
          contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
          generationConfig: {
            maxOutputTokens: params.maxOutputTokens
          }
        },
        { timeoutMs: params.timeoutMs }
      );
      const finish = getGeminiFinishInfo(data);
      const finishText = `${finish.finishReason ?? ''}\n${finish.finishMessage ?? ''}`.trim();
      const malformedCall =
        finish.finishReason === 'MALFORMED_FUNCTION_CALL' || /malformed function call|call:google[_:]search/i.test(finishText);
      if (!malformedCall) {
        return data;
      }
      if (attempt >= maxAttempts) {
        return data;
      }
      const jitter = Math.floor(Math.random() * 1000);
      await sleep(1500 + jitter);
      continue;
    } catch (error) {
      const retry = shouldRetryGeminiRequest(error);
      if (!retry.retry || attempt >= maxAttempts) {
        throw error;
      }
      const jitter = Math.floor(Math.random() * 1000);
      const is503 = error instanceof GeminiHttpError && error.status === 503;
      const exponential = is503 ? 5000 * 2 ** (attempt - 1) : 500 * 2 ** (attempt - 1);
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
    return {
      questions: [
        { question: 'What time range should we focus on?', options: ['Past 12 months', 'Past 5 years', 'Since 2020'] },
        { question: 'Any geographic focus?', options: ['United States', 'Global', 'Europe'] }
      ]
    };
  }

  const data = await request(
    `/models/${geminiFastModel}:generateContent`,
    {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                'You are a Research Question Refiner for deep-research workflows.\n' +
                'Goal: make the question precise enough that step-by-step research produces a complete, high-quality final report.\n\n' +
                'Decision:\n' +
                '- If the question is already research-ready, output EXACTLY: NONE\n' +
                '- Otherwise output JSON only, using this shape:\n' +
                '{"questions":[{"question":"...","options":["...","..."]}]}\n\n' +
                'Rules:\n' +
                '- Ask 1-5 questions max.\n' +
                '- Ask only high-impact questions that change research results.\n' +
                '- Prioritize: timeframe, geography, scope (entities/population), comparison baseline, success criteria, and desired output format.\n' +
                '- For EACH question, include 2-4 short clickable options (2-4 words each) relevant to that exact question.\n' +
                '- No explanations, no answers, no meta-commentary.\n' +
                '- Do not write anything except NONE or the JSON object.\n\n' +
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
    `/models/${geminiFastModel}:generateContent`,
    {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                'Rewrite the user prompt into ONE high-impact deep-research prompt that maximizes completeness and insight.\n' +
                'Include constraints from clarifications.\n' +
                'Do NOT impose artificial brevity, source-count caps, or output-length limits.\n' +
                'Require full evidence coverage, opposing viewpoints, and explicit uncertainties.\n' +
                'Return only the rewritten prompt.\n\n' +
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

  const SEGMENT_CHAR_LIMIT = 8000;
  const fullText = input.researchText.trim();
  const segments: string[] = [];
  for (let cursor = 0; cursor < fullText.length; cursor += SEGMENT_CHAR_LIMIT) {
    segments.push(fullText.slice(cursor, cursor + SEGMENT_CHAR_LIMIT));
  }
  if (segments.length === 0) segments.push('');

  const call = async (prompt: string, maxOutputTokens: number) => {
    const data = await request(
      `/models/${geminiFastModel}:generateContent`,
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

  const systemHeader =
    `Write a thorough summary of the following ${input.provider} research output.\n` +
    `- Use neutral, factual language.\n` +
    `- Aim for complete sentences with no cut-offs.\n` +
    (includeRefs
      ? `- Add inline citations like [3] for claims supported by a reference. Use ONLY the numbers below. Do NOT invent citations.\n`
      : `- Do NOT include citations.\n`) +
    `- Do NOT include a title or bullet points.\n\n` +
    `REFERENCES:\n${refsText}\n\n`;

  const parts: string[] = [];
  let previousTail = '';

  for (let i = 0; i < segments.length; i++) {
    const isFirst = i === 0;
    const isLast = i === segments.length - 1;
    const segment = segments[i] ?? '';

    const continuationPrefix = previousTail
      ? `Continue the summary without repeating. Here is the end of what was written so far (do not repeat):\n\n${previousTail}\n\n---\n\n`
      : '';

    const segmentRole = isFirst
      ? 'RESEARCH OUTPUT (part 1 of ' + segments.length + '):'
      : `RESEARCH OUTPUT (part ${i + 1} of ${segments.length}):`;

    const isLastInstruction = isLast
      ? '\n- This is the final segment. Ensure the summary ends with a complete sentence.'
      : '\n- More segments follow. Do NOT write a concluding sentence yet. Stop cleanly at a sentence boundary.';

    const prompt = `${continuationPrefix}${systemHeader}${segmentRole}${isLastInstruction}\n\n${segment}`;
    const result = await call(prompt, 2500);
    parts.push(result.text);

    const truncated =
      (result.finishReason && result.finishReason.toLowerCase().includes('max')) || looksTruncated(result.text);

    if (truncated) {
      const tail = result.text.slice(-900);
      const continuationPrompt =
        `Continue the summary without repeating any sentences.\n` +
        `- Return ONLY the continuation text.\n` +
        `- Ensure the text ends with a complete sentence.\n\n` +
        `PREVIOUS SUMMARY TAIL (do not repeat):\n${tail}\n\n` +
        systemHeader +
        `RESEARCH OUTPUT (continuation of part ${i + 1}):\n\n${segment.slice(-3000)}`;
      const cont = await call(continuationPrompt, 1500);
      parts.push(cont.text);
      previousTail = cont.text.slice(-900);
    } else {
      previousTail = result.text.slice(-900);
    }
  }

  return parts.join('\n\n').trim();
}

export async function generateModelComparisonGemini(
  input: {
    openaiReport: string;
    geminiReport: string;
    topic: string;
  },
  opts?: { stub?: boolean; timeoutMs?: number }
): Promise<string> {
  if (opts?.stub) {
    return `Stub comparison for topic: ${input.topic}.`;
  }

  const openaiExcerpt = input.openaiReport.trim().slice(0, 5000);
  const geminiExcerpt = input.geminiReport.trim().slice(0, 5000);

  const prompt =
    `You are a senior research analyst comparing two independent AI-generated research reports on the same topic.\n\n` +
    `RESEARCH TOPIC: ${input.topic}\n\n` +
    `OPENAI REPORT EXCERPT:\n${openaiExcerpt}\n\n` +
    `GEMINI REPORT EXCERPT:\n${geminiExcerpt}\n\n` +
    `Write a concise but thorough comparison section with the following subsections:\n` +
    `1. **Key Agreements** - Major findings both reports agree on.\n` +
    `2. **Notable Differences** - Conclusions or emphasis where the reports diverge.\n` +
    `3. **Unique OpenAI Insights** - Important information only the OpenAI report covers.\n` +
    `4. **Unique Gemini Insights** - Important information only the Gemini report covers.\n` +
    `5. **Coverage Assessment** - Brief overall assessment of depth, breadth, and reliability.\n\n` +
    `Use neutral language. Do not repeat the full content of either report. Be specific about differences.`;

  const data = await request(
    `/models/${geminiDeepModel}:generateContent`,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 2000 }
    },
    { timeoutMs: opts?.timeoutMs }
  );
  return extractTextFromGemini(data).trim();
}

export async function runGemini(
  refinedPrompt: string,
  opts?: { stub?: boolean; timeoutMs?: number; maxSources?: number; model?: string; maxOutputTokens?: number }
): Promise<GeminiResponse> {
  if (opts?.stub) {
    return { outputText: `Stubbed Gemini result for: ${refinedPrompt}` };
  }
  const selectedModel = opts?.model || geminiModel;
  const maxSources = typeof opts?.maxSources === 'number' ? Math.max(10, Math.min(100, Math.trunc(opts.maxSources))) : 15;
  // Default to 32 768 tokens — enough for a full deep-research report.
  // The old hardcoded 2500 was cutting Gemini off after ~1–2 pages.
  const outputTokenCeiling = typeof opts?.maxOutputTokens === 'number' && opts.maxOutputTokens > 0
    ? opts.maxOutputTokens
    : 32768;
  const sourceBudgetText = `SOURCE COVERAGE TARGET: Use at least ${maxSources} distinct high-quality sources when available. Exceed this target if needed for completeness, contradiction checks, and full coverage. Prefer primary sources and highly reputable secondary sources.`;
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
          generationConfig: { maxOutputTokens: outputTokenCeiling }
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
          generationConfig: { maxOutputTokens: outputTokenCeiling }
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
          generationConfig: { maxOutputTokens: outputTokenCeiling }
        },
        { timeoutMs: opts?.timeoutMs }
      );
    }
    return await request(
      `/models/${selectedModel}:generateContent`,
      {
        ...(tools ? { tools } : {}),
        contents: [{ role: 'user', parts: [{ text: legacyPrompt }] }],
        generationConfig: { maxOutputTokens: outputTokenCeiling }
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
        generationConfig: { maxOutputTokens: outputTokenCeiling }
      }, { timeoutMs: opts?.timeoutMs });
    } catch {
      data = await request(
        `/models/${selectedModel}:generateContent`,
        {
          contents: [{ role: 'user', parts: [{ text: `${safeSystemText}\n\nRESEARCH QUESTION (refined):\n${refinedPrompt}` }] }],
          generationConfig: { maxOutputTokens: outputTokenCeiling }
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
  const maxOutputTokens = Math.max(200, Math.min(32768, Math.trunc(params.maxOutputTokens)));

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
  subcallModel?: string;
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
  const subcallModel = params.subcallModel || geminiSubcallModel || model;
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
  const masterPromptShort = params.prompt.replace(/\s+/g, ' ').trim().slice(0, 320);
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
        'Find distinct, high-quality grounded web sources for the subquestion below.\n\n' +
        `MASTER RESEARCH QUESTION: ${masterPromptShort}\n\n` +
        `SUBQUESTION FOR THIS SCOUT CALL: ${subquestion}\n\n` +
        'Requirements:\n' +
        '1) Cite at least 5 sources across at least 4 domains when possible.\n' +
        '2) For each source, provide one concrete finding and cite URL inline as [URL].\n' +
        '3) Include contradictory evidence if found.\n' +
        '4) Keep output dense and concise.\n' +
        '5) Never emit any function/tool call syntax.\n\n' +
        'Output format:\n' +
        '- One short paragraph per source.\n' +
        '- End with: "Found X sources across Y domains."';

      try {
        const data = await runGeminiGroundedSubcall({
          model: subcallModel,
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
  const SUBCALL_TEXT_CHAR_LIMIT = 4000;
  const findings = completed
    .filter((item) => item.responseText)
    .map((item, idx) => {
      const text = item.responseText ?? '';
      const truncated =
        text.length > SUBCALL_TEXT_CHAR_LIMIT ? `${text.slice(0, SUBCALL_TEXT_CHAR_LIMIT)}... [truncated]` : text;
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
    const consolidationOutputTokens = Math.min(32768, Math.max(8000, subcallsCompleted * 500));
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
      const MAX_CONTINUATION_PASSES = 3;
      let continuationPass = 0;
      while (continuationPass < MAX_CONTINUATION_PASSES && looksTruncated(text)) {
        continuationPass += 1;
        const tailContext = text.slice(-1200);
        const remainingBudget = Math.max(5_000, startMs + totalBudgetMs - Date.now());
        if (remainingBudget < 8_000) break;

        const continuationPrompt =
          'You were writing a research synthesis report and ran out of space. ' +
          'Continue writing from exactly where you left off. Do NOT repeat any content. ' +
          'Do NOT add a preamble or "continuing from..." header. Just continue the text.\n\n' +
          `THE TEXT SO FAR ENDS WITH:\n...${tailContext}\n\n` +
          'Continue directly from this point and write until the synthesis is complete. ' +
          'End with a complete "## Sources" section listing all URLs cited.';

        try {
          const continuationData = await request(
            `/models/${model}:generateContent`,
            {
              system_instruction: {
                parts: [{ text: consolidationSystemInstruction }]
              },
              contents: [{ role: 'user', parts: [{ text: continuationPrompt }] }],
              generationConfig: {
                maxOutputTokens: Math.min(32768, consolidationOutputTokens)
              }
            },
            { timeoutMs: Math.min(consolidationBudgetMs, remainingBudget) }
          );
          const continuationText = extractTextFromGemini(continuationData).trim();
          if (!continuationText) break;
          text = `${text}\n\n${continuationText}`;
        } catch {
          break;
        }
      }
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
