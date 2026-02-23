import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { getEnv, getEnvInt, getEnvNumber } from './env';

const openaiApiKey = getEnv('OPENAI_API_KEY');
const openaiApiBase =
  getEnv('OPENAI_API_BASE') || 'https://api.openai.com/v1';
const refinerModel = getEnv('OPENAI_REFINER_MODEL') || 'gpt-4.1-mini';
const summaryModel = getEnv('OPENAI_SUMMARY_MODEL') || refinerModel;
const deepResearchModel = getEnv('OPENAI_DEEP_RESEARCH_MODEL') || 'o3-deep-research';
const deepResearchFallbackModel = getEnv('OPENAI_DEEP_RESEARCH_FALLBACK_MODEL') || null;
const maxToolCalls = getEnvNumber('OPENAI_MAX_TOOL_CALLS');
const requestTimeoutMs = getEnvNumber('OPENAI_REQUEST_TIMEOUT_MS') ?? 10 * 60 * 1000;
const headersTimeoutMs = getEnvNumber('OPENAI_HEADERS_TIMEOUT_MS') ?? 10 * 60 * 1000;
const bodyTimeoutMs = getEnvNumber('OPENAI_BODY_TIMEOUT_MS') ?? 10 * 60 * 1000;
const maxRetries = getEnvInt('OPENAI_FETCH_RETRIES') ?? 5;
const retryBaseDelayMs = getEnvNumber('OPENAI_FETCH_RETRY_BASE_DELAY_MS') ?? 500;
const deepResearchConcurrency = Math.max(1, getEnvInt('OPENAI_DEEP_RESEARCH_CONCURRENCY') ?? 1);

export type RefinementResponse = {
  questions: string[];
};

export type ReasoningLevel = 'low' | 'high';
type ReasoningEffort = 'low' | 'medium' | 'high';

export type ResearchResponse = {
  outputText: string;
  sources?: unknown;
  responseId?: string | null;
};

export type RewriteInput = {
  topic: string;
  draftPrompt: string;
  clarifications: Array<{ question: string; answer: string }>;
};

export type ReportReference = { n: number; title?: string; url: string; accessedAt?: string };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCodeFromText(errorText: string): string | null {
  try {
    const parsed = JSON.parse(errorText) as { error?: { code?: string } };
    return typeof parsed?.error?.code === 'string' ? parsed.error.code : null;
  } catch {
    return null;
  }
}

function getErrorMessageFromText(errorText: string): string | null {
  try {
    const parsed = JSON.parse(errorText) as { error?: { message?: string } };
    return typeof parsed?.error?.message === 'string' ? parsed.error.message : null;
  } catch {
    return null;
  }
}

function isDeepResearchAccessError(errorText: string): boolean {
  const code = getErrorCodeFromText(errorText);
  if (code === 'model_not_found') {
    return true;
  }
  const msg = (getErrorMessageFromText(errorText) || '').toLowerCase();
  return msg.includes('must be verified') || msg.includes('verify organization');
}

function isUnsupportedReasoningEffortError(errorTextOrMessage: string): boolean {
  const text = errorTextOrMessage.toLowerCase();
  return text.includes('unsupported_value') && text.includes('reasoning.effort');
}

function isUnsupportedMessageInputError(errorTextOrMessage: string): boolean {
  const text = errorTextOrMessage.toLowerCase();
  return (
    text.includes("invalid type for 'input'") ||
    text.includes('invalid type for input') ||
    (text.includes('input') && text.includes('expected') && text.includes('string'))
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as Error & { code?: unknown }).code;
  const codeString = typeof code === 'string' ? code : null;
  if (error.name === 'AbortError') {
    return true;
  }
  if (
    codeString &&
    (codeString.includes('TIMEOUT') ||
      codeString.includes('ECONNRESET') ||
      codeString.includes('EAI_AGAIN') ||
      codeString.includes('ETIMEDOUT'))
  ) {
    return true;
  }
  const msg = error.message.toLowerCase();
  return msg.includes('timeout') || msg.includes('fetch failed');
}

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const code = (error as Error & { code?: unknown }).code;
  const codeString = typeof code === 'string' ? code : null;
  const parts = [error.message];
  if (codeString) {
    parts.push(`code=${codeString}`);
  }
  return parts.join(' ');
}

