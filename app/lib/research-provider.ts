import {
  extractGeminiGroundingMetadata,
  looksTruncated,
  runGemini,
  runGeminiReasoningStep,
  runGeminiReasoningStepFanOut
} from './gemini-client';
import {
  getResponseOutputText,
  getResponsePrimaryMessageContent,
  getResponseSources,
  runOpenAiReasoningStep,
  startResearchJob,
  waitDeepResearch
} from './openai-client';
import { getResearchProviderConfig } from './research-config';
import { normalizeProviderCitations } from './citation-normalizer';
import {
  buildFallbackResearchPlan,
  parseResearchPlanFromText,
  RESEARCH_PLAN_SCHEMA
} from './research-plan-schema';
import { STEP_SEQUENCE } from './research-types';
import type {
  ResearchEvidence,
  ResearchPlan,
  ResearchProviderName,
  ResearchStepArtifact,
  StepType
} from './research-types';
import type { GeminiCoverageMetrics, GeminiSubcallResult, RankedSource } from './gemini-client';

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

const GAP_CHECK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    missing_sections: { type: 'array', items: { type: 'string' } },
    weak_claims: { type: 'array', items: { type: 'string' } },
    missing_primary_sources: { type: 'array', items: { type: 'string' } },
    follow_up_queries: { type: 'array', items: { type: 'string' } },
    severe_gaps: { type: 'boolean' }
  },
  required: ['missing_sections', 'weak_claims', 'missing_primary_sources', 'follow_up_queries', 'severe_gaps']
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
  queryPack?: string[];
  timeoutMs: number;
  maxOutputTokens: number;
  model: string;
  useSearch?: boolean;
  structuredOutput?: {
    schemaName: string;
      jsonSchema: Record<string, unknown>;
  };
}): Promise<{
  text: string;
  usage: unknown;
  rawSources: unknown;
  providerNativeOutput: string;
  providerNativeCitationMetadata: unknown;
  subcallResults?: GeminiSubcallResult[];
  coverageMetrics?: GeminiCoverageMetrics;
  rankedSources?: RankedSource[];
}> {
  if (params.provider === 'openai') {
    const out = await runOpenAiReasoningStep({
      prompt: params.prompt,
      timeoutMs: params.timeoutMs,
      maxOutputTokens: params.maxOutputTokens,
      model: params.model,
      useWebSearch: params.useSearch ?? true,
      structuredOutput: params.structuredOutput
    });
    return {
      text: out.text,
      usage: out.usage ?? null,
      rawSources: out.sources ?? null,
      providerNativeOutput: out.primaryContent?.text ?? out.text,
      providerNativeCitationMetadata: out.primaryContent?.annotations ?? null
    };
  }

  if (params.useSearch ?? true) {
    const geminiCfg = getResearchProviderConfig('gemini');

    if (params.structuredOutput?.schemaName === 'research_plan') {
      // Plan generation should not consume scout synthesis text as prior findings.
      const out = await runGeminiReasoningStep({
        prompt: params.prompt,
        timeoutMs: params.timeoutMs,
        maxOutputTokens: params.maxOutputTokens,
        model: params.model,
        useSearch: false,
        structuredOutput: params.structuredOutput
      });
      return {
        text: out.text,
        usage: out.usage ?? null,
        rawSources: out.sources ?? null,
        providerNativeOutput: out.text,
        providerNativeCitationMetadata: out.groundingMetadata ?? null
      };
    }

    if (!params.structuredOutput) {
      const out = await runGeminiReasoningStepFanOut({
        prompt: params.prompt,
        queryPack: params.queryPack ?? [],
        timeoutMs: params.timeoutMs,
        maxOutputTokens: params.maxOutputTokens,
        model: params.model,
        subcallModel: geminiCfg.fast_model,
        maxSubcalls: Math.min(30, params.queryPack?.length ?? 30),
        maxParallelSubcalls: 6
      });
      return {
        text: out.text,
        usage: out.usage ?? null,
        rawSources: out.sources ?? null,
        providerNativeOutput: out.text,
        providerNativeCitationMetadata: (out.sources as { groundingMetadata?: unknown } | null)?.groundingMetadata ?? null,
        subcallResults: out.subcallResults,
        coverageMetrics: out.coverageMetrics,
        rankedSources: out.rankedSources
      };
    }

    const fanOut = await runGeminiReasoningStepFanOut({
      prompt: params.prompt,
      queryPack: params.queryPack ?? [],
      timeoutMs: params.timeoutMs,
      maxOutputTokens: Math.min(params.maxOutputTokens, 4000),
      model: params.model,
      subcallModel: geminiCfg.fast_model,
      maxSubcalls: Math.min(15, params.queryPack?.length ?? 15),
      maxParallelSubcalls: 4
    });
    const structuredResult = await runGeminiReasoningStep({
      prompt: `Based on these research findings:\n\n${fanOut.text.slice(0, 8000)}\n\n${params.prompt}`,
      maxOutputTokens: params.maxOutputTokens,
      model: params.model,
      useSearch: false,
      structuredOutput: params.structuredOutput
    });
    return {
      text: structuredResult.text,
      usage: structuredResult.usage ?? null,
      rawSources: fanOut.sources ?? null,
      providerNativeOutput: structuredResult.text,
      providerNativeCitationMetadata: fanOut.sources ?? null,
      subcallResults: fanOut.subcallResults,
      coverageMetrics: fanOut.coverageMetrics,
      rankedSources: fanOut.rankedSources
    };
  }

  const out = await runGeminiReasoningStep({
    prompt: params.prompt,
    timeoutMs: params.timeoutMs,
    maxOutputTokens: params.maxOutputTokens,
    model: params.model,
    useSearch: params.useSearch ?? true,
    structuredOutput: params.structuredOutput
  });

  return {
    text: out.text,
    usage: out.usage ?? null,
    rawSources: out.sources ?? null,
    providerNativeOutput: out.text,
    providerNativeCitationMetadata: out.groundingMetadata ?? null
  };
}

