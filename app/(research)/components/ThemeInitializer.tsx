'use client';

import { useEffect } from 'react';

export default function ThemeInitializer() {
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Settings fetch timeout')), 8000);
    fetch('/api/settings', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!active || !data) return;
        const theme = (data as { theme?: unknown }).theme;
        if (theme === 'dark' || theme === 'light') {
          document.documentElement.dataset.theme = theme;
        }
      })
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  return null;
}

