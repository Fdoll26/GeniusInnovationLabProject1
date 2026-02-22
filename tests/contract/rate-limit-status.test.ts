// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/authz', () => ({
  requireSession: vi.fn(async () => ({ user: { email: 'user@example.com' } }))
}));
vi.mock('../../app/lib/session-repo', () => ({
  getUserIdByEmail: vi.fn(async () => 'user-id')
}));

const getRateLimitStatus = vi.fn();
vi.mock('../../app/lib/rate-limit', () => ({ getRateLimitStatus: (...args: any[]) => getRateLimitStatus(...args) }));

import { GET } from '../../app/api/rate-limit/route';

describe('GET /api/rate-limit', () => {
  it('uses create_session overrides by default', async () => {
    getRateLimitStatus.mockResolvedValueOnce({ remaining: 5, limit: 5, resetAt: 'x', windowSeconds: 3600 });

    const res = await GET(new Request('http://localhost/api/rate-limit'));
    expect(res.status).toBe(200);
    expect(getRateLimitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-id',
        action: 'create_session',
        windowSeconds: 3600,
        maxRequests: 5
      })
    );
  });

  it('does not apply overrides for other actions', async () => {
    getRateLimitStatus.mockResolvedValueOnce({ remaining: 1, limit: 10, resetAt: 'x', windowSeconds: 60 });

    const res = await GET(new Request('http://localhost/api/rate-limit?action=approve_prompt'));
    expect(res.status).toBe(200);
    expect(getRateLimitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-id',
        action: 'approve_prompt',
        windowSeconds: undefined,
        maxRequests: undefined
      })
    );
  });
});