function withModel(body: unknown, model: string): unknown {
  if (!body || typeof body !== 'object') {
    return body;
  }
  return { ...(body as Record<string, unknown>), model };
}

function parseRetryAfterMsFromResponse(params: {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  bodyText: string;
}) {
  if (params.status !== 429) {
    return null;
  }
  const retryAfterRaw = params.headers['retry-after'];
  const retryAfter =
    typeof retryAfterRaw === 'string' ? retryAfterRaw : Array.isArray(retryAfterRaw) ? retryAfterRaw[0] : null;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(60_000, Math.max(0, Math.round(seconds * 1000)));
    }
  }
  const match = params.bodyText.match(/try again in\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i);
  if (match) {
    const raw = Number(match[1]);
    const unit = match[2]?.toLowerCase();
    if (Number.isFinite(raw) && raw >= 0) {
      const ms = unit === 's' ? raw * 1000 : raw;
      return Math.min(60_000, Math.max(0, Math.round(ms)));
    }
  }
  const matchMs = params.bodyText.match(/try again in\s+(\d+)\s*ms/i);
  if (matchMs) {
    const ms = Number(matchMs[1]);
    if (Number.isFinite(ms) && ms >= 0) {
      return Math.min(60_000, Math.max(0, Math.round(ms)));
    }
  }
  return 1500;
}

type NodeHttpResult = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  bodyText: string;
};

type DeepResearchSemaphoreState = {
  active: number;
  queue: Array<() => void>;
};

const deepResearchSemaphore: DeepResearchSemaphoreState = { active: 0, queue: [] };

async function acquireDeepResearchSlot() {
  if (deepResearchSemaphore.active < deepResearchConcurrency) {
    deepResearchSemaphore.active += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    deepResearchSemaphore.queue.push(() => {
      deepResearchSemaphore.active += 1;
      resolve();
    });
  });
}

function releaseDeepResearchSlot() {
  deepResearchSemaphore.active = Math.max(0, deepResearchSemaphore.active - 1);
  const next = deepResearchSemaphore.queue.shift();
  if (next) {
    next();
  }
}

async function withDeepResearchSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireDeepResearchSlot();
  try {
    return await fn();
  } finally {
    releaseDeepResearchSlot();
  }
}

async function nodeRequestJson(params: {
  method: 'POST' | 'GET';
  url: string;
  headers: Record<string, string>;
  jsonBody?: string;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  bodyTimeoutMs: number;
}): Promise<NodeHttpResult> {
  const parsed = new URL(params.url);
  const isHttps = parsed.protocol === 'https:';
  if (!isHttps && parsed.protocol !== 'http:') {
    const err = new Error(`Unsupported protocol for OPENAI_API_BASE: ${parsed.protocol}`);
    (err as any).code = 'UNSUPPORTED_PROTOCOL';
    throw err;
  }

  const requestFn = isHttps ? httpsRequest : httpRequest;

  return new Promise<NodeHttpResult>((resolve, reject) => {
    const req = requestFn(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: params.method,
        headers: {
          ...params.headers,
          ...(params.method === 'POST' && typeof params.jsonBody === 'string'
            ? { 'Content-Length': Buffer.byteLength(params.jsonBody).toString() }
            : {})
        }
      },
      (res) => {
        clearTimeout(headersTimer);
        clearTimeout(requestTimer);

        let bodyTimer: NodeJS.Timeout | null = null;
        const resetBodyTimer = () => {
          if (bodyTimer) {
            clearTimeout(bodyTimer);
          }
          bodyTimer = setTimeout(() => {
            const err = new Error('OpenAI body timeout');
            (err as any).code = 'OPENAI_BODY_TIMEOUT';
            req.destroy(err);
          }, params.bodyTimeoutMs);
        };

        resetBodyTimer();
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          resetBodyTimer();
        });
        res.on('end', () => {
          if (bodyTimer) {
            clearTimeout(bodyTimer);
          }
          const bodyText = Buffer.concat(chunks).toString('utf-8');
          resolve({
            status: res.statusCode || 0,
            headers: res.headers as unknown as Record<string, string | string[] | undefined>,
            bodyText
          });
        });
      }
    );

    req.on('error', (err) => reject(err));

    const headersTimer = setTimeout(() => {
      const err = new Error('OpenAI headers timeout');
      (err as any).code = 'OPENAI_HEADERS_TIMEOUT';
      req.destroy(err);
    }, params.headersTimeoutMs);

    const requestTimer = setTimeout(() => {
      const err = new Error('OpenAI request timeout');
      (err as any).code = 'OPENAI_REQUEST_TIMEOUT';
      req.destroy(err);
    }, params.requestTimeoutMs);

    if (params.method === 'POST' && typeof params.jsonBody === 'string') {
      req.write(params.jsonBody);
    }
    req.end();
  });
}

