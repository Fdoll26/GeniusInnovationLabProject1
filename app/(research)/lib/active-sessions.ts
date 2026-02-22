export type ActiveSession = { id: string; topic: string };

export type SessionListRecord = {
  id: string;
  topic: string;
  state?: string;
  updated_at?: string;
  created_at?: string;
};

export type StoredActiveSession = { id: string; topic?: string };

export function isTerminalSessionState(state: unknown): boolean {
  const s = typeof state === 'string' ? state : '';
  return s === 'completed' || s === 'partial' || s === 'failed';
}

function pickUpdatedAt(record: SessionListRecord | null, fallback = ''): string {
  return record?.updated_at ?? record?.created_at ?? fallback;
}

export async function restoreActiveSessions(params: {
  storedSessions: StoredActiveSession[];
  storedActiveId: string | null;
  urlSessionId: string | null;
  serverList: SessionListRecord[];
  fetchSessionById?: (id: string) => Promise<SessionListRecord | null>;
  maxSessions?: number;
}): Promise<{ sessions: ActiveSession[]; activeId: string | null }> {
  const max = typeof params.maxSessions === 'number' ? Math.max(1, Math.trunc(params.maxSessions)) : 3;
  const byId = new Map(params.serverList.map((s) => [s.id, s]));

  const resolveFromServer = async (id: string): Promise<SessionListRecord | null> => {
    const direct = byId.get(id);
    if (direct) return direct;
    if (typeof params.fetchSessionById !== 'function') return null;
    return await params.fetchSessionById(id);
  };

  const merged: Array<{ id: string; topic: string; updatedAt: string }> = [];

  for (const stored of params.storedSessions) {
    if (!stored?.id || typeof stored.id !== 'string') continue;
    const fromServer = await resolveFromServer(stored.id);
    if (fromServer && isTerminalSessionState(fromServer.state)) {
      continue;
    }
    merged.push({
      id: stored.id,
      topic: fromServer?.topic ?? String(stored.topic ?? ''),
      updatedAt: pickUpdatedAt(fromServer, '')
    });
  }

  const inProgress = params.serverList
    .filter((s) => !isTerminalSessionState(s.state))
    .sort((a, b) => String(pickUpdatedAt(b)).localeCompare(String(pickUpdatedAt(a))));

  for (const s of inProgress) {
    if (merged.some((m) => m.id === s.id)) continue;
    merged.push({ id: s.id, topic: s.topic, updatedAt: pickUpdatedAt(s) });
  }

  const sessions = merged
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, max)
    .map((s) => ({ id: s.id, topic: s.topic }));

  const fromUrl =
    params.urlSessionId && sessions.some((s) => s.id === params.urlSessionId) ? params.urlSessionId : null;
  const fromStored =
    params.storedActiveId && sessions.some((s) => s.id === params.storedActiveId) ? params.storedActiveId : null;
  const activeId = fromUrl || fromStored || sessions[0]?.id || null;

  return { sessions, activeId };
}

