'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';

const labelMap: Record<string, string> = {
  draft: 'Draft',
  refining: 'Awaiting clarifications',
  running_research: 'Waiting on research results',
  aggregating: 'Aggregating results',
  completed: 'Completed',
  partial: 'Completed with partial results',
  failed: 'Failed'
};

function isTerminalState(state: unknown): boolean {
  return state === 'completed' || state === 'partial' || state === 'failed';
}

function storageKey(email: string | null) {
  return `activeSessions:${email ?? 'dev'}`;
}

type ProviderResult = {
  provider: string;
  status: string;
  output_text?: string | null;
  sources_json?: unknown | null;
  started_at?: string | null;
  completed_at?: string | null;
  error_code?: string | null;
  error_message?: string | null;
};

type SessionDetail = {
  session: {
    id: string;
    topic: string;
    refined_prompt: string | null;
    state: string;
    created_at: string;
    refined_at?: string | null;
    completed_at?: string | null;
  };
  providerResults: ProviderResult[];
  report?: {
    email_status?: string | null;
    sent_at?: string | null;
    email_error?: string | null;
  } | null;
};

export default function SessionDetail({
  sessionId,
  onClose
}: {
  sessionId: string | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [regenStatus, setRegenStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [regenError, setRegenError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const { data: authSession } = useSession();

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    const load = async () => {
      const response = await fetch(`/api/research/sessions/${sessionId}`);
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as SessionDetail;
      setDetail(data);
    };
    load();
  }, [sessionId]);

  if (!sessionId) {
    return null;
  }

  if (!detail) {
    return (
      <div className="modal-backdrop">
        <div className="modal card">Loading session...</div>
      </div>
    );
  }

  const canRetry =
    detail.session.state === 'failed' ||
    detail.session.state === 'partial' ||
    detail.session.state === 'aggregating' ||
    detail.session.state === 'running_research';
  const canRegenerate = detail.session.state === 'completed' || detail.session.state === 'partial';
  const emailStatus = detail.report?.email_status ?? 'unknown';
  const refinedPromptValue = detail.session.refined_prompt ?? 'N/A';
  const signedInEmail = authSession?.user?.email ?? null;
  const sessionStateLabel = labelMap[detail.session.state] ?? detail.session.state;

  async function copyRefinedPrompt() {
    try {
      await navigator.clipboard.writeText(refinedPromptValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  async function retrySession() {
    setRetryError(null);
    if (!detail) {
      setRetryError('Retry failed');
      return;
    }
    setRetrying(true);
    try {
      const currentState = detail.session.state;
      const response = await fetch(`/api/research/sessions/${detail.session.id}/retry`, {
        method: 'POST'
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }

      // If there's capacity (<3 other active sessions), take the user back to Home and
      // pin this session into the active tabs; otherwise show a helpful message.
      try {
        const listRes = await fetch('/api/research/sessions?limit=50&offset=0');
        const list = listRes.ok ? ((await listRes.json()) as Array<{ id: string; state?: string }>) : [];
        const inProgressOtherCount = list.filter((s) => !isTerminalState(s.state) && s.id !== detail.session.id).length;
        if (!isTerminalState(currentState) && inProgressOtherCount >= 3) {
          setRetryError('You already have 3 active sessions. Try again once one of the research tabs has finished.');
          return;
        }
        if (isTerminalState(currentState) && inProgressOtherCount >= 3) {
          setRetryError('You already have 3 active sessions. Try again once one of the research tabs has finished.');
          return;
        }
      } catch {
        // If we can't verify capacity, fall back to attempting activation.
      }

      try {
        const email = signedInEmail ?? null;
        const key = storageKey(email);
        const raw = localStorage.getItem(key);
        const parsed = raw ? (JSON.parse(raw) as Array<{ id: string; topic?: string }> | null) : null;
        const prev = Array.isArray(parsed) ? parsed.filter((s) => s && typeof s.id === 'string') : [];
        const next = [{ id: detail.session.id, topic: detail.session.topic }, ...prev].filter(
          (item, idx, arr) => arr.findIndex((x) => x.id === item.id) === idx
        );
        localStorage.setItem(key, JSON.stringify(next.slice(0, 3)));
        localStorage.setItem(`${key}:active`, detail.session.id);
      } catch {
        // ignore
      }

      window.location.assign(`/?session=${encodeURIComponent(detail.session.id)}`);
      return;

      // Refresh/poll so the user sees progress when resuming finalization.
      const startedAt = Date.now();
      while (Date.now() - startedAt < 25_000) {
        const refreshed = await fetch(`/api/research/sessions/${detail.session.id}`);
        if (refreshed.ok) {
          const data = (await refreshed.json()) as SessionDetail;
          setDetail(data);
          if (data.session.state !== 'aggregating') {
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setRetrying(false);
    }
  }

  async function regenerateReport() {
    setRegenStatus('running');
    setRegenError(null);
    try {
      const response = await fetch(`/api/research/sessions/${detail.session.id}/regenerate-report`, { method: 'POST' });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      setRegenStatus('success');
      // Refresh detail to reflect any updated report metadata.
      const refreshed = await fetch(`/api/research/sessions/${detail.session.id}`);
      if (refreshed.ok) {
        setDetail((await refreshed.json()) as SessionDetail);
      }
      setTimeout(() => setRegenStatus('idle'), 2500);
    } catch (err) {
      setRegenStatus('error');
      setRegenError(err instanceof Error ? err.message : 'Failed to regenerate report');
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="modal card stack">
        <div className="row">
          <h3>Session Detail</h3>
          <button type="button" className="button-secondary" onClick={onClose}>
            Close
          </button>
        </div>
        <p>
          <strong>Initial prompt:</strong> {detail.session.topic}
        </p>
        <p>
          <strong>Status:</strong> {sessionStateLabel}
        </p>
        <p>
          <strong>Created:</strong>{' '}
          {new Date(detail.session.created_at).toLocaleString()}
        </p>
        <p>
          <strong>Refined at:</strong>{' '}
          {detail.session.refined_at ? new Date(detail.session.refined_at).toLocaleString() : 'N/A'}
        </p>
        <p>
          <strong>Completed at:</strong>{' '}
          {detail.session.completed_at
            ? new Date(detail.session.completed_at).toLocaleString()
            : 'N/A'}
        </p>
        <div className="row">
          <strong>Refined prompt:</strong>
          <button
            type="button"
            className="icon-button"
            onClick={copyRefinedPrompt}
            aria-label="Copy refined prompt"
            title="Copy refined prompt"
          >
            📋
          </button>
          {copied ? <small>Copied</small> : null}
        </div>
        <p>{refinedPromptValue}</p>
        <div className="stack">
          <strong>Provider results</strong>
          {detail.providerResults?.map((result) => (
            <div key={result.provider}>
              <strong>{result.provider}:</strong> {result.status}
              {result.error_message ? ` — ${result.error_message}` : null}
              {result.started_at ? (
                <div>
                  <small className="muted">
                    Started: {new Date(result.started_at).toLocaleString()}
                  </small>
                </div>
              ) : null}
              {result.completed_at ? (
                <div>
                  <small className="muted">
                    Completed: {new Date(result.completed_at).toLocaleString()}
                  </small>
                </div>
              ) : null}
              {result.error_code ? (
                <div>
                  <small className="muted">Error code: {result.error_code}</small>
                </div>
              ) : null}
              {result.output_text ? (
                <details className="details">
                  <summary className="details__summary">Show output</summary>
                  <div className="details__body">
                    <pre className="pre">{result.output_text}</pre>
                  </div>
                </details>
              ) : null}
            </div>
          ))}
        </div>
        <div className="stack">
          <strong>Email delivery</strong>
          <p>
            Status: {emailStatus}
            {emailStatus === 'sent' && signedInEmail ? ` (sent to ${signedInEmail})` : null}
          </p>
          {detail.report?.email_error ? (
            <p>Failure: {detail.report.email_error}</p>
          ) : null}
          {detail.report?.sent_at ? (
            <p>Sent at: {new Date(detail.report.sent_at).toLocaleString()}</p>
          ) : null}
        </div>
        {canRetry ? (
          <button type="button" onClick={retrySession} disabled={retrying}>
            {detail.session.state === 'aggregating' ? 'Resume finalizing' : 'Retry Session'}
          </button>
        ) : null}
        {canRegenerate ? (
          <div className="stack">
            <button type="button" onClick={regenerateReport} disabled={regenStatus === 'running'}>
              {regenStatus === 'running' ? 'Sending…' : 'Regenerate + re-send report email'}
            </button>
            {regenStatus === 'success' ? <small>Report sent.</small> : null}
            {regenError ? <small className="muted">Failed: {regenError}</small> : null}
          </div>
        ) : null}
        {retrying ? <small>Working…</small> : null}
        {retryError ? <p role="alert">{retryError}</p> : null}
      </div>
    </div>
  );
}
