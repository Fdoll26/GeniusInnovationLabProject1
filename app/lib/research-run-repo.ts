import { query } from './db';
import type {
  ResearchDepth,
  ResearchEvidence,
  ResearchMode,
  ResearchPlan,
  ResearchProviderName,
  ResearchStepArtifact,
  ResearchWorkflowState,
  StepStatus,
  StepType
} from './research-types';

export type ResearchRunRecord = {
  id: string;
  session_id: string;
  attempt: number;
  state: ResearchWorkflowState;
  provider: ResearchProviderName;
  mode: ResearchMode;
  depth: ResearchDepth;
  question: string;
  clarifying_questions_json: unknown | null;
  assumptions_json: unknown | null;
  clarifications_json: unknown | null;
  research_brief_json: unknown | null;
  research_plan_json: unknown | null;
  progress_json: unknown | null;
  current_step_index: number;
  max_steps: number;
  target_sources_per_step: number;
  max_total_sources: number;
  max_tokens_per_step: number;
  min_word_count: number;
  synthesized_report_md: string | null;
  synthesized_sources_json: unknown | null;
  synthesized_citation_map_json: unknown | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type ResearchStepRecord = {
  id: string;
  run_id: string;
  step_index: number;
  step_type: StepType;
  status: StepStatus;
  provider: ResearchProviderName;
  model: string | null;
  mode: ResearchMode;
  step_goal: string | null;
  inputs_summary: string | null;
  tools_used: unknown | null;
  raw_output: string | null;
  output_excerpt: string | null;
  sources_json: unknown | null;
  evidence_json: unknown | null;
  citation_map_json: unknown | null;
  next_step_proposal: string | null;
  token_usage_json: unknown | null;
  provider_native_json: unknown | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ResearchCitationRecord = {
  source_id: string;
  url: string;
  title: string | null;
  publisher: string | null;
  accessed_at: string;
  reliability_tags_json: unknown | null;
  metadata_json: unknown | null;
};

function jsonOrNull(value: unknown) {
  return value == null ? null : JSON.stringify(value);
}

function normalizeStepStatusFromDb(status: string): StepStatus {
  if (status === 'pending') return 'queued';
  if (status === 'completed') return 'done';
  return status as StepStatus;
}

function legacyStepStatus(status: StepStatus): string {
  if (status === 'planned') return 'pending';
  if (status === 'queued') return 'pending';
  if (status === 'done') return 'completed';
  return status;
}

function normalizeStepRecordStatus(row: ResearchStepRecord): ResearchStepRecord {
  return { ...row, status: normalizeStepStatusFromDb(String(row.status)) };
}

export async function createResearchRun(params: {
  sessionId: string;
  provider: ResearchProviderName;
  mode: ResearchMode;
  depth: ResearchDepth;
  question: string;
  maxSteps: number;
  targetSourcesPerStep: number;
  maxTotalSources: number;
  maxTokensPerStep: number;
  minWordCount: number;
}): Promise<ResearchRunRecord> {
  const values = [
    params.sessionId,
    params.provider,
    params.mode,
    params.depth,
    params.question,
    params.maxSteps,
    params.targetSourcesPerStep,
    params.maxTotalSources,
    params.maxTokensPerStep,
    params.minWordCount
  ];
  for (let i = 0; i < 3; i += 1) {
    try {
      const rows = await query<ResearchRunRecord>(
        `INSERT INTO research_runs
          (session_id, attempt, provider, mode, depth, question, max_steps, target_sources_per_step, max_total_sources, max_tokens_per_step, min_word_count)
         SELECT
          $1,
          COALESCE(MAX(attempt), 0) + 1,
          $2,$3,$4,$5,$6,$7,$8,$9,$10
         FROM research_runs
         WHERE session_id = $1
           AND provider = $2
         RETURNING *`,
        values
      );
      return rows[0];
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
      if (code === '23505') {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Failed to create research run for session ${params.sessionId} provider ${params.provider}`);
}

export async function getLatestResearchRunBySessionId(sessionId: string): Promise<ResearchRunRecord | null> {
  const rows = await query<ResearchRunRecord>(
    `SELECT *
     FROM research_runs
     WHERE session_id = $1
     ORDER BY attempt DESC, created_at DESC
     LIMIT 1`,
    [sessionId]
  );
  return rows[0] ?? null;
}

export async function listResearchRunsBySessionId(sessionId: string): Promise<ResearchRunRecord[]> {
  return query<ResearchRunRecord>(
    `SELECT *
     FROM research_runs
     WHERE session_id = $1
     ORDER BY provider ASC, attempt DESC, created_at DESC`,
    [sessionId]
  );
}

export async function getLatestResearchRunBySessionProvider(
  sessionId: string,
  provider: ResearchProviderName
): Promise<ResearchRunRecord | null> {
  const rows = await query<ResearchRunRecord>(
    `SELECT *
     FROM research_runs
     WHERE session_id = $1 AND provider = $2
     ORDER BY attempt DESC, created_at DESC
     LIMIT 1`,
    [sessionId, provider]
  );
  return rows[0] ?? null;
}

export async function getResearchRunById(runId: string): Promise<ResearchRunRecord | null> {
  const rows = await query<ResearchRunRecord>('SELECT * FROM research_runs WHERE id = $1', [runId]);
  return rows[0] ?? null;
}

export async function markResearchRunQueued(runId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE research_runs
     SET state = 'PLANNED',
         updated_at = now()
     WHERE id = $1
       AND state NOT IN ('DONE', 'FAILED')
     RETURNING id`,
    [runId]
  );
  return rows.length > 0;
}

export async function claimQueuedResearchRun(runId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE research_runs
     SET state = 'IN_PROGRESS',
         updated_at = now()
     WHERE id = $1
       AND state = 'PLANNED'
     RETURNING id`,
    [runId]
  );
  return rows.length > 0;
}

export async function updateResearchRun(params: {
  runId: string;
  state?: ResearchWorkflowState;
  currentStepIndex?: number;
  clarifyingQuestions?: string[] | null;
  assumptions?: string[] | null;
  clarifications?: Array<{ question: string; answer: string }> | null;
  brief?: Record<string, unknown> | null;
  plan?: ResearchPlan | null;
  progress?: unknown | null;
  synthesizedReportMd?: string | null;
  synthesizedSources?: Array<Record<string, unknown>> | null;
  synthesizedCitationMap?: Array<Record<string, unknown>> | null;
  errorMessage?: string | null;
  completed?: boolean;
}) {
  await query(
    `UPDATE research_runs
     SET state = COALESCE($2, state),
         current_step_index = COALESCE($3, current_step_index),
         clarifying_questions_json = COALESCE($4, clarifying_questions_json),
         assumptions_json = COALESCE($5, assumptions_json),
         clarifications_json = COALESCE($6, clarifications_json),
         research_brief_json = COALESCE($7, research_brief_json),
         research_plan_json = COALESCE($8, research_plan_json),
         progress_json = CASE
           WHEN $9::jsonb IS NULL THEN progress_json
           WHEN progress_json IS NULL THEN $9::jsonb
           WHEN jsonb_typeof(progress_json) = 'object' AND jsonb_typeof($9::jsonb) = 'object'
             THEN progress_json || $9::jsonb
           ELSE $9::jsonb
         END,
         synthesized_report_md = COALESCE($10, synthesized_report_md),
         synthesized_sources_json = COALESCE($11, synthesized_sources_json),
         synthesized_citation_map_json = COALESCE($12, synthesized_citation_map_json),
         error_message = COALESCE($13, error_message),
         completed_at = CASE WHEN $14::boolean THEN now() ELSE completed_at END,
         updated_at = now()
     WHERE id = $1`,
    [
      params.runId,
      params.state ?? null,
      params.currentStepIndex ?? null,
      jsonOrNull(params.clarifyingQuestions),
      jsonOrNull(params.assumptions),
      jsonOrNull(params.clarifications),
      jsonOrNull(params.brief),
      jsonOrNull(params.plan),
      jsonOrNull(params.progress),
      params.synthesizedReportMd ?? null,
      jsonOrNull(params.synthesizedSources),
      jsonOrNull(params.synthesizedCitationMap),
      params.errorMessage ?? null,
      params.completed ?? false
    ]
  );
}

export async function upsertResearchStep(params: {
  runId: string;
  stepIndex: number;
  stepType: StepType;
  status: StepStatus;
  provider: ResearchProviderName;
  mode: ResearchMode;
  model?: string | null;
  stepGoal?: string | null;
  inputsSummary?: string | null;
  toolsUsed?: string[] | null;
  rawOutput?: string | null;
  outputExcerpt?: string | null;
  sources?: Array<Record<string, unknown>> | null;
  evidence?: Array<Record<string, unknown>> | null;
  citationMap?: Array<Record<string, unknown>> | null;
  nextStepProposal?: string | null;
  tokenUsage?: Record<string, unknown> | null;
  providerNative?: Record<string, unknown> | null;
  errorMessage?: string | null;
  started?: boolean;
  startedAt?: string | null;
  completed?: boolean;
}): Promise<ResearchStepRecord> {
  const statusValue = params.status === 'planned' ? 'queued' : params.status;
  const sql = `INSERT INTO research_steps (
       run_id, step_index, step_type, status, provider, model, mode, step_goal, inputs_summary, tools_used,
       raw_output, output_excerpt, sources_json, evidence_json, citation_map_json, next_step_proposal, token_usage_json,
       provider_native_json, error_message, started_at, completed_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
       $11,$12,$13,$14,$15,$16,$17,
       $18,$19, COALESCE($20::timestamptz, CASE WHEN $21::boolean THEN now() ELSE NULL END), CASE WHEN $22::boolean THEN now() ELSE NULL END, now()
     )
     ON CONFLICT (run_id, step_index)
     DO UPDATE SET
       step_type = EXCLUDED.step_type,
       status = EXCLUDED.status,
       provider = EXCLUDED.provider,
       model = COALESCE(EXCLUDED.model, research_steps.model),
       mode = EXCLUDED.mode,
       step_goal = COALESCE(EXCLUDED.step_goal, research_steps.step_goal),
       inputs_summary = COALESCE(EXCLUDED.inputs_summary, research_steps.inputs_summary),
       tools_used = COALESCE(EXCLUDED.tools_used, research_steps.tools_used),
       raw_output = COALESCE(EXCLUDED.raw_output, research_steps.raw_output),
       output_excerpt = COALESCE(EXCLUDED.output_excerpt, research_steps.output_excerpt),
       sources_json = COALESCE(EXCLUDED.sources_json, research_steps.sources_json),
       evidence_json = COALESCE(EXCLUDED.evidence_json, research_steps.evidence_json),
       citation_map_json = COALESCE(EXCLUDED.citation_map_json, research_steps.citation_map_json),
       next_step_proposal = COALESCE(EXCLUDED.next_step_proposal, research_steps.next_step_proposal),
       token_usage_json = COALESCE(EXCLUDED.token_usage_json, research_steps.token_usage_json),
       provider_native_json = COALESCE(EXCLUDED.provider_native_json, research_steps.provider_native_json),
       error_message = COALESCE(EXCLUDED.error_message, research_steps.error_message),
       started_at = COALESCE(research_steps.started_at, EXCLUDED.started_at, CASE WHEN $21::boolean THEN now() ELSE NULL END),
       completed_at = CASE
         WHEN $22::boolean THEN now()
         ELSE research_steps.completed_at
       END,
       updated_at = now()
     RETURNING *`;
  const values = [
    params.runId,
    params.stepIndex,
    params.stepType,
    statusValue,
    params.provider,
    params.model ?? null,
    params.mode,
    params.stepGoal ?? null,
    params.inputsSummary ?? null,
    jsonOrNull(params.toolsUsed),
    params.rawOutput ?? null,
    params.outputExcerpt ?? null,
    jsonOrNull(params.sources),
    jsonOrNull(params.evidence),
    jsonOrNull(params.citationMap),
    params.nextStepProposal ?? null,
    jsonOrNull(params.tokenUsage),
    jsonOrNull(params.providerNative),
    params.errorMessage ?? null,
    params.startedAt ?? null,
    params.started ?? false,
    params.completed ?? false
  ];
  try {
    const rows = await query<ResearchStepRecord>(
      sql,
      values
    );
    return normalizeStepRecordStatus(rows[0]);
  } catch (error) {
    const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (!msg.includes('research_steps_status_check')) {
      throw error;
    }
    const legacyValues = [...values];
    legacyValues[3] = legacyStepStatus(statusValue as StepStatus);
    const rows = await query<ResearchStepRecord>(
      sql,
      legacyValues
    );
    return normalizeStepRecordStatus(rows[0]);
  }
}

export async function initializePlannedResearchSteps(params: {
  runId: string;
  provider: ResearchProviderName;
  mode: ResearchMode;
  steps: Array<{
    stepIndex: number;
    stepType: StepType;
    stepGoal?: string | null;
    inputsSummary?: string | null;
  }>;
}) {
  for (const step of params.steps) {
    await upsertResearchStep({
      runId: params.runId,
      stepIndex: step.stepIndex,
      stepType: step.stepType,
      status: 'planned',
      provider: params.provider,
      mode: params.mode,
      stepGoal: step.stepGoal ?? null,
      inputsSummary: step.inputsSummary ?? null
    });
  }
}

export async function listResearchSteps(runId: string): Promise<ResearchStepRecord[]> {
  const rows = await query<ResearchStepRecord>(
    `SELECT *
     FROM research_steps
     WHERE run_id = $1
     ORDER BY step_index ASC, created_at ASC`,
    [runId]
  );
  return rows.map((row) => normalizeStepRecordStatus(row));
}

export async function upsertResearchSource(params: {
  runId: string;
  stepId?: string | null;
  source: ResearchStepArtifact['citations'][number];
}) {
  await query(
    `INSERT INTO research_sources (
       run_id, step_id, source_id, url, title, publisher, accessed_at, source_type, reliability_tags_json, metadata_json, updated_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (run_id, source_id)
     DO UPDATE SET
       step_id = COALESCE(EXCLUDED.step_id, research_sources.step_id),
       url = EXCLUDED.url,
       title = COALESCE(EXCLUDED.title, research_sources.title),
       publisher = COALESCE(EXCLUDED.publisher, research_sources.publisher),
       accessed_at = COALESCE(EXCLUDED.accessed_at, research_sources.accessed_at),
       source_type = COALESCE(EXCLUDED.source_type, research_sources.source_type),
       reliability_tags_json = COALESCE(EXCLUDED.reliability_tags_json, research_sources.reliability_tags_json),
       metadata_json = COALESCE(EXCLUDED.metadata_json, research_sources.metadata_json),
       updated_at = now()`,
    [
      params.runId,
      params.stepId ?? null,
      params.source.citation_id,
      params.source.url,
      params.source.title ?? null,
      params.source.publisher ?? null,
      params.source.accessed_at,
      'web',
      jsonOrNull(params.source.reliability_tags ?? ['unknown']),
      jsonOrNull(params.source.provider_metadata ?? null)
    ]
  );
}

export async function listResearchSources(runId: string): Promise<ResearchStepArtifact['citations']> {
  const rows = await query<ResearchCitationRecord>(
    `SELECT source_id, url, title, publisher, accessed_at, reliability_tags_json, metadata_json
     FROM research_sources
     WHERE run_id = $1
     ORDER BY created_at ASC`,
    [runId]
  );
  return rows.map((row) => ({
    citation_id: row.source_id,
    url: row.url,
    title: row.title,
    publisher: row.publisher,
    accessed_at: row.accessed_at,
    provider_metadata: row.metadata_json as Record<string, unknown> | null,
    reliability_tags: Array.isArray(row.reliability_tags_json) ? (row.reliability_tags_json as any) : ['unknown']
  }));
}

export async function upsertResearchEvidence(params: {
  runId: string;
  stepId?: string | null;
  evidence: ResearchEvidence;
}) {
  await query(
    `INSERT INTO research_evidence (
       run_id, step_id, evidence_id, claim, supporting_snippets_json, source_ids_json, confidence, notes, citation_anchor, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (run_id, evidence_id)
     DO UPDATE SET
       step_id = COALESCE(EXCLUDED.step_id, research_evidence.step_id),
       claim = EXCLUDED.claim,
       supporting_snippets_json = COALESCE(EXCLUDED.supporting_snippets_json, research_evidence.supporting_snippets_json),
       source_ids_json = COALESCE(EXCLUDED.source_ids_json, research_evidence.source_ids_json),
       confidence = COALESCE(EXCLUDED.confidence, research_evidence.confidence),
       notes = COALESCE(EXCLUDED.notes, research_evidence.notes),
       citation_anchor = COALESCE(EXCLUDED.citation_anchor, research_evidence.citation_anchor),
       updated_at = now()`,
    [
      params.runId,
      params.stepId ?? null,
      params.evidence.evidence_id,
      params.evidence.claim,
      jsonOrNull([params.evidence.supporting_snippet]),
      jsonOrNull(params.evidence.source_citation_ids),
      params.evidence.confidence === 'high' ? 0.9 : params.evidence.confidence === 'med' ? 0.65 : 0.35,
      params.evidence.notes ?? null,
      params.evidence.evidence_id
    ]
  );
}

export async function listResearchEvidence(runId: string): Promise<ResearchEvidence[]> {
  const rows = await query<{
    evidence_id: string;
    claim: string;
    supporting_snippets_json: unknown | null;
    source_ids_json: unknown | null;
    confidence: string | number | null;
    notes: string | null;
  }>(
    `SELECT evidence_id, claim, supporting_snippets_json, source_ids_json, confidence, notes
     FROM research_evidence
     WHERE run_id = $1
     ORDER BY created_at ASC`,
    [runId]
  );
  return rows.map((row) => {
    const conf = row.confidence == null ? 0.5 : Number(row.confidence);
    return {
      evidence_id: row.evidence_id,
      claim: row.claim,
      supporting_snippet: Array.isArray(row.supporting_snippets_json)
        ? String(row.supporting_snippets_json[0] ?? '')
        : '',
      source_citation_ids: Array.isArray(row.source_ids_json) ? (row.source_ids_json as string[]) : [],
      confidence: conf >= 0.8 ? 'high' : conf >= 0.55 ? 'med' : 'low',
      notes: row.notes
    };
  });
}

export async function appendCitationMappings(params: {
  runId: string;
  stepId?: string | null;
  citationMap: Array<{ claim_anchor: string; section_name?: string | null; source_ids: string[] }>;
}) {
  for (const citation of params.citationMap) {
    await query(
      `INSERT INTO research_citations (run_id, step_id, claim_anchor, section_name, source_ids_json)
       VALUES ($1,$2,$3,$4,$5)`,
      [params.runId, params.stepId ?? null, citation.claim_anchor, citation.section_name ?? null, jsonOrNull(citation.source_ids)]
    );
  }
}

export async function listCitationMappings(runId: string): Promise<Array<{ claim_anchor: string; section_name?: string | null; source_ids: string[] }>> {
  const rows = await query<{
    claim_anchor: string;
    section_name: string | null;
    source_ids_json: unknown;
  }>(
    `SELECT claim_anchor, section_name, source_ids_json
     FROM research_citations
     WHERE run_id = $1
     ORDER BY created_at ASC`,
    [runId]
  );
  return rows.map((row) => ({
    claim_anchor: row.claim_anchor,
    section_name: row.section_name,
    source_ids: Array.isArray(row.source_ids_json) ? (row.source_ids_json as string[]) : []
  }));
}
