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
  research?: {
    run: {
      id: string;
      state: string;
      provider: string;
      mode: string;
      depth: string;
      current_step_index: number;
      max_steps: number;
      synthesized_report_md?: string | null;
    };
    steps: Array<{
      id: string;
      step_index: number;
      step_type: string;
      status: string;
      step_goal?: string | null;
      output_excerpt?: string | null;
      raw_output?: string | null;
      completed_at?: string | null;
      error_message?: string | null;
    }>;
    sources: Array<{
      source_id: string;
      url: string;
      title?: string | null;
      reliability_tags?: string[];
    }>;
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
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [regenStatus, setRegenStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [regenError, setRegenError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const { data: authSession } = useSession();

  async function loadDetail(targetSessionId: string, signal?: AbortSignal) {
    setLoadingDetail(true);
    setDetailError(null);
    try {
      const response = await fetch(`/api/research/sessions/${targetSessionId}`, { cache: 'no-store', signal });
      if (!response.ok) {
        throw new Error(`Failed to load session (${response.status})`);
      }
      const data = (await response.json()) as SessionDetail;
      setDetail(data);
    } catch (error) {
      if (signal?.aborted) {
        return;
      }
      setDetail(null);
      setDetailError(error instanceof Error ? error.message : 'Failed to load session');
    } finally {
      if (!signal?.aborted) {
        setLoadingDetail(false);
      }
    }
  }

  useEffect(() => {
    if (!sessionId) {
      setDetail(null);
      setLoadingDetail(false);
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    void loadDetail(sessionId, controller.signal);
    return () => controller.abort();
  }, [sessionId]);

  if (!sessionId) {
    return null;
  }

  if (detailError) {
    return (
      <div className="modal-backdrop">
        <div className="modal card stack">
          <p role="alert">{detailError}</p>
          <div className="row">
            <button type="button" onClick={() => void loadDetail(sessionId)}>
              Retry
            </button>
            <button type="button" className="button-secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (loadingDetail || !detail) {
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
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setRetrying(false);
    }
  }

  async function regenerateReport() {
    if (!detail) {
      return;
    }
    const currentSessionId = detail.session.id;

    setRegenStatus('running');
    setRegenError(null);
    try {
      const response = await fetch(`/api/research/sessions/${currentSessionId}/regenerate-report`, { method: 'POST' });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      setRegenStatus('success');
      // Refresh detail to reflect any updated report metadata.
      await loadDetail(currentSessionId);
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
        {detail.research?.run ? (
          <div className="stack">
            <strong>Research artifacts</strong>
            <small>
              Run state: {detail.research.run.state} | Provider/mode: {detail.research.run.provider}/{detail.research.run.mode} | Depth:{' '}
              {detail.research.run.depth}
            </small>
            <small>
              Progress: {Math.min(detail.research.run.current_step_index, detail.research.run.max_steps)}/{detail.research.run.max_steps} steps
            </small>
            {detail.research.steps.length > 0 ? (
              <small>
                Current step:{' '}
                {detail.research.steps
                  .slice()
                  .sort((a, b) => b.step_index - a.step_index)[0]
                  ?.step_type.replace(/_/g, ' ')}
              </small>
            ) : null}
            <details className="details">
              <summary className="details__summary">Step artifacts</summary>
              <div className="details__body stack">
                {detail.research.steps.map((step) => (
                  <div key={step.id}>
                    <strong>
                      #{step.step_index + 1} {step.step_type} - {step.status}
                    </strong>
                    {step.step_goal ? <div>{step.step_goal}</div> : null}
                    {step.output_excerpt ? <small className="muted">{step.output_excerpt}</small> : null}
                    {step.raw_output ? <pre className="pre">{step.raw_output}</pre> : null}
                    {step.error_message ? <small className="muted">Error: {step.error_message}</small> : null}
                  </div>
                ))}
              </div>
            </details>
            <details className="details">
              <summary className="details__summary">Sources ({detail.research.sources.length})</summary>
              <div className="details__body stack">
                {detail.research.sources.map((source, index) => (
                  <small key={`${source.source_id}:${source.url}:${index}`}>
                    {source.title || source.url} {source.reliability_tags?.length ? `(${source.reliability_tags.join(', ')})` : ''}
                  </small>
                ))}
              </div>
            </details>
          </div>
        ) : null}
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
