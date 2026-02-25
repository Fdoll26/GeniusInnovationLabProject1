import { runGemini, runGeminiReasoningStep } from './gemini-client';
import { getResponseOutputText, getResponseSources, runOpenAiReasoningStep, startResearchJob } from './openai-client';
import { getResearchProviderConfig } from './research-config';
import type {
  ResearchEvidence,
  ResearchPlan,
  ResearchProviderName,
  ResearchStepArtifact,
  StepType
} from './research-types';

type ExecutionInput = {
  provider: ResearchProviderName;
  stepType: Exclude<StepType, 'NATIVE_SECTION'>;
  question: string;
  timeoutMs: number;
  plan: ResearchPlan | null;
  priorStepSummary: string;
  sourceTarget: number;
  maxOutputTokens: number;
  maxCandidates: number;
  shortlistSize: number;
};

function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  return h;
}

function parseJsonObject<T>(text: string): T | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(trimmed.slice(first, last + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function parseJsonArray<T>(text: string): T[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T[];
  } catch {
    const first = trimmed.indexOf('[');
    const last = trimmed.lastIndexOf(']');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(trimmed.slice(first, last + 1)) as T[];
      } catch {
        return null;
      }
    }
    return null;
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function classifyReliability(url: string) {
  const host = safeHost(url);
  if (!host) return ['unknown'] as const;
  if (host.endsWith('.gov') || host.endsWith('.mil')) return ['gov', 'primary'] as const;
  if (host.includes('nature.com') || host.includes('science.org') || host.includes('nejm.org') || host.includes('thelancet.com')) {
    return ['peer_reviewed', 'primary'] as const;
  }
  if (host.includes('reuters.com') || host.includes('apnews.com') || host.includes('ft.com') || host.includes('wsj.com') || host.includes('nytimes.com')) {
    return ['press'] as const;
  }
  if (host.includes('medium.com') || host.includes('substack.com')) return ['blog'] as const;
  return ['unknown'] as const;
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)\]>"']+/gi) ?? [];
  return Array.from(new Set(matches.map((u) => u.replace(/[.,;:!?]+$/, ''))));
}

function normalizeCitations(
  provider: ResearchProviderName,
  text: string,
  rawSources: unknown,
  maxItems = 60
): ResearchStepArtifact['citations'] {
  const now = new Date().toISOString();
  const byUrl = new Map<string, ResearchStepArtifact['citations'][number]>();

  const fromRaw = (node: unknown) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        fromRaw(item);
      }
      return;
    }
    if (typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    const url =
      (typeof rec.url === 'string' && rec.url) ||
      (typeof rec.uri === 'string' && rec.uri) ||
      (typeof rec.href === 'string' && rec.href) ||
      null;
    if (url && /^https?:\/\//i.test(url) && !byUrl.has(url)) {
      byUrl.set(url, {
        citation_id: `c_${Math.abs(hash(url)).toString(36)}`,
        url,
        title: typeof rec.title === 'string' ? rec.title : null,
        publisher: typeof rec.publisher === 'string' ? rec.publisher : null,
        accessed_at: now,
        provider_metadata: { provider, raw: rec },
        reliability_tags: [...classifyReliability(url)]
      });
    }
    for (const value of Object.values(rec)) {
      if (typeof value === 'object' && value) fromRaw(value);
    }
  };

  fromRaw(rawSources);

  const urls = extractUrls(text);
  for (const url of urls) {
    if (!byUrl.has(url)) {
      byUrl.set(url, {
        citation_id: `c_${Math.abs(hash(url)).toString(36)}`,
        url,
        title: null,
        publisher: null,
        accessed_at: now,
        provider_metadata: { provider },
        reliability_tags: [...classifyReliability(url)]
      });
    }
  }

  return [...byUrl.values()].slice(0, maxItems);
}

function evidenceFromText(text: string, citations: ResearchStepArtifact['citations']): ResearchEvidence[] {
  const sourceIds = citations.slice(0, 2).map((c) => c.citation_id);
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 80)
    .slice(0, 10)
    .map((claim, idx) => ({
      evidence_id: `ev_${idx + 1}_${Math.abs(hash(claim)).toString(36)}`,
      claim: claim.slice(0, 280),
      supporting_snippet: claim.slice(0, 220),
      source_citation_ids: sourceIds,
      confidence: 'med' as const,
      notes: null
    }));
}

