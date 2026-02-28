'use client';

import { useEffect, useState } from 'react';
import LoadingBar from './LoadingBar';

type RefinementQuestion = {
  id: string;
  question_text: string;
  options_json: string[] | null;
  is_complete: boolean;
  answer_text: string | null;
};

type SessionDetail = {
  session: { id: string; topic: string; refined_prompt: string | null; state: string };
  refinementQuestions: RefinementQuestion[];
};

export default function RefinementPanel({ sessionId }: { sessionId: string | null }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [answersByQuestion, setAnswersByQuestion] = useState<Record<string, string>>({});
  const [refinedPrompt, setRefinedPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [approved, setApproved] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    // Switching between sessions should not carry over "submitting"/modal state from a different session.
    setDetail(null);
    setAnswersByQuestion({});
    setRefinedPrompt('');
    setError(null);
    setSubmitting(false);
    setLoading(false);
    setApproved(false);
    setConfirmOpen(false);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    let active = true;
    const load = async () => {
      setLoading(true);
      const response = await fetch(`/api/research/sessions/${sessionId}`);
      if (!response.ok) {
        if (active) {
          setLoading(false);
        }
        return;
      }
      const data = (await response.json()) as SessionDetail;
      if (active) {
        setDetail(data);
        setAnswersByQuestion((prev) => {
          const next = { ...prev };
          for (const question of data.refinementQuestions) {
            if (!next[question.id] || !next[question.id].trim()) {
              next[question.id] = question.answer_text ?? '';
            }
          }
          return next;
        });
        setRefinedPrompt((prev) => prev || data.session.refined_prompt || data.session.topic);
        setLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 10000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [sessionId]);

  if (!sessionId || approved) {
    return null;
  }

  if (loading && !detail) {
    return (
      <div className="card stack">
        <h3>Refinement</h3>
        <div className="status-block">
          <div className="status-row">
            <span className="spinner" aria-hidden />
            <span>Loading refinement...</span>
          </div>
          <LoadingBar />
        </div>
      </div>
    );
  }

  if (!detail) {
    return null;
  }

  const nextQuestion = detail.refinementQuestions.find((q) => !q.is_complete);
  const isWaitingForQuestions =
    detail.session.state === 'refining' &&
    detail.refinementQuestions.length === 0 &&
    !detail.session.refined_prompt;

  const allQuestionsAnswered =
    detail.refinementQuestions.length > 0 &&
    detail.refinementQuestions.every((question) =>
      String(answersByQuestion[question.id] ?? question.answer_text ?? '').trim().length > 0
    );

  const toggleSuggestedOption = (questionId: string, option: string) => {
    setAnswersByQuestion((prev) => {
      const current = String(prev[questionId] ?? '').trim();
      const parts = current
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      const hasOption = parts.some((part) => part.toLowerCase() === option.toLowerCase());
      const nextParts = hasOption
        ? parts.filter((part) => part.toLowerCase() !== option.toLowerCase())
        : [...parts, option];
      return { ...prev, [questionId]: nextParts.join(', ') };
    });
  };

  async function submitAnswers() {
    const currentDetail = detail;
    if (!sessionId || !currentDetail || !currentDetail.refinementQuestions.length) {
      return;
    }
    if (!allQuestionsAnswered) {
      setError('Please answer every clarification question before continuing.');
      return;
    }

    const answers = currentDetail.refinementQuestions.map((question) => ({
      questionId: question.id,
      answer: String(answersByQuestion[question.id] ?? question.answer_text ?? '').trim()
    }));

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/research/sessions/${sessionId}/refinement/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers })
      });
      if (!response.ok) {
        setError('Failed to submit answers');
        return;
      }
      const data = (await response.json()) as {
        refinedPrompt?: string | null;
        nextQuestion?: RefinementQuestion | null;
        isFinal?: boolean;
        updatedQuestionIds?: string[];
      };
      setDetail((prev) => {
        if (!prev) {
          return prev;
        }
        const updatedIds = new Set(
          data.isFinal
            ? prev.refinementQuestions.map((question) => question.id)
            : (data.updatedQuestionIds ?? answers.map((item) => item.questionId))
        );
        const answerById = new Map(answers.map((item) => [item.questionId, item.answer]));
        const updatedQuestions = prev.refinementQuestions.map((question) => {
          if (!updatedIds.has(question.id)) return question;
          return {
            ...question,
            is_complete: true,
            answer_text: answerById.get(question.id) ?? question.answer_text
          };
        });
        if (data.nextQuestion && !updatedQuestions.find((q) => q.id === data.nextQuestion?.id)) {
          updatedQuestions.push(data.nextQuestion);
        }
        const nextRefinedPrompt = data.refinedPrompt ?? prev.session.refined_prompt ?? prev.session.topic;
        return {
          ...prev,
          refinementQuestions: updatedQuestions,
          session: {
            ...prev.session,
            refined_prompt: nextRefinedPrompt
          }
        };
      });
      setRefinedPrompt(
        (prev) => data.refinedPrompt ?? (prev || detail.session.refined_prompt || detail.session.topic)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit answers');
    } finally {
      setSubmitting(false);
    }
  }

  async function approvePrompt() {
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch(`/api/research/sessions/${sessionId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refinedPrompt })
      });
      if (!response.ok) {
        setError('Failed to approve prompt');
        return;
      }
      setApproved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve prompt');
    } finally {
      setSubmitting(false);
    }
  }

  if (detail.session.state !== 'refining') {
    return null;
  }

  return (
    <div className="card stack">
      <h3>Refinement</h3>
      {isWaitingForQuestions ? (
        <div className="status-block">
          <div className="status-row">
            <span className="spinner" aria-hidden />
            <span>Generating clarification questions...</span>
          </div>
          <LoadingBar />
        </div>
      ) : null}
      {nextQuestion ? (
        <>
          <div className="clarify-plan stack">
            <div className="clarify-plan__header">
              <div className="clarify-plan__step-box" aria-hidden>
                <span>1</span>
              </div>
              <div className="clarify-plan__title-wrap">
                <strong>Research Plan</strong>
                <small className="muted">Answer these questions to refine your research</small>
              </div>
            </div>

            <div className="clarify-plan__topic">
              <p>
                <strong>Topic:</strong> {detail.session.topic}
              </p>
            </div>

            <div className="clarify-plan__questions">
              {detail.refinementQuestions.map((question, index) => {
                const displayValue = String(answersByQuestion[question.id] ?? question.answer_text ?? '');
                const selectedOptions = displayValue
                  .split(',')
                  .map((part) => part.trim().toLowerCase())
                  .filter(Boolean);
                const suggestedOptions = Array.isArray(question.options_json)
                  ? question.options_json.map((value) => String(value ?? '').trim()).filter(Boolean)
                  : [];

                return (
                  <div key={question.id} className="clarify-plan__question-row">
                    <div className="clarify-plan__question-index" aria-hidden>
                      {index + 1}
                    </div>
                    <div className="clarify-plan__question-content">
                      <label>{question.question_text}</label>
                      {suggestedOptions.length > 0 ? (
                        <div className="clarify-plan__options">
                          {suggestedOptions.map((option) => {
                            const selected = selectedOptions.includes(option.toLowerCase());
                            return (
                              <button
                                key={option}
                                type="button"
                                className={`clarify-plan__option-chip ${selected ? 'is-selected' : ''}`}
                                onClick={() => toggleSuggestedOption(question.id, option)}
                                disabled={submitting || isWaitingForQuestions}
                              >
                                {option}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                      <textarea
                        value={displayValue}
                        onChange={(event) =>
                          setAnswersByQuestion((prev) => ({ ...prev, [question.id]: event.target.value }))
                        }
                        rows={3}
                        disabled={submitting || isWaitingForQuestions}
                        placeholder="Click options above or type your answer..."
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="clarify-plan__next">
              <div className="clarify-plan__next-row">
                <div className="clarify-plan__next-step" aria-hidden>
                  <span>2</span>
                </div>
                <span>Deep Research</span>
              </div>
              <div className="clarify-plan__next-row">
                <div className="clarify-plan__next-step" aria-hidden>
                  <span>3</span>
                </div>
                <span>Generate Report</span>
              </div>
            </div>

            <div className="clarify-plan__actions">
              <button
                type="button"
                onClick={submitAnswers}
                disabled={submitting || isWaitingForQuestions || !allQuestionsAnswered}
              >
                Start Research
              </button>
              {submitting ? (
                <div className="status-row" aria-live="polite">
                  <span className="spinner" aria-hidden />
                  <span>Saving answers...</span>
                </div>
              ) : null}
            </div>
          </div>
        </>
      ) : (
        <>
          <p>Review refined prompt</p>
          <textarea
            value={refinedPrompt}
            onChange={(event) => setRefinedPrompt(event.target.value)}
            rows={7}
            disabled={submitting}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (refinedPrompt && !submitting) {
                  setConfirmOpen(true);
                }
              }
            }}
          />
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={submitting || !refinedPrompt}
          >
            Approve Prompt
          </button>
          {submitting ? (
            <div className="status-block" aria-live="polite">
              <div className="status-row">
                <span className="spinner" aria-hidden />
                <span>Submitting...</span>
              </div>
              <LoadingBar />
            </div>
          ) : null}
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {confirmOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal card stack">
            <strong>Start deep research?</strong>
            <p>This will send the refined prompt to OpenAI Deep Research.</p>
            <div className="row">
              <button
                type="button"
                onClick={() => {
                  setConfirmOpen(false);
                  approvePrompt();
                }}
                disabled={submitting}
              >
                Confirm
              </button>
              <button type="button" className="button-secondary" onClick={() => setConfirmOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
