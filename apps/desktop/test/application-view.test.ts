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
    get detachListenerCount(): number {
      return this.detachListeners.length;
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
    focusCalls: number;
    setBoundsCalls: unknown[];
    navigationListeners: Partial<Record<'will-navigate' | 'will-redirect', (event: { preventDefault: () => void }, url: string) => void>>;
    /** #277: the `before-input-event` handler that turns Escape into a way out of the handoff. */
    inputListener?: (event: unknown, input: { type: string; key: string }) => void;
    inputListenerCount: number;
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
      /** #277: the handoff moves keyboard focus into the live page. Writable, so a test can make it
       * throw the way a destroyed `webContents` really does. */
      focus: () => void;
      on: (event: string, listener: (...args: never[]) => void) => void;
    };
    setBounds: (bounds: unknown) => void;

    constructor(options: unknown) {
      const debug = new FakeDebugger();
      const record: (typeof instances)[number] = {
        options,
        debug,
        closeCalls: 0,
        focusCalls: 0,
        setBoundsCalls: [],
        navigationListeners: {},
        inputListenerCount: 0,
      };
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
        focus: () => {
          record.focusCalls += 1;
        },
        on: (event, listener) => {
          if (event === 'will-navigate' || event === 'will-redirect') {
            record.navigationListeners[event] = listener as (event: { preventDefault: () => void }, url: string) => void;
          }
          if (event === 'before-input-event') {
            record.inputListener = listener as (event: unknown, input: { type: string; key: string }) => void;
            record.inputListenerCount += 1;
          }
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

import { createApplicationView, HANDOFF_BANNER_HEIGHT_PX } from '../electron/application-view.js';

const ALLOW_ALL = () => true;

type Bounds = { x: number; y: number; width: number; height: number };

/** `bounds` may be a live getter, so a test can resize the window between calls the way a real one
 * does rather than only reporting the size it had when it was built. */
function fakeWindow(bounds: Bounds | (() => Bounds) = { x: 0, y: 0, width: 800, height: 600 }) {
  const addChildView = vi.fn();
  const removeChildView = vi.fn();
  /** Each registration keeps a link back to the function the caller passed, so `removeListener`
   * can find a `once` wrapper by the original -- the same indirection Node's own EventEmitter
   * uses, and the reason `removeListener(event, handler)` works for a `once(event, handler)`. */
  type Registration = { original: () => void; run: () => void };
  const listeners = new Map<string, Registration[]>();
  function register(event: string, registration: Registration): void {
    listeners.set(event, [...(listeners.get(event) ?? []), registration]);
  }
  return {
    contentView: { addChildView, removeChildView },
    getContentBounds: () => (typeof bounds === 'function' ? bounds() : bounds),
    webContents: { focus: vi.fn() },
    on: (event: string, listener: () => void) => register(event, { original: listener, run: listener }),
    // `once` really does stop firing after the first event, the same guarantee the real one gives.
    once: (event: string, listener: () => void) => {
      const registration: Registration = {
        original: listener,
        run: () => {
          listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== registration));
          listener();
        },
      };
      register(event, registration);
    },
    removeListener: (event: string, listener: () => void) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate.original !== listener));
    },
    /** Test-only. */
    emit: (event: string) => {
      for (const registration of [...(listeners.get(event) ?? [])]) registration.run();
    },
  } as never;
}

function emitWindowEvent(window: never, event: string): void {
  (window as unknown as { emit: (event: string) => void }).emit(event);
}

beforeEach(() => {
  instances.length = 0;
  baseWindowInstances.length = 0;
});

