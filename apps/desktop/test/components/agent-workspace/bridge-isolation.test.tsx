import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentWorkspacePage } from '../../../src/components/agent-workspace/index.js';
import type { AgentDockBridge, CvBridge, SystemBridge } from '../../../src/window.js';
import { installSystemBridge, installWorkspaceBridge } from '../../workspace-bridge.js';
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
 * ADI-07's hard constraint, asserted directly.
 *
 * A v2 session's `cwd` has exactly one legitimate source in this system: the canonical path behind a
 * `workspaceGrant`-issued ref, resolved in the **main** process. Four bridges in this app can return
 * or accept a real filesystem path, and all four are grandfathered pre-v2 surfaces this ticket
 * promises not to touch:
 *
 * | bridge | channel | why it is path-bearing |
 * |---|---|---|
 * | `agentDock.selectDirectory` | `dialog:select-directory` | returns the chosen folder's path |
 * | `cv.getWorkspaceDir` | `cv:get-workspace-dir` | returns the app's scratch directory |
 * | `cv.selectAndRead` | `cv:select-and-read` | reads a file the user picks |
 * | `system.saveFile` | `system:save-file` | writes to a path the OS dialog chooses |
 *
 * If the AI Workspace could reach any of them, the grant system would still be intact and the
 * property it exists to provide would not be: the renderer would have a second, ungated way to
 * learn or name a location, and "the folder is held in main" would stop being true of this screen.
 *
 * So all four are installed as spies that **throw**, not as spies that record. A recording spy
 * proves only that the call did not happen in the exact path the test drove; a throwing spy turns
 * any reachable call anywhere in the render tree into a visible failure, including one inside an
 * effect or an error boundary a passing assertion might otherwise step over.
 */

function installThrowingGrandfatheredBridges(): {
  selectDirectory: ReturnType<typeof vi.fn>;
  getWorkspaceDir: ReturnType<typeof vi.fn>;
  selectAndRead: ReturnType<typeof vi.fn>;
  saveFile: ReturnType<typeof vi.fn>;
} {
  const boom = (name: string) =>
    vi.fn(() => {
      throw new Error(`the AI Workspace must never call ${name}`);
    });

  const selectDirectory = boom('agentDock.selectDirectory');
  const getWorkspaceDir = boom('cv.getWorkspaceDir');
  const selectAndRead = boom('cv.selectAndRead');
  const saveFile = boom('system.saveFile');

  const agentDock: AgentDockBridge = {
    getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' }),
    onDaemonStatus: vi.fn().mockReturnValue(() => {}),
    listProviders: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(() => {
      // v1's own session route. The AI Workspace starts sessions through `workspaceGrant`, whose
      // ref main resolves; reaching v1 here would mean a `cwd` had to come from somewhere.
      throw new Error('the AI Workspace must never call agentDock.createSession');
    }),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    onSessionEvent: vi.fn().mockReturnValue(() => {}),
    selectDirectory: selectDirectory as unknown as AgentDockBridge['selectDirectory'],
  };
  (window as unknown as { agentDock: AgentDockBridge }).agentDock = agentDock;

  const cv = {
    getWorkspaceDir,
    selectAndRead,
  } as unknown as CvBridge;
  (window as unknown as { cv: CvBridge }).cv = cv;

  installSystemBridge({ saveFile: saveFile as unknown as SystemBridge['saveFile'] });

  return { selectDirectory, getWorkspaceDir, selectAndRead, saveFile };
}

let grandfathered: ReturnType<typeof installThrowingGrandfatheredBridges>;

beforeEach(() => {
  grandfathered = installThrowingGrandfatheredBridges();
  installWorkspaceBridge();
});

afterEach(() => {
  // Deliberately NOT `vi.restoreAllMocks()`. Testing Library's global `afterEach(cleanup)` in
  // test/setup.ts unmounts the tree, and vitest runs file-level hooks *before* it, so restoring the
  // mocks here would strip `detachActivity`'s resolved value out from under the hook's own unmount
  // cleanup. Every bridge is installed fresh in `beforeEach`, so there is nothing to restore.
  vi.clearAllMocks();
});

function expectNoGrandfatheredBridgeTouched(): void {
  expect(grandfathered.selectDirectory).not.toHaveBeenCalled();
  expect(grandfathered.getWorkspaceDir).not.toHaveBeenCalled();
  expect(grandfathered.selectAndRead).not.toHaveBeenCalled();
  expect(grandfathered.saveFile).not.toHaveBeenCalled();
}

