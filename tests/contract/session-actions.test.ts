// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/authz', () => ({
  requireSession: vi.fn(async () => ({ user: { email: 'user@example.com' } }))
}));
vi.mock('../../app/lib/session-repo', () => ({
  getUserIdByEmail: vi.fn(async () => 'user-id'),
  assertSessionOwnership: vi.fn(async () => undefined),
  getSessionById: vi.fn(async () => ({ id: 's1', state: 'refining' }))
}));

const getDebugFlags = vi.fn(async () => ({
  stubExternals: true,
  stubRefiner: true,
  stubOpenAI: true,
  stubGemini: true,
  stubEmail: true,
  stubPdf: true,
  skipOpenAI: false,
  skipGemini: false
}));
vi.mock('../../app/lib/debug', () => ({ getDebugFlags: (...args: any[]) => getDebugFlags(...args) }));

const checkRateLimit = vi.fn(async () => undefined);
vi.mock('../../app/lib/rate-limit', () => ({ checkRateLimit: (...args: any[]) => checkRateLimit(...args) }));

const listProviderResults = vi.fn(async () => []);
vi.mock('../../app/lib/provider-repo', () => ({ listProviderResults: (...args: any[]) => listProviderResults(...args) }));

const handleRefinementApproval = vi.fn(async () => undefined);
const runProviders = vi.fn(async () => undefined);
const finalizeReport = vi.fn(async () => undefined);
const regenerateReportForSession = vi.fn(async () => ({ reportId: 'r1' }));
const syncSession = vi.fn(async () => undefined);
vi.mock('../../app/lib/orchestration', () => ({
  handleRefinementApproval: (...args: any[]) => handleRefinementApproval(...args),
  runProviders: (...args: any[]) => runProviders(...args),
  finalizeReport: (...args: any[]) => finalizeReport(...args),
  regenerateReportForSession: (...args: any[]) => regenerateReportForSession(...args),
  syncSession: (...args: any[]) => syncSession(...args)
}));

import { POST } from '../../app/api/research/sessions/[sessionId]/[action]/route';

describe('POST /api/research/sessions/:id/:action', () => {
  it('approve returns 400 when prompt missing', async () => {
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' }
    });
    const res = await POST(req, { params: Promise.resolve({ sessionId: 's1', action: 'approve' }) });
    expect(res.status).toBe(400);
  });

  it('approve skips when session is not refining', async () => {
    const { getSessionById } = await import('../../app/lib/session-repo');
    (getSessionById as any).mockResolvedValueOnce({ id: 's1', state: 'completed' });

    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ refinedPrompt: 'x' }),
      headers: { 'Content-Type': 'application/json' }
    });
    const res = await POST(req, { params: Promise.resolve({ sessionId: 's1', action: 'approve' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true });
    expect(handleRefinementApproval).not.toHaveBeenCalled();
  });

  it('retry calls finalizeReport when aggregating', async () => {
    const { getSessionById } = await import('../../app/lib/session-repo');
    (getSessionById as any).mockResolvedValueOnce({ id: 's1', state: 'aggregating' });
    listProviderResults.mockResolvedValueOnce([
      { provider: 'openai', status: 'failed' },
      { provider: 'gemini', status: 'completed' }
    ]);

    const req = new Request('http://localhost', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ sessionId: 's1', action: 'retry' }) });
    expect(res.status).toBe(200);
    expect(finalizeReport).toHaveBeenCalledWith(
      's1',
      true,
      false,
      expect.objectContaining({ stub: true, stubPdf: true, stubEmail: true })
    );
    expect(runProviders).not.toHaveBeenCalled();
  });

  it('retry calls runProviders for non-aggregating sessions', async () => {
    const { getSessionById } = await import('../../app/lib/session-repo');
    (getSessionById as any).mockResolvedValueOnce({ id: 's1', state: 'failed' });

    const req = new Request('http://localhost', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ sessionId: 's1', action: 'retry' }) });
    expect(res.status).toBe(200);
    expect(runProviders).toHaveBeenCalled();
  });

  it('regenerate-report rejects non-terminal sessions', async () => {
    const { getSessionById } = await import('../../app/lib/session-repo');
    (getSessionById as any).mockResolvedValueOnce({ id: 's1', state: 'running_research' });

    const req = new Request('http://localhost', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ sessionId: 's1', action: 'regenerate-report' }) });
    expect(res.status).toBe(400);
  });

  it('regenerate-report returns reportId for completed sessions', async () => {
    const { getSessionById } = await import('../../app/lib/session-repo');
    (getSessionById as any).mockResolvedValueOnce({ id: 's1', state: 'completed' });

    const req = new Request('http://localhost', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ sessionId: 's1', action: 'regenerate-report' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reportId: 'r1' });
  });
});

