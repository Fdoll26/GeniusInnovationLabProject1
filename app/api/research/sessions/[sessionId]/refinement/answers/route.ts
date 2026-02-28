import { NextResponse } from 'next/server';
import { requireSession, unauthorizedResponse } from '../../../../../../lib/authz';
import { answerQuestion, getNextQuestion, listQuestions } from '../../../../../../lib/refinement-repo';
import { assertSessionOwnership, getSessionById, getUserIdByEmail, updateSessionState } from '../../../../../../lib/session-repo';
import { rewritePrompt } from '../../../../../../lib/openai-client';
import { rewritePromptGemini } from '../../../../../../lib/gemini-client';
import { getDebugFlags } from '../../../../../../lib/debug';
import { getUserSettings } from '../../../../../../lib/user-settings-repo';

type BulkAnswer = {
  questionId: string;
  answer: string;
};

function normalizeAnswers(input: unknown): BulkAnswer[] {
  if (!Array.isArray(input)) return [];
  const normalized: BulkAnswer[] = [];
  for (const item of input) {
    const questionId = String((item as { questionId?: unknown })?.questionId ?? '').trim();
    const answer = String((item as { answer?: unknown })?.answer ?? '').trim();
    if (!questionId || !answer) {
      continue;
    }
    normalized.push({ questionId, answer });
  }
  return normalized;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await params;
    const session = await requireSession();
    const userId = await getUserIdByEmail(session.user!.email!);
    await assertSessionOwnership(sessionId, userId);

    const body = await request.json();
    const answers = normalizeAnswers(body?.answers);
    if (answers.length === 0) {
      return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
    }

    for (const entry of answers) {
      await answerQuestion({ questionId: entry.questionId, answer: entry.answer });
    }

    const questionsAfterSubmit = await listQuestions(sessionId);
    const allAnswered = questionsAfterSubmit.length > 0 && questionsAfterSubmit.every((question) => {
      if (question.is_complete) return true;
      return Boolean(String(question.answer_text ?? '').trim());
    });
    const nextQuestion = allAnswered ? null : await getNextQuestion(sessionId);
    let refinedPrompt: string | null = null;

    if (allAnswered) {
      const debug = await getDebugFlags();
      const sessionRecord = await getSessionById(sessionId);
      if (sessionRecord) {
        const settings = await getUserSettings(sessionRecord.user_id);
        const clarifications = questionsAfterSubmit
          .filter((question) => question.answer_text)
          .map((question) => ({
            question: question.question_text,
            answer: question.answer_text as string
          }));
        try {
          if (settings.refine_provider === 'gemini') {
            refinedPrompt = await rewritePromptGemini(
              {
                topic: sessionRecord.topic,
                draftPrompt: sessionRecord.refined_prompt ?? sessionRecord.topic,
                clarifications
              },
              { stub: debug.stubRefiner, timeoutMs: settings.gemini_timeout_minutes * 60_000 }
            );
          } else {
            refinedPrompt = await rewritePrompt(
              {
                topic: sessionRecord.topic,
                draftPrompt: sessionRecord.refined_prompt ?? sessionRecord.topic,
                clarifications
              },
              { stub: debug.stubRefiner }
            );
          }
        } catch (error) {
          console.error('Bulk refinement rewrite failed, falling back to topic/draft prompt', error);
          refinedPrompt = sessionRecord.refined_prompt ?? sessionRecord.topic;
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
      isFinal: allAnswered,
      updatedQuestionIds: answers.map((entry) => entry.questionId)
    });
  } catch (error) {
    const response = unauthorizedResponse(error);
    if (response) return response;
    throw error;
  }
}