async function request(
  path: string,
  body: unknown,
  opts?: { requestTimeoutMs?: number; headersTimeoutMs?: number; bodyTimeoutMs?: number }
) {
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const url = `${openaiApiBase}${path}`;
  const jsonBody = JSON.stringify(body);
  const effectiveRequestTimeoutMs = opts?.requestTimeoutMs ?? requestTimeoutMs;
  const effectiveHeadersTimeoutMs = opts?.headersTimeoutMs ?? headersTimeoutMs;
  const effectiveBodyTimeoutMs = opts?.bodyTimeoutMs ?? bodyTimeoutMs;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= Math.max(0, maxRetries); attempt++) {
    let retryAfterOverrideMs: number | null = null;
    try {
      const result = await nodeRequestJson({
        method: 'POST',
        url,
        jsonBody,
        requestTimeoutMs: effectiveRequestTimeoutMs,
        headersTimeoutMs: effectiveHeadersTimeoutMs,
        bodyTimeoutMs: effectiveBodyTimeoutMs,
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Encoding': 'identity'
        }
      });

      const requestIdRaw =
        (typeof result.headers['x-request-id'] === 'string' && result.headers['x-request-id']) ||
        (typeof result.headers['x-requestid'] === 'string' && result.headers['x-requestid']) ||
        (typeof result.headers['x-openai-request-id'] === 'string' && result.headers['x-openai-request-id']) ||
        null;
      const messageSuffix = requestIdRaw ? ` request_id=${requestIdRaw}` : '';

      if (result.status < 200 || result.status >= 300) {
        if (isRetryableStatus(result.status) && attempt < Math.max(0, maxRetries)) {
          lastError = new Error(`OpenAI request failed status=${result.status}${messageSuffix}: ${result.bodyText}`);
          retryAfterOverrideMs = parseRetryAfterMsFromResponse(result);
        } else {
          throw new Error(`OpenAI request failed status=${result.status}${messageSuffix}: ${result.bodyText}`);
        }
      } else {
        try {
          return JSON.parse(result.bodyText) as unknown;
        } catch (parseError) {
          throw new Error(`OpenAI returned non-JSON response${messageSuffix}: ${result.bodyText}`, {
            cause: parseError
          });
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('OpenAI request failed status=')) {
        throw error;
      }
      if (error instanceof Error && error.message.startsWith('OpenAI returned non-JSON response')) {
        throw error;
      }
      lastError = error;
      if (attempt >= Math.max(0, maxRetries) || !isRetryableFetchError(error)) {
        throw new Error(
          `OpenAI network request failed (${describeFetchError(error)}). ` +
            `Try increasing OPENAI_HEADERS_TIMEOUT_MS / OPENAI_BODY_TIMEOUT_MS / OPENAI_REQUEST_TIMEOUT_MS.`,
          { cause: error }
        );
      }
    }

    const backoff = retryBaseDelayMs * Math.pow(2, attempt);
    const base = retryAfterOverrideMs != null ? retryAfterOverrideMs : Math.min(8000, backoff);
    await sleep(base + Math.floor(Math.random() * 200));
  }

  throw lastError instanceof Error ? lastError : new Error('OpenAI request failed');
}

