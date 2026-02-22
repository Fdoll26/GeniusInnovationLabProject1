// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../app/(research)/actions', () => ({
  createSessionFromForm: vi.fn(async () => ({ id: 'session-id', topic: 'Test topic' }))
}));

import TopicForm from '../../app/(research)/components/TopicForm';

describe('TopicForm', () => {
  it('submits a topic and calls onCreated', async () => {
    const onCreated = vi.fn();
    render(<TopicForm onCreated={onCreated} />);

    fireEvent.change(screen.getByPlaceholderText('Enter your research question'), {
      target: { value: 'Test topic' }
    });

    fireEvent.submit(screen.getByText('Start Research').closest('form')!);

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith({ id: 'session-id', topic: 'Test topic' });
    });
  });
});
