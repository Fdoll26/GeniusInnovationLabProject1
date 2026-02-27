import { getEnv } from './env';
import type { ResearchProviderName, StepType } from './research-types';

type StepConfig = {
  model_tier: 'fast' | 'deep';
  max_output_tokens: number;
};

export type ProviderResearchConfig = {
  fast_model: string;
  deep_model: string;
  steps: Record<Exclude<StepType, 'NATIVE_SECTION'>, StepConfig>;
  max_candidates: number;
  shortlist_size: number;
  max_gap_loops: number;
};

function asNumber(value: unknown, fallback: number, min: number, max: number) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

const defaults: Record<ResearchProviderName, ProviderResearchConfig> = {
  openai: {
    fast_model: getEnv('OPENAI_REFINER_MODEL') || 'gpt-4.1-mini',
    deep_model: getEnv('OPENAI_DEEP_RESEARCH_MODEL') || 'o3-deep-research',
    steps: {
      DEVELOP_RESEARCH_PLAN: { model_tier: 'fast', max_output_tokens: 1400 },
      DISCOVER_SOURCES_WITH_PLAN: { model_tier: 'deep', max_output_tokens: 2600 },
      SHORTLIST_RESULTS: { model_tier: 'fast', max_output_tokens: 1200 },
      DEEP_READ: { model_tier: 'deep', max_output_tokens: 3000 },
      EXTRACT_EVIDENCE: { model_tier: 'fast', max_output_tokens: 1500 },
      COUNTERPOINTS: { model_tier: 'deep', max_output_tokens: 1800 },
      GAP_CHECK: { model_tier: 'fast', max_output_tokens: 1200 },
      SECTION_SYNTHESIS: { model_tier: 'deep', max_output_tokens: 3800 }
    },
    max_candidates: 40,
    shortlist_size: 18,
    max_gap_loops: 1
  },
  gemini: {
    fast_model: getEnv('GEMINI_FAST_MODEL') || 'gemini-2.0-flash',
    deep_model: getEnv('GEMINI_DEEP_MODEL') || getEnv('GEMINI_MODEL') || 'gemini-2.5-pro',
    steps: {
      DEVELOP_RESEARCH_PLAN: { model_tier: 'fast', max_output_tokens: 1400 },
      DISCOVER_SOURCES_WITH_PLAN: { model_tier: 'deep', max_output_tokens: 2600 },
      SHORTLIST_RESULTS: { model_tier: 'fast', max_output_tokens: 1200 },
      DEEP_READ: { model_tier: 'deep', max_output_tokens: 3000 },
      EXTRACT_EVIDENCE: { model_tier: 'fast', max_output_tokens: 1500 },
      COUNTERPOINTS: { model_tier: 'deep', max_output_tokens: 1800 },
      GAP_CHECK: { model_tier: 'fast', max_output_tokens: 1200 },
      SECTION_SYNTHESIS: { model_tier: 'deep', max_output_tokens: 3800 }
    },
    max_candidates: 40,
    shortlist_size: 18,
    max_gap_loops: 1
  }
};

function mergeProviderConfig(
  base: ProviderResearchConfig,
  input: Partial<ProviderResearchConfig> | undefined
): ProviderResearchConfig {
  if (!input) return base;
  const mergedSteps = { ...base.steps };
  const rawSteps = input.steps as Partial<Record<Exclude<StepType, 'NATIVE_SECTION'>, StepConfig>> | undefined;
  if (rawSteps) {
    for (const [step, cfg] of Object.entries(rawSteps)) {
      const key = step as Exclude<StepType, 'NATIVE_SECTION'>;
      if (!mergedSteps[key] || !cfg) continue;
      mergedSteps[key] = {
        model_tier: cfg.model_tier === 'deep' ? 'deep' : 'fast',
        max_output_tokens: asNumber(cfg.max_output_tokens, mergedSteps[key].max_output_tokens, 300, 8000)
      };
    }
  }

  return {
    fast_model: typeof input.fast_model === 'string' && input.fast_model ? input.fast_model : base.fast_model,
    deep_model: typeof input.deep_model === 'string' && input.deep_model ? input.deep_model : base.deep_model,
    steps: mergedSteps,
    max_candidates: asNumber(input.max_candidates, base.max_candidates, 10, 80),
    shortlist_size: asNumber(input.shortlist_size, base.shortlist_size, 8, 40),
    max_gap_loops: asNumber(input.max_gap_loops, base.max_gap_loops, 0, 3)
  };
}

let cached: Record<ResearchProviderName, ProviderResearchConfig> | null = null;

export function getResearchProviderConfig(provider: ResearchProviderName): ProviderResearchConfig {
  if (!cached) {
    const raw = getEnv('RESEARCH_STEP_CONFIG_JSON');
    if (!raw) {
      cached = defaults;
    } else {
      try {
        const parsed = JSON.parse(raw) as Partial<Record<ResearchProviderName, Partial<ProviderResearchConfig>>>;
        cached = {
          openai: mergeProviderConfig(defaults.openai, parsed.openai),
          gemini: mergeProviderConfig(defaults.gemini, parsed.gemini)
        };
      } catch {
        cached = defaults;
      }
    }
  }
  return cached[provider];
}
