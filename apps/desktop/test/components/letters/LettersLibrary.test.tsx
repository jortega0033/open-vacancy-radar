import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LettersLibrary } from '../../../src/components/letters/index.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';
import { makeLetter } from './fixtures.js';

/** The row for a letter, found by its title cell. The actions are only unique within it. */
function rowFor(title: string): HTMLElement {
  const cell = screen.getByRole('cell', { name: title });
  const row = cell.closest('tr');
  if (!row) throw new Error(`no row for ${title}`);
  return row;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LettersLibrary', () => {
  it('lists saved letters with their type, date and status', async () => {
    installWorkspaceBridge({
      listLetters: vi.fn().mockResolvedValue([
        makeLetter({ id: 'a', title: 'Motivation letter: Redwood', type: 'motivation_letter', status: 'draft' }),
        makeLetter({
          id: 'b',
          title: 'Recruiter note: Freeday',
          company: 'Freeday',
          role: 'Frontend Developer',
          type: 'recruiter_message',
          status: 'sent',
        }),
      ]),
    });

    render(<LettersLibrary onOpen={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Motivation letter: Redwood')).toBeInTheDocument());
    expect(screen.getByText('Recruiter note: Freeday')).toBeInTheDocument();
    // Labels come from LETTER_TYPE_OPTIONS / LETTER_STATUS_OPTIONS, never the raw column value.
    expect(screen.getByText('Motivation letter')).toBeInTheDocument();
    expect(screen.getByText('Recruiter message')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.queryByText('recruiter_message')).not.toBeInTheDocument();
    // formatUpdatedAt renders a locale date rather than the ISO string.
    expect(screen.queryByText('2026-08-20T10:00:00.000Z')).not.toBeInTheDocument();
  });

  it('shows an empty state with a way to start a letter', async () => {
    installWorkspaceBridge({ listLetters: vi.fn().mockResolvedValue([]) });
    const onNew = vi.fn();

    render(<LettersLibrary onOpen={vi.fn()} onNew={onNew} />);

    await waitFor(() => expect(screen.getByText(/no letters yet/i)).toBeInTheDocument());
    expect(screen.getByTestId('empty-state-illustration').getAttribute('style')).toContain('empty-letters');

    // One is in the toolbar and one is under the empty-state copy.
    const newButtons = screen.getAllByRole('button', { name: /new letter/i });
    expect(newButtons).toHaveLength(2);
    fireEvent.click(newButtons[1] as HTMLElement);
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('hands the row to onOpen when Open is clicked', async () => {
    const letter = makeLetter({ id: 'open-1', title: 'Cover letter: Acme' });
    installWorkspaceBridge({ listLetters: vi.fn().mockResolvedValue([letter]) });
    const onOpen = vi.fn();

    render(<LettersLibrary onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByText('Cover letter: Acme')).toBeInTheDocument());

    fireEvent.click(within(rowFor('Cover letter: Acme')).getByRole('button', { name: /^open$/i }));

    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'open-1' }));
  });

  it('duplicates a letter and shows the copy at the top of the list', async () => {
    const letter = makeLetter({ id: 'dup-1', title: 'Motivation letter: Redwood' });
    const duplicateLetter = vi
      .fn()
      .mockResolvedValue(makeLetter({ id: 'dup-2', title: 'Motivation letter: Redwood (copy)' }));
    installWorkspaceBridge({ listLetters: vi.fn().mockResolvedValue([letter]), duplicateLetter });
    const onCountChanged = vi.fn();

    render(<LettersLibrary onOpen={vi.fn()} onCountChanged={onCountChanged} />);
    await waitFor(() => expect(screen.getByText('Motivation letter: Redwood')).toBeInTheDocument());

    fireEvent.click(within(rowFor('Motivation letter: Redwood')).getByRole('button', { name: /duplicate/i }));

    await waitFor(() => expect(duplicateLetter).toHaveBeenCalledWith('dup-1'));
    expect(await screen.findByText('Motivation letter: Redwood (copy)')).toBeInTheDocument();
    expect(screen.getByText('Motivation letter: Redwood')).toBeInTheDocument();
    await waitFor(() => expect(onCountChanged).toHaveBeenCalled());
  });

  it('reports a failed duplicate and keeps the list intact', async () => {
    installWorkspaceBridge({
      listLetters: vi.fn().mockResolvedValue([makeLetter({ id: 'dup-1' })]),
      duplicateLetter: vi.fn().mockRejectedValue(new Error('database is locked')),
    });

    render(<LettersLibrary onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(makeLetter().title)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /duplicate/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('database is locked');
    expect(screen.getByText(makeLetter().title)).toBeInTheDocument();
  });

  it('deletes a letter only after the confirm dialog is accepted', async () => {
    const letter = makeLetter({ id: 'del-1', title: 'Motivation letter: Redwood' });
    const deleteLetter = vi.fn().mockResolvedValue({ deleted: true });
    installWorkspaceBridge({ listLetters: vi.fn().mockResolvedValue([letter]), deleteLetter });

    render(<LettersLibrary onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Motivation letter: Redwood')).toBeInTheDocument());

    fireEvent.click(within(rowFor('Motivation letter: Redwood')).getByRole('button', { name: /delete/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/motivation letter: redwood/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(deleteLetter).toHaveBeenCalledWith('del-1'));
    await waitFor(() => expect(screen.getByText(/no letters yet/i)).toBeInTheDocument());
  });

  it('cancelling the confirm dialog deletes nothing', async () => {
    const deleteLetter = vi.fn().mockResolvedValue({ deleted: true });
    installWorkspaceBridge({ listLetters: vi.fn().mockResolvedValue([makeLetter({ id: 'keep-1' })]), deleteLetter });

    render(<LettersLibrary onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(makeLetter().title)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(deleteLetter).not.toHaveBeenCalled();
    expect(screen.getByText(makeLetter().title)).toBeInTheDocument();
  });

  it('surfaces a load failure instead of an empty table', async () => {
    installWorkspaceBridge({ listLetters: vi.fn().mockRejectedValue(new Error('workspace database unreachable')) });

    render(<LettersLibrary onOpen={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('workspace database unreachable');
    expect(screen.queryByText(/no letters yet/i)).not.toBeInTheDocument();
  });

  it('reloads when the parent bumps refreshToken', async () => {
    const listLetters = vi
      .fn()
      .mockResolvedValueOnce([makeLetter({ id: 'a', title: 'First letter' })])
      .mockResolvedValueOnce([
        makeLetter({ id: 'a', title: 'First letter' }),
        makeLetter({ id: 'b', title: 'Second letter' }),
      ]);
    installWorkspaceBridge({ listLetters });

    const { rerender } = render(<LettersLibrary refreshToken={0} onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('First letter')).toBeInTheDocument());

    rerender(<LettersLibrary refreshToken={1} onOpen={vi.fn()} />);

    expect(await screen.findByText('Second letter')).toBeInTheDocument();
    expect(listLetters).toHaveBeenCalledTimes(2);
  });
});
