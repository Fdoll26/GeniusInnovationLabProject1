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

export function useSessionStatus(sessionId: string | null) {
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    let active = true;
    const fetchStatus = async () => {
      try {
        const response = await fetch(`/api/research/sessions/${sessionId}/status`);
        if (!response.ok) {
          throw new Error('Failed to fetch status');
        }
        const data = (await response.json()) as SessionStatus;
        if (active) {
          setStatus(data);
          setError(null);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Status error');
        }
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    const onFocus = () => fetchStatus();
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        fetchStatus();
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [sessionId]);

  return { status, error };
}
