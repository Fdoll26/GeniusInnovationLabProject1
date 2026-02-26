// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../../app/lib/db', () => ({ query: (...args: any[]) => query(...args) }));

import { claimReportSendForSession } from '../../app/lib/report-repo';

afterEach(() => {
  query.mockReset();
});

describe('claimReportSendForSession', () => {
  it('guards against concurrent sends for the same session', async () => {
    query.mockResolvedValueOnce([{ id: 'r1' }]);

    await claimReportSendForSession('s1');

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("email_status IN ('sent', 'sending')");
  });
});
