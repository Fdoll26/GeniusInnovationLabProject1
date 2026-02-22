'use client';

import Link from 'next/link';
import { signIn, useSession } from 'next-auth/react';
import { useEffect, useMemo, useState } from 'react';
import SidebarDrawer from './SidebarDrawer';

function getCookie(name: string) {
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.split('=')[1];
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

export default function AppHeader() {
  const { data: session, status } = useSession();
  const [debugBypass, setDebugBypass] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    setDebugBypass(getCookie('dev_bypass') === '1');
  }, []);

  const user = session?.user;
  const isAuthed = Boolean(user?.email) && !debugBypass;
  const menuLabel = useMemo(() => (drawerOpen ? 'Close menu' : 'Open menu'), [drawerOpen]);

  return (
    <header className="app-header">
      <div className="app-header__inner">
        <div className="app-header__left">
          {isAuthed ? (
            <button
              type="button"
              className={classNames('icon-button', 'hamburger')}
              aria-label={menuLabel}
              onClick={() => setDrawerOpen((prev) => !prev)}
            >
              <span className="hamburger__lines" aria-hidden />
            </button>
          ) : null}
          <Link href="/" className="app-brand">
            Multi-API Research
          </Link>
        </div>

        <div className="app-header__right">
          {debugBypass ? <span className="pill pill--warn">Dev bypass</span> : null}

          {!session && !debugBypass ? (
            <button type="button" onClick={() => signIn('google')} disabled={status === 'loading'}>
              Sign in with Google
            </button>
          ) : null}
        </div>
      </div>
      {isAuthed ? <SidebarDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} /> : null}
    </header>
  );
}
