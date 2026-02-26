import type { DeepResearchJobPayload } from '../deep-research-job';
import type { ResearchProviderName } from '../research-types';

export type LaneTaskResult = { terminal: boolean };
export type LaneTask = () => Promise<LaneTaskResult>;

type LaneQueueEntry = {
  job: DeepResearchJobPayload;
  task: LaneTask;
  resolve: (value: LaneTaskResult) => void;
  reject: (error: unknown) => void;
};

export function createLaneQueue(params: {
  name: string;
  provider: ResearchProviderName;
  concurrency: number;
}) {
  const { name, provider, concurrency } = params;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Invalid lane concurrency for ${name}: ${concurrency}`);
  }

  const queue: LaneQueueEntry[] = [];
  const pendingByJobId = new Map<string, Promise<LaneTaskResult>>();
  let activeWorkers = 0;

  const drain = () => {
    while (activeWorkers < concurrency && queue.length > 0) {
      const entry = queue.shift();
      if (!entry) {
        continue;
      }
      activeWorkers += 1;
      void (async () => {
        try {
          const result = await entry.task();
          entry.resolve(result);
        } catch (error) {
          entry.reject(error);
        } finally {
          activeWorkers -= 1;
          pendingByJobId.delete(entry.job.idempotencyKey || entry.job.jobId);
          drain();
        }
      })();
    }
  };

  return {
    name,
    provider,
    concurrency,
    enqueue(params: { job: DeepResearchJobPayload; task: LaneTask }): Promise<LaneTaskResult> {
      const { job, task } = params;
      if (job.provider !== provider) {
        throw new Error(`Lane ${name} rejected provider ${job.provider}; expected ${provider}`);
      }

      const key = job.idempotencyKey || job.jobId;
      const existing = pendingByJobId.get(key);
      if (existing) {
        return existing;
      }

      const promise = new Promise<LaneTaskResult>((resolve, reject) => {
        queue.push({ job, task, resolve, reject });
        drain();
      });
      pendingByJobId.set(key, promise);
      return promise;
    },
    resetForTests() {
      queue.length = 0;
      pendingByJobId.clear();
      activeWorkers = 0;
    }
  };
}
