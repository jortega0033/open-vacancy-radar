import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LettersPage } from '../../../src/components/letters/index.js';
import { installBridges } from '../../cv-bridges.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';
import { LETTER_VACANCY, makeCv, makeLetter } from './fixtures.js';

function setup(workspace: Parameters<typeof installWorkspaceBridge>[0] = {}) {
  const bridges = installBridges();
  const ws = installWorkspaceBridge({
    listCvDocuments: vi.fn().mockResolvedValue([makeCv()]),
    listLetters: vi.fn().mockResolvedValue([]),
    ...workspace,
  });
  return { ...bridges, workspace: ws };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LettersPage', () => {
  it('opens on the library and can switch to the generator and back', async () => {
    setup({ listLetters: vi.fn().mockResolvedValue([makeLetter()]) });
    render(<LettersPage />);

    await waitFor(() => expect(screen.getByText(makeLetter().title)).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: /library/i })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('tab', { name: /generator/i }));

    expect(await screen.findByRole('textbox', { name: /letter title/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /generator/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /library/i }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('opening a letter from the library loads it into the generator in edit mode', async () => {
    const letter = makeLetter({ title: 'Motivation letter: Redwood', body: 'Saved body text.' });
    setup({ listLetters: vi.fn().mockResolvedValue([letter]) });

    render(<LettersPage />);
    await waitFor(() => expect(screen.getByText('Motivation letter: Redwood')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));

    expect(await screen.findByRole('textbox', { name: /letter title/i })).toHaveValue(
      'Motivation letter: Redwood',
    );
    expect(screen.getByRole('textbox', { name: /letter body/i })).toHaveValue('Saved body text.');
    // Edit mode: the action updates the existing row rather than adding one.
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
  });

  it('"New letter" from the library opens a blank generator', async () => {
    setup({ listLetters: vi.fn().mockResolvedValue([makeLetter({ title: 'An old letter' })]) });

    render(<LettersPage />);
    await waitFor(() => expect(screen.getByText('An old letter')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /new letter/i }));

    await waitFor(() => expect(screen.queryByRole('table')).not.toBeInTheDocument());
    expect(screen.queryByRole('textbox', { name: /letter body/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no document yet/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /letter title/i })).not.toHaveValue('An old letter');
  });

  it('a save in the generator refreshes the library and reports the change upward', async () => {
    const saved = makeLetter({ id: 'saved-1', title: 'Motivation letter: Redwood Software' });
    const listLetters = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([saved]);
    const onLettersChanged = vi.fn();
    const bridges = setup({ listLetters, createLetter: vi.fn().mockResolvedValue(saved) });

    render(<LettersPage vacancy={LETTER_VACANCY} onLettersChanged={onLettersChanged} />);
    await waitFor(() => expect(screen.getByText(/no letters yet/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: /generator/i }));

    const generate = await screen.findByRole('button', { name: /^generate$/i });
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Dear hiring team, generated text.' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    fireEvent.click(await screen.findByRole('button', { name: /save letter/i }));

    await waitFor(() => expect(onLettersChanged).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('tab', { name: /library/i }));

    expect(await screen.findByText('Motivation letter: Redwood Software')).toBeInTheDocument();
    expect(listLetters).toHaveBeenCalledTimes(2);
  });

  it('deleting from the library reports the count change upward', async () => {
    const deleteLetter = vi.fn().mockResolvedValue({ deleted: true });
    const onLettersChanged = vi.fn();
    setup({ listLetters: vi.fn().mockResolvedValue([makeLetter({ id: 'del-1' })]), deleteLetter });

    render(<LettersPage onLettersChanged={onLettersChanged} />);
    await waitFor(() => expect(screen.getByText(makeLetter().title)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(deleteLetter).toHaveBeenCalledWith('del-1'));
    await waitFor(() => expect(onLettersChanged).toHaveBeenCalled());
  });

  it('"Back to library" from the generator returns to the list', async () => {
    setup({ listLetters: vi.fn().mockResolvedValue([makeLetter()]) });

    render(<LettersPage />);
    await waitFor(() => expect(screen.getByText(makeLetter().title)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));
    await screen.findByRole('textbox', { name: /letter title/i });

    fireEvent.click(screen.getByRole('button', { name: /back to library/i }));

    expect(await screen.findByRole('table')).toBeInTheDocument();
  });
});