describe('createApplicationView', () => {
  it('gives the view a per-attempt, non-persistent, no-preload, sandboxed configuration', () => {
    createApplicationView('attempt-123', ALLOW_ALL);
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
    createApplicationView('attempt-a', ALLOW_ALL);
    createApplicationView('attempt-b', ALLOW_ALL);
    const partitions = instances.map((i) => (i.options as { webPreferences: { partition: string } }).webPreferences.partition);
    expect(partitions).toEqual(['ovr-apply-attempt-a', 'ovr-apply-attempt-b']);
  });

  it('denies every permission request unconditionally', () => {
    createApplicationView('attempt-1', ALLOW_ALL);
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
    createApplicationView('attempt-1', ALLOW_ALL);
    const record = instances[0]!;
    expect(record.windowOpenHandler).toBeDefined();
    expect(record.windowOpenHandler!()).toEqual({ action: 'deny' });
  });

  it('attaches the CDP debugger lazily, on the first transport call, not at construction', () => {
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const record = instances[0]!;
    expect(record.debug.attachCalls).toHaveLength(0);
    void applicationView.transport.sendCommand('DOM.getDocument', {});
    expect(record.debug.attachCalls).toEqual(['1.3']);
  });

  it('does not re-attach the debugger on a second transport call', async () => {
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
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
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const record = instances[0]!;
    await applicationView.transport.sendCommand('DOM.getDocument', {});
    expect(record.debug.attachCalls).toHaveLength(1);

    record.debug.simulateExternalDetach();
    await applicationView.transport.sendCommand('DOM.getDocument', {});
    expect(record.debug.attachCalls).toHaveLength(2);
  });

  it('show() attaches the view to the window and sizes it to the content bounds below the banner', () => {
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const window = fakeWindow({ x: 0, y: 0, width: 1024, height: 768 });
    // Construction already sized the view once, for its hidden host window -- see this module's
    // own doc comment on why an unhosted `WebContentsView` doesn't work for real.
    expect(instances[0]!.setBoundsCalls).toEqual([{ x: 0, y: 0, width: 1024, height: 768 }]);
    applicationView.show(window);
    expect((window as unknown as { contentView: { addChildView: ReturnType<typeof vi.fn> } }).contentView.addChildView).toHaveBeenCalledWith(
      applicationView.view,
    );
    // #277: the app keeps the top strip, so the view fills what is left rather than the whole window.
    expect(instances[0]!.setBoundsCalls).toEqual([
      { x: 0, y: 0, width: 1024, height: 768 },
      { x: 0, y: HANDOFF_BANNER_HEIGHT_PX, width: 1024, height: 768 - HANDOFF_BANNER_HEIGHT_PX },
    ]);
  });

  it('hide() detaches from the window it was shown in, and is a no-op if never shown', () => {
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
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
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const shownIn = fakeWindow();
    const otherWindow = fakeWindow();
    applicationView.show(shownIn);
    applicationView.hide(otherWindow);
    expect((shownIn as unknown as { contentView: { removeChildView: ReturnType<typeof vi.fn> } }).contentView.removeChildView).not.toHaveBeenCalled();
  });

  it('destroy() detaches the debugger (if attached) and closes the webContents, and is idempotent', async () => {
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
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
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const record = instances[0]!;
    applicationView.destroy();
    expect(record.debug.detachCalls).toBe(0);
    expect(record.closeCalls).toBe(1);
  });

  it('destroy() detaches from whatever window it was shown in', () => {
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const window = fakeWindow();
    applicationView.show(window);
    applicationView.destroy();
    expect((window as unknown as { contentView: { removeChildView: ReturnType<typeof vi.fn> } }).contentView.removeChildView).toHaveBeenCalledWith(
      applicationView.view,
    );
  });

  it('creates a hidden host BaseWindow at construction and adds the view to it', () => {
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    expect(baseWindowInstances).toHaveLength(1);
    const host = baseWindowInstances[0]!;
    expect((host.options as { show?: boolean }).show).toBe(false);
    expect(host.addChildViewCalls).toEqual([applicationView.view]);
  });

  it('show() moves the view off the host window before adding it to the real one', () => {
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const host = baseWindowInstances[0]!;
    const window = fakeWindow();
    applicationView.show(window);
    expect(host.removeChildViewCalls).toEqual([applicationView.view]);
  });

  it('hide() re-parents the view back onto the hidden host window', () => {
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const host = baseWindowInstances[0]!;
    const window = fakeWindow();
    applicationView.show(window);
    applicationView.hide(window);
    // Once at construction, once again on hide().
    expect(host.addChildViewCalls).toEqual([applicationView.view, applicationView.view]);
  });

  it('destroy() also destroys the hidden host window', () => {
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const host = baseWindowInstances[0]!;
    applicationView.destroy();
    expect(host.destroyCalls).toBe(1);
  });

  it('show() moves keyboard focus into the live page, which is what makes it a handoff (#277)', () => {
    // Without this the page renders but never receives a keystroke, which is useless for the two
    // things a handoff exists for: a CAPTCHA and a login.
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const window = fakeWindow();
    expect(instances[0]!.focusCalls).toBe(0);
    applicationView.show(window);
    expect(instances[0]!.focusCalls).toBe(1);
  });

  it('show() leaves an app-owned strip at the top that the target page cannot draw in (#277)', () => {
    // The live view renders above the app's own web contents. Covering the whole content area would
    // paint over the banner naming the employer and the way out of the handoff, leaving a
    // chrome-less third-party page with no app-owned pixel on screen to contradict it.
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const window = fakeWindow({ x: 0, y: 0, width: 1024, height: 768 });
    applicationView.show(window);
    expect(instances[0]!.setBoundsCalls.at(-1)).toEqual({
      x: 0,
      y: HANDOFF_BANNER_HEIGHT_PX,
      width: 1024,
      height: 768 - HANDOFF_BANNER_HEIGHT_PX,
    });
  });

  it('resizing the host window re-fits the live view, so it never sits at stale bounds', () => {
    // Stale bounds either clip the page or, worse, leave app UI exposed under an untrusted page.
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    let bounds = { x: 0, y: 0, width: 1024, height: 768 };
    const window = fakeWindow(() => bounds);
    applicationView.show(window);

    bounds = { x: 0, y: 0, width: 640, height: 480 };
    emitWindowEvent(window, 'resize');
    expect(instances[0]!.setBoundsCalls.at(-1)).toEqual({
      x: 0,
      y: HANDOFF_BANNER_HEIGHT_PX,
      width: 640,
      height: 480 - HANDOFF_BANNER_HEIGHT_PX,
    });

    // And it stops listening once hidden, rather than re-fitting for the rest of the view's life.
    applicationView.hide(window);
    const callsAfterHide = instances[0]!.setBoundsCalls.length;
    emitWindowEvent(window, 'resize');
    expect(instances[0]!.setBoundsCalls).toHaveLength(callsAfterHide);
  });

  it('Escape inside the live page calls the caller\'s way out, before the page sees the key', () => {
    // The only exit that does not depend on the page cooperating: a keyboard user focused inside
    // the live page cannot Tab back to the app's own banner button, and a page can swallow keys.
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const window = fakeWindow();
    const onEscape = vi.fn();
    applicationView.show(window, onEscape);

    instances[0]!.inputListener!({}, { type: 'keyDown', key: 'a' });
    expect(onEscape).not.toHaveBeenCalled();
    instances[0]!.inputListener!({}, { type: 'keyUp', key: 'Escape' });
    expect(onEscape).not.toHaveBeenCalled(); // keyUp is not the gesture

    instances[0]!.inputListener!({}, { type: 'keyDown', key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);

    // And it stops mattering once hidden, so a later Escape cannot re-enter a closed handoff.
    applicationView.hide(window);
    instances[0]!.inputListener!({}, { type: 'keyDown', key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('registers exactly one before-input-event listener for the view\'s whole lifetime', () => {
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const window = fakeWindow();
    applicationView.show(window, vi.fn());
    applicationView.hide(window);
    applicationView.show(window, vi.fn());
    expect(instances[0]!.inputListenerCount).toBe(1);
  });

  it('a host window closed under a live handoff is forgotten, never removed from twice', () => {
    // macOS: close all windows, then `activate` builds a *new* main window. Without this,
    // `destroy()` would later call removeChildView on a destroyed BrowserWindow.
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const window = fakeWindow();
    applicationView.show(window);
    emitWindowEvent(window, 'closed');
    expect(applicationView.shownIn()).toBeUndefined();

    applicationView.destroy();
    expect((window as unknown as { contentView: { removeChildView: ReturnType<typeof vi.fn> } }).contentView.removeChildView).not.toHaveBeenCalled();
  });

  it('hide() gives focus back to the app rather than leaving nothing focused', () => {
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const window = fakeWindow();
    applicationView.show(window);
    applicationView.hide(window);
    expect((window as unknown as { webContents: { focus: ReturnType<typeof vi.fn> } }).webContents.focus).toHaveBeenCalledTimes(1);
  });

  it('a webContents that throws on focus never takes the whole handoff down with it', () => {
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const window = fakeWindow();
    // A destroyed or closing `webContents` throws on `focus()`. The view must still be attached.
    const view = applicationView.view as unknown as { webContents: { focus: () => void } };
    view.webContents.focus = () => {
      throw new Error('Object has been destroyed');
    };
    expect(() => applicationView.show(window)).not.toThrow();
    expect((window as unknown as { contentView: { addChildView: ReturnType<typeof vi.fn> } }).contentView.addChildView).toHaveBeenCalled();
  });

  it('shownIn() reports which window holds the view, so one attempt can tell it is not the shown one', () => {
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const window = fakeWindow();
    expect(applicationView.shownIn()).toBeUndefined();
    applicationView.show(window);
    expect(applicationView.shownIn()).toBe(window);
    applicationView.hide(window);
    expect(applicationView.shownIn()).toBeUndefined();
  });

  it('registers exactly one debugger detach listener at construction, never a second on reattach', async () => {
    // Real gap this test guards against: the listener used to be (re)registered inside the lazy
    // attach path, so an external detach followed by a reattach added a second listener with
    // nothing ever removing the first -- unbounded growth over repeated cycles.
    const applicationView = createApplicationView('attempt-1', ALLOW_ALL);
    const record = instances[0]!;
    await applicationView.transport.sendCommand('DOM.getDocument', {});
    record.debug.simulateExternalDetach();
    await applicationView.transport.sendCommand('DOM.getDocument', {});
    record.debug.simulateExternalDetach();
    await applicationView.transport.sendCommand('DOM.getDocument', {});

    expect(record.debug.attachCalls).toHaveLength(3);
    expect(record.debug.detachListenerCount).toBe(1);
  });

  it('will-navigate is denied (and reported) for a URL isUrlAllowed rejects, allowed otherwise', () => {
    const onBlocked = vi.fn();
    createApplicationView('attempt-1', (url: string) => url === 'https://allowed.example/apply', onBlocked);
    const record = instances[0]!;
    const listener = record.navigationListeners['will-navigate'];
    expect(listener).toBeDefined();

    const allowedEvent = { preventDefault: vi.fn() };
    listener!(allowedEvent, 'https://allowed.example/apply');
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled();
    expect(onBlocked).not.toHaveBeenCalled();

    const blockedEvent = { preventDefault: vi.fn() };
    listener!(blockedEvent, 'https://attacker.example/apply');
    expect(blockedEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledWith('https://attacker.example/apply');
  });

  it('will-redirect is denied the same way as will-navigate', () => {
    const onBlocked = vi.fn();
    createApplicationView('attempt-1', (url: string) => url === 'https://allowed.example/apply', onBlocked);
    const record = instances[0]!;
    const listener = record.navigationListeners['will-redirect'];
    expect(listener).toBeDefined();

    const event = { preventDefault: vi.fn() };
    listener!(event, 'https://redirected-elsewhere.example/');
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledWith('https://redirected-elsewhere.example/');
  });

  it('onBlockedNavigation is optional: a missing callback never throws when a navigation is denied', () => {
    createApplicationView('attempt-1', () => false);
    const record = instances[0]!;
    const listener = record.navigationListeners['will-navigate']!;
    const event = { preventDefault: vi.fn() };
    expect(() => listener(event, 'https://anything.example/')).not.toThrow();
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });
});
