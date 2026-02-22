'use client';

import { useEffect, useMemo, useState } from 'react';
import { applyTheme, type ThemeMode } from '../lib/theme';

type Settings = {
  refine_provider: 'openai' | 'gemini';
  summarize_provider: 'openai' | 'gemini';
  max_sources: number;
  openai_timeout_minutes: number;
  gemini_timeout_minutes: number;
  reasoning_level: 'low' | 'high';
  report_summary_mode: 'one' | 'two';
  report_include_refs_in_summary: boolean;
  theme: 'light' | 'dark';
};

const defaultSettings: Settings = {
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

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await fetch('/api/settings');
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const data = (await response.json()) as Settings;
        if (!active) return;
        const merged = { ...defaultSettings, ...data };
        setSettings(merged);
        if (merged.theme === 'light' || merged.theme === 'dark') {
          applyTheme(merged.theme as ThemeMode);
        }
        setError(null);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load settings');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const canSave = useMemo(() => !loading && !saving, [loading, saving]);

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const data = (await response.json()) as Settings;
      const merged = { ...defaultSettings, ...data };
      setSettings(merged);
      if (merged.theme === 'light' || merged.theme === 'dark') {
        applyTheme(merged.theme as ThemeMode);
      }
      window.dispatchEvent(new CustomEvent('user-settings-updated', { detail: merged }));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card stack">
      <h3>Settings</h3>
      {loading ? <p>Loading…</p> : null}
      {error ? <p role="alert">Error: {error}</p> : null}

      {!loading ? (
        <>
          <div className="two-col two-col--equal">
            <label className="stack">
              <span>Refine provider</span>
              <select
                value={settings.refine_provider}
                onChange={(event) => setSettings((prev) => ({ ...prev, refine_provider: event.target.value as Settings['refine_provider'] }))}
              >
                <option value="openai">OpenAI</option>
                <option value="gemini">Gemini</option>
              </select>
            </label>

            <label className="stack">
              <span>Summarize provider</span>
              <select
                value={settings.summarize_provider}
                onChange={(event) =>
                  setSettings((prev) => ({ ...prev, summarize_provider: event.target.value as Settings['summarize_provider'] }))
                }
              >
                <option value="openai">OpenAI</option>
                <option value="gemini">Gemini</option>
              </select>
            </label>
          </div>

          <div className="two-col two-col--equal">
            <label className="stack">
              <span>Max sources (1–20)</span>
              <input
                type="number"
                min={1}
                max={20}
                value={settings.max_sources}
                onChange={(event) => setSettings((prev) => ({ ...prev, max_sources: Number(event.target.value) }))}
              />
            </label>

            <label className="stack">
              <span>Reasoning level</span>
              <select
                value={settings.reasoning_level}
                onChange={(event) => setSettings((prev) => ({ ...prev, reasoning_level: event.target.value as Settings['reasoning_level'] }))}
              >
                <option value="low">Low</option>
                <option value="high">High</option>
              </select>
            </label>
          </div>

          <div className="two-col two-col--equal">
            <label className="stack">
              <span>OpenAI timeout (minutes)</span>
              <input
                type="number"
                min={1}
                max={20}
                value={settings.openai_timeout_minutes}
                onChange={(event) => setSettings((prev) => ({ ...prev, openai_timeout_minutes: Number(event.target.value) }))}
              />
            </label>

            <label className="stack">
              <span>Gemini timeout (minutes)</span>
              <input
                type="number"
                min={1}
                max={20}
                value={settings.gemini_timeout_minutes}
                onChange={(event) => setSettings((prev) => ({ ...prev, gemini_timeout_minutes: Number(event.target.value) }))}
              />
            </label>
          </div>

          <div className="two-col two-col--equal">
            <label className="stack">
              <span>Report summary mode</span>
              <select
                value={settings.report_summary_mode}
                onChange={(event) =>
                  setSettings((prev) => ({ ...prev, report_summary_mode: event.target.value as Settings['report_summary_mode'] }))
                }
              >
                <option value="two">Two (OpenAI + Gemini)</option>
                <option value="one">One (Combined)</option>
              </select>
            </label>

            <label className="stack">
              <span>Theme</span>
              <select
                value={settings.theme}
                onChange={(event) => {
                  const nextTheme = event.target.value as ThemeMode;
                  setSettings((prev) => ({ ...prev, theme: nextTheme }));
                  if (nextTheme === 'light' || nextTheme === 'dark') {
                    applyTheme(nextTheme);
                  }
                }}
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
          </div>

          <label className="settings__checkbox">
            <input
              type="checkbox"
              checked={settings.report_include_refs_in_summary}
              onChange={(event) => setSettings((prev) => ({ ...prev, report_include_refs_in_summary: event.target.checked }))}
            />
            <span>Include references in summary</span>
          </label>

          <div className="row">
            <button type="button" onClick={save} disabled={!canSave}>
              {saving ? 'Saving…' : 'Save settings'}
            </button>
            {saved ? <small className="muted">Saved.</small> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
