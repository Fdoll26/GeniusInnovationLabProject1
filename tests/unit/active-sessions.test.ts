// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { restoreActiveSessions } from '../../app/(research)/lib/active-sessions';

describe('restoreActiveSessions', () => {
  it('drops terminal sessions from stored list', async () => {
    const result = await restoreActiveSessions({
      storedSessions: [
        { id: 'c1', topic: 'Completed' },
        { id: 'i1', topic: 'Draft' }
      ],
      storedActiveId: 'c1',
      urlSessionId: null,
      serverList: [
        { id: 'c1', topic: 'Completed', state: 'completed', updated_at: '2026-01-01T00:00:00.000Z' },
        { id: 'i1', topic: 'Draft', state: 'draft', updated_at: '2026-01-02T00:00:00.000Z' }
      ]
    });

    expect(result.sessions.map((s) => s.id)).toEqual(['i1']);
    expect(result.activeId).toBe('i1');
  });

  it('consults fetchSessionById for sessions missing from list', async () => {
    const fetchSessionById = vi.fn(async (id: string) => {
      if (id === 'missing-terminal') {
        return { id, topic: 'Old', state: 'failed', updated_at: '2026-01-01T00:00:00.000Z' };
      }
      return { id, topic: 'Missing', state: 'refining', updated_at: '2026-01-03T00:00:00.000Z' };
    });

    const result = await restoreActiveSessions({
      storedSessions: [{ id: 'missing-terminal', topic: 'Ignore me' }, { id: 'missing-active', topic: 'Keep me' }],
      storedActiveId: null,
      urlSessionId: null,
      serverList: [],
      fetchSessionById
    });

    expect(fetchSessionById).toHaveBeenCalledTimes(2);
    expect(result.sessions.map((s) => s.id)).toEqual(['missing-active']);
  });
});