async function runGeminiSectionSynthesis(params: {
  prompt: string;
  queryPack: string[];
  timeoutMs: number;
  maxOutputTokens: number;
  model: string;
}): Promise<{
  text: string;
  usage: unknown;
  rawSources: unknown;
  providerNativeOutput: string;
  providerNativeCitationMetadata: unknown;
  subcallResults?: GeminiSubcallResult[];
  coverageMetrics?: GeminiCoverageMetrics;
  rankedSources?: RankedSource[];
}> {
  const geminiCfg = getResearchProviderConfig('gemini');
  const fanOut = await runGeminiReasoningStepFanOut({
    prompt: params.prompt,
    queryPack: params.queryPack,
    timeoutMs: params.timeoutMs,
    maxOutputTokens: params.maxOutputTokens,
    model: params.model,
    subcallModel: geminiCfg.fast_model,
    maxSubcalls: Math.min(30, params.queryPack.length),
    maxParallelSubcalls: 6
  });

  if (!looksTruncated(fanOut.text) && fanOut.text.length > 500) {
    return {
      text: fanOut.text,
      usage: fanOut.usage ?? null,
      rawSources: fanOut.sources ?? null,
      providerNativeOutput: fanOut.text,
      providerNativeCitationMetadata: (fanOut.sources as { groundingMetadata?: unknown } | null)?.groundingMetadata ?? null,
      subcallResults: fanOut.subcallResults,
      coverageMetrics: fanOut.coverageMetrics,
      rankedSources: fanOut.rankedSources
    };
  }

  const SEGMENT_SIZE = 6000;
  const fullFindings = fanOut.text;
  const segments: string[] = [];
  for (let cursor = 0; cursor < fullFindings.length; cursor += SEGMENT_SIZE) {
    segments.push(fullFindings.slice(cursor, cursor + SEGMENT_SIZE));
  }
  if (segments.length === 0) segments.push(fullFindings);

  const reportParts: string[] = [];
  let previousTail = '';
  const perSegmentMs = Math.max(30_000, Math.floor(params.timeoutMs / (segments.length + 1)));

  for (let i = 0; i < segments.length; i += 1) {
    const isFirst = i === 0;
    const isLast = i === segments.length - 1;
    const continuationContext = previousTail
      ? `Continue the report seamlessly. The previous section ended with:\n...${previousTail}\n\nDo NOT repeat any content already written. Continue directly.\n\n`
      : '';
    const segmentInstruction = isLast
      ? 'This is the final segment. Complete the synthesis and end with a full "## Sources" section listing every URL cited.'
      : 'More research segments follow. Write this section completely but do not write a conclusion or Sources section yet.';
    const segmentPrompt =
      `${continuationContext}` +
      `${isFirst ? `${params.prompt}\n\n` : ''}` +
      `RESEARCH FINDINGS (segment ${i + 1} of ${segments.length}):\n${segments[i]}\n\n` +
      segmentInstruction;

    try {
      const segmentData = await runGeminiReasoningStep({
        prompt: segmentPrompt,
        maxOutputTokens: 8000,
        model: params.model,
        useSearch: false,
        timeoutMs: perSegmentMs
      });
      reportParts.push(segmentData.text);
      previousTail = segmentData.text.slice(-800);
    } catch (error) {
      reportParts.push(
        `\n[Section ${i + 1} generation failed: ${error instanceof Error ? error.message : String(error)}]\n`
      );
    }
  }

  const combinedText = reportParts.join('\n\n');
  return {
    text: combinedText,
    usage: fanOut.usage ?? null,
    rawSources: fanOut.sources ?? null,
    providerNativeOutput: combinedText,
    providerNativeCitationMetadata: (fanOut.sources as { groundingMetadata?: unknown } | null)?.groundingMetadata ?? null,
    subcallResults: fanOut.subcallResults,
    coverageMetrics: fanOut.coverageMetrics,
    rankedSources: fanOut.rankedSources
  };
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
    const finalData =
      out.responseId && out.status !== 'completed'
        ? await waitDeepResearch(out.responseId, { timeoutMs: params.timeoutMs })
        : out.data;
    const finalStatus = (finalData as { status?: unknown })?.status;
    if (typeof finalStatus === 'string' && finalStatus !== 'completed') {
      throw new Error(`OpenAI deep research ended with status=${finalStatus}`);
    }
    const outputText = getResponseOutputText(finalData);
    const primary = getResponsePrimaryMessageContent(finalData);
    return {
      text: outputText,
      usage: null,
      rawSources: getResponseSources(finalData) ?? null,
      providerNativeOutput: primary?.text ?? outputText,
      providerNativeCitationMetadata: primary?.annotations ?? null
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
    rawSources: out.sources ?? null,
    providerNativeOutput: out.outputText,
    providerNativeCitationMetadata: extractGeminiGroundingMetadata(out.sources) ?? null
  };
}

