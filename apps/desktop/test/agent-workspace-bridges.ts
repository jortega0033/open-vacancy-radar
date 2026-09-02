import { vi } from 'vitest';
import type {
  ActivityPush,
  AgentWorkspaceBridge,
  HistoryEntry,
  SessionCapacity,
  SessionSummary,
  WorkspaceGrantBridge,
} from '../src/window.js';

/**
 * Stubs for the two bridges the AI Workspace page talks to (ADI-07), in the same style as
 * `test/workspace-bridge.ts` and `test/cv-bridges.ts`.
 *
 * `installAgentWorkspaceBridge` also hands back a `push` function, so a test can deliver a
 * sanitized activity frame the way main would, without a real SSE stream.
 */

export const TEST_CAPACITY: SessionCapacity = {
  global: { active: 1, limit: 4 },
  provider: { active: 1, limit: 2 },
};

/** A canonical v2 session id: the shape `parseSessionId` in workspace/validate.ts requires. */
export const SESSION_A = '11111111-2222-4333-8444-555555555555';
export const SESSION_B = '99999999-8888-4777-8666-555555555555';

export function sessionSummary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    provider: 'claude',
    protocolVersion: 1,
    transportId: 'legacy-one-shot',
    status: 'running',
    acceptedWork: 'prompt',
    rootSessionId: id,
    continuationKind: 'fresh',
    startedAt: '2026-09-02T10:00:00.000Z',
    earliestSequence: 0,
    eventCount: 3,
    eventsTruncated: false,
    scope: { authenticated: 'authenticated', platform: 'win32', accountEvidence: 'cli_owned' },
    unknownFrameCount: 0,
    ...overrides,
  };
}

/**
 * A history entry, defaulting to a `status` row.
 *
 * The cast is unavoidable and deliberately narrow: `HistoryEntry` is a discriminated union, so a
 * spread of a `Partial<HistoryEntry>` over a `status` base widens `kind` to a union TypeScript can
 * no longer narrow. Callers pass a coherent variant; the sanitizer's own tests are where the
 * variants are checked for real.
 */
export function historyEntry(seq: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    seq,
    at: '2026-09-02T10:00:01.000Z',
    origin: 'history',
    kind: 'status',
    status: 'thinking',
    ...overrides,
  } as HistoryEntry;
}

export interface InstalledAgentWorkspaceBridge {
  bridge: AgentWorkspaceBridge;
  /** Delivers one push exactly as main's `agent-workspace:activity` channel would. */
  push(message: ActivityPush): void;
}

export function installAgentWorkspaceBridge(
  overrides: Partial<AgentWorkspaceBridge> = {},
): InstalledAgentWorkspaceBridge {
  const listeners = new Set<(push: ActivityPush) => void>();

  const bridge: AgentWorkspaceBridge = {
    listSessions: vi.fn().mockResolvedValue({ sessions: [], capacity: TEST_CAPACITY }),
    getSession: vi.fn().mockResolvedValue(null),
    getSessionEvents: vi.fn(async (sessionId: string) => ({ sessionId, events: [] })),
    attachActivity: vi.fn().mockResolvedValue({ ok: true }),
    detachActivity: vi.fn().mockResolvedValue(undefined),
    onActivity: vi.fn((callback: (push: ActivityPush) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }),
    ...overrides,
  };

  (window as unknown as { agentWorkspace: AgentWorkspaceBridge }).agentWorkspace = bridge;
  return {
    bridge,
    push: (message) => {
      for (const listener of [...listeners]) listener(message);
    },
  };
}

export function installWorkspaceGrantBridge(
  overrides: Partial<WorkspaceGrantBridge> = {},
): WorkspaceGrantBridge {
  const bridge: WorkspaceGrantBridge = {
    requestGrant: vi
      .fn()
      .mockResolvedValue({
        grantHandle: 'g'.repeat(43),
        display: { name: 'my-project', branch: 'main', dirty: false, effects: 'unbounded_cli' },
      }),
    consumeGrant: vi.fn().mockResolvedValue({ ok: true, workspaceSessionRef: 'r'.repeat(43) }),
    getGrantStatus: vi.fn().mockResolvedValue({ state: 'active', expiresInMs: 60_000 }),
    startSession: vi.fn().mockResolvedValue({
      ok: true,
      session: { sessionId: SESSION_A, provider: 'claude', status: 'starting' },
    }),
    ...overrides,
  };
  (window as unknown as { workspaceGrant: WorkspaceGrantBridge }).workspaceGrant = bridge;
  return bridge;
}
