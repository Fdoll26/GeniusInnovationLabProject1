// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import ThemeInitializer from '../../app/(research)/components/ThemeInitializer';

describe('ThemeInitializer', () => {
  it('applies theme from user-settings-updated event', async () => {
    document.documentElement.dataset.theme = 'light';
    render(<ThemeInitializer />);

    window.dispatchEvent(new CustomEvent('user-settings-updated', { detail: { theme: 'dark' } }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

