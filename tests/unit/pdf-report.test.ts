// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { buildPdfReport } from '../../app/lib/pdf-report';

describe('buildPdfReport', () => {
  it('returns a stub buffer when stub=true', async () => {
    const buf = await buildPdfReport(
      {
        sessionId: 's1',
        topic: 'Test Topic',
        refinedPrompt: 'Refined prompt',
        createdAt: new Date().toISOString()
      },
      { stub: true }
    );
    expect(buf.toString('utf8')).toContain('Stub PDF');
  });

  it('returns a real PDF buffer by default', async () => {
    const buf = await buildPdfReport({
      sessionId: 's1',
      topic: 'Test Topic',
      refinedPrompt: 'Refined prompt',
      createdAt: new Date().toISOString()
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  });
});

