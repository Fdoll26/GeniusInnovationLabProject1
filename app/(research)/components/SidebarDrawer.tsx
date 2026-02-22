'use client';

import { useEffect, useMemo, useState } from 'react';
import { signOut, useSession } from 'next-auth/react';
import { usePathname, useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';

type SessionListItem = {
  id: string;
  topic: string;
  state: string;
  updated_at: string;
};

const statusLabel: Record<string, string> = {
  draft: 'Draft',
  refining: 'Needs clarifications',
  running_research: 'Waiting on research results',
  aggregating: 'Aggregating results',
  completed: 'Completed',
  partial: 'Partial',
  failed: 'Failed'
};

function formatRelative(iso: string) {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = Math.max(0, now - then);

  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  const months = Math.floor(days / 30);
  return `${Math.max(1, months)}mo ago`;
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

export default function SidebarDrawer({
  open,
  onClose
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { data: session } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [recentOpen, setRecentOpen] = useState(false);
  const [recent, setRecent] = useState<SessionListItem[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const isAuthed = Boolean(session?.user?.email);
  const avatar = session?.user?.image ?? null;
  const email = session?.user?.email ?? null;

  const isActive = useMemo(() => {
    return (href: string) => pathname === href;
  }, [pathname]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) {
      setRecentOpen(false);
      return;
    }
    // Escape to close
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !recentOpen || recentLoading || recent.length > 0) {
      return;
    }
    let active = true;
    setRecentLoading(true);
    setRecentError(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Recent fetch timeout')), 8000);
    fetch('/api/research/sessions/recent?limit=5', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t || 'Request failed')))))
      .then((data) => {
        if (!active) {
          return;
        }
        setRecent(Array.isArray(data) ? (data as SessionListItem[]) : []);
      })
      .catch((err) => {
        if (!active) return;
        setRecentError(err instanceof Error ? err.message : 'Failed to load recent sessions');
      })
      .finally(() => {
        clearTimeout(timer);
        controller.abort();
        if (active) {
          setRecentLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [open, recentOpen, recentLoading, recent.length]);

  if (!isAuthed) {
    return null;
  }

  if (!mounted) {
    return null;
  }

  const content = (
    <>
      <div
        className={classNames('drawer-backdrop', open && 'is-open')}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            onClose();
          }
        }}
        aria-hidden={!open}
      />
      <aside className={classNames('drawer', open && 'is-open')} aria-hidden={!open}>
        <div className="drawer__header">
          <div className="drawer__account">
            {avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="drawer__avatar" src={avatar} alt="" />
            ) : (
              <span className="drawer__avatar drawer__avatar--fallback" aria-hidden>
                {(email || 'U').slice(0, 1).toUpperCase()}
              </span>
            )}
            <div className="drawer__account-meta">
              <strong className="truncate">Google user</strong>
              <small className="muted truncate">{email}</small>
            </div>
          </div>
        </div>

        <div className="drawer__body">
          <button
            type="button"
            className={classNames('drawer__link', isActive('/') && 'is-active')}
            onClick={() => {
              router.push('/');
              onClose();
            }}
          >
            New Research Subject
          </button>
          <button
            type="button"
            className={classNames('drawer__link', isActive('/history') && 'is-active')}
            onClick={() => {
              router.push('/history');
              onClose();
            }}
          >
            Historical Results
          </button>
          <button
            type="button"
            className={classNames('drawer__link', isActive('/incomplete') && 'is-active')}
            onClick={() => {
              router.push('/incomplete');
              onClose();
            }}
          >
            Incomplete Research
          </button>
          <button
            type="button"
            className={classNames('drawer__link', isActive('/settings') && 'is-active')}
            onClick={() => {
              router.push('/settings');
              onClose();
            }}
          >
            Settings
          </button>

          <button
            type="button"
            className="drawer__link"
            aria-expanded={recentOpen}
            onClick={() => setRecentOpen((prev) => !prev)}
          >
            Recent Results
            <span className="drawer__chevron" aria-hidden>
              {recentOpen ? '▾' : '▸'}
            </span>
          </button>

          {recentOpen ? (
            <div className="drawer__recent stack">
              {recentLoading ? <small className="muted">Loading…</small> : null}
              {!recentLoading && recentError ? <small className="muted">Failed to load: {recentError}</small> : null}
              {!recentLoading && recent.length === 0 ? <small className="muted">No recent sessions.</small> : null}
              {recent.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="drawer__recent-item"
                  onClick={() => {
                    router.push(`/history?id=${encodeURIComponent(item.id)}`);
                    onClose();
                  }}
                >
                  <div className="drawer__recent-top">
                    <span className="drawer__recent-title truncate">{item.topic}</span>
                  </div>
                  <div className="drawer__recent-bottom">
                    <small className="muted">{formatRelative(item.updated_at)}</small>
                    <small className="drawer__status">
                      {statusLabel[item.state] ?? item.state}
                    </small>
                  </div>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="drawer__footer">
          <button
            type="button"
            className="drawer__signout"
            onClick={async () => {
              onClose();
              await signOut({ callbackUrl: '/' });
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
    </>
  );

  return createPortal(content, document.body);
}
