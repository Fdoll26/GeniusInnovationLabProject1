'use client';

import { useEffect, useState } from 'react';

type RefinementQuestion = {
  id: string;
  question_text: string;
  is_complete: boolean;
  answer_text: string | null;
};

type SessionDetail = {
  session: { id: string; topic: string; refined_prompt: string | null; state: string };
  refinementQuestions: RefinementQuestion[];
};

export default function RefinementPanel({ sessionId }: { sessionId: string | null }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [answer, setAnswer] = useState('');
  const [refinedPrompt, setRefinedPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [approved, setApproved] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    // Switching between sessions should not carry over "submitting"/modal state from a different session.
    setDetail(null);
    setAnswer('');
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
          <div className="progress-bar" aria-hidden>
            <div className="progress-bar__fill" />
          </div>
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

  async function submitAnswer() {
    if (!nextQuestion) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/research/sessions/${sessionId}/refinement/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: nextQuestion.id, answer })
      });
      if (!response.ok) {
        setError('Failed to submit answer');
        return;
      }
      const data = (await response.json()) as {
        refinedPrompt?: string | null;
        nextQuestion?: RefinementQuestion | null;
      };
      setDetail((prev) => {
        if (!prev) {
          return prev;
        }
        const updatedQuestions = prev.refinementQuestions.map((question) =>
          question.id === nextQuestion.id ? { ...question, is_complete: true, answer_text: answer } : question
        );
        if (data.nextQuestion && !updatedQuestions.find((q) => q.id === data.nextQuestion?.id)) {
          updatedQuestions.push(data.nextQuestion);
        }
        const nextRefinedPrompt = data.refinedPrompt ?? prev.session.refined_prompt ?? '';
        return {
          ...prev,
          refinementQuestions: updatedQuestions,
          session: {
            ...prev.session,
            refined_prompt: nextRefinedPrompt || prev.session.refined_prompt
          }
        };
      });
      if (data.refinedPrompt) {
        setRefinedPrompt(data.refinedPrompt);
      }
      setAnswer('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit answer');
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
          <div className="progress-bar" aria-hidden>
            <div className="progress-bar__fill" />
          </div>
        </div>
      ) : null}
      {nextQuestion ? (
        <>
          <p>{nextQuestion.question_text}</p>
          <textarea
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            rows={4}
            disabled={submitting || isWaitingForQuestions}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (answer.trim() && !submitting) {
                  submitAnswer();
                }
              }
            }}
          />
          <div className="row">
            <button
              type="button"
              onClick={submitAnswer}
              disabled={submitting || isWaitingForQuestions || !answer.trim()}
            >
              Submit answer
            </button>
            {submitting ? (
              <div className="status-row" aria-live="polite">
                <span className="spinner" aria-hidden />
                <span>Saving...</span>
              </div>
            ) : null}
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
              <div className="progress-bar" aria-hidden>
                <div className="progress-bar__fill" />
              </div>
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
