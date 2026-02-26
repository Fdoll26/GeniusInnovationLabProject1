import type { ResearchProviderName } from './research-types';

export type DeepResearchJobPayload = {
  topicId: string;
  modelRunId: string;
  provider: ResearchProviderName;
  attempt: number;
  jobId: string;
  idempotencyKey: string;
};

const SAFE_ID_PATTERN = /^\S{1,200}$/;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Deep research job payload must be an object');
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(record: Record<string, unknown>, field: keyof DeepResearchJobPayload): string {
  const value = record[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Deep research job payload "${String(field)}" must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (!SAFE_ID_PATTERN.test(trimmed)) {
    throw new Error(`Deep research job payload "${String(field)}" has invalid format`);
  }
  return trimmed;
}

export function parseDeepResearchJobPayload(raw: unknown): DeepResearchJobPayload {
  const record = asRecord(raw);
  const topicId = requireNonEmptyString(record, 'topicId');
  const modelRunId = requireNonEmptyString(record, 'modelRunId');
  const providerRaw = requireNonEmptyString(record, 'provider');
  if (providerRaw !== 'openai' && providerRaw !== 'gemini') {
    throw new Error('Deep research job payload "provider" must be "openai" or "gemini"');
  }
  const jobIdRaw = typeof record.jobId === 'string' ? record.jobId.trim() : '';
  const idempotencyRaw = typeof record.idempotencyKey === 'string' ? record.idempotencyKey.trim() : '';
  const idempotencyKey = idempotencyRaw || jobIdRaw;
  if (!idempotencyKey) {
    throw new Error('Deep research job payload requires non-empty "jobId" or "idempotencyKey"');
  }
  if (!SAFE_ID_PATTERN.test(idempotencyKey)) {
    throw new Error('Deep research job payload "idempotencyKey" has invalid format');
  }
  if (jobIdRaw && !SAFE_ID_PATTERN.test(jobIdRaw)) {
    throw new Error('Deep research job payload "jobId" has invalid format');
  }
  const attemptValue = record.attempt;
  if (!Number.isInteger(attemptValue) || Number(attemptValue) < 1) {
    throw new Error('Deep research job payload "attempt" must be a positive integer');
  }

  return {
    topicId,
    modelRunId,
    provider: providerRaw,
    attempt: Number(attemptValue),
    jobId: jobIdRaw || idempotencyKey,
    idempotencyKey
  };
}
