import { STEP_SEQUENCE, type ResearchPlan, type ResearchPlanStep, type ResearchPlanStepBudget } from './research-types';

const SOURCE_TYPES = [
  'academic_journal',
  'government',
  'industry_report',
  'news',
  'company_filing',
  'dataset',
  'reference',
  'expert_analysis'
] as const;

function asTextArray(input: unknown, maxItems = 12): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .slice(0, maxItems);
}

function asInt(input: unknown, fallback: number, min: number, max: number): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeStepBudget(input: unknown, fallback: ResearchPlanStepBudget): ResearchPlanStepBudget {
  const typed = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    max_sources: asInt(typed.max_sources, fallback.max_sources, 1, 30),
    max_tokens: asInt(typed.max_tokens, fallback.max_tokens, 300, 8000),
    max_minutes: asInt(typed.max_minutes, fallback.max_minutes, 1, 120)
  };
}

function normalizePlanStep(input: unknown, defaults: { index: number; sourceTarget: number; maxTokensPerStep: number }): ResearchPlanStep | null {
  if (!input || typeof input !== 'object') return null;
  const typed = input as Record<string, unknown>;
  const idx = asInt(typed.step_index, defaults.index, 0, STEP_SEQUENCE.length - 1);
  const rawStepType = typeof typed.step_type === 'string' ? typed.step_type : STEP_SEQUENCE[Math.min(idx, STEP_SEQUENCE.length - 1)];
  const stepType = STEP_SEQUENCE.includes(rawStepType as (typeof STEP_SEQUENCE)[number])
    ? (rawStepType as (typeof STEP_SEQUENCE)[number])
    : STEP_SEQUENCE[Math.min(idx, STEP_SEQUENCE.length - 1)];
  const queries = asTextArray(typed.search_query_pack, 18);
  const deliverables = asTextArray(typed.deliverables, 10);

  return {
    step_index: idx,
    step_type: stepType,
    title: typeof typed.title === 'string' && typed.title.trim() ? typed.title.trim() : stepType.replace(/_/g, ' '),
    objective:
      typeof typed.objective === 'string' && typed.objective.trim()
        ? typed.objective.trim()
        : `Execute ${stepType.toLowerCase().replace(/_/g, ' ')}`,
    target_source_types: asTextArray(typed.target_source_types, 8).filter(
      (kind): kind is (typeof SOURCE_TYPES)[number] => SOURCE_TYPES.includes(kind as (typeof SOURCE_TYPES)[number])
    ),
    search_query_pack: queries.length > 0 ? queries : [stepType.toLowerCase().replace(/_/g, ' ')],
    budgets: normalizeStepBudget(typed.budgets, {
      max_sources: defaults.sourceTarget,
      max_tokens: defaults.maxTokensPerStep,
      max_minutes: 15
    }),
    deliverables: deliverables.length > 0 ? deliverables : ['Step output with citations'],
    done_definition: asTextArray(typed.done_definition, 8)
  };
}

export const RESEARCH_PLAN_STEP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'step_index',
    'step_type',
    'title',
    'objective',
    'target_source_types',
    'search_query_pack',
    'budgets',
    'deliverables',
    'done_definition'
  ],
  properties: {
    step_index: { type: 'integer', minimum: 0, maximum: STEP_SEQUENCE.length - 1 },
    step_type: { type: 'string', enum: STEP_SEQUENCE },
    title: { type: 'string', minLength: 3, maxLength: 120 },
    objective: { type: 'string', minLength: 10, maxLength: 360 },
    target_source_types: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { type: 'string', enum: SOURCE_TYPES }
    },
    search_query_pack: {
      type: 'array',
      minItems: 1,
      maxItems: 18,
      items: { type: 'string', minLength: 3, maxLength: 220 }
    },
    budgets: {
      type: 'object',
      additionalProperties: false,
      required: ['max_sources', 'max_tokens', 'max_minutes'],
      properties: {
        max_sources: { type: 'integer', minimum: 1, maximum: 30 },
        max_tokens: { type: 'integer', minimum: 300, maximum: 8000 },
        max_minutes: { type: 'integer', minimum: 1, maximum: 120 }
      }
    },
    deliverables: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: { type: 'string', minLength: 5, maxLength: 240 }
    },
    done_definition: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { type: 'string', minLength: 5, maxLength: 200 }
    }
  }
};

export const RESEARCH_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'refined_topic', 'assumptions', 'total_budget', 'steps', 'deliverables'],
  properties: {
    version: { type: 'string', const: '1.0' },
    refined_topic: { type: 'string', minLength: 5, maxLength: 500 },
    assumptions: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string', minLength: 2, maxLength: 280 }
    },
    total_budget: {
      type: 'object',
      additionalProperties: false,
      required: ['max_steps', 'max_sources', 'max_tokens'],
      properties: {
        max_steps: { type: 'integer', minimum: 1, maximum: STEP_SEQUENCE.length },
        max_sources: { type: 'integer', minimum: 1, maximum: 400 },
        max_tokens: { type: 'integer', minimum: 300, maximum: 64000 }
      }
    },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: STEP_SEQUENCE.length,
      items: RESEARCH_PLAN_STEP_SCHEMA
    },
    deliverables: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: { type: 'string', minLength: 4, maxLength: 220 }
    }
  }
};

