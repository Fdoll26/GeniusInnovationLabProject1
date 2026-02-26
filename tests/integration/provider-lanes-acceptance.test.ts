// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import { parseDeepResearchJobPayload } from '../../app/lib/deep-research-job';
import {
  enqueueOpenAiLaneJob,
  OPENAI_LANE_QUEUE_NAME,
  OPENAI_LANE_WORKER_CONCURRENCY,
  __resetOpenAiLaneForTests
} from '../../app/lib/queue/openai';
import {
  enqueueGeminiLaneJob,
  GEMINI_LANE_QUEUE_NAME,
  GEMINI_LANE_WORKER_CONCURRENCY,
  __resetGeminiLaneForTests
} from '../../app/lib/queue/gemini';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Window = { provider: 'openai' | 'gemini'; topicId: string; startedAt: number; completedAt: number };

describe('provider lane queues acceptance', () => {
  beforeEach(() => {
    __resetOpenAiLaneForTests();
    __resetGeminiLaneForTests();
  });

  it('processes each lane sequentially (concurrency=1) while allowing lane parallelism', async () => {
    expect(OPENAI_LANE_QUEUE_NAME).not.toEqual(GEMINI_LANE_QUEUE_NAME);
    expect(OPENAI_LANE_WORKER_CONCURRENCY).toBe(1);
    expect(GEMINI_LANE_WORKER_CONCURRENCY).toBe(1);

    const topics = ['topic-1', 'topic-2', 'topic-3'];
    const windows: Window[] = [];
    let openAiActive = 0;
    let geminiActive = 0;
    let maxOpenAiActive = 0;
    let maxGeminiActive = 0;

    const openAiPromises = topics.map((topicId, idx) => {
      const job = parseDeepResearchJobPayload({
        topicId,
        provider: 'openai',
        modelRunId: `openai-run-${idx + 1}`,
        attempt: 1,
        jobId: `openai:openai-run-${idx + 1}:1`
      });
      return enqueueOpenAiLaneJob({
        job,
        task: async () => {
          openAiActive += 1;
          maxOpenAiActive = Math.max(maxOpenAiActive, openAiActive);
          const startedAt = Date.now();
          await sleep(50);
          const completedAt = Date.now();
          windows.push({ provider: 'openai', topicId, startedAt, completedAt });
          openAiActive -= 1;
          return { terminal: true };
        }
      });
    });

    const geminiPromises = topics.map((topicId, idx) => {
      const job = parseDeepResearchJobPayload({
        topicId,
        provider: 'gemini',
        modelRunId: `gemini-run-${idx + 1}`,
        attempt: 1,
        jobId: `gemini:gemini-run-${idx + 1}:1`
      });
      return enqueueGeminiLaneJob({
        job,
        task: async () => {
          geminiActive += 1;
          maxGeminiActive = Math.max(maxGeminiActive, geminiActive);
          const startedAt = Date.now();
          await sleep(50);
          const completedAt = Date.now();
          windows.push({ provider: 'gemini', topicId, startedAt, completedAt });
          geminiActive -= 1;
          return { terminal: true };
        }
      });
    });

    await Promise.all([...openAiPromises, ...geminiPromises]);

    expect(maxOpenAiActive).toBe(1);
    expect(maxGeminiActive).toBe(1);

    const openAiWindows = windows.filter((w) => w.provider === 'openai').sort((a, b) => a.startedAt - b.startedAt);
    const geminiWindows = windows.filter((w) => w.provider === 'gemini').sort((a, b) => a.startedAt - b.startedAt);
    expect(openAiWindows).toHaveLength(3);
    expect(geminiWindows).toHaveLength(3);

    for (let i = 1; i < openAiWindows.length; i += 1) {
      expect(openAiWindows[i]!.startedAt).toBeGreaterThanOrEqual(openAiWindows[i - 1]!.completedAt);
    }
    for (let i = 1; i < geminiWindows.length; i += 1) {
      expect(geminiWindows[i]!.startedAt).toBeGreaterThanOrEqual(geminiWindows[i - 1]!.completedAt);
    }

    const hasOverlap = openAiWindows.some((o) =>
      geminiWindows.some((g) => o.startedAt < g.completedAt && g.startedAt < o.completedAt)
    );
    expect(hasOverlap).toBe(true);
  });
});
