'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type Provider = 'openai' | 'gemini';

type StepDef = {
  type: string;
  label: string;
  index: number;
};

const STEPS: StepDef[] = [
  { index: 0, type: 'DEVELOP_RESEARCH_PLAN', label: '#1 Develop Research Plan' },
  { index: 1, type: 'DISCOVER_SOURCES_WITH_PLAN', label: '#2 Discover Sources With Plan' },
  { index: 2, type: 'SHORTLIST_RESULTS', label: '#3 Shortlist Results' },
  { index: 3, type: 'DEEP_READ', label: '#4 Deep Read' },
  { index: 4, type: 'EXTRACT_EVIDENCE', label: '#5 Extract Evidence' },
  { index: 5, type: 'COUNTERPOINTS', label: '#6 Counterpoints' },
  { index: 6, type: 'GAP_CHECK', label: '#7 Gap Check' },
  { index: 7, type: 'SECTION_SYNTHESIS', label: '#8 Section Synthesis' }
];

type DbStep = {
  step_index: number;
  step_type: string;
  status: string;
  output_excerpt: string;
};

type DbRun = {
  id: string;
  session_id: string;
  provider: string;
  state: string;
  question: string;
  current_step_index: number;
  created_at: string;
  stepCount: number;
  doneSteps: number;
  steps: DbStep[];
};

type StepResult = {
  stepType: string;
  stepLabel: string;
  status: 'done' | 'failed';
  rawOutput: string;
  citations: Array<{ url: string; title?: string | null }>;
  error?: string;
  durationMs: number;
};

