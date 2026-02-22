// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

    render(<SessionDetail sessionId="s1" onClose={() => undefined} />);

    expect(await screen.findByText(/Topic/)).toBeInTheDocument();
  });

  it('regenerates report and shows success', async () => {
    const user = userEvent.setup();

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session: { id: 's1', topic: 'Topic', refined_prompt: 'Refined', state: 'completed' },
          providerResults: []
        })
      })
      .mockResolvedValueOnce({ ok: true, text: async () => '' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session: { id: 's1', topic: 'Topic', refined_prompt: 'Refined', state: 'completed' },
          providerResults: [],
          report: { email_status: 'sent' }
        })
      });

    render(<SessionDetail sessionId="s1" onClose={() => undefined} />);
    const button = await screen.findByRole('button', { name: /regenerate \+ re-send report email/i });

    await act(async () => {
      await user.click(button);
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/research/sessions/s1/regenerate-report',
      expect.objectContaining({ method: 'POST' })
    );
    expect(await screen.findByText(/Report sent\./i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText(/Report sent\./i)).not.toBeInTheDocument();
    }, { timeout: 4000 });
  });
});