async function requestGet(path: string, opts?: { requestTimeoutMs?: number; headersTimeoutMs?: number; bodyTimeoutMs?: number }) {
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const url = `${openaiApiBase}${path}`;
  const effectiveRequestTimeoutMs = opts?.requestTimeoutMs ?? requestTimeoutMs;
  const effectiveHeadersTimeoutMs = opts?.headersTimeoutMs ?? headersTimeoutMs;
  const effectiveBodyTimeoutMs = opts?.bodyTimeoutMs ?? bodyTimeoutMs;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= Math.max(0, maxRetries); attempt++) {
    let retryAfterOverrideMs: number | null = null;
    try {
      const result = await nodeRequestJson({
        method: 'GET',
        url,
        requestTimeoutMs: effectiveRequestTimeoutMs,
        headersTimeoutMs: effectiveHeadersTimeoutMs,
        bodyTimeoutMs: effectiveBodyTimeoutMs,
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          Accept: 'application/json',
          'Accept-Encoding': 'identity'
        }
      });

      const requestIdRaw =
        (typeof result.headers['x-request-id'] === 'string' && result.headers['x-request-id']) ||
        (typeof result.headers['x-requestid'] === 'string' && result.headers['x-requestid']) ||
        (typeof result.headers['x-openai-request-id'] === 'string' && result.headers['x-openai-request-id']) ||
        null;
      const messageSuffix = requestIdRaw ? ` request_id=${requestIdRaw}` : '';

      if (result.status < 200 || result.status >= 300) {
        if (isRetryableStatus(result.status) && attempt < Math.max(0, maxRetries)) {
          lastError = new Error(`OpenAI request failed status=${result.status}${messageSuffix}: ${result.bodyText}`);
          retryAfterOverrideMs = parseRetryAfterMsFromResponse(result);
        } else {
          throw new Error(`OpenAI request failed status=${result.status}${messageSuffix}: ${result.bodyText}`);
        }
      } else {
        try {
          return JSON.parse(result.bodyText) as unknown;
        } catch (parseError) {
          throw new Error(`OpenAI returned non-JSON response${messageSuffix}: ${result.bodyText}`, { cause: parseError });
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('OpenAI request failed status=')) {
        throw error;
      }
      if (error instanceof Error && error.message.startsWith('OpenAI returned non-JSON response')) {
        throw error;
      }
      lastError = error;
      if (attempt >= Math.max(0, maxRetries) || !isRetryableFetchError(error)) {
        throw new Error(
          `OpenAI network request failed (${describeFetchError(error)}). ` +
            `Try increasing OPENAI_HEADERS_TIMEOUT_MS / OPENAI_BODY_TIMEOUT_MS / OPENAI_REQUEST_TIMEOUT_MS.`,
          { cause: error }
        );
      }
    }

    const backoff = retryBaseDelayMs * Math.pow(2, attempt);
    const base = retryAfterOverrideMs != null ? retryAfterOverrideMs : Math.min(8000, backoff);
    await sleep(base + Math.floor(Math.random() * 200));
  }

  throw lastError instanceof Error ? lastError : new Error('OpenAI request failed');
}

