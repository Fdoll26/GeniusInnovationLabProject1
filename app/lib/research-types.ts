export type ResearchWorkflowState =
  | 'NEW'
  | 'NEEDS_CLARIFICATION'
  | 'PLANNED'
  | 'IN_PROGRESS'
  | 'SYNTHESIS'
  | 'DONE'
  | 'FAILED';

export type ResearchProviderName = 'openai' | 'gemini';
export type ResearchMode = 'native' | 'custom';
export type ResearchDepth = 'light' | 'standard' | 'deep';

export const STEP_SEQUENCE = [
  'DEVELOP_RESEARCH_PLAN',
  'DISCOVER_SOURCES_WITH_PLAN',
  'SHORTLIST_RESULTS',
  'DEEP_READ',
  'EXTRACT_EVIDENCE',
  'COUNTERPOINTS',
  'GAP_CHECK',
  'SECTION_SYNTHESIS'
] as const;

export type StepType = (typeof STEP_SEQUENCE)[number] | 'NATIVE_SECTION';

export const STEP_LABELS: Record<(typeof STEP_SEQUENCE)[number], string> = {
  DEVELOP_RESEARCH_PLAN: 'Develop Research Plan',
  DISCOVER_SOURCES_WITH_PLAN: 'Discover Sources',
  SHORTLIST_RESULTS: 'Shortlist Results',
  DEEP_READ: 'Deep Read',
  EXTRACT_EVIDENCE: 'Extract Evidence',
  COUNTERPOINTS: 'Counterpoints',
  GAP_CHECK: 'Gap Check',
  SECTION_SYNTHESIS: 'Section Synthesis'
};

export type StepStatus = 'planned' | 'queued' | 'running' | 'done' | 'failed';

export type TokenUsage = {
  prompt?: number | null;
  output?: number | null;
  reasoning?: number | null;
  total?: number | null;
};

export type ReliabilityTag =
  | 'primary'
  | 'peer_reviewed'
  | 'gov'
  | 'press'
  | 'blog'
  | 'unknown';

export type ResearchCitation = {
  citation_id: string;
  url: string;
  title?: string | null;
  publisher?: string | null;
  accessed_at: string;
  provider_metadata?: Record<string, unknown> | null;
  reliability_tags?: ReliabilityTag[];
};

export type EvidenceConfidence = 'low' | 'med' | 'high';

export type ResearchEvidence = {
  evidence_id: string;
  claim: string;
  supporting_snippet: string;
  source_citation_ids: string[];
  confidence: EvidenceConfidence;
  notes?: string | null;
};

export type ResearchStepArtifact = {
  step_goal: string;
  inputs_summary: string;
  raw_output_text: string;
  output_text_with_refs?: string;
  references?: Array<{ n: number; url: string; title?: string | null }>;
  citations: ResearchCitation[];
  consulted_sources?: Array<{ url: string; title?: string | null }>;
  provider_native_output?: string | null;
  provider_native_citation_metadata?: unknown;
  evidence: ResearchEvidence[];
  tools_used?: string[];
  token_usage?: TokenUsage | null;
  model_used?: string | null;
  next_step_hint?: string | null;
  structured_output?: Record<string, unknown> | null;
};

export type ResearchPlanSection = {
  section: string;
  objectives: string[];
  query_pack: string[];
  acceptance_criteria: string[];
};

export type ResearchPlanSourceType =
  | 'academic_journal'
  | 'government'
  | 'industry_report'
  | 'news'
  | 'company_filing'
  | 'dataset'
  | 'reference'
  | 'expert_analysis';

export type ResearchPlanStepBudget = {
  max_sources: number;
  max_tokens: number;
  max_minutes: number;
};

export type ResearchPlanStep = {
  step_index: number;
  step_type: (typeof STEP_SEQUENCE)[number];
  title: string;
  objective: string;
  target_source_types: ResearchPlanSourceType[];
  search_query_pack: string[];
  budgets: ResearchPlanStepBudget;
  deliverables: string[];
  done_definition: string[];
};

export type ResearchPlan = {
  version: '1.0';
  refined_topic: string;
  assumptions: string[];
  total_budget: {
    max_steps: number;
    max_sources: number;
    max_tokens: number;
  };
  steps: ResearchPlanStep[];
  deliverables: string[];
};

export type PipelineProgress = {
  step_id: (typeof STEP_SEQUENCE)[number] | null;
  step_index: number;
  total_steps: number;
  step_label: string | null;
};