async function runFastReasoning(params: {
  provider: ResearchProviderName;
  prompt: string;
  timeoutMs: number;
  maxOutputTokens: number;
  model: string;
  useSearch?: boolean;
}) {
  if (params.provider === 'openai') {
    const out = await runOpenAiReasoningStep({
      prompt: params.prompt,
      timeoutMs: params.timeoutMs,
      maxOutputTokens: params.maxOutputTokens,
      model: params.model,
      useWebSearch: params.useSearch ?? false
    });
    return { text: out.text, usage: out.usage ?? null, rawSources: null };
  }

  const out = await runGeminiReasoningStep({
    prompt: params.prompt,
    timeoutMs: params.timeoutMs,
    maxOutputTokens: params.maxOutputTokens,
    model: params.model,
    useSearch: params.useSearch ?? false
  });
  return { text: out.text, usage: out.usage ?? null, rawSources: out.sources ?? null };
}

async function runDeep(params: {
  provider: ResearchProviderName;
  prompt: string;
  timeoutMs: number;
  sourceTarget: number;
  model: string;
}) {
  if (params.provider === 'openai') {
    const out = await startResearchJob(params.prompt, {
      timeoutMs: params.timeoutMs,
      maxSources: params.sourceTarget,
      model: params.model
    });
    return {
      text: getResponseOutputText(out.data),
      usage: null,
      rawSources: getResponseSources(out.data) ?? null
    };
  }

  const out = await runGemini(params.prompt, {
    timeoutMs: params.timeoutMs,
    maxSources: params.sourceTarget,
    model: params.model
  });
  return {
    text: out.outputText,
    usage: null,
    rawSources: out.sources ?? null
  };
}

function fallbackPlan(question: string): ResearchPlan {
  return {
    objectives: ['Answer the user question with evidence-backed findings and explicit uncertainty.'],
    outline: ['Context', 'Current Evidence', 'Counterpoints', 'Gaps', 'Implications'],
    sections: [
      {
        section: 'Context',
        objectives: ['Define scope and key terms'],
        query_pack: [question, `${question} definitions`],
        acceptance_criteria: ['Clear scope and definitions']
      },
      {
        section: 'Evidence',
        objectives: ['Collect primary and secondary sources'],
        query_pack: [`${question} data`, `${question} primary sources`],
        acceptance_criteria: ['At least one primary source', 'Cross-source corroboration']
      },
      {
        section: 'Counterpoints',
        objectives: ['Capture strongest disagreements and limits'],
        query_pack: [`${question} criticism`, `${question} limitations`],
        acceptance_criteria: ['At least two meaningful counterarguments']
      }
    ],
    source_quality_requirements: {
      primary_sources_required: true,
      recency: 'Prioritize last 24 months unless foundational history is required.',
      geography: 'Global unless the question specifies geography.',
      secondary_sources_allowed: true
    },
    token_budgets: {},
    output_budgets: {}
  };
}

