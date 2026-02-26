// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseDeepResearchJobPayload } from '../../app/lib/deep-research-job';

describe('deep-research-job payload parser', () => {
  it('parses canonical payload shape', () => {
    const payload = parseDeepResearchJobPayload({
      topicId: 'topic-1',
      modelRunId: 'openai-run-1',
      provider: 'openai',
      attempt: 1,
      jobId: 'openai:openai-run-1:1',
      idempotencyKey: 'openai:openai-run-1:1'
    });

    expect(payload.provider).toBe('openai');
    expect(payload.attempt).toBe(1);
    expect(payload.idempotencyKey).toBe('openai:openai-run-1:1');
  });

  it('rejects invalid provider values', () => {
    expect(() =>
      parseDeepResearchJobPayload({
        topicId: 'topic-1',
        modelRunId: 'run-1',
        provider: 'anthropic',
        attempt: 1,
        idempotencyKey: 'anthropic:run-1:1'
      })
    ).toThrow(/provider/);
  });

  it('rejects malformed identifiers', () => {
    expect(() =>
      parseDeepResearchJobPayload({
        topicId: 'topic 1',
        modelRunId: 'run-1',
        provider: 'openai',
        attempt: 1,
        idempotencyKey: 'openai:run-1:1'
      })
    ).toThrow(/invalid format/);
  });
});
