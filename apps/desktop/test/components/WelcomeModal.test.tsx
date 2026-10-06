import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ProviderStatus } from '@agent-dock/shared';
import type { AtsRosterImportResult } from '@open-vacancy-radar/vacancy-engine';
import { App } from '../../src/App.js';
import type { AgentDockBridge, CvBridge, CvDocumentRecord } from '../../src/window.js';
import {
  DEFAULT_CANDIDATE_PROFILE,
  DEFAULT_COUNTS,
  DEFAULT_SETTINGS,
  installVacancyRadarBridge,
  installWorkspaceBridge,
} from '../workspace-bridge.js';

/**
 * The welcome modal's gate lives in `App.tsx` (settings + the CV-document count decide whether it
 * renders at all), so these drive the real shell rather than the component in isolation: a test
 * that rendered `<WelcomeModal />` directly would prove nothing about the one thing that can
 * actually go wrong here, which is showing it to the wrong user.
 */

function makeCv(overrides: Partial<CvDocumentRecord> = {}): CvDocumentRecord {
  return {
    id: 'cv-1',
    name: 'Frontend CV',
    kind: 'uploaded',
    targetRole: 'Senior Frontend Engineer',
    text: 'Angular. TypeScript. 8 years.',
    profile: { title: '', years: '', location: '', languages: '', skills: [], summary: '', auth: '' },
    source: null,
    textSource: 'text_layer',
    isDefault: false,
    uploadedAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

/** Only the upload-and-skip tests need this to stay inert; the auto-fill tests install their own
 * session-driving version via `installDrivableAgentDockBridge` below. */
function installAgentDockBridge(): void {
  const bridge: AgentDockBridge = {
    getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' }),
    restartDaemon: vi.fn().mockResolvedValue({ state: 'ready' }),
    onDaemonStatus: vi.fn().mockReturnValue(() => {}),
    listProviders: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    onSessionEvent: vi.fn().mockReturnValue(() => {}),
    selectDirectory: vi.fn(),
  };
  (window as unknown as { agentDock: AgentDockBridge }).agentDock = bridge;
}

/** The auto-started "Fill from CV" step this modal now hands off into after a successful upload
 * needs a real, drivable agent session, the same shape `test/cv-bridges.ts` gives the CV assistant
 * tests: `createSession` resolves to a fixed id, and `emit` pushes events into whatever
 * `onSessionEvent` callback the drawer registered. */
function installDrivableAgentDockBridge(): { agentDock: AgentDockBridge; emit: (sessionId: string, event: AgentEvent) => void } {
  const listeners: ((sessionId: string, event: AgentEvent) => void)[] = [];
  const bridge: AgentDockBridge = {
    getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' }),
    restartDaemon: vi.fn().mockResolvedValue({ state: 'ready' }),
    onDaemonStatus: vi.fn().mockReturnValue(() => {}),
    listProviders: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue({
      id: 'sess-welcome-cv',
      provider: 'claude',
      cwd: '/userData/ai-workspace',
      prompt: 'ignored',
      status: 'starting',
      startedAt: new Date().toISOString(),
    }),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    onSessionEvent: vi.fn((cb: (sessionId: string, event: AgentEvent) => void) => {
      listeners.push(cb);
      return () => {
        const index = listeners.indexOf(cb);
        if (index >= 0) listeners.splice(index, 1);
      };
    }),
    selectDirectory: vi.fn(),
  };
  (window as unknown as { agentDock: AgentDockBridge }).agentDock = bridge;
  return {
    agentDock: bridge,
    emit: (sessionId, event) => {
      for (const listener of [...listeners]) listener(sessionId, event);
    },
  };
}

const GOOD_PROFILE_RESPONSE = JSON.stringify({
  currentRole: 'Senior Frontend Engineer',
  experienceYears: 8,
  location: 'Amsterdam, Netherlands',
  professionalLanguage: 'English',
  strongestSkills: ['Angular', 'TypeScript'],
  additionalSkills: ['RxJS'],
  targetRoles: ['Senior Frontend Engineer'],
  consideredRoles: ['Frontend Architect'],
  primaryCountry: 'Netherlands',
});

function installCvBridge(overrides: Partial<CvBridge> = {}): CvBridge {
  const bridge: CvBridge = {
    selectAndRead: vi
      .fn()
      .mockResolvedValue({ status: 'ok', fileName: 'jamie-rivera-cv.pdf', text: 'Angular. TypeScript.' }),
    getWorkspaceDir: vi.fn().mockResolvedValue('/userData/ai-workspace'),
    ...overrides,
  };
  (window as unknown as { cv: CvBridge }).cv = bridge;
  return bridge;
}

/** A first-launch user: the flag has never been set and the CV library is empty. */
const UNSEEN_SETTINGS = { ...DEFAULT_SETTINGS, welcomeSeen: false };

beforeEach(() => {
  installAgentDockBridge();
  installCvBridge();
  installVacancyRadarBridge();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function welcomeDialog() {
  return screen.queryByRole('dialog', { name: /welcome to open vacancy radar/i });
}

describe('first-launch welcome modal', () => {
  it('opens for a new user: welcomeSeen false and an empty CV library', async () => {
    const workspace = installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue(UNSEEN_SETTINGS),
      listCvDocuments: vi.fn().mockResolvedValue([]),
    });

    render(<App />);

    const dialog = await screen.findByRole('dialog', { name: /welcome to open vacancy radar/i });
    // Two checklist items are there, each with its own live status and its own skip. The company
    // list is no longer one of them: it downloads on its own (#637).
    const checklist = within(dialog).getByRole('list', { name: 'Setup checklist' });
    expect(within(checklist).getByText('Add a CV')).toBeInTheDocument();
    expect(within(checklist).getByText('Connect your AI tool')).toBeInTheDocument();
    expect(within(checklist).queryByText('Download the company list')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Two quick steps. Skip any and come back later.')).toBeInTheDocument();
    await waitFor(() => expect(within(checklist).getAllByText('To do')).toHaveLength(2));
    expect(within(checklist).getByRole('button', { name: 'Skip adding a CV' })).toBeInTheDocument();
    expect(within(checklist).getByRole('button', { name: 'Skip connecting your AI tool' })).toBeInTheDocument();
    expect(within(checklist).queryByRole('button', { name: 'Skip downloading the company list' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload cv/i })).toBeInTheDocument();
    // Still open: nothing is marked seen until the user actually leaves the modal.
    expect(workspace.updateSettings).not.toHaveBeenCalledWith({ welcomeSeen: true });
  });

  it('never opens for an upgrading user who already has a CV, and marks the flag seen silently', async () => {
    const workspace = installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue(UNSEEN_SETTINGS),
      getCounts: vi.fn().mockResolvedValue({ ...DEFAULT_COUNTS, cvDocuments: 1 }),
      listCvDocuments: vi.fn().mockResolvedValue([makeCv()]),
    });

    render(<App />);

    await waitFor(() => expect(workspace.updateSettings).toHaveBeenCalledWith({ welcomeSeen: true }));
    expect(welcomeDialog()).not.toBeInTheDocument();
  });

  it('never opens once welcomeSeen is true, empty library or not', async () => {
    const workspace = installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, welcomeSeen: true }),
      listCvDocuments: vi.fn().mockResolvedValue([]),
    });

    render(<App />);

    await waitFor(() => expect(workspace.getSettings).toHaveBeenCalled());
    expect(welcomeDialog()).not.toBeInTheDocument();
    // An empty library is not enough on its own: the flag alone settles it, and nothing rewrites
    // a flag that is already true. (The Search page does its own `listCvDocuments` call, so the
    // absence of the modal, not the absence of that call, is what proves the gate short-circuited.)
    expect(workspace.updateSettings).not.toHaveBeenCalledWith({ welcomeSeen: true });
  });

  it('"Skip for now" closes it and persists the flag without creating a CV', async () => {
    const workspace = installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue(UNSEEN_SETTINGS),
      listCvDocuments: vi.fn().mockResolvedValue([]),
      createCvDocument: vi.fn(),
    });

    render(<App />);
    await screen.findByRole('dialog', { name: /welcome to open vacancy radar/i });

    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));

    await waitFor(() => expect(welcomeDialog()).not.toBeInTheDocument());
    expect(workspace.updateSettings).toHaveBeenCalledWith({ welcomeSeen: true });
    expect(workspace.createCvDocument).not.toHaveBeenCalled();
  });

  it('the close button dismisses it too, so the modal never blocks the app', async () => {
    const workspace = installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue(UNSEEN_SETTINGS),
      listCvDocuments: vi.fn().mockResolvedValue([]),
    });

    render(<App />);
    const dialog = await screen.findByRole('dialog', { name: /welcome to open vacancy radar/i });

    // The header's close icon and the backdrop share the "Close" label, exactly as the Fill-from-CV drawer
    // does; both are real dismissals, so asserting on the first is enough to prove the exit exists.
    fireEvent.click(within(dialog).getAllByLabelText('Close')[0]!);

    await waitFor(() => expect(welcomeDialog()).not.toBeInTheDocument());
    expect(workspace.updateSettings).toHaveBeenCalledWith({ welcomeSeen: true });
  });

  it('Escape closes it, marks it seen, and puts focus inside it while it is open (#454)', async () => {
    const workspace = installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue(UNSEEN_SETTINGS),
      listCvDocuments: vi.fn().mockResolvedValue([]),
    });

    render(<App />);
    const dialog = await screen.findByRole('dialog', { name: /welcome to open vacancy radar/i });
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(welcomeDialog()).not.toBeInTheDocument());
    expect(workspace.updateSettings).toHaveBeenCalledWith({ welcomeSeen: true });
  });

  it('a successful upload saves the CV and hands off into an auto-started Fill from CV review, without a Read CV click', async () => {
    const savedCv = makeCv({ id: 'cv-new', isDefault: true, text: 'Angular. TypeScript. 8 years.' });
    const createCvDocument = vi.fn().mockResolvedValue(savedCv);
    installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue(UNSEEN_SETTINGS),
      // First call: the App-level welcome gate (empty library). Every call after: the drawer's own
      // fetch, which must see the CV that was just uploaded to auto-select and auto-start on it.
      listCvDocuments: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([savedCv]),
      createCvDocument,
    });
    const cv = installCvBridge();
    const { agentDock, emit } = installDrivableAgentDockBridge();

    render(<App />);
    await screen.findByRole('dialog', { name: /welcome to open vacancy radar/i });

    fireEvent.click(screen.getByRole('button', { name: /upload cv/i }));
    await waitFor(() => expect(cv.selectAndRead).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: /save to cv library/i }));
    await waitFor(() => expect(createCvDocument).toHaveBeenCalledTimes(1));

    // The hand-off: the welcome dialog is gone and a differently-labelled one (Fill search profile
    // from CV) has replaced it, and a real AI session was already started -- proof `autoStart` fired
    // `handleRead` itself, with no "Read CV" click anywhere in this test. The button itself still
    // renders (disabled, mid-spin): autoStart shortens the path to it, it does not hide it.
    await waitFor(() => expect(welcomeDialog()).not.toBeInTheDocument());
    const drawer = await screen.findByRole('dialog', { name: 'Fill search profile from CV' });
    expect(agentDock.createSession).toHaveBeenCalledTimes(1);
    expect(within(drawer).getByRole('button', { name: 'Read CV' })).toBeDisabled();

    emit('sess-welcome-cv', { type: 'assistant.message', text: GOOD_PROFILE_RESPONSE });
    emit('sess-welcome-cv', { type: 'session.completed' });

    await waitFor(() => expect(screen.getByLabelText('Current role')).toHaveValue('Senior Frontend Engineer'));
  });

  it('saving the auto-started profile review returns to the checklist with the CV marked done, and Skip for now then persists the flag', async () => {
    const savedCv = makeCv({ id: 'cv-new', isDefault: true, text: 'Angular. TypeScript. 8 years.' });
    const workspace = installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue(UNSEEN_SETTINGS),
      listCvDocuments: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([savedCv]),
      createCvDocument: vi.fn().mockResolvedValue(savedCv),
    });
    const vacancyRadar = installVacancyRadarBridge();
    installCvBridge();
    const { emit } = installDrivableAgentDockBridge();

    render(<App />);
    await screen.findByRole('dialog', { name: /welcome to open vacancy radar/i });
    fireEvent.click(screen.getByRole('button', { name: /upload cv/i }));
    fireEvent.click(await screen.findByRole('button', { name: /save to cv library/i }));

    await screen.findByRole('dialog', { name: 'Fill search profile from CV' });
    emit('sess-welcome-cv', { type: 'assistant.message', text: GOOD_PROFILE_RESPONSE });
    emit('sess-welcome-cv', { type: 'session.completed' });
    await waitFor(() => expect(screen.getByLabelText('Current role')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Save to profile' }));

    await waitFor(() => expect(vacancyRadar.saveSearchProfile).toHaveBeenCalledTimes(1));
    // Back on the checklist: the CV is done and the other two items are still on offer.
    const checklist = await screen.findByRole('list', { name: 'Setup checklist' });
    expect(within(checklist).getByText('CV saved to your library.')).toBeInTheDocument();
    expect(within(checklist).queryByRole('button', { name: /upload cv/i })).not.toBeInTheDocument();
    expect(workspace.updateSettings).not.toHaveBeenCalledWith({ welcomeSeen: true });

    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(workspace.updateSettings).toHaveBeenCalledWith({ welcomeSeen: true });
  });

  it('cancelling out of the auto-started profile review returns to the checklist, since the CV is already saved', async () => {
    const savedCv = makeCv({ id: 'cv-new', isDefault: true, text: 'Angular. TypeScript. 8 years.' });
    const workspace = installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue(UNSEEN_SETTINGS),
      listCvDocuments: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([savedCv]),
      createCvDocument: vi.fn().mockResolvedValue(savedCv),
    });
    const vacancyRadar = installVacancyRadarBridge();
    installCvBridge();
    const { emit } = installDrivableAgentDockBridge();

    render(<App />);
    await screen.findByRole('dialog', { name: /welcome to open vacancy radar/i });
    fireEvent.click(screen.getByRole('button', { name: /upload cv/i }));
    fireEvent.click(await screen.findByRole('button', { name: /save to cv library/i }));

    const drawer = await screen.findByRole('dialog', { name: 'Fill search profile from CV' });
    // Cancel is disabled while the auto-started run is still in flight (Stop is the way to
    // interrupt that, so a session is never abandoned mid-run) -- stop it first, matching what a
    // user who does not want to wait actually has to do. `cancel()` only requests cancellation; the
    // run only actually leaves "busy" once the session-event stream confirms it, same as a real
    // daemon session, so the test has to supply that event too.
    fireEvent.click(within(drawer).getByRole('button', { name: 'Stop' }));
    emit('sess-welcome-cv', { type: 'session.cancelled' });
    await waitFor(() => expect(within(drawer).getByRole('button', { name: 'Cancel' })).toBeEnabled());
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));

    const checklist = await screen.findByRole('list', { name: 'Setup checklist' });
    expect(within(checklist).getByText('CV saved to your library.')).toBeInTheDocument();
    // Never reached review, so nothing was ever sent to the profile -- only the CV upload happened.
    expect(vacancyRadar.saveSearchProfile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(workspace.updateSettings).toHaveBeenCalledWith({ welcomeSeen: true });
  });
});

