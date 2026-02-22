// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/authz', () => ({
  requireSession: vi.fn(async () => ({ user: { email: 'user@example.com' } }))
}));
vi.mock('../../app/lib/session-repo', () => ({
  getUserIdByEmail: vi.fn(async () => 'user-id'),
  assertSessionOwnership: vi.fn(async () => undefined),
  getSessionById: vi.fn(async () => ({
    state: 'refining',
    updated_at: 'now',
    refined_at: null,
    completed_at: null
  }))
}));
vi.mock('../../app/lib/provider-repo', () => ({
  listProviderResults: vi.fn(async () => [])
}));

import { GET } from '../../app/api/research/sessions/[sessionId]/[action]/route';

describe('GET /api/research/sessions/:id/status', () => {
  it('returns status', async () => {
    const response = await GET(new Request('http://localhost'), { params: { sessionId: 's1', action: 'status' } });
    expect(response.status).toBe(200);
  });
});
