// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import HistoryList from '../../app/(research)/components/HistoryList';

const mockFetch = vi.fn();

global.fetch = mockFetch as unknown as typeof fetch;

describe('HistoryList', () => {
  it('renders sessions', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 's1', topic: 'Topic', state: 'completed', created_at: '' }]
    });

    render(<HistoryList onSelect={vi.fn()} />);

    expect(await screen.findByText(/Topic/)).toBeInTheDocument();
  });
});
