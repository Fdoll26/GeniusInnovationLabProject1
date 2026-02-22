// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/authz', () => ({
  requireSession: vi.fn(async () => ({ user: { email: 'user@example.com' } }))
}));
vi.mock('../../app/lib/session-repo', () => ({
  getUserIdByEmail: vi.fn(async () => 'user-id'),
  assertSessionOwnership: vi.fn(async () => undefined),
  getSessionById: vi.fn(async () => ({ id: 's1', topic: 'Topic', refined_prompt: null })),
  updateSessionState: vi.fn(async () => undefined)
}));
vi.mock('../../app/lib/refinement-repo', () => ({
  answerQuestion: vi.fn(async () => undefined),
  getNextQuestion: vi.fn(async () => null),
  listQuestions: vi.fn(async () => [])
}));
vi.mock('../../app/lib/openai-client', () => ({
  rewritePrompt: vi.fn(async () => 'Refined prompt')
}));
vi.mock('../../app/lib/debug', () => ({
  getDebugFlags: vi.fn(async () => ({ stubRefiner: true }))
}));
vi.mock('../../app/lib/user-settings-repo', () => ({
  getUserSettings: vi.fn(async () => ({
    user_id: 'user-id',
    refine_provider: 'openai',
    summarize_provider: 'openai',
    max_sources: 15,
    openai_timeout_minutes: 10,
    gemini_timeout_minutes: 10,
    reasoning_level: 'low',
    report_summary_mode: 'two',
    report_include_refs_in_summary: true
  }))
}));

import { POST } from '../../app/api/research/sessions/[sessionId]/refinement/answer/route';

describe('POST /api/research/sessions/:id/refinement/answer', () => {
  it('accepts an answer', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ questionId: 'q1', answer: 'A' }),
      headers: { 'Content-Type': 'application/json' }
    });
    const response = await POST(request, { params: { sessionId: 's1' } });
    expect(response.status).toBe(200);
  });
});
