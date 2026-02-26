'use client';

import { useState } from 'react';
import { useSessionStatus } from '../hooks/useSessionStatus';

export default function SessionStatus({ sessionId }: { sessionId: string | null }) {
  const { status, error } = useSessionStatus(sessionId);
  const [expandedByProvider, setExpandedByProvider] = useState<Record<string, boolean>>({});

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

  const researchProviders = status.research?.providers ?? [];
  const providerProgressByName = new Map(researchProviders.map((p) => [p.provider, p]));
  const isExpanded = (provider: 'openai' | 'gemini') => Boolean(expandedByProvider[provider]);
  const toggleExpanded = (provider: 'openai' | 'gemini') => {
    setExpandedByProvider((prev) => ({ ...prev, [provider]: !prev[provider] }));
  };

  type ProviderStatusRow = {
    provider: string;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    errorMessage: string | null;
  };

  const renderProviderBlock = (provider: 'openai' | 'gemini', providerResult?: ProviderStatusRow) => {
    const run = providerProgressByName.get(provider);
    const providerName = provider === 'openai' ? 'OpenAI' : 'Gemini';
    const steps = [...(run?.steps ?? [])].sort((a, b) => a.stepIndex - b.stepIndex);
    const canToggle = steps.length > 0;
    const expanded = isExpanded(provider);

    return (
      <div className="stack" key={provider}>
        <div className="provider-row">
          {providerResult?.status === 'running' ? <span className="spinner" aria-hidden /> : null}
          <span>{providerLabel(providerName, providerResult?.status)}</span>
        </div>
        {providerResult?.errorMessage ? <small className="muted">Error: {providerResult.errorMessage}</small> : null}
        {providerResult?.startedAt ? <small className="muted">Started: {new Date(providerResult.startedAt).toLocaleString()}</small> : null}
        {providerResult?.completedAt ? <small className="muted">Completed: {new Date(providerResult.completedAt).toLocaleString()}</small> : null}
        {run?.progress?.stepLabel ? (
          <small className="muted">
            {`${providerName}: ${run.progress.stepLabel} (${Math.min(
              run.progress.stepNumber ?? 0,
              run.progress.totalSteps ?? 8
            )}/${run.progress.totalSteps ?? 8})`}
          </small>
        ) : null}
        {canToggle ? (
          <button type="button" className="button-secondary provider-toggle" onClick={() => toggleExpanded(provider)}>
            {expanded ? 'Hide' : 'Expand'}
          </button>
        ) : null}
        {expanded ? (
          <div className="step-list">
            {steps.map((step) => (
              <div
                key={step.id}
                className={`step ${step.status === 'running' ? 'is-active' : ''} ${step.status === 'done' ? 'is-done' : ''} ${
                  step.status === 'failed' ? 'is-failed' : ''
                }`}
              >
                <span className="step__dot" aria-hidden />
                <span>
                  #{step.stepIndex + 1} {step.stepType.replace(/_/g, ' ')} - {step.status}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
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

          {status.refinedAt ? (
            <small className="muted">Refined: {new Date(status.refinedAt).toLocaleString()}</small>
          ) : null}
          {status.completedAt ? (
            <small className="muted">Session completed: {new Date(status.completedAt).toLocaleString()}</small>
          ) : null}
        </div>
      </details>

      <div className="stack">
        <strong>Providers</strong>
        {renderProviderBlock('openai', openai)}
        {renderProviderBlock('gemini', gemini)}
      </div>
    </div>
  );
}
