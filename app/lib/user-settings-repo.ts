import { query } from './db';

export type ModelProvider = 'openai' | 'gemini';
export type ReasoningLevel = 'low' | 'high';
export type ReportSummaryMode = 'one' | 'two';
export type ThemeMode = 'light' | 'dark';
export type ResearchMode = 'native' | 'custom';
export type ResearchDepth = 'light' | 'standard' | 'deep';

export type UserSettings = {
  user_id: string;
  refine_provider: ModelProvider;
  summarize_provider: ModelProvider;
  max_sources: number;
  openai_timeout_minutes: number;
  gemini_timeout_minutes: number;
  reasoning_level: ReasoningLevel;
  report_summary_mode: ReportSummaryMode;
  report_include_refs_in_summary: boolean;
  theme: ThemeMode;
  research_provider: ModelProvider;
  research_mode: ResearchMode;
  research_depth: ResearchDepth;
  research_max_steps: number;
  research_target_sources_per_step: number;
  research_max_total_sources: number;
  research_max_tokens_per_step: number;
};

export type UserSettingsUpdate = Partial<Omit<UserSettings, 'user_id'>>;

const DEFAULT_SETTINGS: Omit<UserSettings, 'user_id'> = {
  refine_provider: 'openai',
  summarize_provider: 'openai',
  max_sources: 15,
  openai_timeout_minutes: 10,
  gemini_timeout_minutes: 10,
  reasoning_level: 'low',
  report_summary_mode: 'two',
  report_include_refs_in_summary: true,
  theme: 'light',
  research_provider: 'openai',
  research_mode: 'custom',
  research_depth: 'standard',
  research_max_steps: 8,
  research_target_sources_per_step: 5,
  research_max_total_sources: 40,
  research_max_tokens_per_step: 1800
};