export function buildFallbackResearchPlan(input: {
  refinedTopic: string;
  sourceTarget: number;
  maxTokensPerStep: number;
  maxTotalSources?: number;
}): ResearchPlan {
  const steps: ResearchPlanStep[] = STEP_SEQUENCE.map((stepType, index) => ({
    step_index: index,
    step_type: stepType,
    title: stepType.replace(/_/g, ' '),
    objective: `Execute ${stepType.toLowerCase().replace(/_/g, ' ')}`,
    target_source_types: ['academic_journal', 'government', 'news'],
    search_query_pack: [
      input.refinedTopic,
      `${input.refinedTopic} ${stepType.toLowerCase().replace(/_/g, ' ')}`
    ],
    budgets: {
      max_sources: input.sourceTarget,
      max_tokens: input.maxTokensPerStep,
      max_minutes: 15
    },
    deliverables: ['Structured notes with citations'],
    done_definition: ['Output is evidence-backed and cites sources']
  }));

  return {
    version: '1.0',
    refined_topic: input.refinedTopic,
    assumptions: ['Default to global scope unless user constraints specify otherwise.'],
    total_budget: {
      max_steps: steps.length,
      max_sources: input.maxTotalSources ?? input.sourceTarget * steps.length,
      max_tokens: input.maxTokensPerStep * steps.length
    },
    steps,
    deliverables: ['Source-backed provider report', 'Explicit uncertainty and gap notes']
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    try {
      const parsed = JSON.parse(trimmed.slice(first, last + 1)) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}

export function parseResearchPlanFromText(
  text: string,
  input: {
    refinedTopic: string;
    sourceTarget: number;
    maxTokensPerStep: number;
    maxSteps: number;
    maxTotalSources?: number;
  }
): ResearchPlan | null {
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  return normalizeResearchPlan(parsed, input);
}

export function normalizeResearchPlan(
  plan: unknown,
  input: {
    refinedTopic: string;
    sourceTarget: number;
    maxTokensPerStep: number;
    maxSteps: number;
    maxTotalSources?: number;
  }
): ResearchPlan | null {
  if (!plan || typeof plan !== 'object') return null;
  const typed = plan as Record<string, unknown>;

  const rawSteps = Array.isArray(typed.steps) ? typed.steps : [];
  const desiredSteps = Math.max(1, Math.min(input.maxSteps, STEP_SEQUENCE.length));
  const normalizedSteps = rawSteps
    .slice(0, desiredSteps)
    .map((step, index) =>
      normalizePlanStep(step, {
        index,
        sourceTarget: input.sourceTarget,
        maxTokensPerStep: input.maxTokensPerStep
      })
    )
    .filter((step): step is ResearchPlanStep => Boolean(step));

  if (normalizedSteps.length === 0) {
    return null;
  }

  // Enforce strict ordering and uniqueness by step_index.
  const byIndex = new Map<number, ResearchPlanStep>();
  for (const step of normalizedSteps) {
    byIndex.set(step.step_index, step);
  }
  // Fill missing indices with canonical fallback stages so workflow remains complete and predictable.
  const fallbackSteps = buildFallbackResearchPlan({
    refinedTopic: input.refinedTopic,
    sourceTarget: input.sourceTarget,
    maxTokensPerStep: input.maxTokensPerStep,
    maxTotalSources: input.maxTotalSources
  }).steps;
  for (let index = 0; index < desiredSteps; index += 1) {
    if (!byIndex.has(index) && fallbackSteps[index]) {
      byIndex.set(index, fallbackSteps[index]);
    }
  }
  const ordered = [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, desiredSteps)
    .map(([index, step]) => ({ ...step, step_index: index }));

  const assumptions = asTextArray(typed.assumptions, 12);
  const deliverables = asTextArray(typed.deliverables, 12);
  const budget = typed.total_budget && typeof typed.total_budget === 'object' ? (typed.total_budget as Record<string, unknown>) : {};
  const maxSources = asInt(budget.max_sources, input.maxTotalSources ?? input.sourceTarget * ordered.length, 1, 400);
  const maxTokens = asInt(budget.max_tokens, input.maxTokensPerStep * ordered.length, 300, 64_000);

  return {
    version: '1.0',
    refined_topic: typeof typed.refined_topic === 'string' && typed.refined_topic.trim() ? typed.refined_topic.trim() : input.refinedTopic,
    assumptions,
    total_budget: {
      max_steps: ordered.length,
      max_sources: maxSources,
      max_tokens: maxTokens
    },
    steps: ordered,
    deliverables: deliverables.length > 0 ? deliverables : ['Source-backed provider report']
  };
}
