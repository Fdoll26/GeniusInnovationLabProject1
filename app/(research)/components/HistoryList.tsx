'use client';

import { useEffect, useRef, useState } from 'react';

type SessionListItem = {
  id: string;
  topic: string;
  state: string;
  created_at: string;
};

const labelMap: Record<string, string> = {
  draft: 'Draft',
  refining: 'Awaiting clarifications',
  running_research: 'Waiting on research results',
  aggregating: 'Aggregating results',
  completed: 'Completed',
  partial: 'Completed with partial results',
  failed: 'Failed'
};

function formatListTimestamp(iso: string) {
  const date = new Date(iso);
  const datePart = date.toLocaleDateString();
  const timePart = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${datePart} ${timePart}`;
}

export default function HistoryList({
  onSelect,
  onDeleted
}: {
  onSelect: (id: string) => void;
  onDeleted?: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const pageSize = 10;
  const sessionsRef = useRef<SessionListItem[]>([]);
  const loadingRef = useRef(false);
  const hasMoreRef = useRef(true);
  const requestSeqRef = useRef(0);

  async function loadMore() {
    if (loadingRef.current || !hasMoreRef.current) {
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    setLoadError(null);
    const seq = ++requestSeqRef.current;
    const offset = sessionsRef.current.length;
    const response = await fetch(
      `/api/research/sessions?limit=${pageSize}&offset=${offset}&q=${encodeURIComponent(query)}`,
      { cache: 'no-store' }
    );
    if (!response.ok) {
      if (seq === requestSeqRef.current) {
        setLoadError(`Failed to load sessions (${response.status}).`);
        setLoading(false);
        loadingRef.current = false;
      }
      return;
    }
    const data = (await response.json()) as SessionListItem[];
    if (seq !== requestSeqRef.current) {
      setLoading(false);
      loadingRef.current = false;
      return;
    }
    setSessions((prev) => {
      const seen = new Set(prev.map((s) => s.id));
      const merged = [...prev];
      for (const item of data) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        merged.push(item);
      }
      sessionsRef.current = merged;
      return merged;
    });
    const nextHasMore = data.length === pageSize;
    hasMoreRef.current = nextHasMore;
    setHasMore(nextHasMore);
    setLoading(false);
    loadingRef.current = false;
  }

  useEffect(() => {
    const nextQuery = search.trim();
    if (nextQuery === query) {
      return;
    }
    const handle = setTimeout(() => {
      setSessions([]);
      sessionsRef.current = [];
      setHasMore(true);
      hasMoreRef.current = true;
      requestSeqRef.current += 1; // invalidate in-flight requests
      setQuery(nextQuery);
    }, 350);
    return () => clearTimeout(handle);
  }, [search, query]);

  useEffect(() => {
    loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  async function confirmDelete() {
    if (!confirmDeleteId) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/research/sessions/${encodeURIComponent(confirmDeleteId)}`, { method: 'DELETE' });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== confirmDeleteId);
        sessionsRef.current = next;
        return next;
      });
      if (typeof onDeleted === 'function') {
        onDeleted(confirmDeleteId);
      }
      setConfirmDeleteId(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="card stack">
      <h3>History</h3>
      <label className="stack">
        <span>Search</span>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search topic, refined prompt, or status"
        />
      </label>
      {loadError ? <p role="alert">{loadError}</p> : null}
      {sessions.length === 0 && loading ? (
        <p>Loading sessions...</p>
      ) : sessions.length === 0 ? (
        <p>No sessions yet.</p>
      ) : (
        sessions.map((session) => (
          <div key={session.id} className="row" style={{ alignItems: 'stretch', gap: 10 }}>
            <button
              type="button"
              className="list-button"
              onClick={() => onSelect(session.id)}
              title={`Created: ${new Date(session.created_at).toLocaleString()}`}
              style={{ flex: 1 }}
            >
              <div className="stack">
                <div className="list-button__top row">
                  <strong className="truncate">{session.topic}</strong>
                  <span className="status-pill">{labelMap[session.state] ?? session.state}</span>
                </div>
                <small className="muted">{formatListTimestamp(session.created_at)}</small>
              </div>
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Delete session"
              title="Delete session"
              onClick={() => {
                setConfirmDeleteId(session.id);
                setDeleteError(null);
              }}
            >
              🗑️
            </button>
          </div>
        ))
      )}
      {hasMore ? (
        <button type="button" onClick={loadMore} disabled={loading}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      ) : null}

      {confirmDeleteId ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal card stack">
            <strong>Delete this session?</strong>
            <p className="muted">This will remove the session and its related data (questions, provider outputs, reports).</p>
            {deleteError ? <p role="alert">{deleteError}</p> : null}
            <div className="row">
              <button type="button" onClick={confirmDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Confirm delete'}
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={() => setConfirmDeleteId(null)}
                disabled={deleting}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
