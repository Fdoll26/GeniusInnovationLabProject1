import { getServerSession } from 'next-auth';
import { authOptions } from './auth';
import { query } from './db';
import { getDebugFlags } from './debug';

export async function requireSession() {
  const debug = await getDebugFlags();
  if (debug.bypassAuth) {
    const email = 'dev@example.com';
    const allowed = (process.env.ALLOWED_EMAILS || '').trim();
    if (allowed) {
      const list = allowed.split(',').map((value) => value.trim());
      if (!list.includes(email)) {
        throw new Error('Access denied');
      }
    }
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
    throw new Error('Unauthorized');
  }
  const allowed = (process.env.ALLOWED_EMAILS || '').trim();
  if (allowed) {
    const list = allowed.split(',').map((value) => value.trim());
    if (!list.includes(session.user.email)) {
      throw new Error('Access denied');
    }
  }
  return session;
}
