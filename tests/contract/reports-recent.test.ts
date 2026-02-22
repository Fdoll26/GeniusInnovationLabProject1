// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const requireSession = vi.fn();
vi.mock('../../app/lib/authz', () => ({ requireSession: (...args: any[]) => requireSession(...args) }));

const getUserIdByEmail = vi.fn();
vi.mock('../../app/lib/session-repo', () => ({ getUserIdByEmail: (...args: any[]) => getUserIdByEmail(...args) }));

const listRecentSentReports = vi.fn();
vi.mock('../../app/lib/report-repo', () => ({ listRecentSentReports: (...args: any[]) => listRecentSentReports(...args) }));

import { GET } from '../../app/api/reports/[action]/route';

describe('GET /api/reports/:action', () => {
  it('returns 404 for unknown actions without auth', async () => {
    const res = await GET(new Request('http://localhost/api/reports/nope'), { params: Promise.resolve({ action: 'nope' }) });
    expect(res.status).toBe(404);
    expect(requireSession).not.toHaveBeenCalled();
  });

  it('returns recent reports', async () => {
    requireSession.mockResolvedValueOnce({ user: { email: 'user@example.com' } });
    getUserIdByEmail.mockResolvedValueOnce('user-id');
    listRecentSentReports.mockResolvedValueOnce([{ id: 'r1' }]);

    const res = await GET(new Request('http://localhost/api/reports/recent'), {
      params: Promise.resolve({ action: 'recent' })
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'r1' }]);
  });
});

