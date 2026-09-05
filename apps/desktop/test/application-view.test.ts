import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mocks 'electron' the same way `preload.test.ts` does, for the same reason: this file imports the
 * REAL `electron/application-view.ts` against a stubbed `WebContentsView`, so the assertions run
 * against code that could actually leak something (a missing permission denial, a real preload
 * path, a debugger double-attach) -- not against a fake object the test itself constructed.
 *
 * A real Chromium-backed `WebContentsView` and a real CDP debugger session are deliberately out of
 * scope here (see this file's own header comment below for why): what this file can and does prove
 * is this module's own wiring -- the exact options passed to `WebContentsView`, that every
 * permission request is denied, and that `attach`/`detach`/`show`/`hide`/`destroy` compose the
 * fake debugger's calls in the right order and don't double-attach or double-detach.
 */
const { FakeDebugger, instances, baseWindowInstances } = vi.hoisted(() => {
  class FakeDebugger {
    attachCalls: unknown[] = [];
    detachCalls = 0;
    sendCommandCalls: Array<{ method: string; params: unknown }> = [];
    private detachListeners: Array<(event: unknown, reason: string) => void> = [];

    attach(protocolVersion?: string): void {
      this.attachCalls.push(protocolVersion);
    }
    detach(): void {
      this.detachCalls += 1;
    }
    isAttached(): boolean {
      return this.attachCalls.length > this.detachCalls;
    }
    async sendCommand(method: string, params?: unknown): Promise<unknown> {
      this.sendCommandCalls.push({ method, params });
      return { ok: true };
    }
    on(event: string, listener: (event: unknown, reason: string) => void): void {
      if (event === 'detach') this.detachListeners.push(listener);
    }
    /** Test-only: simulates Electron firing 'detach' on its own (DevTools opened, webContents closed). */
    simulateExternalDetach(): void {
      for (const listener of this.detachListeners) listener({}, 'target_closed');
    }
  }

  interface Instance {
    options: unknown;
    debug: InstanceType<typeof FakeDebugger>;
    permissionHandler?: (wc: unknown, permission: string, callback: (granted: boolean) => void) => void;
    windowOpenHandler?: () => unknown;
    closeCalls: number;
    setBoundsCalls: unknown[];
  }

  const instances: Instance[] = [];

  interface BaseWindowInstance {
    options: unknown;
    addChildViewCalls: unknown[];
    removeChildViewCalls: unknown[];
    destroyCalls: number;
  }

  const baseWindowInstances: BaseWindowInstance[] = [];

  return { FakeDebugger, instances, baseWindowInstances };
});

vi.mock('electron', () => {
  class FakeWebContentsView {
    webContents: {
      debugger: InstanceType<typeof FakeDebugger>;
      session: { setPermissionRequestHandler: (fn: (wc: unknown, permission: string, callback: (granted: boolean) => void) => void) => void };
      setWindowOpenHandler: (fn: () => unknown) => void;
      close: () => void;
    };
    setBounds: (bounds: unknown) => void;

    constructor(options: unknown) {
      const debug = new FakeDebugger();
      const record: (typeof instances)[number] = { options, debug, closeCalls: 0, setBoundsCalls: [] };
      instances.push(record);
      this.webContents = {
        debugger: debug,
        session: {
          setPermissionRequestHandler: (fn) => {
            record.permissionHandler = fn;
          },
        },
        setWindowOpenHandler: (fn) => {
          record.windowOpenHandler = fn;
        },
        close: () => {
          record.closeCalls += 1;
        },
      };
      this.setBounds = (bounds) => record.setBoundsCalls.push(bounds);
    }
  }

  class FakeBaseWindow {
    contentView: { addChildView: (v: unknown) => void; removeChildView: (v: unknown) => void };
    destroy: () => void;

    constructor(options: unknown) {
      const record = { options, addChildViewCalls: [] as unknown[], removeChildViewCalls: [] as unknown[], destroyCalls: 0 };
      baseWindowInstances.push(record);
      this.contentView = {
        addChildView: (v) => record.addChildViewCalls.push(v),
        removeChildView: (v) => record.removeChildViewCalls.push(v),
      };
      this.destroy = () => {
        record.destroyCalls += 1;
      };
    }
  }

  return { WebContentsView: FakeWebContentsView, BaseWindow: FakeBaseWindow };
});

import { createApplicationView } from '../electron/application-view.js';

function fakeWindow(bounds = { x: 0, y: 0, width: 800, height: 600 }) {
  const addChildView = vi.fn();
  const removeChildView = vi.fn();
  return {
    contentView: { addChildView, removeChildView },
    getContentBounds: () => bounds,
  } as never;
}

beforeEach(() => {
  instances.length = 0;
  baseWindowInstances.length = 0;
});

describe('createApplicationView', () => {
  it('gives the view a per-attempt, non-persistent, no-preload, sandboxed configuration', () => {
    createApplicationView('attempt-123');
    expect(instances).toHaveLength(1);
    const options = instances[0]!.options as Record<string, unknown>;
    const webPreferences = options.webPreferences as Record<string, unknown>;
    expect(webPreferences.partition).toBe('ovr-apply-attempt-123');
    expect(webPreferences.sandbox).toBe(true);
    expect(webPreferences.contextIsolation).toBe(true);
    expect(webPreferences.nodeIntegration).toBe(false);
    expect(webPreferences.preload).toBeUndefined();
  });

  it('gives two attempts two distinct, non-persistent partitions', () => {
    createApplicationView('attempt-a');
    createApplicationView('attempt-b');
    const partitions = instances.map((i) => (i.options as { webPreferences: { partition: string } }).webPreferences.partition);
    expect(partitions).toEqual(['ovr-apply-attempt-a', 'ovr-apply-attempt-b']);
  });

  it('denies every permission request unconditionally', () => {
    createApplicationView('attempt-1');
    const record = instances[0]!;
    expect(record.permissionHandler).toBeDefined();
    const callback = vi.fn();
    record.permissionHandler!({}, 'notifications', callback);
    expect(callback).toHaveBeenCalledWith(false);
    callback.mockClear();
    record.permissionHandler!({}, 'clipboard-sanitized-write', callback);
    expect(callback).toHaveBeenCalledWith(false);
  });

  it('denies window.open / popups', () => {
    createApplicationView('attempt-1');
    const record = instances[0]!;
    expect(record.windowOpenHandler).toBeDefined();
    expect(record.windowOpenHandler!()).toEqual({ action: 'deny' });
  });

  it('attaches the CDP debugger lazily, on the first transport call, not at construction', () => {
    const applicationView = createApplicationView('attempt-1');
    const record = instances[0]!;
    expect(record.debug.attachCalls).toHaveLength(0);
    void applicationView.transport.sendCommand('DOM.getDocument', {});
    expect(record.debug.attachCalls).toEqual(['1.3']);
  });

  it('does not re-attach the debugger on a second transport call', async () => {
    const applicationView = createApplicationView('attempt-1');
    const record = instances[0]!;
    await applicationView.transport.sendCommand('DOM.getDocument', {});
    await applicationView.transport.sendCommand('DOM.focus', { nodeId: 1 });
    expect(record.debug.attachCalls).toHaveLength(1);
    expect(record.debug.sendCommandCalls).toEqual([
      { method: 'DOM.getDocument', params: {} },
      { method: 'DOM.focus', params: { nodeId: 1 } },
    ]);
  });

  it('re-attaches after an externally-fired detach (DevTools opened), on the next transport call', async () => {
    const applicationView = createApplicationView('attempt-1');
    const record = instances[0]!;
    await applicationView.transport.sendCommand('DOM.getDocument', {});
    expect(record.debug.attachCalls).toHaveLength(1);

    record.debug.simulateExternalDetach();
    await applicationView.transport.sendCommand('DOM.getDocument', {});
    expect(record.debug.attachCalls).toHaveLength(2);
  });

  it('show() attaches the view to the window and sizes it to the content bounds', () => {
    const applicationView = createApplicationView('attempt-1');
    const window = fakeWindow({ x: 0, y: 0, width: 1024, height: 768 });
    // Construction already sized the view once, for its hidden host window -- see this module's
    // own doc comment on why an unhosted `WebContentsView` doesn't work for real.
    expect(instances[0]!.setBoundsCalls).toEqual([{ x: 0, y: 0, width: 1024, height: 768 }]);
    applicationView.show(window);
    expect((window as unknown as { contentView: { addChildView: ReturnType<typeof vi.fn> } }).contentView.addChildView).toHaveBeenCalledWith(
      applicationView.view,
    );
    expect(instances[0]!.setBoundsCalls).toEqual([
      { x: 0, y: 0, width: 1024, height: 768 },
      { x: 0, y: 0, width: 1024, height: 768 },
    ]);
  });

  it('hide() detaches from the window it was shown in, and is a no-op if never shown', () => {
    const applicationView = createApplicationView('attempt-1');
    const window = fakeWindow();
    // No-op: never shown.
    applicationView.hide(window);
    expect((window as unknown as { contentView: { removeChildView: ReturnType<typeof vi.fn> } }).contentView.removeChildView).not.toHaveBeenCalled();

    applicationView.show(window);
    applicationView.hide(window);
    expect((window as unknown as { contentView: { removeChildView: ReturnType<typeof vi.fn> } }).contentView.removeChildView).toHaveBeenCalledWith(
      applicationView.view,
    );
  });

  it('hide() ignores a window it was not shown in', () => {
    const applicationView = createApplicationView('attempt-1');
    const shownIn = fakeWindow();
    const otherWindow = fakeWindow();
    applicationView.show(shownIn);
    applicationView.hide(otherWindow);
    expect((shownIn as unknown as { contentView: { removeChildView: ReturnType<typeof vi.fn> } }).contentView.removeChildView).not.toHaveBeenCalled();
  });

  it('destroy() detaches the debugger (if attached) and closes the webContents, and is idempotent', async () => {
    const applicationView = createApplicationView('attempt-1');
    const record = instances[0]!;
    await applicationView.transport.sendCommand('DOM.getDocument', {});

    applicationView.destroy();
    expect(record.debug.detachCalls).toBe(1);
    expect(record.closeCalls).toBe(1);

    // Idempotent: a second destroy() must not attempt a second detach (the fake debugger doesn't
    // throw on a redundant detach, but a real one legitimately can -- see this module's own
    // try/catch around detach() -- so the internal "attached" flag must already read false here).
    applicationView.destroy();
    expect(record.debug.detachCalls).toBe(1);
    expect(record.closeCalls).toBe(2);
  });

  it('destroy() never attempts a debugger detach when the transport was never used', () => {
    const applicationView = createApplicationView('attempt-1');
    const record = instances[0]!;
    applicationView.destroy();
    expect(record.debug.detachCalls).toBe(0);
    expect(record.closeCalls).toBe(1);
  });

  it('destroy() detaches from whatever window it was shown in', () => {
    const applicationView = createApplicationView('attempt-1');
    const window = fakeWindow();
    applicationView.show(window);
    applicationView.destroy();
    expect((window as unknown as { contentView: { removeChildView: ReturnType<typeof vi.fn> } }).contentView.removeChildView).toHaveBeenCalledWith(
      applicationView.view,
    );
  });

  it('creates a hidden host BaseWindow at construction and adds the view to it', () => {
    const applicationView = createApplicationView('attempt-1');
    expect(baseWindowInstances).toHaveLength(1);
    const host = baseWindowInstances[0]!;
    expect((host.options as { show?: boolean }).show).toBe(false);
    expect(host.addChildViewCalls).toEqual([applicationView.view]);
  });

  it('show() moves the view off the host window before adding it to the real one', () => {
    const applicationView = createApplicationView('attempt-1');
    const host = baseWindowInstances[0]!;
    const window = fakeWindow();
    applicationView.show(window);
    expect(host.removeChildViewCalls).toEqual([applicationView.view]);
  });

  it('hide() re-parents the view back onto the hidden host window', () => {
    const applicationView = createApplicationView('attempt-1');
    const host = baseWindowInstances[0]!;
    const window = fakeWindow();
    applicationView.show(window);
    applicationView.hide(window);
    // Once at construction, once again on hide().
    expect(host.addChildViewCalls).toEqual([applicationView.view, applicationView.view]);
  });

  it('destroy() also destroys the hidden host window', () => {
    const applicationView = createApplicationView('attempt-1');
    const host = baseWindowInstances[0]!;
    applicationView.destroy();
    expect(host.destroyCalls).toBe(1);
  });
});