function compactSummary(text: string, maxChars = 800): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}...`;
}

function buildStepPrompt(input: ExecutionInput): { prompt: string; expectsJson: boolean } {
  const planText = input.plan ? JSON.stringify(input.plan).slice(0, 6000) : 'null';
  const base =
    `Question:\n${input.question}\n\n` +
    `Prior step summary:\n${input.priorStepSummary || 'None yet.'}\n\n` +
    `Current plan:\n${planText}`;

  if (input.stepType === 'DEVELOP_RESEARCH_PLAN') {
    return {
      expectsJson: true,
      prompt:
        `${base}\n\nReturn ONLY JSON with schema:\n` +
        `{"objectives":string[],"outline":string[],"sections":[{"section":string,"objectives":string[],"query_pack":string[],"acceptance_criteria":string[]}],` +
        `"source_quality_requirements":{"primary_sources_required":boolean,"recency":string,"geography":string,"secondary_sources_allowed":boolean},` +
        `"token_budgets":object,"output_budgets":object}`
    };
  }

  if (input.stepType === 'SHORTLIST_RESULTS') {
    return {
      expectsJson: true,
      prompt:
        `${base}\n\nReturn ONLY JSON with schema:\n` +
        `{"shortlist":[{"url":string,"title":string,"publisher":string,"reason":string,"section":string,"read_priority":"high|med|low"}]}` +
        `\nKeep ${input.shortlistSize} items max, diverse viewpoints, include primary sources where possible.`
    };
  }

  if (input.stepType === 'EXTRACT_EVIDENCE') {
    return {
      expectsJson: true,
      prompt:
        `${base}\n\nReturn ONLY JSON with schema:\n` +
        `{"evidence":[{"claim":string,"supporting_snippet":string,"confidence":"low|med|high","notes":string}]}` +
        `\nFocus on metrics, definitions, timelines, and contradictions.`
    };
  }

  if (input.stepType === 'GAP_CHECK') {
    return {
      expectsJson: true,
      prompt:
        `${base}\n\nReturn ONLY JSON with schema:\n` +
        `{"missing_sections":string[],"weak_claims":string[],"missing_primary_sources":string[],"follow_up_queries":string[],"severe_gaps":boolean}`
    };
  }

  if (input.stepType === 'SECTION_SYNTHESIS') {
    return {
      expectsJson: false,
      prompt:
        `${base}\n\nProduce final provider report in markdown with:\n` +
        `- Title\n- Table of Contents\n- Section/subsection hierarchy\n- Inline citations [#] mapped to sources\n- What we know / what we do not know in each section\n- Summary and implications\n- Full Sources list with URLs`
    };
  }

  if (input.stepType === 'DISCOVER_SOURCES_WITH_PLAN') {
    return {
      expectsJson: false,
      prompt:
        `${base}\n\nDiscover and list ${input.maxCandidates} candidate sources with URL, title, publisher, section fit, and 1-2 line rationale.`
    };
  }

  if (input.stepType === 'DEEP_READ') {
    return {
      expectsJson: false,
      prompt:
        `${base}\n\nDeep-read shortlisted sources by section. For each source provide key takeaways, critical datapoints, and limitations.`
    };
  }

  return {
    expectsJson: false,
    prompt:
      `${base}\n\nGenerate strongest counterarguments, disagreements among sources, and bias/limitation analysis with citations.`
  };
}