function extractOutputText(data: unknown): string {
  const typed = data as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string; annotations?: unknown }> }>;
    sources?: unknown;
  };

  const outputItems = Array.isArray(typed?.output) ? typed.output : null;
  if (outputItems && outputItems.length > 0) {
    const sourceIdToUrl = new Map<string, string>();
    const sources = typed.sources;
    if (Array.isArray(sources)) {
      for (const s of sources as Array<any>) {
        const id = typeof s?.id === 'string' ? s.id : null;
        const url = typeof s?.url === 'string' ? s.url : typeof s?.uri === 'string' ? s.uri : null;
        if (id && url) {
          sourceIdToUrl.set(id, url);
        }
      }
    }

    const addCitations = (text: string, annotations: unknown): string => {
      if (!text) return text;
      if (!Array.isArray(annotations) || annotations.length === 0) return text;

      type Insertion = { at: number; snippet: string };
      const insertions: Insertion[] = [];
      for (const ann of annotations as Array<any>) {
        const endIndexRaw = ann?.end_index ?? ann?.endIndex;
        const endIndex = typeof endIndexRaw === 'number' && Number.isFinite(endIndexRaw) ? endIndexRaw : null;
        if (endIndex == null || endIndex <= 0) continue;

        const type = typeof ann?.type === 'string' ? ann.type : null;
        const urlRaw = ann?.url ?? ann?.uri ?? null;
        const sourceId = typeof ann?.source_id === 'string' ? ann.source_id : typeof ann?.sourceId === 'string' ? ann.sourceId : null;
        const url =
          (typeof urlRaw === 'string' && /^https?:\/\//i.test(urlRaw) ? urlRaw : null) ||
          (sourceId ? sourceIdToUrl.get(sourceId) ?? null : null);
        if (!url) continue;

        // Prefer url citations, but accept any citation-like annotation that yields a URL.
        if (type && !type.includes('citation') && !type.includes('url')) {
          // fall through; still acceptable if it has a URL
        }

        insertions.push({ at: endIndex, snippet: `[${url}]` });
      }

      if (insertions.length === 0) return text;

      // Group by insertion index and sort descending to avoid shifting indices.
      const grouped = new Map<number, string[]>();
      for (const ins of insertions) {
        const arr = grouped.get(ins.at) ?? [];
        arr.push(ins.snippet);
        grouped.set(ins.at, arr);
      }

      const sorted = Array.from(grouped.entries()).sort((a, b) => b[0] - a[0]);
      let out = text;
      for (const [at, snippets] of sorted) {
        const safeAt = Math.max(0, Math.min(out.length, at));
        const unique = Array.from(new Set(snippets));
        const needsLeadingSpace = safeAt > 0 && !/\s/.test(out[safeAt - 1] ?? '');
        const citationString = unique.join(' ');
        out = `${out.slice(0, safeAt)}${needsLeadingSpace ? ' ' : ''}${citationString}${out.slice(safeAt)}`;
      }
      return out;
    };

    const parts: string[] = [];
    for (const item of outputItems) {
      const content = Array.isArray((item as any)?.content) ? ((item as any).content as any[]) : [];
      for (const block of content) {
        const text = typeof block?.text === 'string' ? block.text : '';
        const withCites = addCitations(text, block?.annotations);
        if (withCites) {
          parts.push(withCites);
        }
      }
    }
    const combined = parts.join('');
    if (combined) {
      return combined;
    }
  }

  if (typed?.output_text) {
    return typed.output_text;
  }
  const chunks = typed?.output?.flatMap((item) => (item as any)?.content ?? []) ?? [];
  return chunks.map((chunk: any) => chunk?.text ?? '').join('');
}

export function getResponseOutputText(data: unknown): string {
  return extractOutputText(data);
}

export function getResponseSources(data: unknown): unknown {
  return (data as { sources?: unknown }).sources;
}

function parseRefinementOutput(text: string): { questions: string[] } {
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

  // If the model deviates, default to no clarification questions to avoid polluting the refined prompt.
  return { questions: [] };
}

export async function startRefinement(topic: string, opts?: { stub?: boolean; timeoutMs?: number }): Promise<RefinementResponse> {
  if (opts?.stub) {
    return {
      questions: ['What time range should we focus on?', 'Any geographic focus?']
    };
  }
  const data = await request('/responses', {
    model: refinerModel,
    input:
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
      'Evaluation Criteria\n' +
      ' - A research-ready question should:\n' +
      ' - Be specific and bounded\n' +
      ' - Identify relevant population, variables, or domain\n' +
      ' - Avoid vague terms (e.g., “better,” “impact,” “effective” without context)\n' +
      ' - Avoid unnecessary breadth\n' +
      ' - Be suitable for deep, structured research\n\n' +
      'If the user input is not a research question, reformulate it into one when possible.\n\n' +
      `USER INPUT:\n${topic}`
  }, opts?.timeoutMs ? { requestTimeoutMs: opts.timeoutMs, headersTimeoutMs: opts.timeoutMs, bodyTimeoutMs: opts.timeoutMs } : undefined);
  const parsed = parseRefinementOutput(extractOutputText(data));
  return {
    questions: parsed.questions
  };
}

