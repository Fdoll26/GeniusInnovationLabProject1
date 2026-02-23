const geminiApiKey = process.env.GEMINI_API_KEY;
const geminiApiBase =
  process.env.GEMINI_API_BASE?.trim() ||
  'https://generativelanguage.googleapis.com/v1beta';
const geminiModel = process.env.GEMINI_MODEL || 'gemini-1.5-pro-002';

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
      throw new Error(`Gemini request failed: ${errorText}`);
    }

    return response.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
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

type GeminiGroundingMetadata = {
  webSearchQueries?: string[];
  groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
  groundingSupports?: Array<{
    segment?: { endIndex?: number };
    groundingChunkIndices?: number[];
  }>;
};

function getGeminiGroundingMetadata(data: unknown): GeminiGroundingMetadata | null {
  const typed = data as {
    candidates?: Array<{ groundingMetadata?: unknown }>;
  };
  const md = typed?.candidates?.[0]?.groundingMetadata as GeminiGroundingMetadata | undefined;
  return md && typeof md === 'object' ? md : null;
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
  opts?: { stub?: boolean; timeoutMs?: number; maxSources?: number }
): Promise<GeminiResponse> {
  if (opts?.stub) {
    return { outputText: `Stubbed Gemini result for: ${refinedPrompt}` };
  }
  const timeBudgetMinutes = 10;
  const maxSearchQueries = 30;
  const maxSources = typeof opts?.maxSources === 'number' ? Math.max(1, Math.min(20, Math.trunc(opts.maxSources))) : 15;
  const freshnessWindow = 'the last 12 months';
  const contextConstraints = 'None';

  const systemText =
    'You are a Deep Research agent. Your job is to produce a rigorous, web-grounded research report with citations.\n\n' +
    'SCOPE & CONSTRAINTS (obey strictly):\n' +
    `- Time budget: ${timeBudgetMinutes} minutes maximum (stop early if needed).\n` +
    `- Source budget: Use at most ${maxSources} distinct sources. Prefer primary sources and highly reputable secondary sources.\n` +
    `- Search budget: Perform at most ${maxSearchQueries} web searches total. Reuse sources when possible.\n` +
    `- Freshness: Prefer sources from ${freshnessWindow} unless the topic requires older foundational sources.\n` +
    `- Geography/Context constraints: ${contextConstraints}\n` +
    '- If critical info is missing after the budget is exhausted, say so explicitly and list what you could not verify.\n\n' +
    'QUALITY BAR:\n' +
    '- Do not guess. If unsure, say “insufficient evidence found within budget.”\n' +
    '- Resolve conflicting claims by comparing sources and explaining why you trust one over another.\n' +
    '- Distinguish facts vs interpretations vs hypotheses.\n\n' +
    'OUTPUT FORMAT (must follow):\n' +
    '1) Research plan actually executed (brief: queries run + why; keep concise)\n' +
    '2) Findings (structured with headings)\n' +
    '3) Evidence table (Claim | Best supporting source | Counter/limits | Confidence 0–1)\n' +
    '4) Gaps & next steps (what to research if budget increased)\n\n' +
    'CITATION RULES:\n' +
    '- Every non-trivial factual claim must have an inline citation like [http://example.com], [Book title by Example author].\n' +
    '- Sources list must include: title, publisher/venue, date (if available), and URL.\n' +
    '- Prefer citing the most authoritative source available; avoid low-quality blogs unless unavoidable.';

  const legacyPrompt = `${systemText}\n\nRESEARCH QUESTION (refined):\n${refinedPrompt}`;
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
        `/models/${geminiModel}:generateContent`,
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
        `/models/${geminiModel}:generateContent`,
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
        `/models/${geminiModel}:generateContent`,
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
      `/models/${geminiModel}:generateContent`,
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
      data = await request(`/models/${geminiModel}:generateContent`, {
        tools: [{ google_search: {} }],
        system_instruction: { parts: [{ text: safeSystemText }] },
        contents: [{ role: 'user', parts: [{ text: refinedPrompt }] }],
        generationConfig: { maxOutputTokens: 2500 }
      }, { timeoutMs: opts?.timeoutMs });
    } catch {
      data = await request(
        `/models/${geminiModel}:generateContent`,
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