export async function executePipelineStep(input: ExecutionInput): Promise<ResearchStepArtifact & { updatedPlan?: ResearchPlan | null }> {
  const providerCfg = getResearchProviderConfig(input.provider);
  const stepCfg = providerCfg.steps[input.stepType];
  const model = stepCfg.model_tier === 'deep' ? providerCfg.deep_model : providerCfg.fast_model;
  const outputTokens = Math.max(300, Math.min(input.maxOutputTokens, stepCfg.max_output_tokens));
  const promptDef = buildStepPrompt(input);

  const runResult =
    stepCfg.model_tier === 'deep'
      ? await runDeep({
          provider: input.provider,
          prompt: promptDef.prompt,
          timeoutMs: input.timeoutMs,
          sourceTarget: input.sourceTarget,
          model
        })
      : await runFastReasoning({
          provider: input.provider,
          prompt: promptDef.prompt,
          timeoutMs: input.timeoutMs,
          maxOutputTokens: outputTokens,
          model,
          useSearch: input.stepType === 'DISCOVER_SOURCES_WITH_PLAN'
        });

  const rawText = runResult.text.trim();
  const citations = normalizeCitations(input.provider, rawText, runResult.rawSources, input.maxCandidates);
  let evidence = evidenceFromText(rawText, citations);
  let structuredOutput: Record<string, unknown> | null = null;
  let updatedPlan: ResearchPlan | null = null;

  if (promptDef.expectsJson) {
    const parsedObj = parseJsonObject<Record<string, unknown>>(rawText);
    if (parsedObj) {
      structuredOutput = parsedObj;
      if (input.stepType === 'DEVELOP_RESEARCH_PLAN') {
        const parsedPlan = parseJsonObject<ResearchPlan>(rawText);
        updatedPlan = parsedPlan ?? fallbackPlan(input.question);
        structuredOutput = updatedPlan as unknown as Record<string, unknown>;
        evidence = [];
      } else if (input.stepType === 'EXTRACT_EVIDENCE') {
        const rows = Array.isArray(parsedObj.evidence) ? parsedObj.evidence : [];
        evidence = rows
          .map((row, idx) => {
            const rec = row as Record<string, unknown>;
            const claim = typeof rec.claim === 'string' ? rec.claim.trim() : '';
            if (!claim) return null;
            const snippet = typeof rec.supporting_snippet === 'string' ? rec.supporting_snippet.trim() : claim.slice(0, 180);
            const conf = rec.confidence === 'high' || rec.confidence === 'med' || rec.confidence === 'low' ? rec.confidence : 'med';
            return {
              evidence_id: `ev_${idx + 1}_${Math.abs(hash(claim)).toString(36)}`,
              claim,
              supporting_snippet: snippet,
              source_citation_ids: citations.slice(0, 2).map((c) => c.citation_id),
              confidence: conf,
              notes: typeof rec.notes === 'string' ? rec.notes : null
            } as ResearchEvidence;
          })
          .filter((item): item is ResearchEvidence => Boolean(item));
      } else if (input.stepType === 'SHORTLIST_RESULTS') {
        const shortlist = Array.isArray(parsedObj.shortlist) ? parsedObj.shortlist : [];
        const shortlistUrls = new Set(
          shortlist
            .map((row) => (row && typeof row === 'object' ? (row as Record<string, unknown>).url : null))
            .filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u))
        );
        if (shortlistUrls.size > 0) {
          evidence = [];
          const filtered = citations.filter((c) => shortlistUrls.has(c.url));
          if (filtered.length > 0) {
            citations.splice(0, citations.length, ...filtered);
          }
        }
      }
    }
  }

  if (input.stepType === 'SECTION_SYNTHESIS') {
    evidence = [];
  }

  const hint =
    input.stepType === 'GAP_CHECK' && structuredOutput && Array.isArray(structuredOutput.follow_up_queries)
      ? `follow_up_queries=${(structuredOutput.follow_up_queries as unknown[]).length}`
      : null;

  return {
    step_goal: `Execute ${input.stepType.replace(/_/g, ' ').toLowerCase()}`,
    inputs_summary: compactSummary(`${input.stepType} | sourceTarget=${input.sourceTarget} | maxTokens=${outputTokens}`),
    raw_output_text: rawText,
    citations,
    evidence,
    tools_used: [input.provider === 'openai' ? 'web_search_preview' : 'google_search'],
    token_usage: runResult.usage as Record<string, unknown> | null,
    model_used: model,
    next_step_hint: hint,
    structured_output: structuredOutput,
    updatedPlan
  };
}

export async function generateResearchPlan(params: {
  provider: ResearchProviderName;
  question: string;
  depth: 'light' | 'standard' | 'deep';
  maxSteps: number;
  targetSourcesPerStep: number;
  maxTokensPerStep: number;
  timeoutMs: number;
}): Promise<{ needsClarification: boolean; clarifyingQuestions: string[]; assumptions: string[]; plan: ResearchPlan; brief: unknown }> {
  const out = await executePipelineStep({
    provider: params.provider,
    stepType: 'DEVELOP_RESEARCH_PLAN',
    question: params.question,
    timeoutMs: params.timeoutMs,
    plan: null,
    priorStepSummary: '',
    sourceTarget: params.targetSourcesPerStep,
    maxOutputTokens: params.maxTokensPerStep,
    maxCandidates: getResearchProviderConfig(params.provider).max_candidates,
    shortlistSize: getResearchProviderConfig(params.provider).shortlist_size
  });

  const plan = out.updatedPlan ?? fallbackPlan(params.question);
  return {
    needsClarification: false,
    clarifyingQuestions: [],
    assumptions: [],
    plan,
    brief: {
      audience: 'General',
      scope: 'Evidence-backed synthesis',
      depth: params.depth,
      geography_time_window: 'Global and recent with foundational exceptions',
      required_sections: plan.outline
    }
  };
}

