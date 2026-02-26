import { query } from './db';

export type RefinementQuestionRecord = {
  id: string;
  session_id: string;
  sequence: number;
  question_text: string;
  answer_text: string | null;
  answered_at: string | null;
  is_complete: boolean;
};

export async function createQuestions(params: {
  sessionId: string;
  questions: string[];
}) {
  const inserts = params.questions.map((question, index) =>
    query(
      `INSERT INTO refinement_questions (session_id, sequence, question_text)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id, sequence) DO NOTHING`,
      [params.sessionId, index + 1, question]
    )
  );

  await Promise.all(inserts);
}

export async function listQuestions(sessionId: string): Promise<RefinementQuestionRecord[]> {
  return query<RefinementQuestionRecord>(
    'SELECT * FROM refinement_questions WHERE session_id = $1 ORDER BY sequence',
    [sessionId]
  );
}

export async function answerQuestion(params: {
  questionId: string;
  answer: string;
}) {
  await query(
    `UPDATE refinement_questions
     SET answer_text = $2,
         answered_at = now(),
         is_complete = true
     WHERE id = $1`,
    [params.questionId, params.answer]
  );
}

export async function getNextQuestion(sessionId: string): Promise<RefinementQuestionRecord | null> {
  const rows = await query<RefinementQuestionRecord>(
    `SELECT * FROM refinement_questions
     WHERE session_id = $1 AND is_complete = false
     ORDER BY sequence
     LIMIT 1`,
    [sessionId]
  );
  return rows[0] ?? null;
}
