'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type IncompleteSessionItem = {
  id: string;
  topic: string;
  state: string;
  updated_at: string;
};

const labelMap: Record<string, string> = {
  draft: 'Draft',
  refining: 'Needs clarifications'
};

function formatListTimestamp(iso: string) {
  const date = new Date(iso);
  const datePart = date.toLocaleDateString();
  const timePart = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${datePart} ${timePart}`;
}

export default function IncompletePageClient() {
  const router = useRouter();
  const [items, setItems] = useState<IncompleteSessionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetch('/api/research/sessions/incomplete?limit=50')
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t || 'Request failed')))))
      .then((data) => {
        if (!active) return;
        setItems(Array.isArray(data) ? (data as IncompleteSessionItem[]) : []);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load incomplete sessions');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="card stack">
      <h3>Incomplete Research</h3>
      <p className="muted">Pick a session to continue (clarifications + pipeline steps).</p>
      {loading ? <p>Loading…</p> : null}
      {!loading && error ? <p role="alert">Failed to load: {error}</p> : null}
      {!loading && !error && items.length === 0 ? <p>No incomplete sessions.</p> : null}
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="list-button"
          onClick={() => router.push(`/?session=${encodeURIComponent(item.id)}`)}
          title={`Updated: ${new Date(item.updated_at).toLocaleString()}`}
        >
          <div className="stack">
            <div className="list-button__top row">
              <strong className="truncate">{item.topic}</strong>
              <span className="status-pill">{labelMap[item.state] ?? item.state}</span>
            </div>
            <small className="muted">{formatListTimestamp(item.updated_at)}</small>
          </div>
        </button>
      ))}
    </div>
  );
}

