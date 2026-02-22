// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/authz', () => ({
  requireSession: vi.fn(async () => ({ user: { email: 'user@example.com' } }))
}));
vi.mock('../../app/lib/session-repo', () => ({
  getUserIdByEmail: vi.fn(async () => 'user-id'),
  createSession: vi.fn(async () => ({ id: 'session-id' }))
}));
vi.mock('../../app/lib/orchestration', () => ({
  runRefinement: vi.fn(async () => undefined)
}));
vi.mock('../../app/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => undefined)
}));

import { POST } from '../../app/api/research/sessions/route';

describe('POST /api/research/sessions', () => {
  it('creates a session', async () => {
    const request = new Request('http://localhost/api/research/sessions', {
      method: 'POST',
      body: JSON.stringify({ topic: 'Test topic' }),
      headers: { 'Content-Type': 'application/json' }
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
  });
});
