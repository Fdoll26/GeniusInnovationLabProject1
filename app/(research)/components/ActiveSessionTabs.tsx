'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSessionStatus } from '../hooks/useSessionStatus';

export type ActiveSession = { id: string; topic: string };

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function truncate(text: string, max = 36) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

function Tab({
  session,
  active,
  flashComplete,
  onSelect,
  onCompleted
}: {
  session: ActiveSession;
  active: boolean;
  flashComplete: boolean;
  onSelect: () => void;
  onCompleted: () => void;
}) {
  const { status } = useSessionStatus(session.id);

  useEffect(() => {
    if (!status?.state) return;
    if (status.state === 'completed' || status.state === 'partial') {
      onCompleted();
    }
  }, [status?.state, onCompleted]);

  const label = useMemo(() => {
    if (flashComplete) return 'Complete';
    const s = status?.state ?? '…';
    if (s === 'running_research') return 'Researching';
    if (s === 'aggregating') return 'Finalizing';
    if (s === 'refining') return 'Refining';
    if (s === 'draft') return 'Draft';
    if (s === 'failed') return 'Failed';
    if (s === 'partial') return 'Complete';
    if (s === 'completed') return 'Complete';
    return s;
  }, [flashComplete, status?.state]);

  return (
    <button
      type="button"
      className={classNames('session-tab', active && 'is-active', flashComplete && 'is-complete')}
      onClick={onSelect}
      title={session.topic}
    >
      <span className="session-tab__title">{truncate(session.topic)}</span>
      <span className="session-tab__status">{label}</span>
    </button>
  );
}

export default function ActiveSessionTabs({
  sessions,
  activeId,
  onSelect,
  onRemoveAfterComplete
}: {
  sessions: ActiveSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRemoveAfterComplete: (id: string) => void;
}) {
  const [completeFlash, setCompleteFlash] = useState<Record<string, boolean>>({});

  const handleCompleted = (id: string) => {
    if (completeFlash[id]) return;
    setCompleteFlash((prev) => ({ ...prev, [id]: true }));
    setTimeout(() => {
      onRemoveAfterComplete(id);
      setCompleteFlash((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }, 3200);
  };

  return (
    <>
      {sessions.length >= 2 ? (
        <div className="session-tabs" aria-label="Active sessions">
          {sessions.map((s) => (
            <Tab
              key={s.id}
              session={s}
              active={s.id === activeId}
              flashComplete={Boolean(completeFlash[s.id])}
              onSelect={() => onSelect(s.id)}
              onCompleted={() => handleCompleted(s.id)}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}
