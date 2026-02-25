// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import { parseDeepResearchJobPayload } from '../../app/lib/deep-research-job';
import { enqueueOpenAiLaneJob, __resetOpenAiLaneForTests } from '../../app/lib/queue/openai';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('provider lane job idempotency', () => {
  beforeEach(() => {
    __resetOpenAiLaneForTests();
  });

  it('executes once when the same job is enqueued twice', async () => {
    const job = parseDeepResearchJobPayload({
      topicId: 'topic-1',
      provider: 'openai',
      modelRunId: 'run-1',
      attempt: 1,
      jobId: 'openai:run-1:1'
    });

    let executions = 0;
    const task = async () => {
      executions += 1;
      await sleep(20);
      return { terminal: true as const };
    };

    const [r1, r2] = await Promise.all([
      enqueueOpenAiLaneJob({ job, task }),
      enqueueOpenAiLaneJob({ job, task })
    ]);

    expect(r1.terminal).toBe(true);
    expect(r2.terminal).toBe(true);
    expect(executions).toBe(1);
  });
});