function claudeStatus(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    id: 'claude',
    name: 'Claude Code',
    installed: true,
    authenticated: 'authenticated',
    capabilities: { resume: true },
    version: '2.4.1',
    ...overrides,
  };
}

function rosterResult(totalEntries = 1234): AtsRosterImportResult {
  return {
    file: 'ats-roster-v1.json',
    importedAt: '2026-09-11T00:00:00.000Z',
    totalEntries,
    providers: [
      {
        provider: 'greenhouse',
        status: 'success',
        rawRowCount: totalEntries,
        importedCount: totalEntries,
        invalidRowCount: 0,
        duplicateRowCount: 0,
        error: null,
      },
    ],
  };
}

async function openWelcome(workspaceOverrides: Parameters<typeof installWorkspaceBridge>[0] = {}) {
  const workspace = installWorkspaceBridge({
    getSettings: vi.fn().mockResolvedValue(UNSEEN_SETTINGS),
    listCvDocuments: vi.fn().mockResolvedValue([]),
    ...workspaceOverrides,
  });
  render(<App />);
  const dialog = await screen.findByRole('dialog', { name: /welcome to open vacancy radar/i });
  return { workspace, dialog };
}

describe('first-launch checklist: AI runtime item', () => {
  it('shows the live status of the default provider', async () => {
    const agentDock = installDrivableAgentDockBridge().agentDock;
    agentDock.listProviders = vi.fn().mockResolvedValue([claudeStatus()]);

    const { dialog } = await openWelcome();

    // A ready tool needs nothing from the user, so the item goes away and the intro counts two steps.
    await waitFor(() => expect(within(dialog).queryByText('Connect your AI tool')).not.toBeInTheDocument());
    expect(within(dialog).getByText('One quick step. Skip any and come back later.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
  });

  it('says what is missing and offers Check again, which re-reads the status', async () => {
    // Stateful rather than "first call, then the rest": the shell's own sidebar also reads the list.
    let current = claudeStatus({ installed: false, authenticated: 'unknown' });
    const agentDock = installDrivableAgentDockBridge().agentDock;
    agentDock.listProviders = vi.fn(async () => [current]);

    const { dialog } = await openWelcome();

    await waitFor(() => expect(within(dialog).getByText('Claude Code is not installed yet.')).toBeInTheDocument());
    const callsBefore = (agentDock.listProviders as ReturnType<typeof vi.fn>).mock.calls.length;
    current = claudeStatus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check again' }));

    await waitFor(() => expect(within(dialog).queryByText('Connect your AI tool')).not.toBeInTheDocument());
    expect((agentDock.listProviders as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('reports a helper that has not responded instead of a false not-installed', async () => {
    const agentDock = installDrivableAgentDockBridge().agentDock;
    agentDock.listProviders = vi.fn().mockRejectedValue(new Error('daemon is not ready yet'));

    const { dialog } = await openWelcome();

    await waitFor(() => expect(within(dialog).getByText(/Still starting\. Check again in a moment/)).toBeInTheDocument());
  });

  it('re-checks on its own once the AI helper reports ready', async () => {
    const { agentDock } = installDrivableAgentDockBridge();
    let notifyStatus: ((status: { state: 'ready' }) => void) | undefined;
    agentDock.onDaemonStatus = vi.fn((cb) => {
      notifyStatus = cb as typeof notifyStatus;
      return () => {};
    });
    let helperUp = false;
    agentDock.listProviders = vi.fn(async () => {
      if (!helperUp) throw new Error('daemon is not ready yet');
      return [claudeStatus()];
    });

    const { dialog } = await openWelcome();
    await waitFor(() => expect(within(dialog).getByText(/Still starting/)).toBeInTheDocument());

    helperUp = true;
    notifyStatus?.({ state: 'ready' });

    await waitFor(() => expect(within(dialog).queryByText('Connect your AI tool')).not.toBeInTheDocument());
  });

  it('skipping marks the item skipped without touching the provider list again', async () => {
    const agentDock = installDrivableAgentDockBridge().agentDock;
    agentDock.listProviders = vi.fn().mockResolvedValue([claudeStatus({ installed: false })]);

    const { dialog } = await openWelcome();
    await waitFor(() => expect(within(dialog).getByText('Claude Code is not installed yet.')).toBeInTheDocument());
    const callsBefore = (agentDock.listProviders as ReturnType<typeof vi.fn>).mock.calls.length;

    fireEvent.click(within(dialog).getByRole('button', { name: 'Skip connecting your AI tool' }));

    expect(within(dialog).getByText('Skipped')).toBeInTheDocument();
    expect(agentDock.listProviders).toHaveBeenCalledTimes(callsBefore);
  });

  it('Set up closes the modal, persists the flag and opens that page', async () => {
    const agentDock = installDrivableAgentDockBridge().agentDock;
    agentDock.listProviders = vi.fn().mockResolvedValue([claudeStatus({ installed: false })]);

    const { workspace, dialog } = await openWelcome();
    await waitFor(() => expect(within(dialog).getByText('Claude Code is not installed yet.')).toBeInTheDocument());

    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up' }));

    await waitFor(() => expect(welcomeDialog()).not.toBeInTheDocument());
    expect(workspace.updateSettings).toHaveBeenCalledWith({ welcomeSeen: true });
    expect(await screen.findByRole('heading', { level: 1, name: 'AI runtime' })).toBeInTheDocument();
  });
});

describe('first-launch checklist: company list is automatic (#637)', () => {
  it('does not render a company list item or button in the welcome modal', async () => {
    installVacancyRadarBridge({ getAtsRosterStatus: vi.fn().mockResolvedValue(null), refreshAtsRoster: vi.fn().mockResolvedValue(rosterResult()) });
    const { dialog } = await openWelcome();

    expect(within(dialog).queryByText('Download the company list')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /download company list/i })).not.toBeInTheDocument();
  });

  it('starts the download once on first launch without a click', async () => {
    const refreshAtsRoster = vi.fn().mockResolvedValue(rosterResult(1234));
    installVacancyRadarBridge({ getAtsRosterStatus: vi.fn().mockResolvedValue(null), refreshAtsRoster });
    await openWelcome();

    await waitFor(() => expect(refreshAtsRoster).toHaveBeenCalledTimes(1));
    // Settle any re-render: it must not start a second time.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refreshAtsRoster).toHaveBeenCalledTimes(1);
  });

  it('does not download again when a list was already imported', async () => {
    const refreshAtsRoster = vi.fn();
    const getAtsRosterStatus = vi
      .fn()
      .mockResolvedValue({ importedAt: '2026-09-01T00:00:00.000Z', totalEntries: 987, sourceCounts: { greenhouse: 987 } });
    installVacancyRadarBridge({ getAtsRosterStatus, refreshAtsRoster });
    await openWelcome();

    await waitFor(() => expect(getAtsRosterStatus).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refreshAtsRoster).not.toHaveBeenCalled();
  });

  it('does not download when the switch is off', async () => {
    const refreshAtsRoster = vi.fn().mockResolvedValue(rosterResult());
    const getAtsRosterStatus = vi.fn().mockResolvedValue(null);
    installVacancyRadarBridge({ getAtsRosterStatus, refreshAtsRoster });
    await openWelcome({
      getSettings: vi.fn().mockResolvedValue({ ...UNSEEN_SETTINGS, autoRosterDownloadEnabled: false }),
    });

    await waitFor(() => expect(getAtsRosterStatus).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refreshAtsRoster).not.toHaveBeenCalled();
  });

  it('does not download when the main process reports the switch off (as it does under e2e)', async () => {
    const refreshAtsRoster = vi.fn().mockResolvedValue(rosterResult());
    const getAtsRosterStatus = vi.fn().mockResolvedValue(null);
    installVacancyRadarBridge({ getAtsRosterStatus, refreshAtsRoster });
    await openWelcome({
      getSettings: vi.fn().mockResolvedValue({ ...UNSEEN_SETTINGS, autoRosterDownloadEnabled: false }),
    });

    await waitFor(() => expect(getAtsRosterStatus).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refreshAtsRoster).not.toHaveBeenCalled();
  });

  it('shows one line on Search after a failure, and Try again runs the download', async () => {
    const refreshAtsRoster = vi
      .fn()
      .mockRejectedValueOnce(new Error('the roster source could not be reached'))
      .mockResolvedValue(rosterResult(50));
    installVacancyRadarBridge({ getAtsRosterStatus: vi.fn().mockResolvedValue(null), refreshAtsRoster });
    installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, welcomeSeen: true }) });
    render(<App />);

    expect(
      await screen.findByText('Could not download the company list. Searches still use the other sources.'),
    ).toBeInTheDocument();
    // One attempt only: a failure is not retried on its own.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refreshAtsRoster).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(refreshAtsRoster).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByText('Could not download the company list. Searches still use the other sources.'),
      ).not.toBeInTheDocument(),
    );
  });

  it('skipping marks the CV skipped, and Done replaces Skip for now once every item is addressed', async () => {
    installDrivableAgentDockBridge().agentDock.listProviders = vi.fn().mockResolvedValue([claudeStatus()]);
    const { dialog } = await openWelcome();
    await waitFor(() => expect(within(dialog).queryByText('Connect your AI tool')).not.toBeInTheDocument());

    fireEvent.click(within(dialog).getByRole('button', { name: 'Skip adding a CV' }));

    expect(within(dialog).getAllByText('Skipped')).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });
});

