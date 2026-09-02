import { useCallback, useState } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import { NewSessionPanel } from './NewSessionPanel.js';
import { CapacityLine, SessionList } from './SessionList.js';
import { SessionDetail } from './SessionDetail.js';
import { useAgentWorkspace } from './useAgentWorkspace.js';

/**
 * The AI Workspace destination (ADI-07): a session rail on the left, a detail pane on the right.
 *
 * ## What this page can reach, and what it cannot
 *
 * It talks to exactly two bridges: `window.agentWorkspace` (read v2 sessions, stream sanitized
 * activity), `window.workspaceGrant` (the ADI-06 grant flow), plus `window.agentDock.cancelSession`
 * for stopping and `window.workspace.getSettings/updateSettings` for its three persisted
 * preferences. It reaches **none** of the four grandfathered path-bearing bridges:
 * `agentDock.selectDirectory` (`dialog:select-directory`), `cv.getWorkspaceDir`, `cv.selectAndRead`,
 * and `system.saveFile`. That is the hard constraint the whole design pass centers on, and it is
 * asserted directly: `test/components/agent-workspace/bridge-isolation.test.tsx` renders this page
 * through a full session lifecycle with all four stubbed as throwing spies.
 *
 * The reason it matters is narrow and specific. Those four bridges either return a real filesystem
 * path or accept one, and a v2 session's `cwd` has exactly one legitimate source in this system:
 * the canonical path behind a `workspaceGrant`-issued ref, resolved in the main process. If this UI
 * could obtain a path through any other route, the grant system would still be intact and the
 * property it exists to provide would not be.
 *
 * ## Two panes, no shared "current session"
 *
 * The rail renders every session at once, each reading its own slice; the detail pane renders
 * whichever one is selected. Selection is a render pointer and nothing more: unselecting a running
 * session does not stop it, does not detach its live relay, and does not discard its timeline.
 *
 * No em dashes: this is user-facing copy.
 */

export interface AgentWorkspacePageProps {
  /** The provider the app is configured to use, offered as the default in the composer. */
  defaultProvider: ProviderId;
}

export function AgentWorkspacePage({ defaultProvider }: AgentWorkspacePageProps) {
  const workspace = useAgentWorkspace();
  const { state } = workspace;

  const [showArchived, setShowArchived] = useState(false);
  const [composing, setComposing] = useState(false);
  const [cancelling, setCancelling] = useState<string>();

  const openSession = useCallback(
    (sessionId: string) => {
      setComposing(false);
      workspace.select(sessionId);
    },
    [workspace],
  );

  const cancel = useCallback(
    (sessionId: string) => {
      setCancelling(sessionId);
      void workspace.cancelSession(sessionId).finally(() => setCancelling(undefined));
    },
    [workspace],
  );

  const selected = state.selectedId === undefined ? undefined : state.sessions[state.selectedId];
  // The composer takes the pane whenever the user asked for it, and also whenever there is nothing
  // to show instead: an empty workspace should open on the thing that makes it non-empty.
  const showComposer = composing || selected === undefined;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">AI Workspace</h2>
          <CapacityLine capacity={state.capacity} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowArchived((current) => !current)}
            aria-pressed={showArchived}
          >
            {showArchived ? 'Show active' : 'Show archived'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={workspace.refresh}>
            Refresh
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setComposing(true)}>
            New session
          </button>
        </div>
      </div>

      {state.listStatus === 'error' && state.listError !== undefined && (
        <div className="alert alert-error alert-soft mt-4 text-sm">{state.listError}</div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-[18rem_1fr]">
        <div className="min-w-0">
          {state.listStatus === 'loading' && state.order.length === 0 ? (
            <p className="p-3 text-sm text-base-content/60">Loading sessions…</p>
          ) : (
            <SessionList
              state={state}
              archived={showArchived}
              onSelect={openSession}
              onSetArchived={workspace.setArchived}
              onLoadMore={workspace.loadMoreSessions}
            />
          )}
        </div>

        <div className="min-w-0">
          {showComposer ? (
            <NewSessionPanel
              pendingStarts={state.pendingStarts}
              capacity={state.capacity}
              defaultProvider={defaultProvider}
              newClientKey={workspace.newClientKey}
              onStart={(clientKey, provider, prompt) => {
                void workspace.startSession(clientKey, provider, prompt);
              }}
              onDismiss={workspace.dismissPendingStart}
              onOpenSession={openSession}
            />
          ) : (
            selected !== undefined && (
              <SessionDetail
                entry={selected}
                onCancel={cancel}
                cancelling={cancelling === selected.view.id}
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}
