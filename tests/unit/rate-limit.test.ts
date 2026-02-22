// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../../app/lib/db', () => ({ query: (...args: any[]) => query(...args) }));

import { checkRateLimit, getRateLimitStatus } from '../../app/lib/rate-limit';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  query.mockReset();
});

describe('checkRateLimit', () => {
  it('inserts when under the limit', async () => {
    query.mockResolvedValueOnce([{ count: 0 }]);
    query.mockResolvedValueOnce([]);

    await checkRateLimit({ userId: 'u1', action: 'x', windowSeconds: 60, maxRequests: 2 });

    expect(query).toHaveBeenCalledTimes(2);
  });

  it('throws when at/over the limit', async () => {
    query.mockResolvedValueOnce([{ count: 2 }]);

    await expect(checkRateLimit({ userId: 'u1', action: 'x', windowSeconds: 60, maxRequests: 2 })).rejects.toThrow(
      /rate limit exceeded/i
    );

    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('getRateLimitStatus', () => {
  it('computes remaining and resetAt from oldest timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-22T00:00:00.000Z'));

    query.mockResolvedValueOnce([{ count: 3, oldest: '2026-02-21T23:59:00.000Z' }]);

    const status = await getRateLimitStatus({ userId: 'u1', action: 'x', windowSeconds: 120, maxRequests: 5 });

    expect(status.remaining).toBe(2);
    expect(status.limit).toBe(5);
    expect(status.windowSeconds).toBe(120);
    expect(status.resetAt).toBe(new Date('2026-02-22T00:01:00.000Z').toISOString());
  });
});

