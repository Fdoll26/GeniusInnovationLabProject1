import { requireSession, unauthorizedResponse } from '../../../../lib/authz';
import { listProviderResults } from '../../../../lib/provider-repo';
import { getUserIdByEmail, assertSessionOwnership, getSessionById } from '../../../../lib/session-repo';
import { listSessionResearchSnapshots } from '../../../../lib/research-orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizeProviderStepsForDisplay(
  steps: Array<any>,
  runState: string,
  activeStepIndex: number
): Array<any> {
  const normalized = steps.map((step) => ({ ...step }));
  if (runState !== 'IN_PROGRESS') {
    return normalized;
  }

  return normalized.map((step) => {
    const idx = Number(step.step_index);
    if (!Number.isFinite(idx)) {
      return step;
    }

    if (idx < activeStepIndex && (step.status === 'running' || step.status === 'queued' || step.status === 'planned')) {
      return { ...step, status: 'done' };
    }
    if (idx === activeStepIndex && step.status !== 'done' && step.status !== 'failed') {
      return { ...step, status: 'running' };
    }
    if (idx > activeStepIndex && step.status === 'running') {
      return { ...step, status: 'queued' };
    }
    return step;
  });
}

async function buildStatusPayload(sessionId: string) {
  const sessionRecord = await getSessionById(sessionId);
  if (!sessionRecord) {
    return null;
  }

  const [providerResults, researchRuns] = await Promise.all([
    listProviderResults(sessionId),
    process.env.DATABASE_URL ? listSessionResearchSnapshots(sessionId) : Promise.resolve([])
  ]);

  const researchByProvider = ['openai', 'gemini']
    .map((provider) => {
      const run = researchRuns.find((item) => item.run?.provider === provider)?.run;
      const entry = researchRuns.find((item) => item.run?.provider === provider);
      if (!run || !entry) return null;
      const progress = (run.progress_json && typeof run.progress_json === 'object'
        ? run.progress_json
        : null) as Record<string, unknown> | null;
      const activeStepIndex =
        progress && typeof progress.step_index === 'number' && Number.isFinite(progress.step_index)
          ? Math.max(0, Math.trunc(progress.step_index))
          : Math.max(0, run.current_step_index);
      const normalizedSteps = normalizeProviderStepsForDisplay(entry.steps, run.state, activeStepIndex);

      return {
        provider,
        runId: run.id,
        state: run.state,
        stepIndex: run.current_step_index,
        maxSteps: run.max_steps,
        mode: run.mode,
        progress: progress
          ? {
              stepId: typeof progress.step_id === 'string' ? progress.step_id : null,
              stepLabel: typeof progress.step_label === 'string' ? progress.step_label : null,
              stepNumber: typeof progress.step_index === 'number' ? progress.step_index : run.current_step_index,
              totalSteps: typeof progress.total_steps === 'number' ? progress.total_steps : run.max_steps
            }
          : null,
        steps: normalizedSteps
          .map((step: any) => ({
            id: step.id,
            stepIndex: step.step_index,
            stepType: step.step_type,
            status: step.status,
            stepGoal: step.step_goal,
            outputExcerpt: step.output_excerpt,
            errorMessage: step.error_message,
            startedAt: step.started_at,
            completedAt: step.completed_at
          }))
          .sort((a, b) => a.stepIndex - b.stepIndex),
        sourceCount: entry.sources.length
      };
    })
    .filter(Boolean);

  return {
    state: sessionRecord.state,
    updatedAt: sessionRecord.updated_at,
    refinedAt: sessionRecord.refined_at,
    completedAt: sessionRecord.completed_at,
    providers: providerResults.map((result) => ({
      provider: result.provider,
      status: result.status,
      startedAt: result.started_at,
      completedAt: result.completed_at,
      errorMessage: result.error_message
    })),
    research: {
      providers: researchByProvider
    }
  };
}

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    const session = await requireSession();
    const userId = await getUserIdByEmail(session.user!.email!);
    await assertSessionOwnership(sessionId, userId);

    const encoder = new TextEncoder();
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastPayload = '';

    const stream = new ReadableStream({
      async start(controller) {
        const send = (payload: unknown) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        };

        const poll = async () => {
          if (closed) return;
          try {
            const payload = await buildStatusPayload(sessionId);
            if (!payload) {
              send({ type: 'no_snapshot' });
            } else {
              const next = JSON.stringify(payload);
              if (next !== lastPayload) {
                lastPayload = next;
                send(payload);
              }

              if (payload.state === 'completed' || payload.state === 'failed' || payload.state === 'partial') {
                send({ type: 'terminal', state: payload.state });
                closed = true;
                controller.close();
                return;
              }
            }
          } catch (error) {
            send({ type: 'error', message: error instanceof Error ? error.message : 'Poll error' });
          }

          if (!closed) {
            timer = setTimeout(() => {
              void poll();
            }, 2000);
          }
        };

        await poll();
      },
      cancel() {
        closed = true;
        if (timer) {
          clearTimeout(timer);
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      }
    });
  } catch (error) {
    const response = unauthorizedResponse(error);
    if (response) return response;
    throw error;
  }
}
