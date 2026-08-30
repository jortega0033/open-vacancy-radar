import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LetterGenerator, MAX_INSTRUCTION_CHARS } from '../../../src/components/letters/index.js';
import { installBridges } from '../../cv-bridges.js';
import { installSystemBridge, installWorkspaceBridge } from '../../workspace-bridge.js';
import { LETTER_VACANCY, makeCv, makeLetter } from './fixtures.js';

/**
 * `installBridges` installs a *default* workspace bridge of its own (the CV assistant saves to the
 * library), so the workspace overrides a test cares about have to be installed after it.
 */
function setup(workspace: Parameters<typeof installWorkspaceBridge>[0] = {}) {
  const bridges = installBridges();
  const ws = installWorkspaceBridge({
    listCvDocuments: vi.fn().mockResolvedValue([makeCv()]),
    ...workspace,
  });
  const system = installSystemBridge();
  return { ...bridges, workspace: ws, system };
}

/** jsdom has no clipboard implementation, so install one we can assert against. */
function installClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
  return writeText;
}

/** The Generate button only enables once a CV and a job are both resolved. */
async function waitForGenerateEnabled(name: RegExp = /^generate$/i) {
  const button = await screen.findByRole('button', { name });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LetterGenerator', () => {
  it('builds the prompt from the chosen CV, job and document settings, then streams the draft in', async () => {
    const bridges = setup();
    render(<LetterGenerator vacancy={LETTER_VACANCY} />);

    await waitFor(() => expect(bridges.workspace.listCvDocuments).toHaveBeenCalled());
    expect(await screen.findByRole('combobox', { name: 'CV' })).toHaveValue('cv-1');

    // The three document controls are driven by the LETTER_*_OPTIONS constants.
    fireEvent.change(screen.getByLabelText(/^type$/i), { target: { value: 'recruiter_message' } });
    fireEvent.change(screen.getByLabelText(/^tone$/i), { target: { value: 'concise' } });
    fireEvent.change(screen.getByLabelText(/^length$/i), { target: { value: 'short' } });

    const instructions = screen.getByLabelText(/personal instructions/i);
    expect(instructions).toHaveAttribute('maxlength', String(MAX_INSTRUCTION_CHARS));
    fireEvent.change(instructions, { target: { value: 'Mention the referral from Marta.' } });

    fireEvent.click(await waitForGenerateEnabled());
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));

    const prompt = vi.mocked(bridges.agentDock.createSession).mock.calls[0]?.[0].prompt ?? '';
    expect(prompt).toContain('a short direct message to a recruiter');
    expect(prompt).toContain('Redwood Software');
    expect(prompt).toContain('Angular architect. Eight years of frontend work.');
    expect(prompt).toContain('Mention the referral from Marta.');
    // The safety layer shared with the CV assistant travels with it.
    expect(prompt).toContain('Do not invent a hiring manager');

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Hi — I saw the frontend role.' });
    expect(await screen.findByRole('log', { name: /letter being generated/i })).toHaveTextContent(
      'Hi — I saw the frontend role.',
    );

    bridges.emit('sess-cv-1', { type: 'session.completed' });

    // On completion the stream hands over to an editable document.
    const body = await screen.findByRole('textbox', { name: /letter body/i });
    expect(body).toHaveValue('Hi — I saw the frontend role.');
    expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
  });

  it('surfaces a failed generation without destroying the letter already open', async () => {
    const bridges = setup();
    render(<LetterGenerator letter={makeLetter()} vacancy={null} />);

    const body = await screen.findByRole('textbox', { name: /letter body/i });
    expect(body).toHaveValue(makeLetter().body);

    fireEvent.click(await waitForGenerateEnabled(/^regenerate$/i));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));

    bridges.emit('sess-cv-1', { type: 'session.failed', message: 'provider CLI is not authenticated' });

    expect(await screen.findByRole('alert')).toHaveTextContent('provider CLI is not authenticated');
    // The document the user already had is untouched.
    expect(screen.getByRole('textbox', { name: /letter body/i })).toHaveValue(makeLetter().body);
  });

  it('reports a session that could not be started at all', async () => {
    const bridges = setup();
    vi.mocked(bridges.agentDock.createSession).mockRejectedValue(new Error('AgentDock daemon is not running'));
    render(<LetterGenerator vacancy={LETTER_VACANCY} />);

    fireEvent.click(await waitForGenerateEnabled());

    expect(await screen.findByRole('alert')).toHaveTextContent('AgentDock daemon is not running');
    expect(screen.queryByRole('textbox', { name: /letter body/i })).not.toBeInTheDocument();
  });

  it('creates a new row on the first save', async () => {
    const created = makeLetter({ id: 'created-1', body: 'Dear hiring team, generated text.' });
    const createLetter = vi.fn().mockResolvedValue(created);
    const updateLetter = vi.fn();
    const bridges = setup({ createLetter, updateLetter });

    render(<LetterGenerator vacancy={LETTER_VACANCY} />);
    fireEvent.click(await waitForGenerateEnabled());
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Dear hiring team, generated text.' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    fireEvent.click(await screen.findByRole('button', { name: /save letter/i }));

    await waitFor(() => expect(createLetter).toHaveBeenCalledTimes(1));
    expect(createLetter).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Dear hiring team, generated text.',
        company: 'Redwood Software',
        role: 'Senior Frontend Engineer',
        type: 'motivation_letter',
        status: 'draft',
        cvId: 'cv-1',
        vacancyKey: 'redwood:senior-frontend-engineer',
      }),
    );
    expect(updateLetter).not.toHaveBeenCalled();

    // The second save must update the row the first one created, not add another.
    fireEvent.change(screen.getByRole('textbox', { name: /letter body/i }), {
      target: { value: 'Dear hiring team, edited text.' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateLetter).toHaveBeenCalledTimes(1));
    expect(updateLetter).toHaveBeenCalledWith('created-1', expect.objectContaining({ body: 'Dear hiring team, edited text.' }));
    expect(createLetter).toHaveBeenCalledTimes(1);
  });

  it('updates the existing row when an already-saved letter is opened and edited', async () => {
    const letter = makeLetter();
    const createLetter = vi.fn();
    const updateLetter = vi.fn().mockResolvedValue({ ...letter, body: 'Edited body.', status: 'final' });
    const onSaved = vi.fn();
    setup({ createLetter, updateLetter });

    render(<LetterGenerator letter={letter} onSaved={onSaved} />);

    const body = await screen.findByRole('textbox', { name: /letter body/i });
    fireEvent.change(body, { target: { value: 'Edited body.' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'final' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateLetter).toHaveBeenCalledTimes(1));
    expect(updateLetter).toHaveBeenCalledWith(
      'letter-1',
      expect.objectContaining({ body: 'Edited body.', status: 'final', title: letter.title }),
    );
    expect(createLetter).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'letter-1' })));
  });

  it('reports a failed save and keeps the text', async () => {
    const letter = makeLetter();
    setup({ updateLetter: vi.fn().mockRejectedValue(new Error('database is locked')) });

    render(<LetterGenerator letter={letter} />);

    fireEvent.click(await screen.findByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('database is locked');
    expect(screen.getByRole('textbox', { name: /letter body/i })).toHaveValue(letter.body);
  });

  it('cannot generate without a CV, and says why', async () => {
    setup({ listCvDocuments: vi.fn().mockResolvedValue([]) });
    render(<LetterGenerator vacancy={LETTER_VACANCY} />);

    await waitFor(() => expect(screen.getByText(/no cvs saved yet/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^generate$/i })).toBeDisabled();
  });

  it('asks before replacing unsaved edits, and only then regenerates', async () => {
    const bridges = setup();
    render(<LetterGenerator letter={makeLetter()} vacancy={LETTER_VACANCY} />);

    const body = await screen.findByRole('textbox', { name: /letter body/i });
    fireEvent.change(body, { target: { value: 'My own careful edit.' } });

    fireEvent.click(await waitForGenerateEnabled(/^regenerate$/i));
    expect(bridges.agentDock.createSession).not.toHaveBeenCalled();
    expect(await screen.findByText(/replaces the current text/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /keep my draft/i }));
    expect(bridges.agentDock.createSession).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: /letter body/i })).toHaveValue('My own careful edit.');

    fireEvent.click(screen.getByRole('button', { name: /^regenerate$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /regenerate anyway/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));
  });

  it('copies the letter body to the clipboard and confirms it', async () => {
    setup();
    const writeText = installClipboard();
    render(<LetterGenerator letter={makeLetter()} vacancy={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /^copy$/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(makeLetter().body));
    expect(await screen.findByText(/copied to clipboard/i)).toBeInTheDocument();
  });

  it('reports a clipboard failure instead of silently claiming success', async () => {
    setup();
    installClipboard(vi.fn().mockRejectedValue(new Error('permission denied')));
    render(<LetterGenerator letter={makeLetter()} vacancy={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /^copy$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('permission denied');
    expect(screen.queryByText(/copied to clipboard/i)).not.toBeInTheDocument();
  });

  it('exports the letter as a real file through the native save dialog', async () => {
    const { system } = setup();
    render(<LetterGenerator letter={makeLetter()} vacancy={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /^export$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /markdown \(\.md\)/i }));

    await waitFor(() => expect(system.saveFile).toHaveBeenCalledTimes(1));
    const call = vi.mocked(system.saveFile).mock.calls[0]?.[0];
    expect(call?.suggestedName).toMatch(/\.md$/);
    expect(call?.encoding).toBe('utf8');
    expect(call?.data).toContain(makeLetter().body);
    expect(await screen.findByText(/^exported\.$/i)).toBeInTheDocument();
  });

  it('does not report an error when the user cancels the save dialog', async () => {
    const { system } = setup();
    vi.mocked(system.saveFile).mockResolvedValue({ saved: false });
    render(<LetterGenerator letter={makeLetter()} vacancy={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /^export$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /word \(\.docx\)/i }));

    await waitFor(() => expect(system.saveFile).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/^exported\.$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports an export failure without losing the letter', async () => {
    const { system } = setup();
    vi.mocked(system.saveFile).mockRejectedValue(new Error('disk is full'));
    render(<LetterGenerator letter={makeLetter()} vacancy={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /^export$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /pdf \(\.pdf\)/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('disk is full');
    expect(screen.getByRole('textbox', { name: /letter body/i })).toHaveValue(makeLetter().body);
  });
});
