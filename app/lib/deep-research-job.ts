import type { ResearchProviderName } from './research-types';

export type DeepResearchJobPayload = {
  topicId: string;
  modelRunId: string;
  provider: ResearchProviderName;
  attempt: number;
  jobId: string;
};

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
  return value.trim();
}

export function parseDeepResearchJobPayload(raw: unknown): DeepResearchJobPayload {
  const record = asRecord(raw);
  const topicId = requireNonEmptyString(record, 'topicId');
  const modelRunId = requireNonEmptyString(record, 'modelRunId');
  const providerRaw = requireNonEmptyString(record, 'provider');
  if (providerRaw !== 'openai' && providerRaw !== 'gemini') {
    throw new Error('Deep research job payload "provider" must be "openai" or "gemini"');
  }
  const jobId = requireNonEmptyString(record, 'jobId');
  const attemptValue = record.attempt;
  if (!Number.isInteger(attemptValue) || Number(attemptValue) < 1) {
    throw new Error('Deep research job payload "attempt" must be a positive integer');
  }

  return {
    topicId,
    modelRunId,
    provider: providerRaw,
    attempt: Number(attemptValue),
    jobId
  };
}
