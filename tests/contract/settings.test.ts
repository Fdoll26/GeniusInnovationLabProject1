// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const requireSession = vi.fn(async () => ({ user: { email: 'user@example.com' } }));
vi.mock('../../app/lib/authz', () => ({
  requireSession: (...args: any[]) => requireSession(...args),
  unauthorizedResponse: (error: unknown) =>
    error instanceof Error && error.message === 'Unauthorized'
      ? Response.json({ error: 'Unauthorized' }, { status: 401 })
      : null
}));
vi.mock('../../app/lib/session-repo', () => ({
  getUserIdByEmail: vi.fn(async () => 'user-id')
}));

const getUserSettings = vi.fn();
const upsertUserSettings = vi.fn();
const normalizeUserSettingsUpdate = vi.fn();
vi.mock('../../app/lib/user-settings-repo', () => ({
  getUserSettings: (...args: any[]) => getUserSettings(...args),
  upsertUserSettings: (...args: any[]) => upsertUserSettings(...args),
  normalizeUserSettingsUpdate: (...args: any[]) => normalizeUserSettingsUpdate(...args)
}));

import { GET, POST } from '../../app/api/settings/route';

describe('/api/settings', () => {
  it('GET returns settings', async () => {
    getUserSettings.mockResolvedValueOnce({ user_id: 'user-id', theme: 'light' });

    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: 'user-id', theme: 'light' });
  });

  it('POST normalizes and upserts', async () => {
    normalizeUserSettingsUpdate.mockReturnValueOnce({ theme: 'dark' });
    upsertUserSettings.mockResolvedValueOnce({ user_id: 'user-id', theme: 'dark' });

    const req = new Request('http://localhost/api/settings', {
      method: 'POST',
      body: JSON.stringify({ theme: 'dark', ignored: 'x' }),
      headers: { 'Content-Type': 'application/json' }
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(normalizeUserSettingsUpdate).toHaveBeenCalled();
    expect(upsertUserSettings).toHaveBeenCalledWith('user-id', { theme: 'dark' });
    expect(await res.json()).toEqual({ user_id: 'user-id', theme: 'dark' });
  });

  it('returns 401 when session is missing', async () => {
    requireSession.mockRejectedValueOnce(new Error('Unauthorized'));

    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });
});