function compactSummary(text: string, maxChars = 800): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}...`;
}

function buildDefaultQueryPack(
  stepType: Exclude<StepType, 'NATIVE_SECTION'>,
  question: string,
  priorSummary: string,
  provider: ResearchProviderName = 'openai'
): string[] {
  const q = question.trim();
  const priorHint = priorSummary.trim().slice(0, 160);

  // OpenAI path: keep existing compact packs (OpenAI handles search internally)
  if (provider === 'openai') {
    if (stepType === 'DISCOVER_SOURCES_WITH_PLAN') {
      return [
        `${q} primary sources overview`,
        `${q} academic research papers`,
        `${q} government reports statistics`,
        `${q} industry reports market analysis`,
        `${q} reputable journalism latest developments`,
        `${q} expert analysis recent`,
        `${q} criticisms limitations concerns`,
        `${q} case studies examples`,
        `${q} historical baseline trends`,
        `${q} conflicting evidence debate`
      ];
    }
    if (stepType === 'DEEP_READ') {
      return [
        `${q} key metrics and quantitative findings`,
        `${q} methodology quality and assumptions`,
        `${q} regional differences comparison`,
        `${q} policy and regulatory impacts`,
        `${q} timeline milestones and forecasts`,
        `${q} counterarguments and limitations`,
        `${q} source credibility and evidence strength`,
        `${q} failure cases and edge conditions`
      ];
    }
    if (stepType === 'COUNTERPOINTS') {
      return [
        `${q} strongest criticisms`,
        `${q} contradictory findings`,
        `${q} alternative explanations`,
        `${q} methodological weaknesses`,
        `${q} conflicts of interest bias`,
        `${q} downside risks scenario analysis`,
        `${q} expert disagreement`,
        `${q} replication concerns`
      ];
    }
    if (stepType === 'SECTION_SYNTHESIS') {
      return [
        `${q} cross-source synthesis key takeaways`,
        `${q} consensus findings`,
        `${q} unresolved disagreements`,
        `${q} practical implications`,
        `${q} caveats and uncertainty`,
        `${q} data gaps and next research steps`
      ];
    }
    if (stepType === 'SHORTLIST_RESULTS') {
      return [
        `${q} most authoritative sources`,
        `${q} primary data sources`,
        `${q} highest quality peer reviewed evidence`,
        `${q} government and regulatory sources`,
        `${q} reputable journalism and explainers`,
        `${q} opposing viewpoints`
      ];
    }
    if (stepType === 'EXTRACT_EVIDENCE') {
      return [
        `${q} concrete statistics and figures`,
        `${q} named organizations and reports`,
        `${q} dated claims and timelines`,
        `${q} causal claims with supporting data`,
        `${q} contradictory evidence`,
        `${q} limitations caveats uncertainty`
      ];
    }
    if (stepType === 'GAP_CHECK') {
      return [
        `${q} missing evidence`,
        `${q} unsupported claims`,
        `${q} missing primary sources`,
        `${q} unresolved contradictions`,
        `${q} follow-up research questions`,
        `${q} unknowns and limitations`
      ];
    }
    if (stepType === 'DEVELOP_RESEARCH_PLAN') {
      return [
        `${q} scope and definitions`,
        `${q} key dimensions and sections`,
        `${q} primary source strategy`,
        `${q} opposing perspectives and critiques`,
        `${q} baseline metrics and datasets`,
        `${q} recency and trend indicators`,
        `${q} if prior findings then ${priorHint || 'none'}`
      ];
    }
    return [`${q} overview`, `${q} primary sources`, `${q} criticisms`, `${q} recent updates`];
  }

  if (stepType === 'DISCOVER_SOURCES_WITH_PLAN') {
    return [
      `${q} overview introduction`,
      `${q} academic research peer reviewed studies`,
      `${q} government agency reports official data`,
      `${q} industry analysis market research`,
      `${q} investigative journalism coverage`,
      `${q} expert commentary analysis`,
      `${q} NGO nonprofit research findings`,
      `${q} historical trends baseline data`,
      `${q} recent developments 2023 2024`,
      `${q} case studies real world examples`,
      `${q} criticisms limitations problems`,
      `${q} international comparison global perspective`,
      `${q} statistical data datasets numbers`,
      `${q} policy regulatory framework`,
      `${q} future outlook projections forecasts`,
      `${q} opposing viewpoints debate controversy`,
      `${q} key definitions terminology explained`,
      `${q} primary source documents white papers`
    ];
  }

  if (stepType === 'DEEP_READ') {
    return [
      `${q} quantitative findings key metrics`,
      `${q} methodology research design quality`,
      `${q} sample size confidence intervals statistical significance`,
      `${q} longitudinal data time series trends`,
      `${q} regional geographic breakdown differences`,
      `${q} demographic breakdown population groups`,
      `${q} causal mechanisms explanations why`,
      `${q} policy regulatory impacts implications`,
      `${q} cost benefit economic analysis`,
      `${q} implementation challenges barriers`,
      `${q} success cases best practices`,
      `${q} failure cases edge conditions limitations`,
      `${q} expert practitioner perspectives quotes`,
      `${q} conflicting studies contradictory evidence`,
      `${q} replication reproducibility concerns`,
      `${q} confounding variables alternative explanations`,
      `${q} data source reliability credibility`,
      `${q} most cited foundational papers`
    ];
  }

  if (stepType === 'COUNTERPOINTS') {
    return [
      `${q} strongest criticisms arguments against`,
      `${q} methodological flaws limitations`,
      `${q} contradictory studies contradicting evidence`,
      `${q} alternative explanations competing theories`,
      `${q} conflicts of interest funding bias`,
      `${q} cherry picking selection bias`,
      `${q} publication bias missing negative results`,
      `${q} expert disagreement dissenting voices`,
      `${q} failed implementations negative outcomes`,
      `${q} unintended consequences side effects`,
      `${q} cost and resource objections`,
      `${q} feasibility scalability concerns`,
      `${q} ethical objections moral concerns`,
      `${q} political opposition resistance`,
      `${q} market failure counterexamples`,
      `${q} replication crisis failed replications`,
      `${q} downside risks worst case scenarios`,
      `${q} minority perspective underrepresented critique`
    ];
  }

  if (stepType === 'SECTION_SYNTHESIS') {
    return [
      `${q} consensus expert agreement findings`,
      `${q} evidence strength quality assessment`,
      `${q} key takeaways practical implications`,
      `${q} unresolved debates open questions`,
      `${q} highest confidence findings`,
      `${q} contested claims disputed evidence`,
      `${q} data gaps missing information`,
      `${q} synthesis overview combined findings`,
      `${q} what experts agree on`,
      `${q} what experts still disagree on`,
      `${q} recommended actions next steps`,
      `${q} future research directions needed`,
      `${q} caveats limitations uncertainty`,
      `${q} real world applications outcomes`,
      `${q} cross disciplinary perspectives`,
      `${q} short term vs long term implications`
    ];
  }

  if (stepType === 'SHORTLIST_RESULTS') {
    return [
      `${q} authoritative primary sources`,
      `${q} most cited influential papers`,
      `${q} government official reports`,
      `${q} peer reviewed journal articles`,
      `${q} reputable think tank research`,
      `${q} leading academic institutions studies`,
      `${q} reputable news investigations`,
      `${q} industry association official positions`,
      `${q} WHO UN agency reports`,
      `${q} national statistics offices data`,
      `${q} fact checked verified claims`,
      `${q} most recent updates 2024`,
      `${q} opposing authoritative viewpoints`,
      `${q} foundational seminal works`
    ];
  }

  if (stepType === 'EXTRACT_EVIDENCE') {
    return [
      `${q} specific statistics percentages numbers`,
      `${q} named studies and reports with dates`,
      `${q} concrete examples with outcomes`,
      `${q} quotes from named experts researchers`,
      `${q} causal claims supported by data`,
      `${q} before and after comparisons`,
      `${q} cost figures economic data`,
      `${q} timeframes deadlines milestones`,
      `${q} geographic specific regional data`,
      `${q} contradictory evidence conflicting claims`,
      `${q} limitations caveats qualifications`,
      `${q} confidence levels uncertainty ranges`,
      `${q} primary source direct evidence`,
      `${q} secondary analysis interpretation`,
      `${q} anecdotal evidence case reports`
    ];
  }

  if (stepType === 'GAP_CHECK') {
    return [
      `${q} missing evidence unanswered questions`,
      `${q} under-researched aspects blind spots`,
      `${q} claims lacking primary sources`,
      `${q} unverified assertions speculation`,
      `${q} outdated information needs update`,
      `${q} geographic gaps understudied regions`,
      `${q} demographic gaps underrepresented groups`,
      `${q} long-term data longitudinal studies missing`,
      `${q} contrarian perspectives not yet addressed`,
      `${q} follow-up questions for further research`,
      `${q} emerging developments not yet covered`,
      `${q} practitioner perspectives missing`,
      `${q} implementation evidence practice gap`
    ];
  }

  if (stepType === 'DEVELOP_RESEARCH_PLAN') {
    return [
      `${q} key concepts definitions scope`,
      `${q} main dimensions subtopics breakdown`,
      `${q} primary data sources availability`,
      `${q} academic literature overview`,
      `${q} government and institutional sources`,
      `${q} industry and market intelligence`,
      `${q} counterarguments perspectives to include`,
      `${q} current state of knowledge consensus`,
      `${q} open debates controversies`,
      `${q} geographic and temporal scope`,
      `${q} relevant metrics and indicators`,
      `${q} recent significant developments`,
      `${q} seminal foundational work`,
      `${q} if prior findings then ${priorHint || 'none'}`
    ];
  }

  return [
    `${q} overview`,
    `${q} primary sources government academic`,
    `${q} criticisms limitations`,
    `${q} recent updates 2024`,
    `${q} case studies examples`,
    `${q} expert analysis commentary`
  ];
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
        `${base}\n\nReturn ONLY JSON matching this exact schema and plan all steps in execution order.\n` +
        `Each step's search_query_pack MUST contain 14-18 search queries that are:\n` +
        `- Semantically diverse (synonyms, adjacent concepts, contrasting viewpoints)\n` +
        `- Varied by source type: include queries targeting academic sources, government data, news, industry reports\n` +
        `- Varied by perspective: include queries for supporting evidence AND criticisms/limitations\n` +
        `- Specific enough to return actionable results when used as web search queries\n` +
        `- Include at least 2 queries targeting non-English or non-US sources when globally relevant\n` +
        `- Include at least 1 query with filetype or format bias (e.g. "PDF report", "white paper", "dataset")\n\n` +
        `Schema:\n` +
        JSON.stringify(RESEARCH_PLAN_SCHEMA)
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

