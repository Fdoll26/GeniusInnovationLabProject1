import { NextResponse } from 'next/server';
import { requireSession } from '../../../../../../lib/authz';
import { assertSessionOwnership, getUserIdByEmail } from '../../../../../../lib/session-repo';
import { answerQuestion, getNextQuestion, listQuestions } from '../../../../../../lib/refinement-repo';
import { getSessionById, updateSessionState } from '../../../../../../lib/session-repo';
import { rewritePrompt } from '../../../../../../lib/openai-client';
import { rewritePromptGemini } from '../../../../../../lib/gemini-client';
import { getDebugFlags } from '../../../../../../lib/debug';
import { getUserSettings } from '../../../../../../lib/user-settings-repo';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const session = await requireSession();
  const userId = await getUserIdByEmail(session.user!.email!);
  await assertSessionOwnership(sessionId, userId);
  const body = await request.json();
  const questionId = String(body?.questionId ?? '');
  const answer = String(body?.answer ?? '').trim();
  if (!questionId || !answer) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  }

  await answerQuestion({ questionId, answer });
  const nextQuestion = await getNextQuestion(sessionId);
  let refinedPrompt: string | null = null;

  if (!nextQuestion) {
    const debug = await getDebugFlags();
    const session = await getSessionById(sessionId);
    if (session) {
      const settings = await getUserSettings(session.user_id);
      const questions = await listQuestions(sessionId);
      const clarifications = questions
        .filter((question) => question.answer_text)
        .map((question) => ({
          question: question.question_text,
          answer: question.answer_text as string
        }));
      if (settings.refine_provider === 'gemini') {
        refinedPrompt = await rewritePromptGemini(
          {
            topic: session.topic,
            draftPrompt: session.refined_prompt ?? session.topic,
            clarifications
          },
          { stub: debug.stubRefiner, timeoutMs: settings.gemini_timeout_minutes * 60_000 }
        );
      } else {
        refinedPrompt = await rewritePrompt(
          {
            topic: session.topic,
            draftPrompt: session.refined_prompt ?? session.topic,
            clarifications
          },
          { stub: debug.stubRefiner }
        );
      }
      await updateSessionState({
        sessionId,
        state: 'refining',
        refinedPrompt
      });
    }
  }
  return NextResponse.json({
    nextQuestion,
    refinedPrompt,
    isFinal: !nextQuestion
  });
}
