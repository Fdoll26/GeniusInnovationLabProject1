import { getResponseOutputText, getResponseSources, pollDeepResearch, runResearch, startRefinement, rewritePrompt, summarizeForReport } from './openai-client';
import { runGemini, rewritePromptGemini, startRefinementGemini, summarizeForReportGemini } from './gemini-client';
import { createQuestions, getNextQuestion, listQuestions } from './refinement-repo';
import { updateSessionState, getSessionById } from './session-repo';
import { upsertProviderResult, listProviderResults } from './provider-repo';
import { buildPdfReport } from './pdf-report';
import { claimReportSendForSession, createReport, getReportBySession, updateReportContent, updateReportEmail, checkReportTiming } from './report-repo';
import { sendReportEmail } from './email-sender';
import type { SessionState } from './session-state';
import { getUserSettings } from './user-settings-repo';
import { pool } from './db';

const researchQueueTimeoutMs = 20 * 60_000;
const providerQueueKeys = {
  openai: 'deep_research_queue_openai_v1',
  gemini: 'deep_research_queue_gemini_v1'
} as const;
const inMemoryQueues: Record<'openai' | 'gemini', { active: number; queue: Array<() => void> }> = {
  openai: { active: 0, queue: [] },
  gemini: { active: 0, queue: [] }
};
const inMemorySessionLocks = new Set<string>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireInMemoryQueue(provider: 'openai' | 'gemini') {
  const q = inMemoryQueues[provider];
  if (q.active < 1) {
    q.active += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    q.queue.push(() => {
      q.active += 1;
      resolve();
    });
  });
}

function releaseInMemoryQueue(provider: 'openai' | 'gemini') {
  const q = inMemoryQueues[provider];
  q.active = Math.max(0, q.active - 1);
  const next = q.queue.shift();
  if (next) next();
}

async function acquirePgQueueLock(lockKey: string, timeoutMs: number) {
  if (!pool) {
    throw new Error('DATABASE_URL is not set');
  }
  // IMPORTANT: advisory locks are held per-connection. We must keep the client checked out
  // for the duration of the queued work; otherwise the pool may close idle clients and
  // release the lock early.
  const client = await pool.connect();
  const start = Date.now();
  let delayMs = 600;
  while (Date.now() - start < timeoutMs) {
    const result = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [lockKey]);
    if (result.rows[0]?.ok) {
      return client;
    }
    await sleep(delayMs);
    delayMs = Math.min(3000, Math.floor(delayMs * 1.15));
  }
  client.release();
  throw new Error('Deep research queue timed out waiting for slot.');
}

async function releasePgQueueLock(lockKey: string, client: { query: (text: string, params?: any[]) => Promise<any>; release: () => void }) {
  try {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
  } catch {
    // best-effort
  } finally {
    try {
      client.release();
    } catch {
      // ignore
    }
  }
}

async function withProviderDeepResearchQueue<T>(provider: 'openai' | 'gemini', fn: () => Promise<T>): Promise<T> {
  const lockKey = providerQueueKeys[provider];
  if (pool) {
    const client = await acquirePgQueueLock(lockKey, researchQueueTimeoutMs);
    try {
      return await fn();
    } finally {
      await releasePgQueueLock(lockKey, client as any);
    }
  }
  await acquireInMemoryQueue(provider);
  try {
    return await fn();
  } finally {
    releaseInMemoryQueue(provider);
  }
}

async function withSessionRunLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T | null> {
  const lockKey = `session_run:${sessionId}`;
  if (pool) {
    const client = await pool.connect();
    try {
      const result = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [lockKey]);
      if (!result.rows[0]?.ok) {
        return null;
      }
      try {
        return await fn();
      } finally {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
        } catch {
          // best-effort
        }
      }
    } finally {
      client.release();
    }
  }

  if (inMemorySessionLocks.has(lockKey)) {
    return null;
  }
  inMemorySessionLocks.add(lockKey);
  try {
    return await fn();
  } finally {
    inMemorySessionLocks.delete(lockKey);
  }
}