type RunResult = {
  steps: StepResult[];
  totalDurationMs: number;
};

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function Badge({ status }: { status: string }) {
  const done = status === 'done' || status === 'completed' || status === 'DONE';
  const failed = status === 'failed' || status === 'FAILED';
  const style = done
    ? { color: '#166534', background: '#dcfce7', border: '1px solid #86efac' }
    : failed
      ? { color: '#991b1b', background: '#fee2e2', border: '1px solid #fca5a5' }
      : { color: 'var(--muted)', background: 'transparent', border: '1px solid var(--border)' };
  return (
    <span style={{ ...style, borderRadius: 8, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>{status}</span>
  );
}

function StepResultCard({ step, index }: { step: StepResult; index: number }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="card stack">
      <button type="button" className="button-secondary" onClick={() => setExpanded((v) => !v)}>
        {index + 1}. {step.stepLabel} ({step.status}, {formatMs(step.durationMs)})
      </button>
      {expanded ? (
        <>
          {step.error ? <pre>{step.error}</pre> : null}
          {step.rawOutput ? <pre>{step.rawOutput}</pre> : null}
          {step.citations.length ? (
            <div className="stack">
              <small className="muted">Citations ({step.citations.length})</small>
              {step.citations.slice(0, 10).map((c, i) => (
                <a key={`${c.url}-${i}`} href={c.url} target="_blank" rel="noreferrer">
                  [{i + 1}] {c.title || c.url}
                </a>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function DeepResearchSection() {
  const [provider, setProvider] = useState<Provider>('openai');
  const [startStep, setStartStep] = useState<string>('DEVELOP_RESEARCH_PLAN');
  const [inputMode, setInputMode] = useState<'manual' | 'db'>('manual');
  const [question, setQuestion] = useState('');
  const [priorSummary, setPriorSummary] = useState('');
  const [sourceTarget, setSourceTarget] = useState(5);
  const [maxOutputTokens, setMaxOutputTokens] = useState(2000);
  const [timeoutMin, setTimeoutMin] = useState(5);
  const [dbRuns, setDbRuns] = useState<DbRun[]>([]);
  const [dbRunsLoading, setDbRunsLoading] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [dbRunDetails, setDbRunDetails] = useState<DbRun | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (inputMode !== 'db' || dbRuns.length > 0) return;
    setDbRunsLoading(true);
    fetch('/api/debug/runs')
      .then((r) => r.json())
      .then((data: { runs: DbRun[] }) => setDbRuns(data.runs ?? []))
      .finally(() => setDbRunsLoading(false));
  }, [inputMode, dbRuns.length]);

  useEffect(() => {
    if (!selectedRunId) {
      setDbRunDetails(null);
      return;
    }
    const found = dbRuns.find((r) => r.id === selectedRunId) ?? null;
    setDbRunDetails(found);
    if (found && !question) {
      setQuestion(found.question);
    }
  }, [selectedRunId, dbRuns, question]);

  const handleRun = useCallback(async () => {
    if (!question.trim()) {
      setError('Question is required.');
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const body = {
        provider,
        startStepType: startStep,
        question,
        priorSummary,
        sourceTarget,
        maxOutputTokens,
        timeoutMs: timeoutMin * 60_000,
        existingRunId: inputMode === 'db' ? selectedRunId || null : null,
        useDbInputs: inputMode === 'db'
      };
      const resp = await fetch('/api/debug/run-from-step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error((errData as { error?: string }).error ?? `HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as RunResult;
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [provider, startStep, question, priorSummary, sourceTarget, maxOutputTokens, timeoutMin, inputMode, selectedRunId]);

  const stepsToRun = useMemo(() => STEPS.filter((s) => STEPS.findIndex((x) => x.type === startStep) <= s.index), [startStep]);

  return (
    <section className="card stack">
      <h2>Deep Research Debugger</h2>
      <div className="two-col two-col--equal">
        <div className="stack">
          <label>
            <span>Model / Provider</span>
            <div className="stack" style={{ flexDirection: 'row' }}>
              <button type="button" className={provider === 'openai' ? '' : 'button-secondary'} onClick={() => setProvider('openai')}>OpenAI</button>
              <button type="button" className={provider === 'gemini' ? '' : 'button-secondary'} onClick={() => setProvider('gemini')}>Gemini</button>
            </div>
          </label>
          <label>
            <span>Start At Stage</span>
            <select value={startStep} onChange={(e) => setStartStep(e.target.value)}>
              {STEPS.map((s) => (
                <option key={s.type} value={s.type}>{s.label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="stack">
          <small className="muted">Stages that will run ({stepsToRun.length})</small>
          <div className="stack" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {stepsToRun.map((s) => (
              <code key={s.type}>{s.label}</code>
            ))}
          </div>
        </div>
      </div>

      <label>
        <span>Input Source</span>
        <div className="stack" style={{ flexDirection: 'row' }}>
          <button type="button" className={inputMode === 'manual' ? '' : 'button-secondary'} onClick={() => setInputMode('manual')}>Manual Input</button>
          <button type="button" className={inputMode === 'db' ? '' : 'button-secondary'} onClick={() => setInputMode('db')}>From Database</button>
        </div>
      </label>

      {inputMode === 'manual' ? (
        <div className="stack">
          <label>
            <span>Research Question</span>
            <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} />
          </label>
          <label>
            <span>Prior Step Summary</span>
            <textarea value={priorSummary} onChange={(e) => setPriorSummary(e.target.value)} rows={3} />
          </label>
        </div>
      ) : (
        <div className="stack">
          {dbRunsLoading ? <small className="muted">Loading runs...</small> : null}
          <label>
            <span>Select Existing Run</span>
            <select value={selectedRunId} onChange={(e) => setSelectedRunId(e.target.value)}>
              <option value="">- Choose a run -</option>
              {dbRuns.map((run) => (
                <option key={run.id} value={run.id}>
                  [{run.provider.toUpperCase()}] {run.question.slice(0, 60)}... - {run.state} - {formatDate(run.created_at)}
                </option>
              ))}
            </select>
          </label>
          {dbRunDetails ? (
            <div className="card stack">
              <div className="stack" style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Badge status={dbRunDetails.state} />
                <small className="muted">{dbRunDetails.doneSteps}/{dbRunDetails.stepCount} steps done</small>
              </div>
              <p>{dbRunDetails.question}</p>
            </div>
          ) : null}
          <label>
            <span>Research Question</span>
            <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={2} />
          </label>
        </div>
      )}

      <div className="two-col two-col--equal">
        <label>
          <span>Source Target</span>
          <input type="number" min={1} max={30} value={sourceTarget} onChange={(e) => setSourceTarget(Number(e.target.value))} />
        </label>
        <label>
          <span>Max Tokens</span>
          <input type="number" min={300} max={8000} step={100} value={maxOutputTokens} onChange={(e) => setMaxOutputTokens(Number(e.target.value))} />
        </label>
      </div>

      <label>
        <span>Timeout (min)</span>
        <input type="number" min={1} max={20} value={timeoutMin} onChange={(e) => setTimeoutMin(Number(e.target.value))} />
      </label>

      {error ? <div className="card">{error}</div> : null}

      <button type="button" onClick={handleRun} disabled={running || !question.trim()}>
        {running ? 'Running...' : `Run ${stepsToRun.length === STEPS.length ? 'All Stages' : `From ${STEPS.find((s) => s.type === startStep)?.label}`}`}
      </button>

      {result ? (
        <div className="stack">
          <h3>Results</h3>
          <small className="muted">Total: {formatMs(result.totalDurationMs)}</small>
          {result.steps.map((step, i) => (
            <StepResultCard key={`${step.stepType}-${i}`} step={step} index={i} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ReportSection() {
  const [dbRuns, setDbRuns] = useState<DbRun[]>([]);
  const [dbRunsLoading, setDbRunsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState('');
  const [selectionType, setSelectionType] = useState<'run' | 'session'>('run');
  const [generating, setGenerating] = useState(false);
  const [missingParts, setMissingParts] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    fetch('/api/debug/runs')
      .then((r) => r.json())
      .then((data: { runs: DbRun[] }) => setDbRuns(data.runs ?? []))
      .finally(() => setDbRunsLoading(false));
  }, []);

  const sessionMap = new Map<string, DbRun[]>();
  for (const run of dbRuns) {
    const arr = sessionMap.get(run.session_id) ?? [];
    arr.push(run);
    sessionMap.set(run.session_id, arr);
  }
  const sessions = Array.from(sessionMap.entries()).map(([sessionId, runs]) => ({
    sessionId,
    runs,
    question: runs[0]?.question ?? sessionId,
    created_at: runs[0]?.created_at ?? ''
  }));

  const selectedRun = selectionType === 'run' ? dbRuns.find((r) => r.id === selectedId) : null;
  const selectedSession = selectionType === 'session' ? sessions.find((s) => s.sessionId === selectedId) : null;

  const handleGenerate = useCallback(async () => {
    if (!selectedId) return;
    setGenerating(true);
    setMissingParts(null);
    setError(null);
    setSuccess(false);

    try {
      const body = selectionType === 'run' ? { runId: selectedId } : { sessionId: selectedId };
      const resp = await fetch('/api/debug/generate-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (resp.status === 422) {
        const data = (await resp.json()) as { error: string; missingParts: string[] };
        setMissingParts(data.missingParts ?? [data.error]);
        return;
      }

      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${resp.status}`);
      }

      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `debug-report-${Date.now()}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setSuccess(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }, [selectedId, selectionType]);

  return (
    <section className="card stack">
      <h2>Report Generation</h2>
      <label>
        <span>Select By</span>
        <div className="stack" style={{ flexDirection: 'row' }}>
          <button type="button" className={selectionType === 'run' ? '' : 'button-secondary'} onClick={() => { setSelectionType('run'); setSelectedId(''); }}>
            Individual Run
          </button>
          <button type="button" className={selectionType === 'session' ? '' : 'button-secondary'} onClick={() => { setSelectionType('session'); setSelectedId(''); }}>
            Full Session
          </button>
        </div>
      </label>

      {dbRunsLoading ? <small className="muted">Loading...</small> : (
        <label>
          <span>{selectionType === 'run' ? 'Research Run' : 'Session'}</span>
          <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
            <option value="">- Select -</option>
            {selectionType === 'run'
              ? dbRuns.map((run) => (
                  <option key={run.id} value={run.id}>
                    [{run.provider.toUpperCase()}] {run.question.slice(0, 55)}... - {run.state} - {formatDate(run.created_at)}
                  </option>
                ))
              : sessions.map((s) => (
                  <option key={s.sessionId} value={s.sessionId}>
                    {s.question.slice(0, 65)}... ({s.runs.length} runs) - {formatDate(s.created_at)}
                  </option>
                ))}
          </select>
        </label>
      )}

      {selectedRun ? <p>{selectedRun.question}</p> : null}
      {selectedSession ? <p>{selectedSession.question}</p> : null}

      {missingParts?.length ? (
        <div className="card stack">
          <strong>Cannot generate report - missing required data:</strong>
          {missingParts.map((part) => <small key={part}>{part}</small>)}
        </div>
      ) : null}

      {error ? <div className="card">{error}</div> : null}
      {success ? <div className="card">Report downloaded successfully.</div> : null}

      <button type="button" onClick={handleGenerate} disabled={generating || !selectedId}>
        {generating ? 'Generating...' : 'Generate & Download PDF Report'}
      </button>
    </section>
  );
}

export default function DebugPage() {
  return (
    <div className="stack" style={{ paddingTop: 8 }}>
      <div className="card stack">
        <h1>Deep Research Debug</h1>
        <small className="muted">Test pipeline stages and report generation</small>
      </div>
      <DeepResearchSection />
      <ReportSection />
    </div>
  );
}
