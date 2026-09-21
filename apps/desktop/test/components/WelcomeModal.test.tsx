import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@agent-dock/shared';
import { App } from '../../src/App.js';
import type { AgentDockBridge, CvBridge, CvDocumentRecord } from '../../src/window.js';
import {
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
    expect(dialog).toHaveTextContent(/upload a cv to get started/i);
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

    // The header's ✕ and the backdrop share the "Close" label, exactly as the Fill-from-CV drawer
    // does; both are real dismissals, so asserting on the first is enough to prove the exit exists.
    fireEvent.click(within(dialog).getAllByLabelText('Close')[0]!);

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

  it('saving the auto-started profile review closes the whole welcome flow and persists the flag', async () => {
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
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(workspace.updateSettings).toHaveBeenCalledWith({ welcomeSeen: true });
  });

  it('cancelling out of the auto-started profile review still finishes the welcome flow, since the CV is already saved', async () => {
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

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(workspace.updateSettings).toHaveBeenCalledWith({ welcomeSeen: true });
    // Never reached review, so nothing was ever sent to the profile -- only the CV upload happened.
    expect(vacancyRadar.saveSearchProfile).not.toHaveBeenCalled();
  });
});