export async function executePipelineStep(input: ExecutionInput): Promise<
  ResearchStepArtifact & {
    updatedPlan?: ResearchPlan | null;
    gemini_subcall_results?: GeminiSubcallResult[];
    gemini_coverage_metrics?: GeminiCoverageMetrics;
    gemini_ranked_sources?: RankedSource[];
  }
> {
  const providerCfg = getResearchProviderConfig(input.provider);
  const stepCfg = providerCfg.steps[input.stepType];
  const model = stepCfg.model_tier === 'deep' ? providerCfg.deep_model : providerCfg.fast_model;
  const isGeminiPlanStep =
    input.provider === 'gemini' && stepCfg.model_tier !== 'deep' && input.stepType === 'DEVELOP_RESEARCH_PLAN';
  const outputTokens = isGeminiPlanStep
    ? 8000
    : Math.max(
        300,
        Math.min(
          input.provider === 'gemini' && stepCfg.model_tier !== 'deep'
            ? Math.min(input.maxOutputTokens * 2, stepCfg.max_output_tokens, 6000)
            : input.maxOutputTokens,
          stepCfg.max_output_tokens
        )
      );
  const promptDef = buildStepPrompt(input);
  const currentPlanStep = input.plan?.steps?.find((s) => s.step_type === input.stepType);
  const queryPack: string[] =
    currentPlanStep?.search_query_pack?.length && Array.isArray(currentPlanStep.search_query_pack)
      ? currentPlanStep.search_query_pack
      : buildDefaultQueryPack(input.stepType, input.question, input.priorStepSummary, input.provider);

  const runResult =
    input.provider === 'gemini' && input.stepType === 'SECTION_SYNTHESIS'
      ? await runGeminiSectionSynthesis({
          prompt: promptDef.prompt,
          queryPack,
          timeoutMs: input.timeoutMs,
          maxOutputTokens: outputTokens,
          model
        })
      : stepCfg.model_tier === 'deep'
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
          useSearch: true,
          queryPack,
          structuredOutput:
            input.stepType === 'DEVELOP_RESEARCH_PLAN'
              ? {
                  schemaName: 'research_plan',
                  jsonSchema: RESEARCH_PLAN_SCHEMA
                }
              : input.stepType === 'GAP_CHECK'
                ? {
                    schemaName: 'gap_check',
                    jsonSchema: GAP_CHECK_SCHEMA
                  }
              : undefined
        });

  const rawText = runResult.text.trim();
  const normalized = normalizeProviderCitations({
    provider: input.provider,
    text: runResult.providerNativeOutput ?? rawText,
    citationMetadata: runResult.providerNativeCitationMetadata ?? null,
    sources: runResult.rawSources ?? null
  });
  const outputText = normalized.outputTextWithRefs || rawText;
  const halfLen = Math.floor(outputText.length / 2);
  const deduplicatedOutput =
    outputText.length > 200 && outputText.slice(0, halfLen).trim() === outputText.slice(halfLen).trim()
      ? outputText.slice(0, halfLen).trim()
      : outputText;
  const citations = normalizeCitations(input.provider, rawText, runResult.rawSources, input.maxCandidates);
  let evidence = evidenceFromText(deduplicatedOutput, citations);
  let structuredOutput: Record<string, unknown> | null = null;
  let updatedPlan: ResearchPlan | null = null;

  if (promptDef.expectsJson) {
    const parsedObj = parseJsonObject<Record<string, unknown>>(rawText);
    if (parsedObj) {
      structuredOutput = parsedObj;
      if (input.stepType === 'DEVELOP_RESEARCH_PLAN') {
        const parsedPlan = parseResearchPlanFromText(rawText, {
          refinedTopic: input.question,
          sourceTarget: input.sourceTarget,
          maxTokensPerStep: input.maxOutputTokens,
          maxSteps: STEP_SEQUENCE.length,
          maxTotalSources: input.sourceTarget * 8
        });
        updatedPlan =
          parsedPlan ??
          buildFallbackResearchPlan({
            refinedTopic: input.question,
            sourceTarget: input.sourceTarget,
            maxTokensPerStep: input.maxOutputTokens,
            maxTotalSources: input.sourceTarget * 8
          });
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
  const fanoutSubcallResults = 'subcallResults' in runResult ? runResult.subcallResults : undefined;
  const fanoutCoverageMetrics = 'coverageMetrics' in runResult ? runResult.coverageMetrics : undefined;
  const fanoutRankedSources = 'rankedSources' in runResult ? runResult.rankedSources : undefined;

  return {
    step_goal: `Execute ${input.stepType.replace(/_/g, ' ').toLowerCase()}`,
    inputs_summary: compactSummary(`${input.stepType} | sourceTarget=${input.sourceTarget} | maxTokens=${outputTokens}`),
    raw_output_text: deduplicatedOutput,
    output_text_with_refs: deduplicatedOutput,
    references: normalized.references,
    citations,
    consulted_sources: Array.isArray((runResult.rawSources as Record<string, unknown> | null)?.web_search_call_sources)
      ? ((runResult.rawSources as { web_search_call_sources: Array<{ url: string; title?: string | null }> }).web_search_call_sources ?? [])
      : [],
    provider_native_output: runResult.providerNativeOutput ?? rawText,
    provider_native_citation_metadata: runResult.providerNativeCitationMetadata ?? null,
    evidence,
    tools_used: [input.provider === 'openai' ? 'web_search_preview' : 'google_search'],
    token_usage: runResult.usage as Record<string, unknown> | null,
    model_used: model,
    next_step_hint: hint,
    structured_output: structuredOutput,
    updatedPlan,
    gemini_subcall_results: fanoutSubcallResults,
    gemini_coverage_metrics: fanoutCoverageMetrics,
    gemini_ranked_sources: fanoutRankedSources
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
  const providerCfg = getResearchProviderConfig(params.provider);
  const out = await executePipelineStep({
    provider: params.provider,
    stepType: 'DEVELOP_RESEARCH_PLAN',
    question: params.question,
    timeoutMs: params.timeoutMs,
    plan: null,
    priorStepSummary: '',
    sourceTarget: params.targetSourcesPerStep,
    maxOutputTokens: params.maxTokensPerStep,
    maxCandidates: providerCfg.max_candidates,
    shortlistSize: providerCfg.shortlist_size
  });

  const plan =
    out.updatedPlan ??
    buildFallbackResearchPlan({
      refinedTopic: params.question,
      sourceTarget: params.targetSourcesPerStep,
      maxTokensPerStep: params.maxTokensPerStep,
      maxTotalSources: params.targetSourcesPerStep * params.maxSteps
    });
  return {
    needsClarification: false,
    clarifyingQuestions: [],
    assumptions: plan.assumptions,
    plan,
    brief: {
      audience: 'General',
      scope: 'Evidence-backed synthesis',
      depth: params.depth,
      geography_time_window: 'Global and recent with foundational exceptions',
      required_sections: plan.steps.map((step) => step.title)
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
