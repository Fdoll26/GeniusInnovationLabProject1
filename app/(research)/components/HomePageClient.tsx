'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { signIn, useSession } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import TopicForm from './TopicForm';
import SessionStatus from './SessionStatus';
import RefinementPanel from './RefinementPanel';
import DebugPanel from './DebugPanel';
import ActiveSessionTabs, { type ActiveSession } from './ActiveSessionTabs';
import { restoreActiveSessions, type SessionListRecord } from '../lib/active-sessions';

function storageKey(email: string | null) {
  return `activeSessions:${email ?? 'dev'}`;
}

export default function HomePageClient() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const sessionIdFromUrl = params.get('session');
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [debugBypass, setDebugBypass] = useState(false);
  const activeSessionsRef = useRef<ActiveSession[]>([]);
  const activeSessionIdRef = useRef<string | null>(null);
  const restoredRef = useRef(false);

  useEffect(() => {
    const hasBypassCookie = document.cookie.includes('dev_bypass=1');
    setDebugBypass(hasBypassCookie);
  }, []);

  useEffect(() => {
    activeSessionsRef.current = activeSessions;
    try {
      const email = session?.user?.email ?? null;
      localStorage.setItem(storageKey(email), JSON.stringify(activeSessions));
    } catch {
      // ignore
    }
  }, [activeSessions, session?.user?.email]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    try {
      const email = session?.user?.email ?? null;
      if (activeSessionId) {
        localStorage.setItem(`${storageKey(email)}:active`, activeSessionId);
      } else {
        localStorage.removeItem(`${storageKey(email)}:active`);
      }
    } catch {
      // ignore
    }
  }, [activeSessionId, session?.user?.email]);

  useEffect(() => {
    if (restoredRef.current) {
      return;
    }
    if (status !== 'authenticated' && !debugBypass) {
      return;
    }
    restoredRef.current = true;
    let active = true;
    (async () => {
      try {
        const email = session?.user?.email ?? null;
        const storedRaw = localStorage.getItem(storageKey(email));
        const stored = storedRaw ? (JSON.parse(storedRaw) as Array<{ id: string; topic?: string }> | null) : null;
        const storedSessions = Array.isArray(stored)
          ? stored
              .filter((s) => s && typeof s.id === 'string')
              .map((s) => ({ id: s.id, topic: String(s.topic ?? '') }))
          : [];
        const storedActiveId = localStorage.getItem(`${storageKey(email)}:active`) || null;

        const res = await fetch('/api/research/sessions?limit=50&offset=0');
        const serverList = res.ok ? ((await res.json()) as SessionListRecord[]) : [];
        const { sessions: nextSessions, activeId: nextActive } = await restoreActiveSessions({
          storedSessions,
          storedActiveId,
          urlSessionId: sessionIdFromUrl,
          serverList,
          fetchSessionById: async (id: string) => {
            const response = await fetch(`/api/research/sessions/${encodeURIComponent(id)}`);
            if (!response.ok) return null;
            const data = (await response.json()) as { session?: SessionListRecord };
            return data?.session ?? null;
          },
          maxSessions: 3
        });

        if (!active) return;
        setActiveSessions(nextSessions);
        setActiveSessionId(nextActive);
      } catch {
        // ignore
      }
    })();
    return () => {
      active = false;
    };
  }, [status, debugBypass, session?.user?.email, sessionIdFromUrl]);

  const canStartNew = useMemo(() => activeSessions.length < 3, [activeSessions.length]);

  const ensureSessionLoaded = async (sessionId: string) => {
    if (activeSessions.some((s) => s.id === sessionId)) {
      setActiveSessionId(sessionId);
      return;
    }
    const response = await fetch(`/api/research/sessions/${encodeURIComponent(sessionId)}`);
    if (!response.ok) {
      return;
    }
    const data = (await response.json()) as { session?: { id: string; topic: string } };
    const topic = data?.session?.topic;
    if (!topic) {
      return;
    }
    setActiveSessions((prev) => {
      const next = [...prev.filter((s) => s.id !== sessionId), { id: sessionId, topic }];
      return next.slice(0, 3);
    });
    setActiveSessionId(sessionId);
  };

  useEffect(() => {
    const fromUrl = sessionIdFromUrl;
    if (fromUrl) {
      void ensureSessionLoaded(fromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionIdFromUrl]);

  const removeAfterComplete = (sessionId: string) => {
    const nextSessions = activeSessionsRef.current.filter((s) => s.id !== sessionId);
    setActiveSessions(nextSessions);

    const isRemovingActive = activeSessionIdRef.current === sessionId;
    if (!isRemovingActive) {
      return;
    }
    const nextActive = nextSessions[0]?.id ?? null;
    setActiveSessionId(nextActive);
    const url = new URL(window.location.href);
    if (nextActive) {
      url.searchParams.set('session', nextActive);
    } else if (url.searchParams.get('session') === sessionId) {
      url.searchParams.delete('session');
    }
    router.replace(url.pathname + url.search);
  };

  if (status === 'loading' && !debugBypass) {
    return <div className="card">Loading...</div>;
  }

  if (!session && !debugBypass) {
    return (
      <div className="auth-shell">
        <div className="card auth-card stack">
          <h1>Multi-API Research</h1>
          <p className="muted">
            Sign in to run deep research across OpenAI + Gemini, generate a PDF report, and email it to yourself.
          </p>
          <ul className="auth-bullets">
            <li>Prompt refinement before research</li>
            <li>OpenAI + Gemini results side-by-side</li>
            <li>History + retries for failed runs</li>
          </ul>
          <button type="button" className="auth-button" onClick={() => signIn('google')}>
            Continue with Google
          </button>
          <small className="muted">Your sessions are stored privately and associated with your Google account.</small>
          <DebugPanel onBypassChange={setDebugBypass} />
        </div>
      </div>
    );
  }

  return (
    <div className="two-col">
      <div className="stack">
        {canStartNew ? (
          <TopicForm
            onCreated={(s) => {
              setActiveSessions((prev) => {
                const next = [...prev, s].filter((item, idx, arr) => arr.findIndex((x) => x.id === item.id) === idx);
                return next.slice(0, 3);
              });
              setActiveSessionId(s.id);
              const url = new URL(window.location.href);
              url.searchParams.set('session', s.id);
              router.replace(url.pathname + url.search);
            }}
          />
        ) : (
          <div className="card">
            You already have 3 active sessions. Complete one (or wait for it to finish) before starting another.
          </div>
        )}

        {activeSessionId ? (
          <>
            <SessionStatus sessionId={activeSessionId} />
            <RefinementPanel sessionId={activeSessionId} />
          </>
        ) : null}
        <DebugPanel onBypassChange={setDebugBypass} />
      </div>

      <ActiveSessionTabs
        sessions={activeSessions}
        activeId={activeSessionId}
        onSelect={(id) => {
          setActiveSessionId(id);
          const url = new URL(window.location.href);
          url.searchParams.set('session', id);
          router.replace(url.pathname + url.search);
        }}
        onRemoveAfterComplete={removeAfterComplete}
      />
    </div>
  );
}
