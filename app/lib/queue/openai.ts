import type { DeepResearchJobPayload } from '../deep-research-job';
import { createLaneQueue, type LaneTask, type LaneTaskResult } from './lane';

export const OPENAI_LANE_QUEUE_NAME = 'deep_research_queue_openai_lane_v1';
export const OPENAI_LANE_WORKER_CONCURRENCY = 1;

const openAiLane = createLaneQueue({
  name: OPENAI_LANE_QUEUE_NAME,
  provider: 'openai',
  concurrency: OPENAI_LANE_WORKER_CONCURRENCY
});

export function enqueueOpenAiLaneJob(params: { job: DeepResearchJobPayload; task: LaneTask }): Promise<LaneTaskResult> {
  return openAiLane.enqueue(params);
}

export function __resetOpenAiLaneForTests() {
  openAiLane.resetForTests();
}
