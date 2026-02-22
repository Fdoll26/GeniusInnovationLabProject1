'use client';

import { useSessionStatus } from '../hooks/useSessionStatus';

export default function SessionStatus({ sessionId }: { sessionId: string | null }) {
  const { status, error } = useSessionStatus(sessionId);

  if (!sessionId) {
    return <div className="card">No active session.</div>;
  }

  if (error) {
    return <div className="card">Status error: {error}</div>;
  }

  if (!status) {
    return <div className="card">Loading status...</div>;
  }

  const isFailed = status.state === 'failed' || status.state === 'partial';
  const labelMap: Record<string, string> = {
    draft: 'Draft',
    refining: 'Needs clarifications',
    running_research: 'Waiting on research results',
    aggregating: 'Aggregating results',
    completed: 'Completed',
    partial: 'Completed with partial results',
    failed: 'Failed'
  };
  const label = labelMap[status.state] ?? status.state;
  const isActive =
    status.state === 'running_research' ||
    status.state === 'aggregating';

  const providersByName = new Map(
    (status.providers ?? []).map((p) => [String(p.provider).toLowerCase(), p])
  );
  const openai = providersByName.get('openai');
  const gemini = providersByName.get('gemini');

  const providerLabel = (provider: string, providerStatus?: string) => {
    const s = providerStatus ?? 'pending';
    const clean = s.replace(/_/g, ' ');
    return `${provider}: ${clean}`;
  };

  return (
    <div className="card stack">
      <div className="status-row">
        {isActive ? <span className="spinner" aria-hidden /> : null}
        <span className="status-pill">{label}</span>
      </div>
      {isActive ? (
        <div className="progress-bar" aria-hidden>
          <div className="progress-bar__fill" />
        </div>
      ) : null}
      <small>Updated: {new Date(status.updatedAt).toLocaleString()}</small>
      {isFailed ? <p role="alert">Session completed with errors.</p> : null}

      <details className="details">
        <summary className="details__summary">Show research steps</summary>
        <div className="details__body stack">
          <div className="stack">
            <strong>Pipeline</strong>
            <div className="step-list">
              <div className={`step ${status.state === 'refining' ? 'is-active' : ''}`}>
                <span className="step__dot" aria-hidden />
                <span>Clarifications</span>
              </div>
              <div className={`step ${status.state === 'running_research' ? 'is-active' : ''}`}>
                <span className="step__dot" aria-hidden />
                <span>Research (OpenAI + Gemini)</span>
              </div>
              <div className={`step ${status.state === 'aggregating' ? 'is-active' : ''}`}>
                <span className="step__dot" aria-hidden />
                <span>Aggregate + PDF + email</span>
              </div>
              <div
                className={`step ${
                  status.state === 'completed' || status.state === 'partial' || status.state === 'failed'
                    ? 'is-active'
                    : ''
                }`}
              >
                <span className="step__dot" aria-hidden />
                <span>Done</span>
              </div>
            </div>
          </div>

          <div className="stack">
            <strong>Providers</strong>
            <div className="stack">
              <div className="provider-row">
                {openai?.status === 'running' ? <span className="spinner" aria-hidden /> : null}
                <span>{providerLabel('OpenAI', openai?.status)}</span>
              </div>
              {openai?.errorMessage ? <small className="muted">Error: {openai.errorMessage}</small> : null}
              {openai?.startedAt ? (
                <small className="muted">Started: {new Date(openai.startedAt).toLocaleString()}</small>
              ) : null}
              {openai?.completedAt ? (
                <small className="muted">Completed: {new Date(openai.completedAt).toLocaleString()}</small>
              ) : null}
            </div>

            <div className="stack">
              <div className="provider-row">
                {gemini?.status === 'running' ? <span className="spinner" aria-hidden /> : null}
                <span>{providerLabel('Gemini', gemini?.status)}</span>
              </div>
              {gemini?.errorMessage ? <small className="muted">Error: {gemini.errorMessage}</small> : null}
              {gemini?.startedAt ? (
                <small className="muted">Started: {new Date(gemini.startedAt).toLocaleString()}</small>
              ) : null}
              {gemini?.completedAt ? (
                <small className="muted">Completed: {new Date(gemini.completedAt).toLocaleString()}</small>
              ) : null}
            </div>
          </div>

          {status.refinedAt ? (
            <small className="muted">Refined: {new Date(status.refinedAt).toLocaleString()}</small>
          ) : null}
          {status.completedAt ? (
            <small className="muted">Session completed: {new Date(status.completedAt).toLocaleString()}</small>
          ) : null}
        </div>
      </details>
    </div>
  );
}
