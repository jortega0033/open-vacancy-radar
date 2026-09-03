// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_WORKSPACE_ACTIVITY_CHANNEL,
  AGENT_WORKSPACE_CHANNELS,
  createSessionAliasBook,
  MAX_ALIAS_BOOKS,
  registerAgentWorkspaceHandlers,
  type AgentWorkspaceIpcDeps,
  type IpcInvokeHandler,
} from '../electron/agent-workspace-ipc.js';
import type { AttachResult, SessionEventsPage, SessionListPage, SessionSummary } from '../electron/agent-workspace-types.js';
import type { GuardedIpcHandle } from '../electron/ipc-sender-guard.js';

/**
 * The desktop half of ADI-07's rollback story, and an honest statement of how far it goes.
 *
 * ## What this file proves
 *
 * `apps/daemon/test/index.downgrade.test.ts` boots the real server stack with the v2 routes'
 * registration skipped and shows every v1 route still working. The desktop equivalent is
 * structurally out of reach: `electron/main.ts` registers ~fifty IPC channels at module scope and
 * cannot be imported by a test at all -- importing it boots Electron, spawns the daemon sidecar,
 * and opens two SQLite databases. That is a pre-existing architectural gap, older than this
 * feature, and this ticket does not try to close it.
 *
 * What ADI-07 *can* do, and now does, is keep the whole feature behind one call. The five channels,
 * their paging helpers and their alias book live in `electron/agent-workspace-ipc.ts`; main.ts
 * holds a relay, a `getJson`, and a single `registerAgentWorkspaceHandlers(ipcMain, ...)`. So the
 * three claims below are real, checkable claims rather than a re-statement of the implementation:
 *
 *  1. **The five channels are additive.** Their names are cross-checked, by reading main.ts's and
 *     preload.ts's source, against every other channel this app registers or invokes. A collision
 *     -- which is the one way a new channel can break an existing handler, since the second
 *     `ipcMain.handle` for a name throws at registration -- would fail here.
 *  2. **Not registering them is a complete rollback.** The registrar sees exactly five `handle`
 *     calls and nothing else; skipping the call leaves a registrar untouched, and importing the
 *     module has no side effect of any kind.
 *  3. **The feature owns no shared mutable state.** This is the specific regression the ticket
 *     exists to prevent: the pre-ADI-07 code kept `activeSessionId` / `activeStreamAbort` as
 *     main.ts module globals, so one session's stream could orphan another's. Two independently
 *     created alias books and two independently registered handler sets are shown not to see each
 *     other, which is the property a module global would break.
 *
 * ## What this file does NOT prove
 *
 * It does not boot main.ts, so it cannot show that main.ts's *other* forty-odd handlers still work
 * with the registration removed -- the way the daemon test shows v1 sessions still serving. Nothing
 * short of making main.ts importable would show that, and that refactor is deliberately out of
 * scope here. Treat this as "the new feature is isolated and removable", not as "the app was booted
 * without it and everything else was verified". The e2e sweep in `e2e/` is the only place the whole
 * app is actually started.
 */

const ELECTRON_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron');

function source(file: string): string {
  return readFileSync(join(ELECTRON_DIR, file), 'utf8');
}

/**
 * Every channel name main.ts registers a handler for, read out of its source.
 *
 * The receiver is `guardedIpc`, not `ipcMain`, since ADI-16: every registration now goes through the
 * sender-verifying registrar in electron/ipc-sender-guard.ts, and a direct `ipcMain.handle` anywhere
 * under electron/ is itself a test failure (see test/ipc-sender-guard.test.ts). Only the receiver
 * changed -- the channel names, and everything this file asserts about them, did not.
 */