describe('AI Workspace bridge isolation (ADI-07)', () => {
  it('never touches a path-bearing bridge across a full session lifecycle', async () => {
    const { push } = installAgentWorkspaceBridge({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [sessionSummary(SESSION_A), sessionSummary(SESSION_B, { status: 'completed' })],
        capacity: TEST_CAPACITY,
      }),
      getSessionEvents: vi.fn(async (sessionId: string) => ({
        sessionId,
        events: [historyEntry(0), historyEntry(1, { kind: 'assistant.message', digest: { bytes: 12, sha256: 'a'.repeat(64) } })],
      })),
    });
    installWorkspaceGrantBridge();

    render(<AgentWorkspacePage defaultProvider="claude" />);

    // 1. Listing lands.
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0));

    // 2. Live activity arrives for a session nobody selected.
    push({
      sessionId: SESSION_A,
      entry: { seq: 2, at: 't', origin: 'live', kind: 'assistant.message', text: 'working on it' },
    });

    // 3. The user selects a session and reads its detail pane.
    fireEvent.click(screen.getAllByRole('button', { name: /^Session claude/ })[0] as HTMLElement);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Session detail' })).toBeInTheDocument());

    // 4. The user opens the composer and starts a session through the grant flow.
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    fireEvent.change(screen.getByRole('textbox', { name: /what should the agent do/i }), {
      target: { value: 'summarize the repo' },
    });
    fireEvent.click(screen.getByRole('button', { name: /choose folder and start/i }));
    await waitFor(() => expect(screen.getByTestId('pending-started')).toBeInTheDocument());

    // 5. Stopping goes through v1's existing cancel, which is not path-bearing.
    fireEvent.click(screen.getAllByRole('button', { name: /^Session claude/ })[0] as HTMLElement);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop session' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));

    expectNoGrandfatheredBridgeTouched();
    expect(window.agentDock.cancelSession).toHaveBeenCalledWith(SESSION_A);
  });

  it('starts sessions only through the grant flow, never through v1 createSession', async () => {
    installAgentWorkspaceBridge();
    const grant = installWorkspaceGrantBridge();

    render(<AgentWorkspacePage defaultProvider="claude" />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Start a session' })).toBeInTheDocument());

    fireEvent.change(screen.getByRole('textbox', { name: /what should the agent do/i }), {
      target: { value: 'go' },
    });
    fireEvent.click(screen.getByRole('button', { name: /choose folder and start/i }));

    await waitFor(() => expect(grant.startSession).toHaveBeenCalled());
    // The ten-step contract, in order: a provider name in, an opaque ref out, no path anywhere.
    expect(grant.requestGrant).toHaveBeenCalledWith('claude');
    expect(grant.consumeGrant).toHaveBeenCalledWith('g'.repeat(43));
    expect(grant.startSession).toHaveBeenCalledWith({
      workspaceSessionRef: 'r'.repeat(43),
      prompt: 'go',
    });
    expect(window.agentDock.createSession).not.toHaveBeenCalled();
    expectNoGrandfatheredBridgeTouched();
  });

  it('sends no location to any agentWorkspace channel, and renders none back', async () => {
    const { bridge } = installAgentWorkspaceBridge({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [sessionSummary(SESSION_A)],
        capacity: TEST_CAPACITY,
      }),
    });
    installWorkspaceGrantBridge();

    const { container } = render(<AgentWorkspacePage defaultProvider="claude" />);
    await waitFor(() => expect(bridge.attachActivity).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole('button', { name: /^Session claude/ })[0] as HTMLElement);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Session detail' })).toBeInTheDocument());

    // Every argument this page ever puts on an `agent-workspace:*` channel.
    const sent = JSON.stringify([
      (bridge.listSessions as ReturnType<typeof vi.fn>).mock.calls,
      (bridge.getSession as ReturnType<typeof vi.fn>).mock.calls,
      (bridge.getSessionEvents as ReturnType<typeof vi.fn>).mock.calls,
      (bridge.attachActivity as ReturnType<typeof vi.fn>).mock.calls,
      (bridge.detachActivity as ReturnType<typeof vi.fn>).mock.calls,
    ]);
    for (const shape of ['cwd', 'path', 'workspaceId', 'incarnation', 'C:', '/Users', '\\\\']) {
      expect(sent, `a location-shaped key (${shape}) reached an agent-workspace channel`).not.toContain(shape);
    }

    // And the rendered pane names the boundary rather than a folder.
    expect(container.textContent).toContain('is not shown here');
    expect(container.textContent).not.toMatch(/[A-Za-z]:[\\/]/);
  });

  it('detaches every live relay on unmount rather than leaving streams open in main', async () => {
    const { bridge } = installAgentWorkspaceBridge({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [sessionSummary(SESSION_A), sessionSummary(SESSION_B)],
        capacity: TEST_CAPACITY,
      }),
    });
    installWorkspaceGrantBridge();

    const { unmount } = render(<AgentWorkspacePage defaultProvider="claude" />);
    await waitFor(() => expect(bridge.attachActivity).toHaveBeenCalledTimes(2));

    unmount();

    await waitFor(() => expect(bridge.detachActivity).toHaveBeenCalledTimes(2));
    expect((bridge.detachActivity as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]).sort()).toEqual(
      [SESSION_A, SESSION_B].sort(),
    );
    expectNoGrandfatheredBridgeTouched();
  });
});
