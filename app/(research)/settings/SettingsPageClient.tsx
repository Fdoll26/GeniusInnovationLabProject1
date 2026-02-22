'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type ModelProvider = 'openai' | 'gemini';
type ReasoningLevel = 'low' | 'high';
type ReportSummaryMode = 'one' | 'two';
type ThemeMode = 'light' | 'dark';

type UserSettings = {
  refine_provider: ModelProvider;
  summarize_provider: ModelProvider;
  max_sources: number;
  openai_timeout_minutes: number;
  gemini_timeout_minutes: number;
  reasoning_level: ReasoningLevel;
  report_summary_mode: ReportSummaryMode;
  report_include_refs_in_summary: boolean;
  theme: ThemeMode;
};

const defaultSettings: UserSettings = {
  refine_provider: 'openai',
  summarize_provider: 'openai',
  max_sources: 15,
  openai_timeout_minutes: 10,
  gemini_timeout_minutes: 10,
  reasoning_level: 'low',
  report_summary_mode: 'two',
  report_include_refs_in_summary: true,
  theme: 'light'
};

function toInt(value: string) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export default function SettingsPageClient() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<UserSettings>(defaultSettings);
  const [savedSettings, setSavedSettings] = useState<UserSettings>(defaultSettings);
  const [dirty, setDirty] = useState(false);
  const latestSettingsRef = useRef<UserSettings>(defaultSettings);
  const dirtyRef = useRef(false);
  const saveSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch('/api/settings');
        if (!res.ok) {
          throw new Error(await res.text());
        }
        const data = (await res.json()) as UserSettings;
        if (!cancelled) {
          const merged = { ...defaultSettings, ...data };
          setSettings(merged);
          setSavedSettings(merged);
          setDirty(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load settings');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    latestSettingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const saveDisabled = useMemo(() => loading || saving || !dirty, [loading, saving, dirty]);

  async function save(nextSettings?: UserSettings) {
    try {
      setSaving(true);
      setError(null);
      const seq = ++saveSeqRef.current;
      const payload = nextSettings ?? latestSettingsRef.current;
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = (await res.json()) as UserSettings;
      // Ignore out-of-order saves (e.g., debounced autosave vs manual save).
      if (seq !== saveSeqRef.current) return;
      const merged = { ...defaultSettings, ...data };
      setSettings(merged);
      setSavedSettings(merged);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  // Auto-save changes so settings persist even if the user navigates away without clicking "Save".
  useEffect(() => {
    if (loading || saving || !dirty) return;
    const timer = setTimeout(() => {
      void save();
    }, 700);
    return () => clearTimeout(timer);
  }, [dirty, loading, saving, settings]); // settings changes reset the debounce

  // Best-effort flush on unmount (e.g., leaving the page quickly).
  useEffect(() => {
    return () => {
      if (!dirtyRef.current) return;
      try {
        void fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(latestSettingsRef.current),
          keepalive: true
        });
      } catch {
        // best-effort
      }
    };
  }, []);

  if (loading) {
    return (
      <main className="container stack">
        <h1>Settings</h1>
        <div className="card">Loading…</div>
      </main>
    );
  }

  return (
    <main className="container stack">
      <h1>Settings</h1>
      {error ? (
        <div className="card" role="alert">
          {error}
        </div>
      ) : null}

      <section className="card stack">
        <h2>Models</h2>

        <div className="stack">
          <label className="row">
            <span>Refining (clarifications + refined prompt)</span>
            <select
              value={settings.refine_provider}
              onChange={(e) => {
                setSettings((s) => ({ ...s, refine_provider: e.target.value as ModelProvider }));
                setDirty(true);
              }}
            >
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option>
            </select>
          </label>

          <label className="row">
            <span>Summarizing (report summaries)</span>
            <select
              value={settings.summarize_provider}
              onChange={(e) => {
                setSettings((s) => ({ ...s, summarize_provider: e.target.value as ModelProvider }));
                setDirty(true);
              }}
            >
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option>
            </select>
          </label>
        </div>
      </section>

      <section className="card stack">
        <h2>Appearance</h2>
        <label className="row">
          <span>Dark mode</span>
          <input
            type="checkbox"
            checked={settings.theme === 'dark'}
            onChange={(e) => {
              setSettings((s) => ({ ...s, theme: e.target.checked ? 'dark' : 'light' }));
              setDirty(true);
            }}
          />
        </label>
      </section>

      <section className="card stack">
        <h2>Budgets</h2>

        <label className="stack">
          <div className="row">
            <span>Max sources</span>
            <span>{settings.max_sources}</span>
          </div>
          <input
            type="range"
            min={1}
            max={20}
            value={settings.max_sources}
            onChange={(e) => {
              setSettings((s) => ({ ...s, max_sources: toInt(e.target.value) }));
              setDirty(true);
            }}
          />
        </label>

        <label className="stack">
          <div className="row">
            <span>OpenAI timeout</span>
            <span>{settings.openai_timeout_minutes} min</span>
          </div>
          <input
            type="range"
            min={1}
            max={20}
            value={settings.openai_timeout_minutes}
            onChange={(e) => {
              setSettings((s) => ({ ...s, openai_timeout_minutes: toInt(e.target.value) }));
              setDirty(true);
            }}
          />
        </label>

        <label className="stack">
          <div className="row">
            <span>Gemini timeout</span>
            <span>{settings.gemini_timeout_minutes} min</span>
          </div>
          <input
            type="range"
            min={1}
            max={20}
            value={settings.gemini_timeout_minutes}
            onChange={(e) => {
              setSettings((s) => ({ ...s, gemini_timeout_minutes: toInt(e.target.value) }));
              setDirty(true);
            }}
          />
        </label>
      </section>

      <section className="card stack">
        <h2>Reasoning</h2>

        <label className="row">
          <span>Reasoning level</span>
          <select
            value={settings.reasoning_level}
            onChange={(e) => {
              setSettings((s) => ({ ...s, reasoning_level: e.target.value as ReasoningLevel }));
              setDirty(true);
            }}
          >
            <option value="low">Low</option>
            <option value="high">High</option>
          </select>
        </label>
      </section>

      <section className="card stack">
        <h2>Report format</h2>

        <label className="row">
          <span>Summary layout</span>
          <select
            value={settings.report_summary_mode}
            onChange={(e) => {
              setSettings((s) => ({ ...s, report_summary_mode: e.target.value as ReportSummaryMode }));
              setDirty(true);
            }}
          >
            <option value="two">Two summaries (OpenAI + Gemini)</option>
            <option value="one">One combined summary</option>
          </select>
        </label>

        <label className="row">
          <span>References in summary</span>
          <input
            type="checkbox"
            checked={settings.report_include_refs_in_summary}
            onChange={(e) => {
              setSettings((s) => ({ ...s, report_include_refs_in_summary: e.target.checked }));
              setDirty(true);
            }}
          />
        </label>
      </section>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 12 }}>
        <button
          type="button"
          className="secondary"
          disabled={loading || saving || !dirty}
          onClick={() => {
            setSettings(savedSettings);
            setDirty(false);
          }}
        >
          Discard changes
        </button>
        <button type="button" disabled={saveDisabled} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </main>
  );
}