describe('first-launch checklist: search profile could not be loaded', () => {
  /** `profileLoads.ok` flips the profile read from failing to working; the shell's Search page also reads it. */
  async function uploadWithBrokenProfile(profileLoads: { ok: boolean }) {
    const getSearchProfile = vi.fn(async () => {
      if (!profileLoads.ok) throw new Error('profile file unreadable');
      return { ...DEFAULT_CANDIDATE_PROFILE };
    });
    const savedCv = makeCv({ id: 'cv-new', isDefault: true });
    installVacancyRadarBridge({ getSearchProfile });
    installCvBridge();
    installDrivableAgentDockBridge();
    const { workspace, dialog } = await openWelcome({
      listCvDocuments: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([savedCv]),
      createCvDocument: vi.fn().mockResolvedValue(savedCv),
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /upload cv/i }));
    fireEvent.click(await screen.findByRole('button', { name: /save to cv library/i }));
    return { workspace, dialog, getSearchProfile };
  }

  it('keeps the modal open and says the CV is saved and the profile can be filled in Settings', async () => {
    const { workspace } = await uploadWithBrokenProfile({ ok: false });

    const alert = await screen.findByText(
      'CV saved. Could not fill your profile automatically. You can do it in Settings.',
    );
    expect(alert).toBeInTheDocument();
    // Still open, and not yet marked seen: the message has to be readable before anything closes.
    expect(welcomeDialog()).toBeInTheDocument();
    expect(workspace.updateSettings).not.toHaveBeenCalledWith({ welcomeSeen: true });
    expect(screen.getByText('CV saved to your library.')).toBeInTheDocument();
  });

  it('Try again reloads the profile and goes on to the review', async () => {
    const profileLoads = { ok: false };
    await uploadWithBrokenProfile(profileLoads);
    await screen.findByText(/Could not fill your profile automatically/);

    profileLoads.ok = true;
    fireEvent.click(within(welcomeDialog()!).getByRole('button', { name: 'Try again' }));

    await screen.findByRole('dialog', { name: 'Fill search profile from CV' });
  });

  it('Open Settings closes the modal and lands on the Search tab with the profile focused', async () => {
    const profileLoads = { ok: false };
    const { workspace } = await uploadWithBrokenProfile(profileLoads);
    await screen.findByText(/Could not fill your profile automatically/);

    profileLoads.ok = true;
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));

    await waitFor(() => expect(welcomeDialog()).not.toBeInTheDocument());
    expect(workspace.updateSettings).toHaveBeenCalledWith({ welcomeSeen: true });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true'));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
  });

  it('Dismiss clears the message', async () => {
    await uploadWithBrokenProfile({ ok: false });
    await screen.findByText(/Could not fill your profile automatically/);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByText(/Could not fill your profile automatically/)).not.toBeInTheDocument();
    expect(welcomeDialog()).toBeInTheDocument();
  });
});

