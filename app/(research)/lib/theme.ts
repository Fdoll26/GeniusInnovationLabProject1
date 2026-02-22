export type ThemeMode = 'light' | 'dark';

export function applyTheme(theme: ThemeMode) {
  document.documentElement.dataset.theme = theme;
}

