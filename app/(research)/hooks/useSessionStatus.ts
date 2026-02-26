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
        if (!entry.inFlight) {
          entriesBySession.delete(sessionId);
        }
      }
    };
  }, [sessionId]);

  return snapshot;
}