export async function executeCustomStep(params: {
  provider: ResearchProviderName;
  stepType: StepType;
  stepGoal: string;
  queryPack: string[];
  question: string;
  priorSummary: string;
  sourceTarget: number;
  maxOutputTokens: number;
  timeoutMs: number;
  previousResponseId?: string | null;
}): Promise<ResearchStepArtifact & { continuationId?: string | null; sources?: ResearchStepArtifact['citations'] }> {
  const legacyMap: Record<string, Exclude<StepType, 'NATIVE_SECTION'>> = {
    DISCOVER: 'DISCOVER_SOURCES_WITH_PLAN',
    SHORTLIST: 'SHORTLIST_RESULTS',
    DEEP_READ: 'DEEP_READ',
    EXTRACT_EVIDENCE: 'EXTRACT_EVIDENCE',
    COUNTERPOINTS: 'COUNTERPOINTS',
    GAPS_CHECK: 'GAP_CHECK',
    SECTION_SYNTHESIS: 'SECTION_SYNTHESIS',
    DEVELOP_RESEARCH_PLAN: 'DEVELOP_RESEARCH_PLAN',
    DISCOVER_SOURCES_WITH_PLAN: 'DISCOVER_SOURCES_WITH_PLAN',
    SHORTLIST_RESULTS: 'SHORTLIST_RESULTS',
    GAP_CHECK: 'GAP_CHECK'
  };
  const stepType = legacyMap[String(params.stepType)] ?? 'SECTION_SYNTHESIS';
  const out = await executePipelineStep({
    provider: params.provider,
    stepType,
    question: `${params.question}\n\nQuery hints:\n${params.queryPack.join('\n')}`,
    timeoutMs: params.timeoutMs,
    plan: null,
    priorStepSummary: params.priorSummary,
    sourceTarget: params.sourceTarget,
    maxOutputTokens: params.maxOutputTokens,
    maxCandidates: getResearchProviderConfig(params.provider).max_candidates,
    shortlistSize: getResearchProviderConfig(params.provider).shortlist_size
  });

  return {
    ...out,
    // Backward compatible alias used in existing tests and older call sites.
    sources: out.citations,
    continuationId: null
  };
}

export async function executeNativeResearch(params: {
  provider: ResearchProviderName;
  question: string;
  maxSources: number;
  timeoutMs: number;
}): Promise<{ rawText: string; rawSources: unknown; citations: ResearchStepArtifact['citations'] }> {
  const model = getResearchProviderConfig(params.provider).deep_model;
  const deep = await runDeep({
    provider: params.provider,
    prompt: params.question,
    timeoutMs: params.timeoutMs,
    sourceTarget: params.maxSources,
    model
  });

  return {
    rawText: deep.text,
    rawSources: deep.rawSources,
    citations: normalizeCitations(params.provider, deep.text, deep.rawSources)
  };
}

export function parseEvidenceArray(text: string): ResearchEvidence[] {
  const arr = parseJsonArray<Record<string, unknown>>(text);
  if (!arr) return [];
  return arr
    .map((row, idx) => {
      const claim = typeof row.claim === 'string' ? row.claim.trim() : '';
      if (!claim) return null;
      return {
        evidence_id: `ev_${idx + 1}_${Math.abs(hash(claim)).toString(36)}`,
        claim,
        supporting_snippet: typeof row.supporting_snippet === 'string' ? row.supporting_snippet : claim.slice(0, 160),
        source_citation_ids: Array.isArray(row.source_citation_ids)
          ? (row.source_citation_ids as unknown[]).filter((v): v is string => typeof v === 'string')
          : [],
        confidence: row.confidence === 'high' || row.confidence === 'med' || row.confidence === 'low' ? row.confidence : 'med',
        notes: typeof row.notes === 'string' ? row.notes : null
      } as ResearchEvidence;
    })
    .filter((item): item is ResearchEvidence => Boolean(item));
}
