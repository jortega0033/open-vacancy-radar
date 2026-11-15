import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LettersLibrary } from '../../../src/components/letters/index.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';
import { makeLetter } from './fixtures.js';

// The preview draws pages with pdf.js; jsdom has no canvas, so the page renderer is stood in for.
vi.mock('../../../src/components/cv/pdf-pages.js', () => ({
  openPdfForReview: vi.fn(async () => ({
    pageCount: 1,
    renderPage: async () => undefined,
    extractText: async () => 'page text',
    destroy: async () => undefined,
  })),
}));

/** The row for a letter, found by its title cell: the actions are only unique within it. */
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
        makeLetter({ id: 'a', title: 'Motivation letter — Redwood', type: 'motivation_letter', status: 'draft' }),
        makeLetter({
          id: 'b',
          title: 'Recruiter note — Freeday',
          company: 'Freeday',
          role: 'Frontend Developer',
          type: 'recruiter_message',
          status: 'sent',
        }),
      ]),
    });

    render(<LettersLibrary onOpen={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Motivation letter — Redwood')).toBeInTheDocument());
    expect(screen.getByText('Recruiter note — Freeday')).toBeInTheDocument();
    // Labels come from LETTER_TYPE_OPTIONS / LETTER_STATUS_OPTIONS, never the raw column value.
    // Scoped to the table: the type filter's options carry the same labels.
    const table = screen.getByRole('table');
    expect(within(table).getByText('Motivation letter')).toBeInTheDocument();
    expect(within(table).getByText('Recruiter message')).toBeInTheDocument();
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

    // Exactly one "New letter" while the list is empty: the empty state's own button.
    const newButtons = screen.getAllByRole('button', { name: /new letter/i });
    expect(newButtons).toHaveLength(1);
    fireEvent.click(newButtons[0] as HTMLElement);
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('hands the row to onOpen when Open is clicked', async () => {
    const letter = makeLetter({ id: 'open-1', title: 'Cover letter — Acme' });
    installWorkspaceBridge({ listLetters: vi.fn().mockResolvedValue([letter]) });
    const onOpen = vi.fn();

    render(<LettersLibrary onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByText('Cover letter — Acme')).toBeInTheDocument());

    fireEvent.click(within(rowFor('Cover letter — Acme')).getByRole('button', { name: /open cover letter/i }));

    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'open-1' }));
  });

  it('duplicates a letter and shows the copy at the top of the list', async () => {
    const letter = makeLetter({ id: 'dup-1', title: 'Motivation letter — Redwood' });
    const duplicateLetter = vi
      .fn()
      .mockResolvedValue(makeLetter({ id: 'dup-2', title: 'Motivation letter — Redwood (copy)' }));
    installWorkspaceBridge({ listLetters: vi.fn().mockResolvedValue([letter]), duplicateLetter });
    const onCountChanged = vi.fn();

    render(<LettersLibrary onOpen={vi.fn()} onCountChanged={onCountChanged} />);
    await waitFor(() => expect(screen.getByText('Motivation letter — Redwood')).toBeInTheDocument());

    fireEvent.click(within(rowFor('Motivation letter — Redwood')).getByRole('button', { name: /duplicate/i }));

    await waitFor(() => expect(duplicateLetter).toHaveBeenCalledWith('dup-1'));
    expect(await screen.findByText('Motivation letter — Redwood (copy)')).toBeInTheDocument();
    expect(screen.getByText('Motivation letter — Redwood')).toBeInTheDocument();
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
    const letter = makeLetter({ id: 'del-1', title: 'Motivation letter — Redwood' });
    const deleteLetter = vi.fn().mockResolvedValue({ deleted: true });
    installWorkspaceBridge({ listLetters: vi.fn().mockResolvedValue([letter]), deleteLetter });

    render(<LettersLibrary onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Motivation letter — Redwood')).toBeInTheDocument());

    fireEvent.click(within(rowFor('Motivation letter — Redwood')).getByRole('button', { name: /delete motivation/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/motivation letter — redwood/i)).toBeInTheDocument();
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

  it('keeps a single "New letter" button on screen, in the toolbar once there are rows', async () => {
    installWorkspaceBridge({ listLetters: vi.fn().mockResolvedValue([makeLetter()]) });

    render(<LettersLibrary onOpen={vi.fn()} onNew={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(makeLetter().title)).toBeInTheDocument());

    expect(screen.getAllByRole('button', { name: /new letter/i })).toHaveLength(1);
  });

  describe('delete with undo', () => {
    it('offers Undo after a delete, and Undo restores the same letter (same id), never a copy', async () => {
      const letter = makeLetter({
        id: 'del-1',
        title: 'Cover letter, Synthetic Co',
        company: 'Synthetic Co',
        role: 'Data Analyst',
        type: 'cover_letter',
        tone: 'formal',
        length: 'short',
        status: 'sent',
        vacancyKey: 'vk-1',
        cvId: 'cv-1',
        body: 'Dear team, synthetic body.',
      });
      const deleteLetter = vi.fn().mockResolvedValue({ deleted: true });
      const createLetter = vi.fn();
      const restoreLetter = vi.fn().mockResolvedValue(letter);
      const purgeLetter = vi.fn().mockResolvedValue({ deleted: true });
      const onCountChanged = vi.fn();
      installWorkspaceBridge({ listLetters: vi.fn().mockResolvedValue([letter]), deleteLetter, createLetter, restoreLetter, purgeLetter });

      render(<LettersLibrary onOpen={vi.fn()} onCountChanged={onCountChanged} />);
      await waitFor(() => expect(screen.getByText(letter.title)).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /^delete /i }));
      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).getByText(/you can undo this/i)).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

      const toast = await screen.findByRole('status');
      expect(toast).toHaveTextContent('Deleted "Cover letter, Synthetic Co".');
      expect(screen.queryByRole('cell', { name: letter.title })).not.toBeInTheDocument();

      fireEvent.click(within(toast).getByRole('button', { name: /^undo$/i }));

      await waitFor(() => expect(restoreLetter).toHaveBeenCalledWith('del-1'));
      expect(createLetter).not.toHaveBeenCalled();
      // The toast closing because of Undo must not purge the letter being restored.
      expect(purgeLetter).not.toHaveBeenCalled();
      expect(await screen.findByRole('cell', { name: letter.title })).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(onCountChanged).toHaveBeenCalledTimes(2);
    });

    it('shows no Undo when the letter had already been deleted', async () => {
      const deleteLetter = vi.fn().mockResolvedValue({ deleted: false });
      installWorkspaceBridge({ listLetters: vi.fn().mockResolvedValue([makeLetter()]), deleteLetter });

      render(<LettersLibrary onOpen={vi.fn()} />);
      await waitFor(() => expect(screen.getByText(makeLetter().title)).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /^delete /i }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^delete$/i }));

      expect(await screen.findByText(/already been deleted/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^undo$/i })).not.toBeInTheDocument();
    });

    it('reports a failed Undo instead of silently losing the letter, and does not purge it', async () => {
      const deleteLetter = vi.fn().mockResolvedValue({ deleted: true });
      const restoreLetter = vi.fn().mockRejectedValue(new Error('database is locked'));
      const purgeLetter = vi.fn().mockResolvedValue({ deleted: true });
      installWorkspaceBridge({ listLetters: vi.fn().mockResolvedValue([makeLetter()]), deleteLetter, restoreLetter, purgeLetter });

      render(<LettersLibrary onOpen={vi.fn()} />);
      await waitFor(() => expect(screen.getByText(makeLetter().title)).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /^delete /i }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^delete$/i }));
      fireEvent.click(await screen.findByRole('button', { name: /^undo$/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('database is locked');
      // Undo was asked for, so the toast closing does not purge; the next start does.
      expect(purgeLetter).not.toHaveBeenCalled();
    });

    it('purges the deleted letter when the Library is left during the undo window', async () => {
      const purgeLetter = vi.fn().mockResolvedValue({ deleted: true });
      installWorkspaceBridge({
        listLetters: vi.fn().mockResolvedValue([makeLetter()]),
        deleteLetter: vi.fn().mockResolvedValue({ deleted: true }),
        purgeLetter,
      });
      const { unmount } = render(<LettersLibrary onOpen={vi.fn()} />);
      await waitFor(() => expect(screen.getByText(makeLetter().title)).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /^delete /i }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^delete$/i }));
      await screen.findByRole('button', { name: /^undo$/i });
      unmount();
      expect(purgeLetter).toHaveBeenCalledWith('letter-1');
    });

    it('keeps the undo toast while a preview is open', async () => {
      installWorkspaceBridge({
        listLetters: vi.fn().mockResolvedValue([makeLetter(), makeLetter({ id: 'other', title: 'Another letter' })]),
        deleteLetter: vi.fn().mockResolvedValue({ deleted: true }),
      });
      render(<LettersLibrary onOpen={vi.fn()} />);
      await waitFor(() => expect(screen.getByText('Another letter')).toBeInTheDocument());
      fireEvent.click(within(rowFor(makeLetter().title)).getByRole('button', { name: /^delete /i }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^delete$/i }));
      await screen.findByRole('button', { name: /^undo$/i });
      fireEvent.click(screen.getByRole('button', { name: 'Preview Another letter' }));
      expect(await screen.findByRole('region', { name: 'Preview of Another letter' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^undo$/i })).toBeInTheDocument();
    });
  });

  it('purges the deleted letter for good once the undo window closes without Undo', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const purgeLetter = vi.fn().mockResolvedValue({ deleted: true });
      installWorkspaceBridge({
        listLetters: vi.fn().mockResolvedValue([makeLetter()]),
        deleteLetter: vi.fn().mockResolvedValue({ deleted: true }),
        purgeLetter,
      });
      render(<LettersLibrary onOpen={vi.fn()} />);
      await waitFor(() => expect(screen.getByText(makeLetter().title)).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /^delete /i }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^delete$/i }));
      await screen.findByRole('button', { name: /^undo$/i });
      expect(purgeLetter).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      await waitFor(() => expect(purgeLetter).toHaveBeenCalledWith('letter-1'));
    } finally {
      vi.useRealTimers();
    }
  });

  describe('#738 search, preview and usage', () => {
    const letters = [
      makeLetter({ id: 'a', title: 'Redwood cover', company: 'Redwood Software', type: 'cover_letter', body: 'About design systems.' }),
      makeLetter({ id: 'b', title: 'Freeday note', company: 'Freeday', role: 'Analyst', type: 'recruiter_message', body: 'Quick hello about Kafka.' }),
    ];

    it('searches title, company, role and body, filters by type, and offers a way back from no matches', async () => {
      installWorkspaceBridge({ listLetters: vi.fn().mockResolvedValue(letters) });
      render(<LettersLibrary onOpen={vi.fn()} />);
      await waitFor(() => expect(screen.getByText('Redwood cover')).toBeInTheDocument());
      const search = screen.getByRole('searchbox', { name: /search letters/i });

      fireEvent.change(search, { target: { value: 'KAFKA' } });
      expect(screen.queryByText('Redwood cover')).not.toBeInTheDocument();
      expect(screen.getByText('Freeday note')).toBeInTheDocument();

      fireEvent.change(search, { target: { value: 'redwood' } });
      expect(screen.getByText('Redwood cover')).toBeInTheDocument();
      expect(screen.queryByText('Freeday note')).not.toBeInTheDocument();

      fireEvent.change(search, { target: { value: '' } });
      fireEvent.change(screen.getByRole('combobox', { name: /type/i }), { target: { value: 'recruiter_message' } });
      expect(screen.queryByText('Redwood cover')).not.toBeInTheDocument();

      fireEvent.change(search, { target: { value: 'redwood' } });
      expect(screen.getByText('No letters match.')).toBeInTheDocument();
      expect(screen.queryByText(/no letters yet/i)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /clear search/i }));
      expect(screen.getByText('Redwood cover')).toBeInTheDocument();
      expect(screen.getByText('Freeday note')).toBeInTheDocument();
    });

    it('shows created date (or that it was not recorded), the usage count and an "Edited since sent" marker', async () => {
      installWorkspaceBridge({
        listLetters: vi.fn().mockResolvedValue([
          { ...letters[0]!, createdAt: null, currentVersion: 3 },
          letters[1]!,
        ]),
        listLetterUsageSummaries: vi.fn().mockResolvedValue([
          { letterId: 'a', usedIn: 2, latestSentVersion: 2, editedSinceSent: true },
          { letterId: 'b', usedIn: 1, latestSentVersion: 1, editedSinceSent: false },
        ]),
      });
      render(<LettersLibrary onOpen={vi.fn()} />);
      await waitFor(() => expect(screen.getByText('2 applications')).toBeInTheDocument());
      const rowA = rowFor('Redwood cover');
      expect(within(rowA).getByText('Not recorded')).toBeInTheDocument();
      expect(within(rowA).getByText('Edited since sent')).toBeInTheDocument();
      expect(within(rowA).getByText('Version 3')).toBeInTheDocument();
      const rowB = rowFor('Freeday note');
      expect(within(rowB).getByText('1 application')).toBeInTheDocument();
      expect(within(rowB).queryByText('Edited since sent')).not.toBeInTheDocument();
    });

    it('opens the preview requested by an application, or says the letter is gone', async () => {
      installWorkspaceBridge({ listLetters: vi.fn().mockResolvedValue(letters) });
      const { unmount } = render(<LettersLibrary onOpen={vi.fn()} initialPreview={{ letterId: 'missing', versionId: 'v9' }} />);
      expect(await screen.findByText(/that letter has been deleted/i)).toBeInTheDocument();
      unmount();

      render(<LettersLibrary onOpen={vi.fn()} initialPreview={{ letterId: 'a', versionId: null }} />);
      expect(await screen.findByRole('region', { name: 'Preview of Redwood cover' })).toBeInTheDocument();
    });
  });
});
