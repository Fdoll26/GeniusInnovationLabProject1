'use client';

import { useEffect } from 'react';
import { applyTheme, type ThemeMode } from '../lib/theme';

export default function ThemeInitializer() {
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Settings fetch timeout')), 8000);

    const onSettingsUpdated = (event: Event) => {
      const typed = event as CustomEvent<{ theme?: unknown }>;
      const next = typed?.detail?.theme;
      if (next === 'light' || next === 'dark') {
        applyTheme(next);
      }
    };
    window.addEventListener('user-settings-updated', onSettingsUpdated as EventListener);

    fetch('/api/settings', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!active || !data) return;
        const theme = (data as { theme?: unknown }).theme;
        if (theme === 'dark' || theme === 'light') {
          applyTheme(theme as ThemeMode);
        }
      })
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
      window.removeEventListener('user-settings-updated', onSettingsUpdated as EventListener);
    };
  }, []);

  return null;
}