export async function regenerateReportForSession(
  sessionId: string,
  opts?: { stub?: boolean; stubPdf?: boolean; stubEmail?: boolean }
): Promise<{ reportId: string }> {
  const session = await getSessionById(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  if (session.state !== 'completed' && session.state !== 'partial') {
    throw new Error('Report regeneration is only available for completed sessions.');
  }
  const settings = await getUserSettings(session.user_id);

  const results = await listProviderResults(sessionId);
  const openaiResult = results.find((result) => result.provider === 'openai');
  const geminiResult = results.find((result) => result.provider === 'gemini');

  const summary = `OpenAI: ${openaiResult?.status ?? 'unknown'} | Gemini: ${geminiResult?.status ?? 'unknown'}`;

  const accessedAt = new Date().toISOString();
  const openaiSources = extractLinksFromText(openaiResult?.output_text ?? '');
  const geminiSourcesRaw = extractLinksFromText(geminiResult?.output_text ?? '');

  const globalRefMap = new Map<string, number>();
  const openaiRefs = openaiSources.map((source, index) => {
    const n = index + 1;
    globalRefMap.set(source.url, n);
    return { n, ...source, accessedAt };
  });
  const geminiRefs: Array<{ n: number; url: string; title?: string; accessedAt: string }> = [];
  for (const source of geminiSourcesRaw) {
    if (globalRefMap.has(source.url)) {
      continue;
    }
    const n = globalRefMap.size + 1;
    globalRefMap.set(source.url, n);
    geminiRefs.push({ n, ...source, accessedAt });
  }

  const openaiTextWithRefs = openaiResult?.output_text ? replaceLinksWithRefs(openaiResult.output_text, globalRefMap) : null;
  const geminiTextWithRefs = geminiResult?.output_text ? replaceLinksWithRefs(geminiResult.output_text, globalRefMap) : null;

  const includeRefs = settings.report_include_refs_in_summary;
  type SummaryRef = { n: number; title?: string; url: string; accessedAt?: string };
  const summarize = async (provider: 'OpenAI' | 'Gemini' | 'Combined', text: string, refs: SummaryRef[]) => {
    if (settings.summarize_provider === 'gemini') {
      return summarizeForReportGemini(
        { provider, researchText: text, references: refs },
        { stub: opts?.stub ?? false, timeoutMs: settings.gemini_timeout_minutes * 60_000, includeRefs }
      );
    }
    return summarizeForReport(
      { provider: provider === 'Combined' ? 'OpenAI' : provider, researchText: text, references: refs },
      { stub: opts?.stub ?? false, timeoutMs: settings.openai_timeout_minutes * 60_000, includeRefs }
    );
  };

  let finalOpenaiSummary = 'No OpenAI result available.';
  let finalGeminiSummary = 'No Gemini result available.';

  if (settings.report_summary_mode === 'one') {
    const combinedText = [openaiTextWithRefs, geminiTextWithRefs].filter(Boolean).join('\n\n');
    const combinedRefs = [...openaiRefs, ...geminiRefs];
    finalOpenaiSummary = combinedText ? await summarize('Combined', combinedText, combinedRefs) : 'No research result available.';
    finalGeminiSummary = '';
  } else {
    finalOpenaiSummary = openaiTextWithRefs ? await summarize('OpenAI', openaiTextWithRefs, openaiRefs) : finalOpenaiSummary;
    finalGeminiSummary = geminiTextWithRefs ? await summarize('Gemini', geminiTextWithRefs, geminiRefs) : finalGeminiSummary;
  }

  const pdfBuffer = await buildPdfReport(
    {
      sessionId,
      topic: session.topic,
      refinedPrompt: session.refined_prompt,
      summaryMode: settings.report_summary_mode,
      openaiSummary: finalOpenaiSummary,
      geminiSummary: finalGeminiSummary,
      references: {
        openai: openaiRefs,
        gemini: geminiRefs
      },
      openaiText: openaiTextWithRefs ?? null,
      geminiText: geminiTextWithRefs ?? null,
      openaiSources: openaiResult?.sources_json ?? null,
      geminiSources: geminiResult?.sources_json ?? null,
      createdAt: session.created_at
    },
    { stub: opts?.stubPdf ?? opts?.stub }
  );

  // Do not overwrite previously sent reports. Create a fresh report row for this resend.
  const report = await createReport({ sessionId, summary, pdfBuffer, emailStatus: 'pending' });

  const email = await resolveUserEmail(sessionId);
  try {
    await sendReportEmail(
      {
        to: email,
        subject: 'Your Research Report',
        summary: report.summary_text || summary,
        pdfBuffer
      },
      { stub: opts?.stubEmail ?? opts?.stub }
    );
    await updateReportEmail({
      reportId: report.id,
      emailStatus: 'sent',
      sentAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Regenerated report email send failed', error);
    await updateReportEmail({
      reportId: report.id,
      emailStatus: 'failed',
      emailError: error instanceof Error ? error.message : 'Email error'
    });
    throw error instanceof Error ? error : new Error('Email send failed');
  }

  return { reportId: report.id };
}

export async function runRefinement(
  sessionId: string,
  topic: string,
  opts?: { stub?: boolean; stubRefiner?: boolean }
) {
  const session = await getSessionById(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  const settings = await getUserSettings(session.user_id);

  const refinement =
    settings.refine_provider === 'gemini'
      ? await startRefinementGemini(topic, { stub: opts?.stubRefiner ?? opts?.stub, timeoutMs: settings.gemini_timeout_minutes * 60_000 })
      : await startRefinement(topic, { stub: opts?.stubRefiner ?? opts?.stub, timeoutMs: settings.openai_timeout_minutes * 60_000 });
  if (refinement.questions.length > 0) {
    await createQuestions({ sessionId, questions: refinement.questions });
    await updateSessionState({ sessionId, state: 'refining' });
    return;
  }

  let refinedPrompt = topic;
  try {
    if (settings.refine_provider === 'gemini') {
      refinedPrompt = await rewritePromptGemini(
        { topic, draftPrompt: topic, clarifications: [] },
        { stub: opts?.stubRefiner ?? opts?.stub, timeoutMs: settings.gemini_timeout_minutes * 60_000 }
      );
    } else {
      refinedPrompt = await rewritePrompt(
        { topic, draftPrompt: topic, clarifications: [] },
        { stub: opts?.stubRefiner ?? opts?.stub, timeoutMs: settings.openai_timeout_minutes * 60_000 }
      );
    }
  } catch (error) {
    console.error('Prompt rewrite failed, using original topic', error);
  }
  await updateSessionState({
    sessionId,
    state: 'refining',
    refinedPrompt
  });
}

export async function handleRefinementApproval(
  sessionId: string,
  refinedPrompt: string,
  opts?: {
    stub?: boolean;
    stubRefiner?: boolean;
    stubOpenAI?: boolean;
    stubGemini?: boolean;
    stubEmail?: boolean;
    stubPdf?: boolean;
    skipOpenAI?: boolean;
    skipGemini?: boolean;
  }
) {
  const questions = await listQuestions(sessionId);
  const clarifications = questions
    .filter((question) => question.answer_text)
    .map((question) => ({
      question: question.question_text,
      answer: question.answer_text as string
    }));
  let finalPrompt = refinedPrompt;
  try {
    const session = await getSessionById(sessionId);
    if (session) {
      const settings = await getUserSettings(session.user_id);
      if (settings.refine_provider === 'gemini') {
        finalPrompt = await rewritePromptGemini(
          {
            topic: session.topic,
            draftPrompt: refinedPrompt,
            clarifications
          },
          { stub: opts?.stubRefiner ?? opts?.stub, timeoutMs: settings.gemini_timeout_minutes * 60_000 }
        );
      } else {
        finalPrompt = await rewritePrompt(
          {
            topic: session.topic,
            draftPrompt: refinedPrompt,
            clarifications
          },
          { stub: opts?.stubRefiner ?? opts?.stub, timeoutMs: settings.openai_timeout_minutes * 60_000 }
        );
      }
    }
  } catch (error) {
    console.error('Prompt rewrite failed, using draft prompt', error);
  }

  await updateSessionState({
    sessionId,
    state: 'running_research',
    refinedPrompt: finalPrompt,
    refinedAt: new Date().toISOString()
  });

  await runProviders(sessionId, opts);
}

type SourceRef = { title?: string; url: string };

function stripTrailingPunctuation(url: string) {
  // Keep this conservative; we only want to remove punctuation that is very commonly adjacent.
  const match = url.match(/^(.*?)([)\],.?!:;"']+)?$/);
  if (!match) {
    return { url, suffix: '' };
  }
  const core = match[1] ?? url;
  const suffix = match[2] ?? '';
  return { url: core, suffix };
}

function extractLinksFromText(text: string, maxItems = 40): SourceRef[] {
  const out: SourceRef[] = [];
  const seen = new Set<string>();
  const regex = /https?:\/\/[^\s<>"']+/g;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    if (!raw) {
      continue;
    }
    const { url } = stripTrailingPunctuation(raw);
    if (!/^https?:\/\//i.test(url)) {
      continue;
    }
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    out.push({ url });
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

function replaceLinksWithRefs(text: string, refMap: Map<string, number>) {
  // Handle markdown links first: [label](https://example.com) -> [n]
  const markdownLinked = text.replace(/\[[^\]]+\]\((https?:\/\/[^\s<>"')]+)\)/g, (whole, url: string) => {
    const { url: cleanUrl } = stripTrailingPunctuation(url);
    const n = refMap.get(cleanUrl);
    return n ? `[${n}]` : whole;
  });

  // First handle bracketed URLs like: [https://example.com] -> [n]
  // This avoids creating doubled brackets like: [[n]].
  const bracketed = markdownLinked.replace(/\[(https?:\/\/[^\s<>"'\]]+)\]/g, (_whole, url: string) => {
    const { url: cleanUrl } = stripTrailingPunctuation(url);
    const n = refMap.get(cleanUrl);
    return n ? `[${n}]` : `[${cleanUrl}]`;
  });

  const regex = /https?:\/\/[^\s<>"']+/g;
  return bracketed.replace(regex, (raw) => {
    const { url, suffix } = stripTrailingPunctuation(raw);
    const n = refMap.get(url);
    if (!n) {
      return raw;
    }
    return `[${n}]${suffix}`;
  });
}

export async function runProviders(
  sessionId: string,
  opts?: {
    stub?: boolean;
    stubOpenAI?: boolean;
    stubGemini?: boolean;
    stubEmail?: boolean;
    stubPdf?: boolean;
    skipOpenAI?: boolean;
    skipGemini?: boolean;
  }
) {
  const didRun = await withSessionRunLock(sessionId, async () => {
    const session = await getSessionById(sessionId);
    if (!session?.refined_prompt) {
      throw new Error('Refined prompt missing');
    }
    const settings = await getUserSettings(session.user_id);

    const refinedPrompt = session.refined_prompt;
    await updateSessionState({ sessionId, state: 'running_research' });

    const existingResults = await listProviderResults(sessionId);
    const existingByProvider = new Map(existingResults.map((r) => [r.provider, r]));

    const runOpenAI = async (): Promise<{ failed: boolean }> => {
      const existing = existingByProvider.get('openai');
      if (existing?.status === 'completed') {
        return { failed: false };
      }
      if (existing?.status === 'running' && existing.external_id) {
        try {
          const openaiResult = await resumeDeepResearch(existing.external_id, {
            timeoutMs: settings.openai_timeout_minutes * 60_000
          });
          await upsertProviderResult({
            sessionId,
            provider: 'openai',
            status: 'completed',
            outputText: openaiResult.outputText,
            sources: openaiResult.sources ?? null,
            externalStatus: 'completed',
            lastPolledAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          });
          return { failed: false };
        } catch (error) {
          console.error('OpenAI resume failed', error);
          await upsertProviderResult({
            sessionId,
            provider: 'openai',
            status: 'failed',
            errorMessage: error instanceof Error ? error.message : 'OpenAI error',
            externalStatus: 'failed',
            lastPolledAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          });
          return { failed: true };
        }
      }

      if (opts?.skipOpenAI) {
        await upsertProviderResult({
          sessionId,
          provider: 'openai',
          status: 'skipped',
          outputText: 'OpenAI run skipped (debug)',
          completedAt: new Date().toISOString()
        });
        return { failed: true };
      }
      try {
        await upsertProviderResult({
          sessionId,
          provider: 'openai',
          status: 'queued',
          lastPolledAt: new Date().toISOString()
        });
        const openaiResult = await withProviderDeepResearchQueue('openai', async () => {
          await upsertProviderResult({
            sessionId,
            provider: 'openai',
            status: 'running',
            startedAt: new Date().toISOString()
          });
          return runResearch(refinedPrompt, {
            stub: opts?.stubOpenAI ?? opts?.stub,
            timeoutMs: settings.openai_timeout_minutes * 60_000,
            maxSources: settings.max_sources,
            reasoningLevel: settings.reasoning_level,
            onStarted: async ({ responseId, status }) => {
              await upsertProviderResult({
                sessionId,
                provider: 'openai',
                status: 'running',
                externalId: responseId,
                externalStatus: status ?? null,
                lastPolledAt: new Date().toISOString()
              });
            }
          });
        });
        await upsertProviderResult({
          sessionId,
          provider: 'openai',
          status: 'completed',
          outputText: openaiResult.outputText,
          sources: openaiResult.sources ?? null,
          externalId: openaiResult.responseId ?? null,
          externalStatus: 'completed',
          lastPolledAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        });
        return { failed: false };
      } catch (error) {
        console.error('OpenAI research failed', error);
        await upsertProviderResult({
          sessionId,
          provider: 'openai',
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : 'OpenAI error',
          completedAt: new Date().toISOString()
        });
        return { failed: true };
      }
    };

    const runGeminiProvider = async (): Promise<{ failed: boolean }> => {
      const existing = existingByProvider.get('gemini');
      if (existing?.status === 'completed') {
        return { failed: false };
      }
      if (existing?.status === 'running') {
        // Gemini is not resumable without a job id. Avoid duplicate launches; let syncSession
        // decide whether it has gone stale.
        return { failed: true };
      }
      if (opts?.skipGemini) {
        await upsertProviderResult({
          sessionId,
          provider: 'gemini',
          status: 'skipped',
          outputText: 'Gemini run skipped (debug)',
          completedAt: new Date().toISOString()
        });
        return { failed: true };
      }
      try {
        await upsertProviderResult({
          sessionId,
          provider: 'gemini',
          status: 'queued',
          lastPolledAt: new Date().toISOString()
        });
        const geminiResult = await withProviderDeepResearchQueue('gemini', async () => {
          await upsertProviderResult({
            sessionId,
            provider: 'gemini',
            status: 'running',
            startedAt: new Date().toISOString()
          });
          return runGemini(refinedPrompt, {
            stub: opts?.stubGemini ?? opts?.stub,
            timeoutMs: settings.gemini_timeout_minutes * 60_000,
            maxSources: settings.max_sources
          });
        });
        if (!geminiResult.outputText.trim()) {
          await upsertProviderResult({
            sessionId,
            provider: 'gemini',
            status: 'failed',
            errorMessage: 'Gemini returned empty output',
            sources: geminiResult.sources ?? null,
            completedAt: new Date().toISOString()
          });
          return { failed: true };
        }
        await upsertProviderResult({
          sessionId,
          provider: 'gemini',
          status: 'completed',
          outputText: geminiResult.outputText,
          sources: geminiResult.sources ?? null,
          completedAt: new Date().toISOString()
        });
        return { failed: false };
      } catch (error) {
        console.error('Gemini research failed', error);
        await upsertProviderResult({
          sessionId,
          provider: 'gemini',
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : 'Gemini error',
          completedAt: new Date().toISOString()
        });
        return { failed: true };
      }
    };

    const [openaiRun, geminiRun] = await Promise.all([runOpenAI(), runGeminiProvider()]);
    const openaiFailed = openaiRun.failed;
    const geminiFailed = geminiRun.failed;

    const postResults = await listProviderResults(sessionId);
    const stillInFlight = postResults.some((r) => r.status === 'running' || r.status === 'queued');
    if (stillInFlight) {
      // Another request (or a previous run) is still in flight. Do not finalize yet.
      return;
    }

    await updateSessionState({ sessionId, state: 'aggregating' });

    try {
      await finalizeReport(sessionId, openaiFailed, geminiFailed, opts);
    } catch (error) {
      console.error('Finalize report failed', error);
      await updateSessionState({
        sessionId,
        state: 'failed',
        completedAt: new Date().toISOString()
      });
    }
  });

  if (didRun === null) {
    await syncSession(sessionId, opts);
    return;
  }
}

export async function syncSession(
  sessionId: string,
  opts?: { stub?: boolean; stubPdf?: boolean; stubEmail?: boolean }
) {
  const session = await getSessionById(sessionId);
  if (!session) {
    return;
  }
  const settings = await getUserSettings(session.user_id);
  const nowIso = new Date().toISOString();
  const queuedStaleMs = Math.max(settings.openai_timeout_minutes, settings.gemini_timeout_minutes) * 60_000 + 5 * 60_000;

  if (session.state === 'aggregating') {
    const results = await listProviderResults(sessionId);
    const openai = results.find((r) => r.provider === 'openai');
    const gemini = results.find((r) => r.provider === 'gemini');
    const openaiFailed = openai?.status === 'failed' || openai?.status === 'skipped';
    const geminiFailed = gemini?.status === 'failed' || gemini?.status === 'skipped';
    await finalizeReport(sessionId, openaiFailed, geminiFailed, opts);
    return;
  }

  if (session.state !== 'running_research') {
    return;
  }

  const results = await listProviderResults(sessionId);
  const openai = results.find((r) => r.provider === 'openai');
  const gemini = results.find((r) => r.provider === 'gemini');

  const maybeRepairQueued = async (provider: 'openai' | 'gemini', result?: { status?: string; started_at?: string | null; last_polled_at?: string | null }) => {
    if (!result || result.status !== 'queued') return;
    if (result.started_at) return;
    const sinceRaw = result.last_polled_at ?? session.updated_at ?? session.created_at ?? null;
    const sinceMs = sinceRaw ? new Date(sinceRaw).getTime() : NaN;
    if (!Number.isFinite(sinceMs)) return;
    if (Date.now() - sinceMs <= queuedStaleMs) return;
    await upsertProviderResult({
      sessionId,
      provider,
      status: 'failed',
      errorMessage: 'Provider work was queued too long (likely interrupted). Retry to run again.',
      completedAt: nowIso,
      lastPolledAt: nowIso
    });
  };

  await Promise.all([
    maybeRepairQueued('openai', openai),
    maybeRepairQueued('gemini', gemini)
  ]);

  if (openai?.status === 'running' && openai.external_id) {
    try {
      const polled = await pollDeepResearch(openai.external_id, { timeoutMs: settings.openai_timeout_minutes * 60_000 });
      await upsertProviderResult({
        sessionId,
        provider: 'openai',
        status: 'running',
        externalId: openai.external_id,
        externalStatus: polled.status,
        lastPolledAt: nowIso
      });
      if (polled.status && ['completed', 'failed', 'cancelled', 'incomplete'].includes(polled.status)) {
        await upsertProviderResult({
          sessionId,
          provider: 'openai',
          status: polled.status === 'completed' ? 'completed' : 'failed',
          outputText: polled.status === 'completed' ? getResponseOutputText(polled.data) : null,
          sources: polled.status === 'completed' ? (getResponseSources(polled.data) ?? null) : null,
          completedAt: nowIso,
          externalStatus: polled.status,
          lastPolledAt: nowIso
        });
      }
    } catch (error) {
      // Ignore transient polling errors; next poll will try again.
      console.error('OpenAI poll failed', error);
    }
  }

  const staleGeminiMs = settings.gemini_timeout_minutes * 60_000 + 60_000;
  if (gemini?.status === 'running' && gemini.started_at) {
    const startedAtMs = new Date(gemini.started_at).getTime();
    if (Date.now() - startedAtMs > staleGeminiMs) {
      await upsertProviderResult({
        sessionId,
        provider: 'gemini',
        status: 'failed',
        errorMessage: 'Gemini run timed out (likely interrupted). Retry to run again.',
        completedAt: nowIso
      });
    }
  }

  const updatedResults = await listProviderResults(sessionId);
  const stillInFlight = updatedResults.some((r) => r.status === 'running' || r.status === 'queued');
  const terminal = new Set(['completed', 'failed', 'skipped']);
  const allTerminal = updatedResults.length > 0 && updatedResults.every((r) => terminal.has(r.status));
  if (!stillInFlight && allTerminal) {
    await updateSessionState({ sessionId, state: 'aggregating' });
    const openai2 = updatedResults.find((r) => r.provider === 'openai');
    const gemini2 = updatedResults.find((r) => r.provider === 'gemini');
    const openaiFailed = openai2?.status === 'failed' || openai2?.status === 'skipped';
    const geminiFailed = gemini2?.status === 'failed' || gemini2?.status === 'skipped';
    await finalizeReport(sessionId, openaiFailed, geminiFailed, opts);
  }
}

export async function finalizeReport(
  sessionId: string,
  openaiFailed: boolean,
  geminiFailed: boolean,
  opts?: { stub?: boolean; stubPdf?: boolean; stubEmail?: boolean }
) {
  if (process.env.DATABASE_URL) {
    try {
      const { query } = await import('./db');
      const lockKey = `finalize:${sessionId}`;
      const rows = await query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockKey]);
      if (!rows[0]?.locked) {
        return;
      }
      try {
        return await finalizeReportUnlocked(sessionId, openaiFailed, geminiFailed, opts);
      } finally {
        try {
          await query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
        } catch {
          // ignore
        }
      }
    } catch {
      // If locking fails for any reason, continue without it.
    }
  }

  return finalizeReportUnlocked(sessionId, openaiFailed, geminiFailed, opts);
}

async function finalizeReportUnlocked(
  sessionId: string,
  openaiFailed: boolean,
  geminiFailed: boolean,
  opts?: { stub?: boolean; stubPdf?: boolean; stubEmail?: boolean }
) {
  const session = await getSessionById(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  const settings = await getUserSettings(session.user_id);

  const existingReport = await getReportBySession(sessionId);
  if (existingReport?.email_status === 'sent') {
    // If an email was already sent but the session got stuck in "aggregating", make it terminal.
    const finalState: SessionState =
      openaiFailed && geminiFailed ? 'failed' : openaiFailed || geminiFailed ? 'partial' : 'completed';
    if (session.state !== 'completed' && session.state !== 'partial' && session.state !== 'failed') {
      const { query } = await import('./db');
      await query(
        `UPDATE research_sessions
         SET state = $2,
             completed_at = COALESCE(completed_at, now()),
             updated_at = now()
         WHERE id = $1`,
        [sessionId, finalState]
      );
    }
    return;
  }

  const results = await listProviderResults(sessionId);
  const openaiResult = results.find((result) => result.provider === 'openai');
  const geminiResult = results.find((result) => result.provider === 'gemini');

  const summary = `OpenAI: ${openaiResult?.status ?? 'unknown'} | Gemini: ${geminiResult?.status ?? 'unknown'}`;
  let finalState: SessionState =
    openaiFailed && geminiFailed ? 'failed' : openaiFailed || geminiFailed ? 'partial' : 'completed';

  const accessedAt = new Date().toISOString();
  const openaiSources = extractLinksFromText(openaiResult?.output_text ?? '');
  const geminiSourcesRaw = extractLinksFromText(geminiResult?.output_text ?? '');

  const globalRefMap = new Map<string, number>();
  const openaiRefs = openaiSources.map((source, index) => {
    const n = index + 1;
    globalRefMap.set(source.url, n);
    return { n, ...source, accessedAt };
  });
  const geminiRefs: Array<{ n: number; url: string; title?: string; accessedAt: string }> = [];
  for (const source of geminiSourcesRaw) {
    if (globalRefMap.has(source.url)) {
      continue;
    }
    const n = globalRefMap.size + 1;
    globalRefMap.set(source.url, n);
    geminiRefs.push({ n, ...source, accessedAt });
  }

  const openaiTextWithRefs = openaiResult?.output_text
    ? replaceLinksWithRefs(openaiResult.output_text, globalRefMap)
    : null;
  const geminiTextWithRefs = geminiResult?.output_text
    ? replaceLinksWithRefs(geminiResult.output_text, globalRefMap)
    : null;

  const includeRefs = settings.report_include_refs_in_summary;
  type SummaryRef = { n: number; title?: string; url: string; accessedAt?: string };
  const summarize = async (provider: 'OpenAI' | 'Gemini' | 'Combined', text: string, refs: SummaryRef[]) => {
    if (settings.summarize_provider === 'gemini') {
      return summarizeForReportGemini(
        { provider, researchText: text, references: refs },
        { stub: opts?.stub ?? false, timeoutMs: settings.gemini_timeout_minutes * 60_000, includeRefs }
      );
    }
    return summarizeForReport(
      { provider: provider === 'Combined' ? 'OpenAI' : provider, researchText: text, references: refs },
      { stub: opts?.stub ?? false, timeoutMs: settings.openai_timeout_minutes * 60_000, includeRefs }
    );
  };

  let finalOpenaiSummary = 'No OpenAI result available.';
  let finalGeminiSummary = 'No Gemini result available.';

  if (settings.report_summary_mode === 'one') {
    const combinedText = [openaiTextWithRefs, geminiTextWithRefs].filter(Boolean).join('\n\n');
    const combinedRefs = [...openaiRefs, ...geminiRefs];
    finalOpenaiSummary = combinedText
      ? await summarize('Combined', combinedText, combinedRefs)
      : 'No research result available.';
    finalGeminiSummary = '';
  } else {
    finalOpenaiSummary = openaiTextWithRefs ? await summarize('OpenAI', openaiTextWithRefs, openaiRefs) : finalOpenaiSummary;
    finalGeminiSummary = geminiTextWithRefs ? await summarize('Gemini', geminiTextWithRefs, geminiRefs) : finalGeminiSummary;
  }

  let pdfBuffer: Buffer | null = null;
  let pdfError: string | null = null;
  try {
    pdfBuffer = await buildPdfReport(
      {
        sessionId,
        topic: session.topic,
        refinedPrompt: session.refined_prompt,
        summaryMode: settings.report_summary_mode,
        openaiSummary: finalOpenaiSummary,
        geminiSummary: finalGeminiSummary,
        references: {
          openai: openaiRefs,
          gemini: geminiRefs
        },
        openaiText: openaiTextWithRefs ?? null,
        geminiText: geminiTextWithRefs ?? null,
        openaiSources: openaiResult?.sources_json ?? null,
        geminiSources: geminiResult?.sources_json ?? null,
        createdAt: session.created_at
      },
      { stub: opts?.stubPdf ?? opts?.stub }
    );
  } catch (error) {
    pdfError = error instanceof Error ? error.message : 'PDF error';
    pdfBuffer = null;
    if (finalState === 'completed') {
      finalState = 'partial';
    }
  }

  const report =
    existingReport && existingReport.email_status !== 'sent'
      ? ((await updateReportContent({ reportId: existingReport.id, summary, pdfBuffer })) ?? existingReport)
      : await createReport({
          sessionId,
          summary,
          pdfBuffer,
          emailStatus: 'pending'
        });

  await updateSessionState({
    sessionId,
    state: finalState,
    completedAt: new Date().toISOString()
  });

  const timing = await checkReportTiming(sessionId);
  if (timing) {
    console.info(`report timing minutes=${timing.durationMinutes} within=${timing.withinBudget}`);
  }

  if (!pdfBuffer) {
    await updateReportEmail({
      reportId: report.id,
      emailStatus: 'failed',
      emailError: pdfError ? `PDF generation failed: ${pdfError}` : 'PDF generation failed'
    });
    return;
  }

  const email = await resolveUserEmail(sessionId);
  const claimedReportId = await claimReportSendForSession(sessionId);
  if (!claimedReportId) {
    return;
  }
  if (claimedReportId !== report.id) {
    // Ensure the claimed row has the latest content.
    await updateReportContent({ reportId: claimedReportId, summary, pdfBuffer });
  }
  try {
    await sendReportEmail({
      to: email,
      subject: 'Your Research Report',
      summary: report.summary_text || summary,
      pdfBuffer
    }, { stub: opts?.stubEmail ?? opts?.stub });
    await updateReportEmail({
      reportId: claimedReportId,
      emailStatus: 'sent',
      sentAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Email send failed', error);
    await updateReportEmail({
      reportId: claimedReportId,
      emailStatus: 'failed',
      emailError: error instanceof Error ? error.message : 'Email error'
    });
  }
}

export async function resolveUserEmail(sessionId: string): Promise<string> {
  const rows = await listSessionUserEmail(sessionId);
  if (!rows[0]) {
    throw new Error('User email not found');
  }
  return rows[0].email;
}

async function listSessionUserEmail(sessionId: string): Promise<{ email: string }[]> {
  const { query } = await import('./db');
  return query<{ email: string }>(
    `SELECT users.email
     FROM research_sessions
     JOIN users ON users.id = research_sessions.user_id
     WHERE research_sessions.id = $1`,
    [sessionId]
  );
}

export async function getCurrentQuestion(sessionId: string) {
  return getNextQuestion(sessionId);
}

export async function getAllQuestions(sessionId: string) {
  return listQuestions(sessionId);
}