export async function runResearch(
  refinedPrompt: string,
  opts?: {
    stub?: boolean;
    timeoutMs?: number;
    maxSources?: number;
    reasoningLevel?: ReasoningLevel;
    onStarted?: (info: { responseId: string; status: string | null }) => void | Promise<void>;
  }
): Promise<ResearchResponse> {
  if (opts?.stub) {
    return { outputText: `Stubbed OpenAI result for: ${refinedPrompt}` };
  }
  const maxSources =
    typeof opts?.maxSources === 'number'
      ? Math.max(1, Math.min(20, Math.trunc(opts.maxSources)))
      : null;
  const sourceBudgetText =
    maxSources != null
      ? `SOURCE BUDGET: Use at most ${maxSources} distinct sources. Prefer primary sources and highly reputable secondary sources.`
      : null;
  const messageInput = [
    ...(sourceBudgetText
      ? ([
          {
            role: 'system',
            content: [{ type: 'input_text', text: sourceBudgetText }]
          }
        ] as const)
      : []),
    {
      role: 'user',
      content: [{ type: 'input_text', text: refinedPrompt }]
    }
  ] as const;
  const legacyInput = sourceBudgetText ? `${sourceBudgetText}\n\n${refinedPrompt}` : refinedPrompt;

  const mappedEffort = (() => {
    if (!opts?.reasoningLevel || !/^o\d/i.test(deepResearchModel)) {
      return null;
    }
    // Some Deep Research models only accept specific effort values.
    if (deepResearchModel.includes('o4-mini-deep-research')) {
      return 'medium' as const;
    }
    return opts.reasoningLevel as ReasoningEffort;
  })();
  const reasoning = mappedEffort ? { effort: mappedEffort } : undefined;

  const body = buildDeepResearchBody(legacyInput, reasoning);
  try {
    const timeoutBudgetMs = typeof opts?.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : requestTimeoutMs;
    let started: { responseId: string | null; status: string | null; data: unknown };
    const startWithInputFallback = async (override?: { effort: ReasoningEffort }) => {
      try {
        return await startDeepResearch(messageInput, {
          timeoutMs: timeoutBudgetMs,
          reasoning: override
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!isUnsupportedMessageInputError(msg)) {
          throw error;
        }
        return await startDeepResearch(legacyInput, {
          timeoutMs: timeoutBudgetMs,
          reasoning: override
        });
      }
    };
    try {
      started = await startWithInputFallback(reasoning);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!isUnsupportedReasoningEffortError(msg)) {
        throw error;
      }
      // Retry once with 'medium' (common supported value), then without reasoning.
      try {
        started = await startWithInputFallback({ effort: 'medium' });
      } catch {
        started = await startWithInputFallback(undefined);
      }
    }
    const responseId = started.responseId;
    if (responseId && typeof opts?.onStarted === 'function') {
      try {
        await opts.onStarted({ responseId, status: started.status });
      } catch {
        // best-effort
      }
    }
    const data = responseId
      ? started.status === 'completed'
        ? started.data
        : await waitDeepResearch(responseId, { timeoutMs: timeoutBudgetMs })
      : started.data;

    return {
      outputText: extractOutputText(data),
      sources: (data as { sources?: unknown }).sources,
      responseId
    };
  } catch (error) {
    if (!deepResearchFallbackModel) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const jsonStart = message.indexOf('{');
    const errorText = jsonStart >= 0 ? message.slice(jsonStart) : message;
    if (!isDeepResearchAccessError(errorText)) {
      throw error;
    }
    const data = await request('/responses', withModel(body, deepResearchFallbackModel));
    return {
      outputText: extractOutputText(data),
      sources: (data as { sources?: unknown }).sources,
      responseId: null
    };
  }
}

