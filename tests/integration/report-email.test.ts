// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/session-repo', () => ({
  getSessionById: vi.fn(async () => ({
    id: 's1',
    topic: 'Topic',
    refined_prompt: 'Refined',
    created_at: new Date().toISOString()
  })),
  updateSessionState: vi.fn(async () => undefined)
}));
vi.mock('../../app/lib/provider-repo', () => ({
  listProviderResults: vi.fn(async () => [
    { provider: 'openai', status: 'completed', output_text: 'A', started_at: '2026-02-23T00:00:00.000Z', completed_at: '2026-02-23T00:01:05.000Z' },
    { provider: 'gemini', status: 'completed', output_text: 'B', started_at: '2026-02-23T00:00:10.000Z', completed_at: '2026-02-23T00:02:10.000Z' }
  ])
}));
vi.mock('../../app/lib/pdf-report', () => ({
  buildPdfReport: vi.fn(async () => Buffer.from('pdf'))
}));
vi.mock('../../app/lib/report-repo', () => ({
  getReportBySession: vi.fn(async () => null),
  createReport: vi.fn(async () => ({ id: 'r1' })),
  updateReportContent: vi.fn(async () => ({ id: 'r1', summary_text: 's', pdf_bytes: Buffer.from('pdf'), email_status: 'pending' })),
  claimReportSendForSession: vi.fn(async () => 'r1'),
  updateReportEmail: vi.fn(async () => undefined),
  checkReportTiming: vi.fn(async () => null)
}));
vi.mock('../../app/lib/email-sender', () => ({
  sendReportEmail: vi.fn(async () => undefined)
}));
vi.mock('../../app/lib/db', () => ({
  query: vi.fn(async () => [{ email: 'user@example.com' }])
}));
vi.mock('../../app/lib/user-settings-repo', () => ({
  getUserSettings: vi.fn(async () => ({
    user_id: 'u1',
    refine_provider: 'openai',
    summarize_provider: 'openai',
    max_sources: 15,
    openai_timeout_minutes: 10,
    gemini_timeout_minutes: 10,
    reasoning_level: 'low',
    report_summary_mode: 'two',
    report_include_refs_in_summary: true,
    theme: 'light'
  }))
}));
vi.mock('../../app/lib/orchestration', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../app/lib/orchestration')>();
  return { ...mod, resolveUserEmail: vi.fn(async () => 'user@example.com') };
});

import { finalizeReport } from '../../app/lib/orchestration';

describe('finalizeReport', () => {
  it('creates and emails report', async () => {
    await finalizeReport('s1', false, false, { stub: true });
    const { buildPdfReport } = await import('../../app/lib/pdf-report');
    expect(buildPdfReport).toHaveBeenCalledWith(
      expect.objectContaining({
        openaiStartedAt: '2026-02-23T00:00:00.000Z',
        openaiCompletedAt: '2026-02-23T00:01:05.000Z',
        geminiStartedAt: '2026-02-23T00:00:10.000Z',
        geminiCompletedAt: '2026-02-23T00:02:10.000Z'
      }),
      expect.anything()
    );
  });
});
