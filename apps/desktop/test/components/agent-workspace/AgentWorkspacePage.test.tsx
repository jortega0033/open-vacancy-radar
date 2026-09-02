import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentWorkspacePage } from '../../../src/components/agent-workspace/index.js';
import type { AgentDockBridge } from '../../../src/window.js';
import { DEFAULT_SETTINGS, installSystemBridge, installWorkspaceBridge } from '../../workspace-bridge.js';
import {
  SESSION_A,
  SESSION_B,
  TEST_CAPACITY,
  historyEntry,
  installAgentWorkspaceBridge,
  installWorkspaceGrantBridge,
  sessionSummary,
} from '../../agent-workspace-bridges.js';

/**
 * The AI Workspace page's own behavior (ADI-07): concurrency the user can see, the two 409s drawn
 * as different situations, a restart-recovered session that is not an error, and the three
 * SQLite-backed preferences.
 */

function installAgentDock(): AgentDockBridge {
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
  return bridge;
}

/**
 * Watches the store this page is deliberately NOT using.
 *
 * ADI-07 puts the three renderer-local preferences in `app_settings` alongside every other
 * preference, rather than in `localStorage` where a browser app would put "which row was
 * selected". Spying on the setter proves the negative directly: jsdom's `Storage.length` is not
 * reliably readable here, and "nothing was stored" is a weaker claim than "nothing tried to store".
 */
let setItem: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  installAgentDock();
  installSystemBridge();
  installWorkspaceBridge();
  setItem = vi.spyOn(Storage.prototype, 'setItem');
});

afterEach(() => {
  // Only the Storage spy is restored, and `clearAllMocks` clears call history without stripping
  // implementations: Testing Library's global `afterEach(cleanup)` unmounts *after* this hook, and
  // the hook's unmount path calls `detachActivity`, which must still resolve.
  setItem.mockRestore();
  vi.clearAllMocks();
});

async function startOne(prompt = 'do the thing'): Promise<void> {
  fireEvent.change(screen.getByRole('textbox', { name: /what should the agent do/i }), {
    target: { value: prompt },
  });
  fireEvent.click(screen.getByRole('button', { name: /choose folder and start/i }));
}

describe('AgentWorkspacePage: concurrency is visible', () => {
  it('attaches every running session, whether or not one is selected', async () => {
    const { bridge } = installAgentWorkspaceBridge({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [sessionSummary(SESSION_A), sessionSummary(SESSION_B)],
        capacity: TEST_CAPACITY,
      }),
    });
    installWorkspaceGrantBridge();

    render(<AgentWorkspacePage defaultProvider="claude" />);

    // Both, with no selection at all: what is streamed is a fact about the sessions, not the UI.
    await waitFor(() => expect(bridge.attachActivity).toHaveBeenCalledTimes(2));
    const attached = (bridge.attachActivity as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    expect(attached.sort()).toEqual([SESSION_A, SESSION_B].sort());
    await waitFor(() => expect(screen.getAllByTestId('live-indicator').length).toBe(2));
  });

  it('does not attach a session the daemon says is finished', async () => {
    const { bridge } = installAgentWorkspaceBridge({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [sessionSummary(SESSION_A, { status: 'completed', terminalReason: 'provider_completed' })],
        capacity: TEST_CAPACITY,
      }),
    });
    installWorkspaceGrantBridge();

    render(<AgentWorkspacePage defaultProvider="claude" />);
    await waitFor(() => expect(screen.getByText('Completed')).toBeInTheDocument());
    expect(bridge.attachActivity).not.toHaveBeenCalled();
  });

  it('shows an unread badge on a session receiving activity while another is selected', async () => {
    const { push } = installAgentWorkspaceBridge({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [sessionSummary(SESSION_A), sessionSummary(SESSION_B)],
        capacity: TEST_CAPACITY,
      }),
    });
    installWorkspaceGrantBridge();

    render(<AgentWorkspacePage defaultProvider="claude" />);
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBe(2));

    // Select the first session, then deliver activity to the second.
    fireEvent.click(screen.getAllByRole('button', { name: /^Session claude/ })[0] as HTMLElement);
    push({
      sessionId: SESSION_B,
      entry: { seq: 0, at: 't', origin: 'live', kind: 'assistant.message', text: 'second session speaking' },
    });

    await waitFor(() => expect(screen.getByLabelText('1 unread updates')).toBeInTheDocument());
    // And the unselected session's timeline really did accumulate: selecting it shows the prose.
    fireEvent.click(screen.getAllByRole('button', { name: /^Session claude/ })[1] as HTMLElement);
    await waitFor(() => expect(screen.getByText('second session speaking')).toBeInTheDocument());
  });
});

