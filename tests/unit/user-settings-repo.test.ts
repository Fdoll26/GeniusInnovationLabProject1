// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../../app/lib/db', () => ({ query: (...args: any[]) => query(...args) }));

import { getUserSettings, normalizeUserSettingsUpdate, upsertUserSettings } from '../../app/lib/user-settings-repo';

describe('normalizeUserSettingsUpdate', () => {
  it('coerces and clamps values', () => {
    const result = normalizeUserSettingsUpdate({
      refine_provider: 'gemini',
      summarize_provider: 'openai',
      max_sources: '999',
      openai_timeout_minutes: 0,
      gemini_timeout_minutes: 3.7,
      reasoning_level: 'high',
      report_summary_mode: 'one',
      report_include_refs_in_summary: false,
      theme: 'dark',
      ignored: 'x'
    });

    expect(result).toEqual({
      refine_provider: 'gemini',
      summarize_provider: 'openai',
      max_sources: 100,
      openai_timeout_minutes: 1,
      gemini_timeout_minutes: 3,
      reasoning_level: 'high',
      report_summary_mode: 'one',
      report_include_refs_in_summary: false,
      theme: 'dark'
    });
  });

  it('drops invalid enum values', () => {
    const result = normalizeUserSettingsUpdate({
      refine_provider: 'nope',
      summarize_provider: null,
      reasoning_level: 'medium',
      report_summary_mode: 'three',
      theme: 'blue'
    });
    expect(result).toEqual({});
  });
});

describe('getUserSettings', () => {
  it('returns defaults when table is missing', async () => {
    query.mockRejectedValueOnce(new Error('relation "user_settings" does not exist'));
    const settings = await getUserSettings('u1');
    expect(settings.user_id).toBe('u1');
    expect(settings.refine_provider).toBe('openai');
  });
});

describe('upsertUserSettings', () => {
  it('surfaces a helpful error when theme column is missing', async () => {
    query.mockRejectedValueOnce(new Error('column "theme" of relation "user_settings" does not exist'));
    await expect(upsertUserSettings('u1', { theme: 'dark' })).rejects.toThrow(
      /theme column missing\. Run db\/migrations\/004_user_settings_theme\.sql/i
    );
  });
});
