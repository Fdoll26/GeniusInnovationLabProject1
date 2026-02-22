export type SessionState =
  | 'draft'
  | 'refining'
  | 'running_openai'
  | 'running_gemini'
  | 'running_research'
  | 'aggregating'
  | 'completed'
  | 'partial'
  | 'failed';

const transitions: Record<SessionState, SessionState[]> = {
  draft: ['refining'],
  refining: ['running_research', 'failed'],
  running_openai: ['running_research', 'running_gemini', 'partial', 'failed'],
  running_gemini: ['running_research', 'aggregating', 'partial', 'failed'],
  running_research: ['aggregating', 'partial', 'failed'],
  aggregating: ['completed', 'partial', 'failed'],
  completed: [],
  partial: [],
  failed: []
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return transitions[from]?.includes(to) ?? false;
}