describe('AgentWorkspacePage: the two 409s are different situations', () => {
  it('offers no folder action for active_session_limit, and shows the capacity that must change', async () => {
    installAgentWorkspaceBridge();
    installWorkspaceGrantBridge({
      startSession: vi.fn().mockResolvedValue({ ok: false, reason: 'active_session_limit' }),
    });

    render(<AgentWorkspacePage defaultProvider="claude" />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Start a session' })).toBeInTheDocument());
    await startOne();

    const card = await screen.findByTestId('pending-refused');
    expect(card).toHaveAttribute('data-reason', 'active_session_limit');
    expect(within(card).getByText(/concurrent session limit/i)).toBeInTheDocument();
    // The numbers that have to change are shown...
    expect(within(card).getByTestId('refusal-capacity')).toBeInTheDocument();
    // ...and the remedy that cannot work is not offered.
    expect(within(card).queryByTestId('refusal-retry-folder')).not.toBeInTheDocument();
    expect(card.textContent?.toLowerCase()).not.toContain('different folder');
  });

  it('offers a different folder for workspace_lease_conflict, and shows no capacity numbers', async () => {
    installAgentWorkspaceBridge();
    const grant = installWorkspaceGrantBridge({
      startSession: vi.fn().mockResolvedValue({ ok: false, reason: 'workspace_lease_conflict' }),
    });

    render(<AgentWorkspacePage defaultProvider="claude" />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Start a session' })).toBeInTheDocument());
    await startOne();

    const card = await screen.findByTestId('pending-refused');
    expect(card).toHaveAttribute('data-reason', 'workspace_lease_conflict');
    expect(within(card).getByText(/already using this folder/i)).toBeInTheDocument();
    // Capacity is not the constraint being hit, so it is not shown.
    expect(within(card).queryByTestId('refusal-capacity')).not.toBeInTheDocument();

    // The remedy is a fresh grant, which re-runs the whole native picker flow with the same prompt.
    const retry = within(card).getByTestId('refusal-retry-folder');
    expect(retry).toHaveTextContent('Choose a different folder');
    fireEvent.click(retry);
    await waitFor(() => expect(grant.requestGrant).toHaveBeenCalledTimes(2));
    expect((grant.startSession as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toMatchObject({
      prompt: 'do the thing',
    });
  });

  it('has distinct copy for the two, so no user is told to do something that cannot work', async () => {
    const seen: string[] = [];
    for (const reason of ['active_session_limit', 'workspace_lease_conflict']) {
      installAgentWorkspaceBridge();
      installWorkspaceGrantBridge({ startSession: vi.fn().mockResolvedValue({ ok: false, reason }) });
      const { unmount } = render(<AgentWorkspacePage defaultProvider="claude" />);
      await waitFor(() => expect(screen.getByRole('region', { name: 'Start a session' })).toBeInTheDocument());
      await startOne();
      const card = await screen.findByTestId('pending-refused');
      seen.push(card.textContent ?? '');
      unmount();
    }
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('surfaces a refusal from the consume step too, not only from the start', async () => {
    installAgentWorkspaceBridge();
    installWorkspaceGrantBridge({
      consumeGrant: vi.fn().mockResolvedValue({ ok: false, reason: 'identity_drift' }),
    });

    render(<AgentWorkspacePage defaultProvider="claude" />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Start a session' })).toBeInTheDocument());
    await startOne();

    const card = await screen.findByTestId('pending-refused');
    expect(card).toHaveAttribute('data-reason', 'identity_drift');
    expect(within(card).getByText(/changed after you approved it/i)).toBeInTheDocument();
  });

  it('treats a cancelled picker as a dismissal, not a refusal', async () => {
    installAgentWorkspaceBridge();
    installWorkspaceGrantBridge({ requestGrant: vi.fn().mockResolvedValue(null) });

    render(<AgentWorkspacePage defaultProvider="claude" />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Start a session' })).toBeInTheDocument());
    await startOne();

    await waitFor(() => expect(screen.queryByTestId('pending-granting')).not.toBeInTheDocument());
    expect(screen.queryByTestId('pending-refused')).not.toBeInTheDocument();
  });

  it('runs two starts at once, and one being refused does not disturb the other', async () => {
    installAgentWorkspaceBridge();
    let call = 0;
    installWorkspaceGrantBridge({
      startSession: vi.fn(async () => {
        call += 1;
        return call === 1
          ? { ok: false as const, reason: 'workspace_lease_conflict' }
          : { ok: true as const, session: { sessionId: SESSION_B, provider: 'claude', status: 'starting' } };
      }),
    });

    render(<AgentWorkspacePage defaultProvider="claude" />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Start a session' })).toBeInTheDocument());
    await startOne('first');
    await screen.findByTestId('pending-refused');
    // The form is never disabled by a start in flight, which is what makes two possible.
    await startOne('second');

    await waitFor(() => expect(screen.getByTestId('pending-started')).toBeInTheDocument());
    expect(screen.getByTestId('pending-refused')).toBeInTheDocument();
  });
});

describe('AgentWorkspacePage: a restart-recovered session is not an error', () => {
  it('settles a refused attach as "not streaming", never as a failure', async () => {
    // The common case after an app restart: the durable record exists, the v1 SessionManager that
    // held its events is gone with the previous daemon process, so there is nothing to attach to.
    const { bridge } = installAgentWorkspaceBridge({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [sessionSummary(SESSION_A, { status: 'running' })],
        capacity: TEST_CAPACITY,
      }),
      attachActivity: vi.fn().mockResolvedValue({ ok: false, reason: 'daemon_unavailable' }),
      getSessionEvents: vi.fn(async (sessionId: string) => ({
        sessionId,
        events: [historyEntry(0), historyEntry(1, { kind: 'assistant.message', digest: { bytes: 40, sha256: 'a'.repeat(64) } })],
      })),
    });
    installWorkspaceGrantBridge();

    render(<AgentWorkspacePage defaultProvider="claude" />);
    await waitFor(() => expect(bridge.attachActivity).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole('button', { name: /^Session claude/ })[0] as HTMLElement);

    // The pane explains it in words from the closed table, with no alert styling and no error copy.
    await waitFor(() => expect(screen.getByTestId('attach-refusal')).toBeInTheDocument());
    expect(screen.getByTestId('attach-refusal').textContent?.toLowerCase()).not.toMatch(/\berror\b|\bfailed\b/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The live indicator is gone: it is not stuck in "Connecting" forever.
    expect(screen.queryByTestId('live-indicator')).not.toBeInTheDocument();
    // And the honest explanation for a timeline that carries only digests is shown.
    expect(screen.getByText(/ran before the app last restarted/i)).toBeInTheDocument();
  });

  it('settles a closed stream the same way, with no terminal event ever arriving', async () => {
    const { bridge, push } = installAgentWorkspaceBridge({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [sessionSummary(SESSION_A)],
        capacity: TEST_CAPACITY,
      }),
    });
    installWorkspaceGrantBridge();

    render(<AgentWorkspacePage defaultProvider="claude" />);
    await waitFor(() => expect(bridge.attachActivity).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('live-indicator')).toBeInTheDocument());

    push({ sessionId: SESSION_A, closed: { reason: 'stream_unavailable' } });

    await waitFor(() => expect(screen.queryByTestId('live-indicator')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a fixed message this build wrote when the list cannot be read', async () => {
    installAgentWorkspaceBridge({
      listSessions: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:51234')),
    });
    installWorkspaceGrantBridge();

    render(<AgentWorkspacePage defaultProvider="claude" />);
    await waitFor(() => expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument());
    // The daemon's own text is never quoted.
    expect(document.body.textContent).not.toContain('ECONNREFUSED');
    expect(document.body.textContent).not.toContain('127.0.0.1');
  });
});

describe('AgentWorkspacePage: preferences are SQLite-backed', () => {
  it('reads selection, archive flags and unread counts from the settings row, not localStorage', async () => {
    const workspace = installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue({
        ...DEFAULT_SETTINGS,
        agentSelectedSessionId: SESSION_B,
        agentArchivedSessionIds: [SESSION_A],
        agentUnreadCounts: { [SESSION_B]: 3 },
      }),
    });
    installAgentWorkspaceBridge({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [sessionSummary(SESSION_A), sessionSummary(SESSION_B)],
        capacity: TEST_CAPACITY,
      }),
    });
    installWorkspaceGrantBridge();

    render(<AgentWorkspacePage defaultProvider="claude" />);

    await waitFor(() => expect(workspace.getSettings).toHaveBeenCalled());
    // A archived out of the active list, B remembered as the selection (which clears its badge).
    await waitFor(() => expect(screen.getByRole('region', { name: 'Session detail' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(setItem).not.toHaveBeenCalled();
  });

  it('writes archive and selection changes back through updateSettings', async () => {
    const workspace = installWorkspaceBridge();
    installAgentWorkspaceBridge({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [sessionSummary(SESSION_A), sessionSummary(SESSION_B)],
        capacity: TEST_CAPACITY,
      }),
    });
    installWorkspaceGrantBridge();

    render(<AgentWorkspacePage defaultProvider="claude" />);
    await waitFor(() => expect(workspace.getSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByRole('button', { name: /^Archive session/ })[0] as HTMLElement);

    await waitFor(() =>
      expect(workspace.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ agentArchivedSessionIds: [SESSION_A] }),
      ),
    );
    // Only the three agent fields are ever written by this page.
    for (const call of (workspace.updateSettings as ReturnType<typeof vi.fn>).mock.calls) {
      expect(Object.keys(call[0] as object).sort()).toEqual(
        ['agentArchivedSessionIds', 'agentSelectedSessionId', 'agentUnreadCounts'].sort(),
      );
    }
    expect(setItem).not.toHaveBeenCalled();
  });

  it('still renders when the workspace database is unavailable', async () => {
    installWorkspaceBridge({
      getSettings: vi.fn().mockRejectedValue(new Error('workspace.db is locked')),
      updateSettings: vi.fn().mockRejectedValue(new Error('workspace.db is locked')),
    });
    installAgentWorkspaceBridge({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [sessionSummary(SESSION_A)],
        capacity: TEST_CAPACITY,
      }),
    });
    installWorkspaceGrantBridge();

    render(<AgentWorkspacePage defaultProvider="claude" />);
    // Losing a remembered selection is an acceptable cost of an unavailable database; losing the
    // page is not.
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument();
  });

  it('archiving does not stop a running session updating', async () => {
    const { bridge, push } = installAgentWorkspaceBridge({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [sessionSummary(SESSION_A)],
        capacity: TEST_CAPACITY,
      }),
    });
    installWorkspaceGrantBridge();

    render(<AgentWorkspacePage defaultProvider="claude" />);
    await waitFor(() => expect(bridge.attachActivity).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /^Archive session/ }));
    push({ sessionId: SESSION_A, entry: { seq: 0, at: 't', origin: 'live', kind: 'assistant.message', text: 'still going' } });

    // Archiving is a list-visibility choice, not a stop button: nothing detached.
    expect(bridge.detachActivity).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show archived' }));
    fireEvent.click(screen.getByRole('button', { name: /^Session claude/ }));
    await waitFor(() => expect(screen.getByText('still going')).toBeInTheDocument());
  });
});

describe('AgentWorkspacePage: capacity', () => {
  it('reports the daemon aggregate without claiming a per-provider number it did not ask for', async () => {
    installAgentWorkspaceBridge({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [],
        capacity: { global: { active: 4, limit: 4 }, provider: { active: 2, limit: 2 } },
      }),
    });
    installWorkspaceGrantBridge();

    render(<AgentWorkspacePage defaultProvider="claude" />);
    const line = await screen.findByTestId('capacity-line');
    expect(line).toHaveTextContent('4 of 4 concurrent sessions in use');
    expect(line).toHaveTextContent(/stop one before starting another/i);
    expect(line.textContent).not.toMatch(/claude|codex/i);
  });
});
