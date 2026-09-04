// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_WORKSPACE_CHANNELS } from '../electron/agent-workspace-ipc.js';
import {
  IPC_SENDER_REJECTED_MESSAGE,
  IpcSenderRejectedError,
  createGuardedIpc,
  guardIpcListener,
  isFromMainWindowFrame,
  type GuardedInvokeEvent,
  type IpcInvokeListener,
} from '../electron/ipc-sender-guard.js';

/**
 * ADI-16, in two halves.
 *
 * The first half is *mechanical*: it reads `electron/`'s own source and asserts that no registration
 * anywhere reaches `ipcMain.handle` directly, and that the set of channels registered through the
 * guarded registrar is exactly the set the preload bridge invokes. That is the part that has to fail
 * for a handler somebody adds in six months without reading any of this. It follows the same
 * source-reading convention `test/agent-workspace-ipc.test.ts` established for channel-collision
 * checks, and the same "the inventory must match in both directions" discipline as ADI-05's
 * redaction test (`apps/daemon/test/persisted-session-schema.test.ts`) and ADI-07's sanitizer test.
 *
 * The second half is *behavioral*: it drives `guardIpcListener` with fake `IpcMainInvokeEvent`-shaped
 * objects and pins which senders run the handler and which never reach it at all.
 *
 * Neither half boots main.ts -- importing it starts Electron, spawns the daemon and opens two SQLite
 * databases, a pre-existing limitation `agent-workspace-ipc.test.ts` documents at length. The `e2e/`
 * suite launching the real app is what proves the real renderer still passes the guard.
 */

const ELECTRON_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron');

/**
 * Drops comments, so prose *about* `ipcMain.handle` (of which this ticket wrote a fair amount) is
 * never mistaken for a registration.
 *
 * Deliberately conservative: block comments, and whole lines that are line comments or continuation
 * lines of a block comment. It does not try to strip a trailing `// ...` from a code line, because
 * doing that naively also truncates any line containing a `'https://...'` literal -- and a blind
 * spot in the middle of a code line is exactly what this test must not have.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
    .join('\n');
}

/** Every `.ts` file under electron/, recursively: the whole surface a registration could hide in. */
function electronSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        out.push({
          path: relative(ELECTRON_DIR, full).replace(/\\/g, '/'),
          text: stripComments(readFileSync(full, 'utf8')),
        });
      }
    }
  };
  walk(ELECTRON_DIR);
  return out;
}

function source(file: string): string {
  return readFileSync(join(ELECTRON_DIR, file), 'utf8');
}

/**
 * The receivers a `handle('channel', ...)` call may legitimately be made on.
 *
 * `guardedIpc` is main.ts's own guarded registrar. `ipc` is the parameter name
 * `registerAgentWorkspaceHandlers(ipc, deps)` registers its five channels on -- and main.ts hands it
 * `guardedIpc`, which the assertion below pins, so those five are guarded by construction rather
 * than by a second copy of the check.
 */
const ALLOWED_HANDLE_RECEIVERS = new Set(['guardedIpc', 'ipc']);