export async function startResearchJob(
  refinedPrompt: string,
  opts?: {
    stub?: boolean;
    timeoutMs?: number;
    maxSources?: number;
    reasoningLevel?: ReasoningLevel;
  }
): Promise<{ responseId: string | null; status: string | null; data: unknown }> {
  if (opts?.stub) {
    return { responseId: null, status: 'completed', data: { output_text: `Stubbed OpenAI result for: ${refinedPrompt}` } };
  }

  const maxSources =
    typeof opts?.maxSources === 'number'
      ? Math.max(1, Math.min(20, Math.trunc(opts.maxSources)))
      : null;
  const sourceBudgetText =
    maxSources != null
      ? `SOURCE BUDGET: Use at most ${maxSources} distinct sources. Prefer primary sources and highly reputable secondary sources.`
      : null;
  const messageInput = [
    ...(sourceBudgetText
      ? ([
          {
            role: 'system',
            content: [{ type: 'input_text', text: sourceBudgetText }]
          }
        ] as const)
      : []),
    {
      role: 'user',
      content: [{ type: 'input_text', text: refinedPrompt }]
    }
  ] as const;
  const legacyInput = sourceBudgetText ? `${sourceBudgetText}\n\n${refinedPrompt}` : refinedPrompt;

  const mappedEffort = (() => {
    if (!opts?.reasoningLevel || !/^o\d/i.test(deepResearchModel)) {
      return null;
    }
    if (deepResearchModel.includes('o4-mini-deep-research')) {
      return 'medium' as const;
    }
    return opts.reasoningLevel as ReasoningEffort;
  })();
  const reasoning = mappedEffort ? { effort: mappedEffort } : undefined;

  const body = buildDeepResearchBody(legacyInput, reasoning);
  try {
    const timeoutBudgetMs = typeof opts?.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : requestTimeoutMs;
    let started: { responseId: string | null; status: string | null; data: unknown };
    const startWithInputFallback = async (override?: { effort: ReasoningEffort }) => {
      try {
        return await startDeepResearch(messageInput, {
          timeoutMs: timeoutBudgetMs,
          reasoning: override
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!isUnsupportedMessageInputError(msg)) {
          throw error;
        }
        return await startDeepResearch(legacyInput, {
          timeoutMs: timeoutBudgetMs,
          reasoning: override
        });
      }
    };
    try {
      started = await startWithInputFallback(reasoning);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!isUnsupportedReasoningEffortError(msg)) {
        throw error;
      }
      try {
        started = await startWithInputFallback({ effort: 'medium' });
      } catch {
        started = await startWithInputFallback(undefined);
      }
    }
    return started;
  } catch (error) {
    if (!deepResearchFallbackModel) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const jsonStart = message.indexOf('{');
    const errorText = jsonStart >= 0 ? message.slice(jsonStart) : message;
    if (!isDeepResearchAccessError(errorText)) {
      throw error;
    }
    const data = await request('/responses', withModel(body, deepResearchFallbackModel));
    return { responseId: null, status: 'completed', data };
  }
}

function buildDeepResearchBody(input: unknown, reasoning?: { effort: ReasoningEffort }) {
  return {
    model: deepResearchModel,
    input,
    tools: [{ type: 'web_search_preview' }],
    tool_choice: 'auto',
    max_tool_calls: maxToolCalls,
    ...(reasoning ? { reasoning } : {})
  } as const;
}

export async function startDeepResearch(
  input: unknown,
  opts?: { timeoutMs?: number; reasoning?: { effort: ReasoningEffort } }
): Promise<{ responseId: string | null; status: string | null; data: unknown }> {
  const timeoutBudgetMs = typeof opts?.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : requestTimeoutMs;
  const createTimeoutMs = Math.min(60_000, timeoutBudgetMs);
  const body = buildDeepResearchBody(input, opts?.reasoning);
  const createBody = { ...body, background: true } as Record<string, unknown>;
  const data = await withDeepResearchSlot(async () =>
    request('/responses', createBody, {
      requestTimeoutMs: createTimeoutMs,
      headersTimeoutMs: createTimeoutMs,
      bodyTimeoutMs: createTimeoutMs
    })
  );
  const created = data as { id?: string; status?: string };
  return {
    responseId: typeof created?.id === 'string' ? created.id : null,
    status: typeof created?.status === 'string' ? created.status : null,
    data
  };
}

export async function pollDeepResearch(
  responseId: string,
  opts?: { timeoutMs?: number }
): Promise<{ status: string | null; data: unknown }> {
  const timeoutBudgetMs = typeof opts?.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : requestTimeoutMs;
  const polled = await requestGet(`/responses/${encodeURIComponent(responseId)}`, {
    requestTimeoutMs: Math.min(60_000, timeoutBudgetMs),
    headersTimeoutMs: Math.min(60_000, timeoutBudgetMs),
    bodyTimeoutMs: Math.min(60_000, timeoutBudgetMs)
  });
  const status = (polled as { status?: unknown }).status;
  return { status: typeof status === 'string' ? status : null, data: polled };
}

