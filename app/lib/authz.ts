import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { authOptions } from './auth';
import { query } from './db';
import { getDebugFlags } from './debug';

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export function unauthorizedResponse(error: unknown) {
  if (error instanceof UnauthorizedError) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (error instanceof Error && error.message === 'Unauthorized') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (error instanceof Error && error.message === 'Forbidden') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
}

export async function requireSession() {
  const debug = await getDebugFlags();
  if (debug.bypassAuth) {
    const email = 'dev@example.com';
    await query(
      `INSERT INTO users (email, name)
       VALUES ($1, $2)
       ON CONFLICT (email)
       DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
      [email, 'Dev User']
    );
    return { user: { email, name: 'Dev User' } };
  }

  const session = await getServerSession(authOptions);
  if (!session || !session.user?.email) {
    throw new UnauthorizedError();
  }
  return session;
}