describe('Finish setup (reopening the checklist, #539)', () => {
  const SEEN_SETTINGS = { ...DEFAULT_SETTINGS, welcomeSeen: true };

  async function openFinishSetup() {
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const opener = await screen.findByRole('button', { name: 'Finish setup' });
    opener.focus();
    fireEvent.click(opener);
    return { opener, dialog: await screen.findByRole('dialog', { name: 'Finish setup' }) };
  }

  it('after Welcome was skipped, reopens the checklist with honest to-do states and no persisted change', async () => {
    const workspace = installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue(SEEN_SETTINGS),
      listCvDocuments: vi.fn().mockResolvedValue([]),
    });
    render(<App />);
    const { dialog } = await openFinishSetup();

    const checklist = within(dialog).getByRole('list', { name: 'Setup checklist' });
    await waitFor(() => expect(within(checklist).getAllByText('To do').length).toBeGreaterThanOrEqual(2));
    expect(within(checklist).getByText('Add a CV')).toBeInTheDocument();
    expect(within(checklist).queryByText('Download the company list')).not.toBeInTheDocument();
    expect(workspace.updateSettings).not.toHaveBeenCalledWith({ welcomeSeen: true });
  });

  it('shows the CV as done for an upgrading user and no company list item', async () => {
    installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue(SEEN_SETTINGS),
      getCounts: vi.fn().mockResolvedValue({ ...DEFAULT_COUNTS, cvDocuments: 1 }),
      listCvDocuments: vi.fn().mockResolvedValue([makeCv()]),
    });
    render(<App />);
    const { dialog } = await openFinishSetup();

    await waitFor(() => expect(within(dialog).getByText('CV saved to your library.')).toBeInTheDocument());
    expect(within(dialog).queryByRole('button', { name: /upload cv/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Download company list' })).not.toBeInTheDocument();
  });

  it('says so when a CV status cannot be read, and still offers the action', async () => {
    installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue(SEEN_SETTINGS),
      getCounts: vi.fn().mockRejectedValue(new Error('db down')),
    });
    installVacancyRadarBridge({ getAtsRosterStatus: vi.fn().mockRejectedValue(new Error('nope')) });
    render(<App />);
    const { dialog } = await openFinishSetup();

    await waitFor(() =>
      expect(within(dialog).getByText('Could not check. You can still add one.')).toBeInTheDocument(),
    );
    expect(within(dialog).getAllByText('Unknown')).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: /upload cv/i })).toBeInTheDocument();
  });

  it('Escape closes it, returns focus to the opener, and does not reset anything', async () => {
    const workspace = installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue(SEEN_SETTINGS) });
    render(<App />);
    const { opener, dialog } = await openFinishSetup();
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
    expect(workspace.updateSettings).not.toHaveBeenCalledWith(expect.objectContaining({ welcomeSeen: false }));
  });

  it('"Set up" closes the reopened checklist and opens the AI runtime page, without touching welcomeSeen', async () => {
    const workspace = installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue(SEEN_SETTINGS) });
    render(<App />);
    const { dialog } = await openFinishSetup();

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Set up' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Finish setup' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Finish setup' })).not.toBeInTheDocument();
    expect(workspace.updateSettings).not.toHaveBeenCalledWith({ welcomeSeen: true });
    expect(workspace.updateSettings).not.toHaveBeenCalledWith(expect.objectContaining({ welcomeSeen: false }));
  });

  it('"Open Settings" from the reopened checklist lands on the Search tab with the profile focused', async () => {
    const profileLoads = { ok: false };
    installVacancyRadarBridge({
      getSearchProfile: vi.fn(async () => {
        if (!profileLoads.ok) throw new Error('unreadable');
        return { ...DEFAULT_CANDIDATE_PROFILE };
      }),
    });
    installCvBridge();
    installDrivableAgentDockBridge();
    const savedCv = makeCv({ id: 'cv-new', isDefault: true });
    installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue(SEEN_SETTINGS),
      listCvDocuments: vi.fn().mockResolvedValue([savedCv]),
      createCvDocument: vi.fn().mockResolvedValue(savedCv),
    });
    render(<App />);
    const { dialog } = await openFinishSetup();
    // The page was already on Settings > General when the modal closes: it must still switch tabs.
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(await within(dialog).findByRole('button', { name: /upload cv/i }));
    fireEvent.click(await screen.findByRole('button', { name: /save to cv library/i }));
    await screen.findByText(/Could not fill your profile automatically/);
    profileLoads.ok = true;
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true'));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
  });

  it('never auto-opens for a dismissed user, and the entry stays once everything is done', async () => {
    installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue(SEEN_SETTINGS),
      getCounts: vi.fn().mockResolvedValue({ ...DEFAULT_COUNTS, cvDocuments: 1 }),
    });
    render(<App />);
    await screen.findByRole('button', { name: 'Settings' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const { dialog } = await openFinishSetup();
    expect(within(dialog).getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0);
  });
});
