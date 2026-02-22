// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import SessionDetail from '../../app/(research)/components/SessionDetail';

const mockFetch = vi.fn();

global.fetch = mockFetch as unknown as typeof fetch;

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { email: 'user@example.com' } } })
}));

describe('SessionDetail', () => {
  it('renders session detail', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        session: { id: 's1', topic: 'Topic', refined_prompt: 'Refined', state: 'completed' },
        providerResults: [{ provider: 'openai', status: 'completed' }]
      })
    });

    render(<SessionDetail sessionId="s1" />);

    expect(await screen.findByText(/Topic/)).toBeInTheDocument();
  });
});
