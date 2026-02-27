'use client';

import { useEffect, useState } from 'react';

export type SessionStatus = {
  state: string;
  updatedAt: string;
  refinedAt?: string | null;
  completedAt?: string | null;
  providers?: Array<{
    provider: string;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    errorMessage: string | null;
  }>;
  research?: {
    providers: Array<{
      provider: 'openai' | 'gemini';
      runId: string;
      state: string;
      stepIndex: number;
      maxSteps: number;
      mode: 'native' | 'custom';
      sourceCount: number;
      progress: {
        stepId: string | null;
        stepLabel: string | null;
        stepNumber: number;
        totalSteps: number;
      } | null;
      steps: Array<{
        id: string;
        stepIndex: number;
        stepType: string;
        status: string;
        stepGoal: string | null;
        outputExcerpt: string | null;
        errorMessage: string | null;
        startedAt: string | null;
        completedAt: string | null;
      }>;
    }>;
  } | null;
};

type SessionStatusSnapshot = {
  status: SessionStatus | null;
  error: string | null;
};

type SessionStatusEntry = SessionStatusSnapshot & {
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  stream: EventSource | null;
  streamRetryTimer: ReturnType<typeof setTimeout> | null;
  intervalMs: number;
  consecutiveFailures: number;
  lastHash: string | null;
};

const POLL_INTERVAL_MS = 5000;
const MAX_BACKOFF_MS = 30000;
const entriesBySession = new Map<string, SessionStatusEntry>();

function getOrCreateEntry(sessionId: string): SessionStatusEntry {
  const existing = entriesBySession.get(sessionId);
  if (existing) {
    return existing;
  }
  const created: SessionStatusEntry = {
    status: null,
    error: null,
    listeners: new Set(),
    timer: null,
    inFlight: null,
    stream: null,
    streamRetryTimer: null,
    intervalMs: POLL_INTERVAL_MS,
    consecutiveFailures: 0,
    lastHash: null
  };
  entriesBySession.set(sessionId, created);
  return created;
}

function notify(entry: SessionStatusEntry) {
  for (const listener of entry.listeners) {
    listener();
  }
}

function schedulePoll(sessionId: string, delayMs?: number) {
  const entry = entriesBySession.get(sessionId);
  if (!entry || entry.listeners.size === 0) {
    return;
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  entry.timer = setTimeout(() => {
    void fetchSessionStatus(sessionId);
  }, delayMs ?? entry.intervalMs);
}

async function fetchSessionStatus(sessionId: string) {
  const entry = entriesBySession.get(sessionId);
  if (!entry) {
    return;
  }
  if (entry.inFlight) {
    return entry.inFlight;
  }
  entry.inFlight = (async () => {
    try {
      const response = await fetch(`/api/research/sessions/${sessionId}/status`, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Failed to fetch status (${response.status})`);
      }
      const data = (await response.json()) as SessionStatus;
      const nextHash = JSON.stringify(data);
      const changed = nextHash !== entry.lastHash;
      const hadError = Boolean(entry.error);
      entry.lastHash = nextHash;
      entry.status = data;
      entry.consecutiveFailures = 0;
      entry.intervalMs = POLL_INTERVAL_MS;
      if (hadError) {
        entry.error = null;
      }
      if (changed || hadError) {
        notify(entry);
      }
    } catch (err) {
      entry.consecutiveFailures += 1;
      entry.intervalMs = Math.min(POLL_INTERVAL_MS * 2 ** (entry.consecutiveFailures - 1), MAX_BACKOFF_MS);
      const message = err instanceof Error ? err.message : 'Status error';
      // Avoid UI thrash on transient failures once we already have data.
      if (!entry.status || entry.consecutiveFailures >= 3) {
        if (entry.error !== message) {
          entry.error = message;
          notify(entry);
        }
      }
    } finally {
      entry.inFlight = null;
      if (entry.listeners.size === 0) {
        entriesBySession.delete(sessionId);
        return;
      }
      schedulePoll(sessionId);
    }
  })();
  return entry.inFlight;
}

function closeSessionStream(entry: SessionStatusEntry) {
  if (entry.stream) {
    entry.stream.close();
    entry.stream = null;
  }
  if (entry.streamRetryTimer) {
    clearTimeout(entry.streamRetryTimer);
    entry.streamRetryTimer = null;
  }
}

function openSessionStream(sessionId: string) {
  const entry = entriesBySession.get(sessionId);
  if (!entry || entry.listeners.size === 0 || typeof window === 'undefined' || entry.stream) {
    return;
  }

  const stream = new EventSource(`/api/research/${sessionId}/stream`);
  entry.stream = stream;

  stream.onmessage = (event) => {
    const current = entriesBySession.get(sessionId);
    if (!current) {
      stream.close();
      return;
    }
    try {
      const data = JSON.parse(event.data) as SessionStatus | { type?: string; message?: string };
      if (data && typeof data === 'object' && 'type' in data && data.type === 'error') {
        current.error = typeof data.message === 'string' ? data.message : 'Stream error';
        notify(current);
        return;
      }
      if (data && typeof data === 'object' && 'type' in data && data.type === 'terminal') {
        closeSessionStream(current);
        return;
      }
      const status = data as SessionStatus;
      const nextHash = JSON.stringify(status);
      const changed = nextHash !== current.lastHash;
      const hadError = Boolean(current.error);
      current.status = status;
      current.lastHash = nextHash;
      current.error = null;
      current.consecutiveFailures = 0;
      current.intervalMs = POLL_INTERVAL_MS;
      if (changed || hadError) {
        notify(current);
      }
    } catch {
      // ignore malformed stream payloads
    }
  };

  stream.onerror = () => {
    const current = entriesBySession.get(sessionId);
    if (!current) {
      stream.close();
      return;
    }
    closeSessionStream(current);
    if (current.listeners.size > 0) {
      current.streamRetryTimer = setTimeout(() => {
        openSessionStream(sessionId);
      }, 2000);
    }
  };
}

export function useSessionStatus(sessionId: string | null) {
  const [snapshot, setSnapshot] = useState<SessionStatusSnapshot>({ status: null, error: null });

  useEffect(() => {
    if (!sessionId) {
      setSnapshot({ status: null, error: null });
      return;
    }

    const entry = getOrCreateEntry(sessionId);
    const sync = () => {
      setSnapshot({ status: entry.status, error: entry.error });
    };
    entry.listeners.add(sync);
    sync();

    void fetchSessionStatus(sessionId);
    openSessionStream(sessionId);
    const onFocus = () => {
      void fetchSessionStatus(sessionId);
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        void fetchSessionStatus(sessionId);
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
      entry.listeners.delete(sync);
      if (entry.listeners.size === 0) {
        if (entry.timer) {
          clearTimeout(entry.timer);
        }
        entry.timer = null;
        closeSessionStream(entry);
        if (!entry.inFlight) {
          entriesBySession.delete(sessionId);
        }
      }
    };
  }, [sessionId]);

  return snapshot;
}
