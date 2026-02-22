// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import RefinementPanel from '../../app/(research)/components/RefinementPanel';

const mockFetch = vi.fn();

global.fetch = mockFetch as unknown as typeof fetch;

describe('RefinementPanel', () => {
  it('renders a refinement question', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        session: { id: 's1', topic: 'Topic', refined_prompt: null, state: 'refining' },
        refinementQuestions: [{ id: 'q1', question_text: 'Q1?', is_complete: false }]
      })
    });

    render(<RefinementPanel sessionId="s1" />);

    expect(await screen.findByText('Q1?')).toBeInTheDocument();
  });
});
