import { BaseWindow, WebContentsView, type BrowserWindow } from 'electron';
import type { CdpTransport } from '@agent-dock/application-executor';

/**
 * The isolated browser surface the executor drives (#196 §4, #201). One `WebContentsView` per
 * attempt, in a dedicated non-persistent session partition, with no preload and every permission
 * request denied -- the same isolation posture as `application-artifact-staging.ts`'s offscreen
 * `BrowserWindow` for `printToPDF`, tightened further since this one loads real employer pages
 * rather than only this app's own HTML.
 *
 * `WebContentsView` (not `BrowserWindow`) is used deliberately: it is a plain content surface with
 * no window chrome of its own, meant to be attached to (and detached from) the main window's
 * `contentView` on demand -- exactly the shape a handoff needs ("show the live view only when the
 * user must see it"), without a second top-level OS window the user could lose track of.
 *
 * A `WebContentsView` with no parent `contentView` at all was verified, against a real Electron
 * process (`e2e/application-executor.spec.ts`), to fail real navigation/CDP commands with "target
 * closed while handling command" -- its `webContents` needs an actual native window hosting it to
 * keep the renderer alive, even while nothing is meant to be visible. `hostWindow` below is that
 * host: a `BaseWindow` (no `webContents` of its own, unlike `BrowserWindow`), created `show:
 * false` and never shown, that owns the view for its whole lifetime except while a real handoff
 * has re-parented it onto the app's own visible main window.
 */

export interface ApplicationView {
  view: WebContentsView;
  transport: CdpTransport;
  /** Attaches the isolated view to `window`'s content view, covering it, so the user can see and
   * interact with the real page during a handoff. */
  show(window: BrowserWindow): void;
  /** Detaches the view from whatever window it was shown in, if any. Safe to call when not shown. */
  hide(window: BrowserWindow): void;
  /** Detaches the CDP debugger and destroys the underlying `WebContents`. Idempotent. */
  destroy(): void;
}

/**
 * Creates one isolated view for `attemptId`. Not shown/attached to any window until `show()` is
 * called -- the executor's normal operation (snapshot/fill/select/attach/capture) needs no visible
 * window at all, only a `webContents` to send CDP commands to.
 */
export function createApplicationView(attemptId: string): ApplicationView {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A fresh, non-persistent partition per attempt: nothing this view stores (cookies, cache,
      // localStorage) survives past this attempt, and it is never the same session the app's own
      // window uses, so an employer page can never see this app's own cookies or vice versa.
      partition: `ovr-apply-${attemptId}`,
      // No preload, deliberately: this view never runs any of this app's own renderer code, only
      // whatever the target page itself serves.
    },
  });

  // Deny everything. This view never legitimately needs camera, microphone, geolocation,
  // notifications, or clipboard access -- it is filled and read entirely over CDP.
  view.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  // No child windows, no `window.open` popups escaping the isolated view.
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const hostWindow = new BaseWindow({ show: false, width: 1024, height: 768 });
  hostWindow.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });

  let attachedTo: BrowserWindow | undefined;
  let debuggerAttached = false;

  function ensureDebuggerAttached(): void {
    if (debuggerAttached) return;
    view.webContents.debugger.attach('1.3');
    debuggerAttached = true;
    // A detach we did not initiate (DevTools invoked on this view, or the OS killed the renderer)
    // is terminal for the executor using this transport -- there is nothing more this view can do
    // until a new one is created. The caller observes this via `webContents.debugger.isAttached()`
    // going false; this handler's only job is to keep the local flag honest.
    view.webContents.debugger.on('detach', () => {
      debuggerAttached = false;
    });
  }

  const transport: CdpTransport = {
    async sendCommand(method, params) {
      ensureDebuggerAttached();
      return view.webContents.debugger.sendCommand(method, params);
    },
  };

  return {
    view,
    transport,
    show(window) {
      hostWindow.contentView.removeChildView(view);
      window.contentView.addChildView(view);
      const bounds = window.getContentBounds();
      view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
      attachedTo = window;
    },
    hide(window) {
      if (attachedTo === window) {
        window.contentView.removeChildView(view);
        hostWindow.contentView.addChildView(view);
        view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
        attachedTo = undefined;
      }
    },
    destroy() {
      if (attachedTo) {
        attachedTo.contentView.removeChildView(view);
        attachedTo = undefined;
      }
      if (debuggerAttached) {
        try {
          view.webContents.debugger.detach();
        } catch {
          // Already detached (e.g. the 'detach' event already fired) -- nothing left to clean up.
        }
        debuggerAttached = false;
      }
      view.webContents.close();
      hostWindow.destroy();
    },
  };
}