/** Channel names registered through main.ts's guarded registrar, read out of its source. */
function guardedChannels(): string[] {
  return [...source('main.ts').matchAll(/guardedIpc\.handle\(\s*'([^']+)'/g)].map((m) => m[1] as string);
}

/** Every channel preload.ts `invoke`s, i.e. the whole renderer-reachable request surface. */
function preloadInvokeChannels(): string[] {
  return [...source('preload.ts').matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((m) => m[1] as string);
}

/**
 * What ADI-16 found: 46 `ipcMain.handle` registrations in main.ts, of which exactly three
 * (`workspace-grant:*`) checked their sender at all, plus five more registered through ADI-07's
 * registrar. Pinned as a floor rather than an equality so that adding channel 47 is not a test
 * failure on its own -- the two exhaustiveness assertions below are what actually enforce coverage.
 */
const REGISTRATIONS_AT_ADI_16 = 46;

describe('every ipcMain.handle registration is guarded (ADI-16, mechanical)', () => {
  it('has no direct registration on ipcMain anywhere under electron/', () => {
    const offenders = electronSources()
      .filter((file) => /\bipcMain\s*\.\s*handle(?:Once)?\s*\(/.test(file.text))
      .map((file) => file.path);
    // The whole point of the registrar: `ipcMain` may be imported (main.ts hands it to
    // `createGuardedIpc`), but nothing may register on it. This is the assertion a future handler
    // added the old way fails.
    expect(offenders, 'register through createGuardedIpc, not ipcMain.handle').toEqual([]);
  });

  it('has no ipcMain.on registration anywhere under electron/ (issue #177)', () => {
    // The mechanical test above only ever matched `.handle`/`.handleOnce`, so a fire-and-forget
    // listener registered with `ipcMain.on` would bypass both the sender guard and this test
    // silently -- `createGuardedIpc`/`GuardedIpcHandle` has no `.on` method at all, so there is no
    // guarded way to register one today. This repo has never needed one (every channel answers with
    // a value, hence `handle`), and this pins that as an enforced invariant rather than a fact that
    // happens to be true: if a future edit adds `ipcMain.on(...)`, this must fail rather than ship
    // an unguarded listener next to forty-six guarded ones.
    const offenders = electronSources()
      .filter((file) => /\bipcMain\s*\.\s*on\s*\(/.test(file.text))
      .map((file) => file.path);
    expect(offenders, 'ipcMain.on is not a supported registration surface in this repo').toEqual([]);
  });

  it('makes every handle() call on a receiver that is known to be guarded', () => {
    const seen: { path: string; receiver: string }[] = [];
    for (const file of electronSources()) {
      // The receiver is captured as a whole dotted expression, not just its last identifier, so
      // that Electron's other registration surfaces -- `webContents.ipc.handle(...)`,
      // `webContents.mainFrame.ipc.handle(...)` -- cannot slip through as a bare `ipc`.
      for (const match of file.text.matchAll(/([\w$]+(?:\.[\w$]+)*)\.handle\(\s*'/g)) {
        seen.push({ path: file.path, receiver: match[1] as string });
      }
    }
    expect(seen.length).toBeGreaterThanOrEqual(REGISTRATIONS_AT_ADI_16);
    const unknown = seen.filter((call) => !ALLOWED_HANDLE_RECEIVERS.has(call.receiver));
    expect(unknown, 'an IPC handler registered on an unrecognised receiver').toEqual([]);
  });

  it('registers at least the 46 channels ADI-16 counted, each exactly once', () => {
    const channels = guardedChannels();
    expect(channels.length).toBeGreaterThanOrEqual(REGISTRATIONS_AT_ADI_16);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it('hands ADI-07 the guarded registrar, so its five channels are covered too', () => {
    // The five `agent-workspace:*` channels are registered inside agent-workspace-ipc.ts against
    // whatever registrar it is given. This one line in main.ts is what makes them guarded.
    expect(source('main.ts')).toContain('registerAgentWorkspaceHandlers(guardedIpc,');
    expect(guardedChannels()).not.toContain(AGENT_WORKSPACE_CHANNELS[0]);
  });

  it('covers exactly the invoke surface preload exposes: no unguarded channel, no dead one', () => {
    const registered = [...guardedChannels(), ...AGENT_WORKSPACE_CHANNELS].sort();
    const invoked = [...new Set(preloadInvokeChannels())].sort();
    // Both directions. A handler added without the guard is missing from `registered` and fails
    // here; a preload method pointing at a channel nobody answers fails here too.
    expect(registered).toEqual(invoked);
    expect(registered.length).toBeGreaterThanOrEqual(REGISTRATIONS_AT_ADI_16 + AGENT_WORKSPACE_CHANNELS.length);
  });

  it('spans all seven preload namespaces', () => {
    const prefixes = new Set(guardedChannels().map((channel) => channel.split(':')[0] as string));
    // The channel prefixes behind `agentDock`, `vacancyRadar`, `workspace`, `cv`, `system` and
    // `workspaceGrant`; `agentWorkspace`'s five come through the registrar hand-off above.
    for (const prefix of ['daemon', 'vacancy', 'workspace', 'workspace-grant', 'cv', 'system', 'dialog']) {
      expect([...prefixes], prefix).toContain(prefix);
    }
  });
});

/** A `WebFrameMain`-shaped stand-in. Only the two fields the check reads. */
function frame(frameTreeNodeId: number, parent: unknown = null): { frameTreeNodeId: number; parent: unknown } {
  return { frameTreeNodeId, parent };
}

/** An `IpcMainInvokeEvent`-shaped stand-in for a call from the main window's top-level frame. */
function eventFromMainWindow(webContentsId = 1, nodeId = 10): GuardedInvokeEvent {
  const top = frame(nodeId);
  return { sender: { id: webContentsId, mainFrame: top }, senderFrame: top };
}

describe('isFromMainWindowFrame', () => {
  it('accepts the main window’s own top-level frame', () => {
    expect(isFromMainWindowFrame(eventFromMainWindow(7, 42), 7)).toBe(true);
  });

  it('accepts a frame object that is not the same instance as mainFrame, if the node id matches', () => {
    // What a cross-process navigation produces: Electron hands out a fresh `WebFrameMain` for the
    // same underlying frame node. Comparing object identity here would reject the real renderer
    // after a reload, which is precisely the false positive this ticket must not introduce.
    const event: GuardedInvokeEvent = {
      sender: { id: 7, mainFrame: frame(42) },
      senderFrame: frame(42),
    };
    expect(isFromMainWindowFrame(event, 7)).toBe(true);
  });

  it('rejects a different WebContents: a second window, a <webview>, a devtools page', () => {
    expect(isFromMainWindowFrame(eventFromMainWindow(9, 42), 7)).toBe(false);
  });

  it('rejects a subframe of the main window, which shares its WebContents', () => {
    const top = frame(42);
    const child = { frameTreeNodeId: 43, parent: top };
    expect(isFromMainWindowFrame({ sender: { id: 7, mainFrame: top }, senderFrame: child }, 7)).toBe(false);
  });

  it('rejects a top-level-looking frame whose node id is not the main frame’s', () => {
    // The shape a forged event would take: `parent: null` alone is not enough.
    const event: GuardedInvokeEvent = { sender: { id: 7, mainFrame: frame(42) }, senderFrame: frame(99) };
    expect(isFromMainWindowFrame(event, 7)).toBe(false);
  });

  it('rejects when there is no window yet, or none any more', () => {
    expect(isFromMainWindowFrame(eventFromMainWindow(7, 42), undefined)).toBe(false);
  });

  it('rejects a null or missing senderFrame rather than falling back to sender.id', () => {
    const top = frame(42);
    for (const senderFrame of [null, undefined]) {
      expect(isFromMainWindowFrame({ sender: { id: 7, mainFrame: top }, senderFrame }, 7)).toBe(false);
    }
  });

  it('rejects, without throwing, a sender being torn down', () => {
    const exploding = {
      get sender(): never {
        throw new Error('Object has been destroyed');
      },
      senderFrame: frame(42),
    } as unknown as GuardedInvokeEvent;
    expect(() => isFromMainWindowFrame(exploding, 7)).not.toThrow();
    expect(isFromMainWindowFrame(exploding, 7)).toBe(false);
  });

  it('rejects a hand-built object that only looks like an event', () => {
    for (const event of [
      { sender: null, senderFrame: frame(42) },
      { sender: { id: '7', mainFrame: frame(42) }, senderFrame: frame(42) },
      { sender: { id: 7, mainFrame: null }, senderFrame: frame(42) },
      { sender: { id: 7, mainFrame: frame(42) }, senderFrame: { frameTreeNodeId: '42', parent: null } },
    ] as unknown as GuardedInvokeEvent[]) {
      expect(isFromMainWindowFrame(event, 7)).toBe(false);
    }
  });
});

describe('guardIpcListener', () => {
  it('never invokes the handler when the sender does not match', async () => {
    const handler = vi.fn(() => 'secret');
    const onRejected = vi.fn();
    const guarded = guardIpcListener('system:save-file', handler as unknown as IpcInvokeListener, {
      mainWindowWebContentsId: () => 1,
      onRejected,
    });

    expect(() => guarded(eventFromMainWindow(2) as never)).toThrow(IpcSenderRejectedError);
    expect(handler).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith({ channel: 'system:save-file' });
  });

  it('refuses with a fixed message that describes nothing about the check', () => {
    const guarded = guardIpcListener('workspace:letters:delete', (() => 'x') as unknown as IpcInvokeListener, {
      mainWindowWebContentsId: () => 1,
    });
    try {
      guarded(eventFromMainWindow(2) as never);
      expect.unreachable('the guard must throw');
    } catch (error) {
      expect((error as Error).message).toBe(IPC_SENDER_REJECTED_MESSAGE);
      expect((error as IpcSenderRejectedError).channel).toBe('workspace:letters:delete');
    }
  });

  it('runs the handler untouched for a legitimate sender, arguments and result included', async () => {
    const handler = vi.fn(async (_event: unknown, input: unknown) => ({ echoed: input }));
    const guarded = guardIpcListener('workspace:saved-jobs:create', handler as unknown as IpcInvokeListener, {
      mainWindowWebContentsId: () => 1,
    });

    const event = eventFromMainWindow(1);
    const result = await (guarded(event as never, { title: 'x' } as never) as Promise<unknown>);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event, { title: 'x' });
    expect(result).toEqual({ echoed: { title: 'x' } });
  });

  it('reads the window id on every call, so a recreated window is picked up', () => {
    const handler = vi.fn(() => 'ok');
    let current: number | undefined;
    const guarded = guardIpcListener('daemon:get-status', handler as unknown as IpcInvokeListener, {
      mainWindowWebContentsId: () => current,
    });

    // Before any window exists.
    expect(() => guarded(eventFromMainWindow(5) as never)).toThrow(IpcSenderRejectedError);
    current = 5;
    expect(guarded(eventFromMainWindow(5) as never)).toBe('ok');
    // The window is destroyed; main.ts clears the id.
    current = undefined;
    expect(() => guarded(eventFromMainWindow(5) as never)).toThrow(IpcSenderRejectedError);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('createGuardedIpc', () => {
  it('registers a wrapper, not the listener itself, on the underlying ipcMain', () => {
    const registered = new Map<string, IpcInvokeListener>();
    const handler = vi.fn(() => 'ok') as unknown as IpcInvokeListener;
    const guardedIpc = createGuardedIpc(
      { handle: (channel, listener) => void registered.set(channel, listener) },
      { mainWindowWebContentsId: () => 3 },
    );

    guardedIpc.handle('cv:get-workspace-dir', handler);

    const wrapped = registered.get('cv:get-workspace-dir');
    expect(wrapped).toBeDefined();
    expect(wrapped).not.toBe(handler);
    expect(() => wrapped?.(eventFromMainWindow(4) as never)).toThrow(IpcSenderRejectedError);
    expect(handler).not.toHaveBeenCalled();
    expect(wrapped?.(eventFromMainWindow(3) as never)).toBe('ok');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('is a drop-in for ADI-07’s registrar: registering its five channels guards all five', async () => {
    const registered = new Map<string, IpcInvokeListener>();
    const guardedIpc = createGuardedIpc(
      { handle: (channel, listener) => void registered.set(channel, listener) },
      { mainWindowWebContentsId: () => 3 },
    );
    const { registerAgentWorkspaceHandlers } = await import('../electron/agent-workspace-ipc.js');

    registerAgentWorkspaceHandlers(guardedIpc, {
      getJson: async () => undefined,
      aliasesFor: () => new Map<string, string>(),
      relay: { attach: () => ({ ok: true }), detach: () => true },
    });

    expect([...registered.keys()]).toEqual([...AGENT_WORKSPACE_CHANNELS]);
    for (const channel of AGENT_WORKSPACE_CHANNELS) {
      expect(() => registered.get(channel)?.(eventFromMainWindow(4) as never), channel).toThrow(
        IpcSenderRejectedError,
      );
    }
    // ...and the legitimate sender still reaches the real handler: `agent-workspace:attach` calls
    // the relay, which a rejected call never would.
    expect(registered.get('agent-workspace:attach')?.(eventFromMainWindow(3) as never, { sessionId: '11111111-2222-4333-8444-555555555555' } as never)).toEqual({ ok: true });
  });
});
