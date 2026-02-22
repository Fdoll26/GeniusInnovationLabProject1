'use server';

import { requireSession } from '../lib/authz';
import { createSession, getUserIdByEmail } from '../lib/session-repo';
import { getDebugFlags } from '../lib/debug';

export async function createSessionAction(topic: string) {
  const session = await requireSession();
  const userId = await getUserIdByEmail(session.user!.email!);
  const cleanTopic = topic.trim();
  if (!cleanTopic) {
    throw new Error('Topic is required');
  }
  const newSession = await createSession({ userId, topic: cleanTopic, state: 'draft' });
  const debug = await getDebugFlags();
  const { runRefinement } = await import('../lib/orchestration');
  await runRefinement(newSession.id, cleanTopic, {
    stub: debug.stubExternals,
    stubRefiner: debug.stubRefiner
  });
  return newSession;
}

export async function createSessionFromForm(formData: FormData) {
  const topic = String(formData.get('topic') ?? '');
  return createSessionAction(topic);
}