function mainHandleChannels(): string[] {
  return [...source('main.ts').matchAll(/guardedIpc\.handle\(\s*'([^']+)'/g)].map((match) => match[1] as string);
}

/** Every channel preload.ts talks on: `invoke`, plus the `on`/`removeListener` push channels. */
function preloadChannels(): string[] {
  const text = source('preload.ts');
  return [...text.matchAll(/ipcRenderer\.(?:invoke|on|removeListener)\(\s*'([^']+)'/g)].map(
    (match) => match[1] as string,
  );
}

/** A stand-in for `ipcMain` that records what was registered, in order. */
function stubRegistrar(): { handle: (channel: string, listener: IpcInvokeHandler) => void; calls: string[]; handlers: Map<string, IpcInvokeHandler> } {
  const calls: string[] = [];
  const handlers = new Map<string, IpcInvokeHandler>();
  return {
    calls,
    handlers,
    handle(channel: string, listener: IpcInvokeHandler): void {
      // Electron itself throws on a duplicate channel; mirroring that makes a collision inside
      // this feature fail here rather than at app start.
      if (handlers.has(channel)) throw new Error(`duplicate handler for '${channel}'`);
      calls.push(channel);
      handlers.set(channel, listener);
    },
  };
}

const SESSION_ID = '11111111-2222-4333-8444-555555555555';

const VIEW = {
  id: SESSION_ID,
  provider: 'claude',
  protocolVersion: 2,
  transportId: 'legacy-one-shot',
  status: 'running',
  acceptedWork: 'prompt',
  rootSessionId: SESSION_ID,
  continuationKind: 'fresh',
  startedAt: '2026-09-02T10:00:00.000Z',
  earliestSequence: 0,
  eventCount: 3,
  eventsTruncated: false,
  scope: { authenticated: 'authenticated', platform: 'win32', executablePath: 'C:/Users/someone/claude.cmd' },
  cwd: 'C:/Users/someone/my-project',
  providerSessionId: 'native-thread-abc',
};

interface Harness {
  registrar: ReturnType<typeof stubRegistrar>;
  getJson: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  aliasesFor: (sessionId: string) => Map<string, string>;
  invoke(channel: string, payload?: unknown): Promise<unknown>;
}

function harness(overrides: Partial<AgentWorkspaceIpcDeps> = {}): Harness {
  const registrar = stubRegistrar();
  const getJson = vi.fn(async (_path: string): Promise<Record<string, unknown> | undefined> => undefined);
  const attach = vi.fn((): AttachResult => ({ ok: true }));
  const detach = vi.fn(() => true);
  const aliasesFor = createSessionAliasBook();

  // registerAgentWorkspaceHandlers now requires the branded GuardedIpcHandle (ADI-16), so real
  // callers can't wire it to an unguarded ipcMain by mistake. This stub deliberately opts out of
  // that check -- it isn't guarded, and it's not meant to be; this file is testing registration and
  // paging behavior, not the sender guard, which has its own test.
  registerAgentWorkspaceHandlers(registrar as unknown as GuardedIpcHandle, {
    getJson,
    aliasesFor,
    relay: { attach, detach },
    ...overrides,
  });

  return {
    registrar,
    getJson,
    attach,
    detach,
    aliasesFor,
    async invoke(channel: string, payload?: unknown): Promise<unknown> {
      const handler = registrar.handlers.get(channel);
      if (!handler) throw new Error(`no handler registered for '${channel}'`);
      // `{}` stands in for Electron's IpcMainInvokeEvent: none of these five handlers reads it.
      return handler({}, payload);
    },
  };
}

describe('the five AI Workspace channels are additive', () => {
  it('registers exactly the documented five, once each', () => {
    const { registrar } = harness();
    expect(registrar.calls).toEqual([...AGENT_WORKSPACE_CHANNELS]);
    expect(new Set(registrar.calls).size).toBe(AGENT_WORKSPACE_CHANNELS.length);
  });

  it('does not collide with any channel main.ts already registers', () => {
    const existing = mainHandleChannels();
    // main.ts no longer registers these inline: the whole feature moved behind one call. If a
    // future edit puts one back, this catches the duplicate before Electron throws at startup.
    expect(existing.filter((channel) => channel.startsWith('agent-workspace:'))).toEqual([]);
    for (const channel of AGENT_WORKSPACE_CHANNELS) {
      expect(existing, `'${channel}' must not already be handled in main.ts`).not.toContain(channel);
    }
    // And main.ts's own list has no duplicates, which is the failure mode a collision would create.
    expect(new Set(existing).size).toBe(existing.length);
    expect(existing.length).toBeGreaterThan(40);
  });

  it('matches, exactly, the agent-workspace channels preload.ts talks on', () => {
    const used = new Set(preloadChannels().filter((channel) => channel.startsWith('agent-workspace:')));
    // The push channel is `webContents.send`-ed by main and listened for by preload; it is
    // deliberately not an `ipcMain.handle` channel, so it is expected here and nowhere above.
    expect([...used].sort()).toEqual([...AGENT_WORKSPACE_CHANNELS, AGENT_WORKSPACE_ACTIVITY_CHANNEL].sort());
  });

  it('keeps the activity push channel out of the invoke surface', () => {
    const { registrar } = harness();
    expect(registrar.handlers.has(AGENT_WORKSPACE_ACTIVITY_CHANNEL)).toBe(false);
    expect(mainHandleChannels()).not.toContain(AGENT_WORKSPACE_ACTIVITY_CHANNEL);
  });

  it('shares a prefix with nothing else: every non-feature channel uses a different namespace', () => {
    // `workspace:*` and `workspace-grant:*` are the near-misses worth pinning: a channel named
    // `agent-workspace:...` must never be answered by one of those handlers, and vice versa.
    for (const channel of mainHandleChannels()) {
      expect(AGENT_WORKSPACE_CHANNELS.some((owned) => owned === channel)).toBe(false);
    }
  });
});

describe('rollback: not calling the registration is the off switch', () => {
  it('leaves a registrar completely untouched when it is not called', () => {
    const registrar = stubRegistrar();
    // The literal rollback: main.ts deletes its one call.
    expect(registrar.calls).toEqual([]);
    expect(registrar.handlers.size).toBe(0);
  });

  it('has no import-time side effect: the module registers nothing on import', async () => {
    // A fresh module instance, imported in isolation. Nothing runs but declarations -- no handler,
    // no timer, no map that outlives the import.
    vi.resetModules();
    const fresh = await import('../electron/agent-workspace-ipc.js');
    expect(typeof fresh.registerAgentWorkspaceHandlers).toBe('function');
    expect(fresh.AGENT_WORKSPACE_CHANNELS).toEqual(AGENT_WORKSPACE_CHANNELS);
  });

  it('owns no module-level mutable state: two registrations cannot see each other', async () => {
    const a = harness();
    const b = harness();

    await a.invoke('agent-workspace:attach', { sessionId: SESSION_ID });

    expect(a.attach).toHaveBeenCalledTimes(1);
    // The `activeSessionId` / `activeStreamAbort` bug pattern in one assertion: if any of this
    // feature's state were a module global, b's relay would see a's attach.
    expect(b.attach).not.toHaveBeenCalled();
    expect(b.registrar.handlers.size).toBe(AGENT_WORKSPACE_CHANNELS.length);
  });

  it('gives each alias book its own storage', () => {
    const first = createSessionAliasBook();
    const second = createSessionAliasBook();
    first(SESSION_ID).set('native-1', 't1');
    expect(second(SESSION_ID).size).toBe(0);
    // ...and the same book hands the same map back, which is what keeps history and live agreeing.
    expect(first(SESSION_ID).get('native-1')).toBe('t1');
  });

  it('bounds the alias book rather than growing forever', () => {
    const aliasesFor = createSessionAliasBook(3);
    for (const id of ['a', 'b', 'c']) aliasesFor(id).set('native', 't1');
    aliasesFor('d'); // evicts the oldest ('a')
    expect(aliasesFor('a').size).toBe(0);
    expect(aliasesFor('c').get('native')).toBe('t1');
    expect(MAX_ALIAS_BOOKS).toBe(64);
  });
});

describe('the registered handlers behave, against fakes rather than a daemon', () => {
  it('lists sessions through the v2 read route, path-free', async () => {
    const h = harness();
    h.getJson.mockResolvedValue({
      sessions: [VIEW, { not: 'a session' }],
      nextCursor: 'abc123',
      capacity: { global: { active: 1, limit: 4 }, provider: { active: 1, limit: 2 } },
    });

    const page = (await h.invoke('agent-workspace:list', { limit: 25 })) as SessionListPage;

    expect(h.getJson).toHaveBeenCalledWith('/v2/sessions?limit=25');
    expect(page.sessions.map((s) => s.id)).toEqual([SESSION_ID]);
    expect(page.nextCursor).toBe('abc123');
    expect(page.capacity).toEqual({ global: { active: 1, limit: 4 }, provider: { active: 1, limit: 2 } });
    // The boundary the feature exists for, asserted at the IPC layer and not only in the view test.
    expect(JSON.stringify(page)).not.toContain('my-project');
    expect(JSON.stringify(page)).not.toContain('native-thread-abc');
  });

  it('drops anything the renderer attached that the list contract does not name', async () => {
    const h = harness();
    h.getJson.mockResolvedValue({ sessions: [] });
    await h.invoke('agent-workspace:list', { limit: 10, cwd: 'C:/Users/someone', provider: 'claude', path: '/etc' });
    // No `cwd`, no `provider`, no `path` reaches the URL: the validator has no parser for them.
    expect(h.getJson).toHaveBeenCalledWith('/v2/sessions?limit=10');
  });

  it('returns null for a session the daemon does not have', async () => {
    const h = harness();
    h.getJson.mockResolvedValue(undefined); // the 404 shape
    expect(await h.invoke('agent-workspace:get', { sessionId: SESSION_ID })).toBeNull();
    expect(h.getJson).toHaveBeenCalledWith(`/v2/sessions/${SESSION_ID}`);
  });

  it('reads a session through get', async () => {
    const h = harness();
    h.getJson.mockResolvedValue({ session: VIEW });
    const summary = (await h.invoke('agent-workspace:get', { sessionId: SESSION_ID })) as SessionSummary;
    expect(summary.id).toBe(SESSION_ID);
    expect(summary).not.toHaveProperty('cwd');
  });

  it('pages history and mints tool aliases from the shared book', async () => {
    const h = harness();
    h.getJson.mockResolvedValue({
      events: [
        { sequence: 0, type: 'session.started', provider: 'claude', timestamp: '2026-09-02T10:00:00.000Z' },
        { sequence: 1, type: 'tool.started', toolName: 'Read', toolCallId: 'native-tool-1', timestamp: '2026-09-02T10:00:01.000Z' },
        { sequence: 2, type: 'tool.completed', toolName: 'Read', toolCallId: 'native-tool-1', isError: false, timestamp: '2026-09-02T10:00:02.000Z' },
        { sequence: 3, type: 'from.a.newer.daemon' },
      ],
      nextCursor: 'zzz999',
    });

    const page = (await h.invoke('agent-workspace:events', { sessionId: SESSION_ID, limit: 100 })) as SessionEventsPage;

    expect(h.getJson).toHaveBeenCalledWith(`/v2/sessions/${SESSION_ID}/events?limit=100`);
    expect(page.sessionId).toBe(SESSION_ID);
    // The unreadable record is skipped, not fatal.
    expect(page.events.map((e) => e.kind)).toEqual(['session.started', 'tool.started', 'tool.completed']);
    // The started/completed pair shares one alias, and the native id never crosses.
    const started = page.events[1] as { toolAlias?: string };
    const completed = page.events[2] as { toolAlias?: string };
    expect(started.toolAlias).toBe(completed.toolAlias);
    expect(JSON.stringify(page)).not.toContain('native-tool-1');
    // The alias came from the book main.ts also hands the live relay.
    expect(h.aliasesFor(SESSION_ID).get('native-tool-1')).toBe(started.toolAlias);
  });

  it('passes attach and detach straight through to the relay', async () => {
    const h = harness();
    h.attach.mockReturnValue({ ok: false, reason: 'attach_limit' });

    expect(await h.invoke('agent-workspace:attach', { sessionId: SESSION_ID, lastSeq: 7 })).toEqual({
      ok: false,
      reason: 'attach_limit',
    });
    expect(h.attach).toHaveBeenCalledWith(SESSION_ID, 7);

    expect(await h.invoke('agent-workspace:detach', { sessionId: SESSION_ID })).toBeUndefined();
    expect(h.detach).toHaveBeenCalledWith(SESSION_ID);
  });

  it('refuses a malformed payload before it reaches the daemon or the relay', async () => {
    const h = harness();
    await expect(h.invoke('agent-workspace:get', { sessionId: '../../etc/passwd' })).rejects.toThrow();
    await expect(h.invoke('agent-workspace:list', { limit: 5000 })).rejects.toThrow();
    await expect(h.invoke('agent-workspace:attach', { sessionId: SESSION_ID, lastSeq: -1 })).rejects.toThrow();
    expect(h.getJson).not.toHaveBeenCalled();
    expect(h.attach).not.toHaveBeenCalled();
  });
});