export async function waitDeepResearch(responseId: string, opts?: { timeoutMs?: number }): Promise<unknown> {
  const timeoutBudgetMs = typeof opts?.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : requestTimeoutMs;
  const start = Date.now();
  let delayMs = 1500;
  let lastStatus: string | null = null;
  while (Date.now() - start < timeoutBudgetMs) {
    const { status, data } = await pollDeepResearch(responseId, { timeoutMs: timeoutBudgetMs });
    lastStatus = status;
    if (status && ['completed', 'failed', 'cancelled', 'incomplete'].includes(status)) {
      return data;
    }
    await sleep(delayMs);
    delayMs = Math.min(8000, Math.floor(delayMs * 1.15));
  }
  throw new Error(`OpenAI research polling timed out response_id=${responseId} status=${lastStatus ?? 'unknown'}`);
}

export async function resumeDeepResearch(
  responseId: string,
  opts?: { timeoutMs?: number }
): Promise<ResearchResponse> {
  const data = await waitDeepResearch(responseId, opts);
  return {
    outputText: extractOutputText(data),
    sources: (data as { sources?: unknown }).sources,
    responseId
  };
}

export async function rewritePrompt(
  input: RewriteInput,
  opts?: { stub?: boolean; timeoutMs?: number }
): Promise<string> {
  if (opts?.stub) {
    return `${input.draftPrompt} (rewritten)`;
  }
  const clarificationsText =
    input.clarifications.length === 0
      ? 'None.'
      : input.clarifications
          .map((item, index) => `${index + 1}. ${item.question} → ${item.answer}`)
          .join('\n');

  const data = await request(
    '/responses',
    {
      model: refinerModel,
      input:
        'Rewrite the user prompt into a clear, detailed research prompt. ' +
        'Include constraints from clarifications. Return only the rewritten prompt.\n\n' +
        `Original topic: ${input.topic}\n` +
        `Draft prompt: ${input.draftPrompt}\n` +
        `Clarifications:\n${clarificationsText}`
    },
    opts?.timeoutMs ? { requestTimeoutMs: opts.timeoutMs, headersTimeoutMs: opts.timeoutMs, bodyTimeoutMs: opts.timeoutMs } : undefined
  );

  return extractOutputText(data).trim();
}

function truncateForSummary(text: string, maxChars = 12000) {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars)}\n\n[truncated]`;
}

export async function summarizeForReport(
  input: { provider: 'OpenAI' | 'Gemini'; researchText: string; references: ReportReference[] },
  opts?: { stub?: boolean; timeoutMs?: number; includeRefs?: boolean }
): Promise<string> {
  if (opts?.stub) {
    return `Stub summary for ${input.provider}.`;
  }
  const includeRefs = opts?.includeRefs ?? true;
  const refsText =
    input.references.length === 0
      ? 'None.'
      : input.references
          .map((ref) => `[${ref.n}] ${ref.title ? `${ref.title} — ` : ''}${ref.url}`)
          .join('\n');

  const data = await request(
    '/responses',
    {
      model: summaryModel,
      input:
        `Write exactly ONE paragraph summarizing the following ${input.provider} research output.\n` +
        `- Use neutral, factual language.\n` +
        (includeRefs
          ? `- If you make a factual claim that is supported by a reference, add a citation like [3].\n` +
            `- Use ONLY the reference numbers provided below.\n` +
            `- Do NOT invent citations.\n`
          : `- Do NOT include citations.\n`) +
        `- Do NOT include a title or bullet points.\n\n` +
        `REFERENCES:\n${refsText}\n\n` +
        `RESEARCH OUTPUT:\n${truncateForSummary(input.researchText)}`
    },
    opts?.timeoutMs ? { requestTimeoutMs: opts.timeoutMs, headersTimeoutMs: opts.timeoutMs, bodyTimeoutMs: opts.timeoutMs } : undefined
  );

  return extractOutputText(data).trim();
}