function clampInt(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function coerceProvider(value: unknown): ModelProvider | null {
  return value === 'openai' || value === 'gemini' ? value : null;
}

function coerceReasoning(value: unknown): ReasoningLevel | null {
  return value === 'low' || value === 'high' ? value : null;
}

function coerceSummaryMode(value: unknown): ReportSummaryMode | null {
  return value === 'one' || value === 'two' ? value : null;
}

function coerceTheme(value: unknown): ThemeMode | null {
  return value === 'light' || value === 'dark' ? value : null;
}

function coerceResearchMode(value: unknown): ResearchMode | null {
  return value === 'native' || value === 'custom' ? value : null;
}

function coerceResearchDepth(value: unknown): ResearchDepth | null {
  return value === 'light' || value === 'standard' || value === 'deep' ? value : null;
}

export function normalizeUserSettingsUpdate(update: unknown): UserSettingsUpdate {
  const obj = (update && typeof update === 'object' ? update : {}) as Record<string, unknown>;
  const normalized: UserSettingsUpdate = {};

  const refineProvider = coerceProvider(obj.refine_provider);
  if (refineProvider) normalized.refine_provider = refineProvider;

  const summarizeProvider = coerceProvider(obj.summarize_provider);
  if (summarizeProvider) normalized.summarize_provider = summarizeProvider;

  const maxSources = clampInt(obj.max_sources, 1, 50);
  if (maxSources !== null) normalized.max_sources = maxSources;

  const openaiTimeout = clampInt(obj.openai_timeout_minutes, 1, 20);
  if (openaiTimeout !== null) normalized.openai_timeout_minutes = openaiTimeout;

  const geminiTimeout = clampInt(obj.gemini_timeout_minutes, 1, 20);
  if (geminiTimeout !== null) normalized.gemini_timeout_minutes = geminiTimeout;

  const reasoning = coerceReasoning(obj.reasoning_level);
  if (reasoning) normalized.reasoning_level = reasoning;

  const summaryMode = coerceSummaryMode(obj.report_summary_mode);
  if (summaryMode) normalized.report_summary_mode = summaryMode;

  if (typeof obj.report_include_refs_in_summary === 'boolean') {
    normalized.report_include_refs_in_summary = obj.report_include_refs_in_summary;
  }

  const theme = coerceTheme(obj.theme);
  if (theme) normalized.theme = theme;

  const researchProvider = coerceProvider(obj.research_provider);
  if (researchProvider) normalized.research_provider = researchProvider;

  const researchMode = coerceResearchMode(obj.research_mode);
  if (researchMode) normalized.research_mode = researchMode;

  const researchDepth = coerceResearchDepth(obj.research_depth);
  if (researchDepth) normalized.research_depth = researchDepth;

  const researchMaxSteps = clampInt(obj.research_max_steps, 3, 20);
  if (researchMaxSteps !== null) normalized.research_max_steps = researchMaxSteps;

  const researchTargetSourcesPerStep = clampInt(obj.research_target_sources_per_step, 1, 20);
  if (researchTargetSourcesPerStep !== null) normalized.research_target_sources_per_step = researchTargetSourcesPerStep;

  const researchMaxTotalSources = clampInt(obj.research_max_total_sources, 5, 300);
  if (researchMaxTotalSources !== null) normalized.research_max_total_sources = researchMaxTotalSources;

  const researchMaxTokensPerStep = clampInt(obj.research_max_tokens_per_step, 300, 8000);
  if (researchMaxTokensPerStep !== null) normalized.research_max_tokens_per_step = researchMaxTokensPerStep;

  return normalized;
}

export async function getUserSettings(userId: string): Promise<UserSettings> {
  try {
    const rows = await query<UserSettings>('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
    const existing = rows[0];
    if (existing) {
      return existing;
    }
    return { user_id: userId, ...DEFAULT_SETTINGS };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes('user_settings') && msg.toLowerCase().includes('does not exist')) {
      return { user_id: userId, ...DEFAULT_SETTINGS };
    }
    throw error;
  }
}

export async function upsertUserSettings(userId: string, update: UserSettingsUpdate): Promise<UserSettings> {
  const next: Omit<UserSettings, 'user_id'> = { ...DEFAULT_SETTINGS, ...update };
  try {
    const rows = await query<UserSettings>(
      `INSERT INTO user_settings (
         user_id,
         refine_provider,
         summarize_provider,
         max_sources,
         openai_timeout_minutes,
         gemini_timeout_minutes,
         reasoning_level,
         report_summary_mode,
         report_include_refs_in_summary,
         theme,
         research_provider,
         research_mode,
         research_depth,
         research_max_steps,
         research_target_sources_per_step,
         research_max_total_sources,
         research_max_tokens_per_step,
         updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
       ON CONFLICT (user_id) DO UPDATE SET
         refine_provider = EXCLUDED.refine_provider,
         summarize_provider = EXCLUDED.summarize_provider,
         max_sources = EXCLUDED.max_sources,
         openai_timeout_minutes = EXCLUDED.openai_timeout_minutes,
         gemini_timeout_minutes = EXCLUDED.gemini_timeout_minutes,
         reasoning_level = EXCLUDED.reasoning_level,
         report_summary_mode = EXCLUDED.report_summary_mode,
         report_include_refs_in_summary = EXCLUDED.report_include_refs_in_summary,
         theme = EXCLUDED.theme,
         research_provider = EXCLUDED.research_provider,
         research_mode = EXCLUDED.research_mode,
         research_depth = EXCLUDED.research_depth,
         research_max_steps = EXCLUDED.research_max_steps,
         research_target_sources_per_step = EXCLUDED.research_target_sources_per_step,
         research_max_total_sources = EXCLUDED.research_max_total_sources,
         research_max_tokens_per_step = EXCLUDED.research_max_tokens_per_step,
         updated_at = now()
       RETURNING *`,
      [
        userId,
        next.refine_provider,
        next.summarize_provider,
        next.max_sources,
        next.openai_timeout_minutes,
        next.gemini_timeout_minutes,
        next.reasoning_level,
        next.report_summary_mode,
        next.report_include_refs_in_summary,
        next.theme
        ,
        next.research_provider,
        next.research_mode,
        next.research_depth,
        next.research_max_steps,
        next.research_target_sources_per_step,
        next.research_max_total_sources,
        next.research_max_tokens_per_step
      ]
    );
    return rows[0];
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes('column') && msg.toLowerCase().includes('theme') && msg.toLowerCase().includes('does not exist')) {
      throw new Error('User settings theme column missing. Run db/migrations/004_user_settings_theme.sql.');
    }
    if (msg.toLowerCase().includes('user_settings') && msg.toLowerCase().includes('does not exist')) {
      throw new Error('User settings table missing. Run db/migrations/003_user_settings.sql.');
    }
    throw error;
  }
}
