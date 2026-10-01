import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationAnswerRecord } from '../../../src/window.js';
import { SavedAnswersSection } from '../../../src/components/settings/SavedAnswersSection.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';

function answer(overrides: Partial<ApplicationAnswerRecord> = {}): ApplicationAnswerRecord {
  return {
    id: 'answer-1',
    normalizedKey: 'why do you want to work here|textarea',
    label: 'Why do you want to work here?',
    controlType: 'textarea',
    answer: 'Because the mission matches what I want to build next.',
    originCompany: 'Northwind Freight',
    originRole: 'Logistics Platform Engineer',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    lastConfirmedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SavedAnswersSection', () => {
  it('shows a loading state, then the populated list', async () => {
    installWorkspaceBridge({
      listApplicationAnswers: vi.fn().mockResolvedValue([answer()]),
    });

    render(<SavedAnswersSection />);

    expect(screen.getByRole('status')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('Why do you want to work here?')).toBeInTheDocument());
    expect(screen.getByText('Text area')).toBeInTheDocument();
    expect(screen.getByText('Used at Northwind Freight')).toBeInTheDocument();
    expect(screen.getByText('Because the mission matches what I want to build next.')).toBeInTheDocument();
  });

  it('shows the empty state when there are no saved answers', async () => {
    installWorkspaceBridge({
      listApplicationAnswers: vi.fn().mockResolvedValue([]),
    });

    render(<SavedAnswersSection />);

    await waitFor(() =>
      expect(
        screen.getByText(
          'No saved answers yet. Save one from an application review to reuse it on a similar question elsewhere.',
        ),
      ).toBeInTheDocument(),
    );
  });

  it('shows an error banner when the initial load fails', async () => {
    installWorkspaceBridge({
      listApplicationAnswers: vi.fn().mockRejectedValue(new Error('database is locked')),
    });

    render(<SavedAnswersSection />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('database is locked'));
  });

  it('edits an answer and shows the record the bridge returns', async () => {
    const updateApplicationAnswer = vi.fn().mockResolvedValue(
      answer({ answer: 'Updated answer text.', updatedAt: '2026-09-02T00:00:00.000Z' }),
    );
    installWorkspaceBridge({
      listApplicationAnswers: vi.fn().mockResolvedValue([answer()]),
      updateApplicationAnswer,
    });

    render(<SavedAnswersSection />);

    await waitFor(() => expect(screen.getByText('Why do you want to work here?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Edit answer for Why do you want to work here?' }));

    const textarea = screen.getByRole('textbox', { name: 'Edit answer for Why do you want to work here?' });
    fireEvent.change(textarea, { target: { value: 'Updated answer text.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(updateApplicationAnswer).toHaveBeenCalledWith('answer-1', { answer: 'Updated answer text.' }),
    );
    await waitFor(() => expect(screen.getByText('Updated answer text.')).toBeInTheDocument());
    expect(screen.queryByRole('textbox', { name: 'Edit answer for Why do you want to work here?' })).not.toBeInTheDocument();
  });

  it('refuses to save an empty answer without calling the bridge', async () => {
    const updateApplicationAnswer = vi.fn();
    installWorkspaceBridge({
      listApplicationAnswers: vi.fn().mockResolvedValue([answer()]),
      updateApplicationAnswer,
    });

    render(<SavedAnswersSection />);

    await waitFor(() => expect(screen.getByText('Why do you want to work here?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Edit answer for Why do you want to work here?' }));

    const textarea = screen.getByRole('textbox', { name: 'Edit answer for Why do you want to work here?' });
    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('An answer cannot be empty.')).toBeInTheDocument();
    expect(updateApplicationAnswer).not.toHaveBeenCalled();
    // Still in edit mode: nothing typed is lost.
    expect(screen.getByRole('textbox', { name: 'Edit answer for Why do you want to work here?' })).toBeInTheDocument();
  });

  it('deletes an answer after confirming, and leaves it when cancelled', async () => {
    const deleteApplicationAnswer = vi.fn().mockResolvedValue({ deleted: true });
    installWorkspaceBridge({
      listApplicationAnswers: vi.fn().mockResolvedValue([answer()]),
      deleteApplicationAnswer,
    });

    render(<SavedAnswersSection />);

    await waitFor(() => expect(screen.getByText('Why do you want to work here?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Delete answer for Why do you want to work here?' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Delete this saved answer?');

    // Cancelling leaves the row in place.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText('Why do you want to work here?')).toBeInTheDocument();
    expect(deleteApplicationAnswer).not.toHaveBeenCalled();

    // Confirming removes it.
    fireEvent.click(screen.getByRole('button', { name: 'Delete answer for Why do you want to work here?' }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteApplicationAnswer).toHaveBeenCalledWith('answer-1'));
    await waitFor(() => expect(screen.queryByText('Why do you want to work here?')).not.toBeInTheDocument());
  });
});
