import { getEnv } from './env';
import type { ResearchProviderName, StepType } from './research-types';

type StepConfig = {
  model_tier: 'nano' | 'mini' | 'full' | 'pro';
  max_output_tokens: number;
};

export type ProviderResearchConfig = {
  nano_model: string;
  mini_model: string;
  full_model: string;
  pro_model: string;
  /** @deprecated Use nano_model/mini_model. Kept for backward compat with RESEARCH_STEP_CONFIG_JSON. */
  fast_model?: string;
  /** @deprecated Use full_model/pro_model. Kept for backward compat with RESEARCH_STEP_CONFIG_JSON. */
  deep_model?: string;
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
    nano_model: getEnv('OPENAI_NANO_MODEL') || 'gpt-5-nano',
    mini_model: getEnv('OPENAI_MINI_MODEL') || 'gpt-5-mini',
    full_model: getEnv('OPENAI_FULL_MODEL') || 'gpt-5',
    pro_model: getEnv('OPENAI_PRO_MODEL') || 'gpt-5-pro',
    steps: {
      DEVELOP_RESEARCH_PLAN: { model_tier: 'mini', max_output_tokens: 4000 },
      DISCOVER_SOURCES_WITH_PLAN: { model_tier: 'full', max_output_tokens: 12000 },
      SHORTLIST_RESULTS: { model_tier: 'nano', max_output_tokens: 4000 },
      DEEP_READ: { model_tier: 'full', max_output_tokens: 16000 },
      EXTRACT_EVIDENCE: { model_tier: 'nano', max_output_tokens: 8000 },
      COUNTERPOINTS: { model_tier: 'pro', max_output_tokens: 12000 },
      GAP_CHECK: { model_tier: 'nano', max_output_tokens: 4000 },
      SECTION_SYNTHESIS: { model_tier: 'pro', max_output_tokens: 32768 }
    },
    max_candidates: 40,
    shortlist_size: 18,
    max_gap_loops: 2
  },
  gemini: {
    nano_model: getEnv('GEMINI_FAST_MODEL') || 'gemini-2.0-flash',
    mini_model: getEnv('GEMINI_FAST_MODEL') || 'gemini-2.0-flash',
    full_model: getEnv('GEMINI_DEEP_MODEL') || getEnv('GEMINI_MODEL') || 'gemini-2.5-pro',
    pro_model: getEnv('GEMINI_DEEP_MODEL') || getEnv('GEMINI_MODEL') || 'gemini-2.5-pro',
    steps: {
      DEVELOP_RESEARCH_PLAN: { model_tier: 'mini', max_output_tokens: 4000 },
      DISCOVER_SOURCES_WITH_PLAN: { model_tier: 'full', max_output_tokens: 12000 },
      SHORTLIST_RESULTS: { model_tier: 'nano', max_output_tokens: 4000 },
      DEEP_READ: { model_tier: 'full', max_output_tokens: 16000 },
      EXTRACT_EVIDENCE: { model_tier: 'nano', max_output_tokens: 8000 },
      COUNTERPOINTS: { model_tier: 'pro', max_output_tokens: 12000 },
      GAP_CHECK: { model_tier: 'nano', max_output_tokens: 4000 },
      SECTION_SYNTHESIS: { model_tier: 'pro', max_output_tokens: 32768 }
    },
    max_candidates: 40,
    shortlist_size: 18,
    max_gap_loops: 2
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
      const rawTier = cfg.model_tier as string;
      const normalizedTier =
        rawTier === 'fast'
          ? 'mini'
          : rawTier === 'deep'
            ? 'full'
            : (['nano', 'mini', 'full', 'pro'] as const).includes(rawTier as StepConfig['model_tier'])
              ? (rawTier as StepConfig['model_tier'])
              : 'mini';
      mergedSteps[key] = {
        model_tier: normalizedTier,
        max_output_tokens: asNumber(cfg.max_output_tokens, mergedSteps[key].max_output_tokens, 300, 32768)
      };
    }
  }

  const fastModelOverride = typeof input.fast_model === 'string' && input.fast_model ? input.fast_model : null;
  const deepModelOverride = typeof input.deep_model === 'string' && input.deep_model ? input.deep_model : null;

  return {
    nano_model:
      typeof input.nano_model === 'string' && input.nano_model
        ? input.nano_model
        : (fastModelOverride ?? base.nano_model),
    mini_model:
      typeof input.mini_model === 'string' && input.mini_model
        ? input.mini_model
        : (fastModelOverride ?? base.mini_model),
    full_model:
      typeof input.full_model === 'string' && input.full_model
        ? input.full_model
        : (deepModelOverride ?? base.full_model),
    pro_model:
      typeof input.pro_model === 'string' && input.pro_model
        ? input.pro_model
        : (deepModelOverride ?? base.pro_model),
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
