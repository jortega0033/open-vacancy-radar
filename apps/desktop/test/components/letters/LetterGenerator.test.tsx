import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LetterGenerator, MAX_INSTRUCTION_CHARS } from '../../../src/components/letters/index.js';
import { CLAUDE_INSTALLED, CLAUDE_NOT_INSTALLED, CODEX_INSTALLED, installBridges } from '../../cv-bridges.js';
import { DEFAULT_SETTINGS, installSystemBridge, installWorkspaceBridge } from '../../workspace-bridge.js';
import { FACT_SELECTION, LETTER_VACANCY, makeCv, makeLetter, makeUnreviewedCv } from './fixtures.js';

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
  it('asks the run for a fact selection, never for prose, and assembles the answer into the editor', async () => {
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
    // The selection contract, not a request for a draft.
    expect(prompt).toContain('{"factIds": [string]}');
    expect(prompt).toContain('Do not return prose, a draft, a rewritten fact');
    expect(prompt).toContain('experience-1');
    // The safety layer shared with the CV assistant travels with it.
    expect(prompt).toContain('Never invent an employer, job title, date');

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: FACT_SELECTION });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    // On completion the selection is assembled into an editable document, in the tone that was
    // chosen, citing only facts the reviewed CV actually carries.
    const body = await screen.findByRole('textbox', { name: /letter body/i });
    const assembled = (body as HTMLTextAreaElement).value;
    expect(assembled).toContain('Dear Redwood Software hiring team,'); // 'concise' salutation
    expect(assembled).toContain('I am applying for the Senior Frontend Engineer role at Redwood Software.');
    expect(assembled).toContain('My reviewed CV lists Senior Frontend Engineer at Northwind Digital (2021 - present).');
    expect(assembled).toContain('My reviewed CV lists Angular as a skill.');
    expect(assembled).toContain('I am available to discuss the role.'); // 'concise' closing
    // A recruiter message carries no formal sign-off, whatever the tone.
    expect(assembled).not.toContain('Robin Vega');
    expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
  });

  it('assembles a different letter for a different tone from the same facts', async () => {
    const bridges = setup();
    render(<LetterGenerator vacancy={LETTER_VACANCY} />);

    fireEvent.change(await screen.findByLabelText(/^tone$/i), { target: { value: 'formal' } });
    fireEvent.click(await waitForGenerateEnabled());
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: FACT_SELECTION });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    const body = await screen.findByRole('textbox', { name: /letter body/i });
    const assembled = (body as HTMLTextAreaElement).value;
    // The tone moved this app's own lines; the cited facts are word for word the same ones.
    expect(assembled).toContain('Dear Redwood Software hiring team,');
    expect(assembled).toContain('I would welcome the opportunity to discuss the role');
    expect(assembled).toContain('Sincerely,\nRobin Vega'); // a motivation letter does sign off
    expect(assembled).toContain('My reviewed CV lists Angular as a skill.');
  });

  it('rejects a malformed selection instead of showing it as a letter', async () => {
    const bridges = setup();
    render(<LetterGenerator vacancy={LETTER_VACANCY} />);

    fireEvent.click(await waitForGenerateEnabled());
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Dear hiring team, I am the ideal candidate.' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    expect(await screen.findByRole('alert')).toHaveTextContent('returned invalid JSON');
    // The prose the run actually produced is nowhere on screen, in a textbox or otherwise.
    expect(screen.queryByRole('textbox', { name: /letter body/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/I am the ideal candidate/)).not.toBeInTheDocument();
  });

  it('rejects a selection naming a fact the reviewed CV does not carry', async () => {
    const bridges = setup();
    render(<LetterGenerator vacancy={LETTER_VACANCY} />);

    fireEvent.click(await waitForGenerateEnabled());
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: '{"factIds":["certification-cissp"]}' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'unsupported source facts: certification-cissp',
    );
    expect(screen.queryByRole('textbox', { name: /letter body/i })).not.toBeInTheDocument();
  });

  it('rejects a reply that smuggles a claim alongside a valid selection', async () => {
    const bridges = setup();
    render(<LetterGenerator vacancy={LETTER_VACANCY} />);

    fireEvent.click(await waitForGenerateEnabled());
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));

    bridges.emit('sess-cv-1', {
      type: 'assistant.message',
      text: '{"factIds":["skill-1"],"claim":"I am CISSP certified."}',
    });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'candidate claims outside the source-fact selection',
    );
    expect(screen.queryByText(/CISSP/)).not.toBeInTheDocument();
  });

  it('refuses to generate from a CV whose source has never been reviewed, and says what would fix it', async () => {
    const bridges = setup({ listCvDocuments: vi.fn().mockResolvedValue([makeUnreviewedCv()]) });
    render(<LetterGenerator vacancy={LETTER_VACANCY} />);

    await waitFor(() => expect(bridges.workspace.listCvDocuments).toHaveBeenCalled());
    expect(await screen.findByText(/no reviewed source record yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^generate$/i })).toBeDisabled();
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
    const created = makeLetter({ id: 'created-1', body: 'Hello Redwood Software hiring team,' });
    const createLetter = vi.fn().mockResolvedValue(created);
    const updateLetter = vi.fn();
    const bridges = setup({ createLetter, updateLetter });

    render(<LetterGenerator vacancy={LETTER_VACANCY} />);
    fireEvent.click(await waitForGenerateEnabled());
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: FACT_SELECTION });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    fireEvent.click(await screen.findByRole('button', { name: /save letter/i }));

    await waitFor(() => expect(createLetter).toHaveBeenCalledTimes(1));
    expect(createLetter).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('My reviewed CV lists Angular as a skill.'),
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

  it("names the actually-configured provider in its CLI disclosure and 'starting' status, not a hardcoded Claude Code", async () => {
    // Real regression: this copy (and AiOutput's "Starting Claude Code…" status line) used to
    // hardcode Claude Code regardless of which CLI the run actually goes through. Both CLIs are
    // installed here, so the preference itself decides -- see the issue #400 tests below for a
    // preference that names an uninstalled CLI.
    const bridges = installBridges({
      // Never resolves, so the run stays in the 'starting' state deterministically instead of
      // racing straight through to 'streaming' once the mocked session "starts".
      agentDock: {
        createSession: vi.fn(() => new Promise<never>(() => {})),
        listProviders: vi.fn().mockResolvedValue([CLAUDE_INSTALLED, CODEX_INSTALLED]),
      },
    });
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([makeCv()]),
      getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, defaultProvider: 'codex' }),
    });
    render(<LetterGenerator vacancy={LETTER_VACANCY} />);

    expect(await screen.findByText(/Generated on your own Codex CLI/)).toBeInTheDocument();
    expect(screen.queryByText(/Claude Code CLI/)).not.toBeInTheDocument();

    fireEvent.click(await waitForGenerateEnabled());
    expect(await screen.findByText(/^Starting Codex…$/)).toBeInTheDocument();

    expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1);
  });

  it('issue #400: falls back to the one installed CLI (Codex) when the persisted preference still names Claude, which is not installed', async () => {
    // The exact machine this issue is about: only Codex is installed, and `defaultProvider` is
    // still the factory default ('claude') because it is a preference, not a live detection --
    // see resolveEffectiveProvider's own doc comment for why it stays that way.
    const bridges = installBridges({
      agentDock: {
        listProviders: vi.fn().mockResolvedValue([CLAUDE_NOT_INSTALLED, CODEX_INSTALLED]),
      },
    });
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([makeCv()]),
      getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, defaultProvider: 'claude' }),
    });
    render(<LetterGenerator vacancy={LETTER_VACANCY} />);

    expect(await screen.findByText(/Generated on your own Codex CLI/)).toBeInTheDocument();

    fireEvent.click(await waitForGenerateEnabled());
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));
    expect(bridges.agentDock.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex' }),
    );
  });

  it('issue #400: never persists the resolved effective provider back as the default', async () => {
    const bridges = installBridges({
      agentDock: {
        listProviders: vi.fn().mockResolvedValue([CLAUDE_NOT_INSTALLED, CODEX_INSTALLED]),
      },
    });
    const workspace = installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([makeCv()]),
      getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, defaultProvider: 'claude' }),
    });
    render(<LetterGenerator vacancy={LETTER_VACANCY} />);

    fireEvent.click(await waitForGenerateEnabled());
    await waitFor(() =>
      expect(bridges.agentDock.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'codex' }),
      ),
    );
    expect(workspace.updateSettings).not.toHaveBeenCalled();
  });
});
