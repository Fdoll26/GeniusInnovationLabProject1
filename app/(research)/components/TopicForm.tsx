'use client';

import { useState } from 'react';
import { createSessionFromForm } from '../actions';

export default function TopicForm({
  onCreated
}: {
  onCreated: (session: { id: string; topic: string }) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [topicValue, setTopicValue] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(formData: FormData) {
    if (submitting) {
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      const session = await createSessionFromForm(formData);
      onCreated({ id: session.id, topic: session.topic });
      setTopicValue('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        await handleSubmit(new FormData(event.currentTarget));
      }}
      className="card stack"
    >
      <label className="stack">
        <span>Research topic</span>
        <input
          name="topic"
          placeholder="Enter your research question"
          required
          value={topicValue}
          onChange={(e) => setTopicValue(e.target.value)}
          disabled={submitting}
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={submitting}>
        {submitting ? 'Starting…' : 'Start Research'}
      </button>
    </form>
  );
}
