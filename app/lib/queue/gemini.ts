import type { DeepResearchJobPayload } from '../deep-research-job';
import { createLaneQueue, type LaneTask, type LaneTaskResult } from './lane';

export const GEMINI_LANE_QUEUE_NAME = 'deep_research_queue_gemini_lane_v1';
export const GEMINI_LANE_WORKER_CONCURRENCY = 1;

const geminiLane = createLaneQueue({
  name: GEMINI_LANE_QUEUE_NAME,
  provider: 'gemini',
  concurrency: GEMINI_LANE_WORKER_CONCURRENCY
});

export function enqueueGeminiLaneJob(params: { job: DeepResearchJobPayload; task: LaneTask }): Promise<LaneTaskResult> {
  return geminiLane.enqueue(params);
}

export function __resetGeminiLaneForTests() {
  geminiLane.resetForTests();
}
