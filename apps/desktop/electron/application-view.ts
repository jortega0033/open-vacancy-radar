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

/**
 * How much of the host window's height a shown handoff leaves to the app itself (#277).
 *
 * The live view is a chrome-less surface showing a third-party page, and it renders *above* the
 * app's own web contents. If it covered the whole content area, two things would follow, both bad:
 * the app's own "you are on the live application page for X at Y" banner and its exit control would
 * be painted over, and a page that drew a convincing imitation of this app's UI (a credential
 * prompt, say) would be indistinguishable from the real thing, with no app-owned pixel left on
 * screen to contradict it. Reserving this strip means there is always a region the target page
 * cannot draw in, carrying an answer to "what am I looking at?" that comes from this app's own
 * workspace record, plus a way out that does not depend on the page cooperating.
 */
export const HANDOFF_BANNER_HEIGHT_PX = 56;

export interface ApplicationView {
  view: WebContentsView;
  transport: CdpTransport;
  /**
   * Attaches the isolated view to `window`'s content view, below a reserved app-owned banner strip
   * (`HANDOFF_BANNER_HEIGHT_PX`), and moves keyboard focus into it, so the person can actually see
   * and *type into* the real page during a handoff.
   *
   * Focus is the part that makes this a handoff rather than a picture (#277): a re-parented
   * `WebContentsView` renders immediately but does not take keyboard focus on its own, so a person
   * asked to solve a CAPTCHA or sign in would have found a page that draws but does not accept
   * typing. `hide()` gives focus back to the host window.
   *
   * `onEscape`, if given, is called when the person presses Escape inside the live page. It is the
   * one way out of the handoff that does not depend on the page: the reserved strip carries a real
   * button too, but a keyboard user whose focus is inside the page cannot Tab out of it, and a page
   * is perfectly capable of swallowing every other key. Escape is observed at the Electron layer
   * (`before-input-event`), before the page sees it.
   */
  show(window: BrowserWindow, onEscape?: () => void): void;
  /** Detaches the view from whatever window it was shown in, if any. Safe to call when not shown. */
  hide(window: BrowserWindow): void;
  /** Which window this view is currently shown in, or `undefined` when it is parked on its own
   * hidden host. Lets the caller tell "this attempt has the handoff" from "some other attempt does"
   * without keeping a second copy of that fact that could drift from this one. */
  shownIn(): BrowserWindow | undefined;
  /** Detaches the CDP debugger and destroys the underlying `WebContents`. Idempotent. */
  destroy(): void;
}

/**
 * Creates one isolated view for `attemptId`. Not shown/attached to any window until `show()` is
 * called -- the executor's normal operation (snapshot/fill/select/attach/capture) needs no visible
 * window at all, only a `webContents` to send CDP commands to.
 *
 * `isUrlAllowed` is the *runtime* half of #196 §1.1's "any navigation to an unlisted origin
 * produces a handoff, never a followed redirect" rule. `ApplicationExecutor.openTarget()` (in
 * `@agent-dock/application-executor`) only checks a URL once, before the CDP `Page.navigate` call
 * it issues itself -- it has no way to observe a same-tab redirect or a page-driven navigation
 * (a link click, a script setting `location.href`) after that, because its `CdpTransport` is
 * request/response only. This is where that gap is closed instead: `will-navigate` and
 * `will-redirect` fire for every navigation attempt on this view regardless of what triggered it,
 * and are the only Electron-level hooks that can `preventDefault()` one before it takes effect.
 * `onBlockedNavigation`, if given, is called (never thrown from) whenever one is blocked, so a
 * caller can record or surface a real handoff-worthy event -- see `HandoffReason.off_policy_navigation`
 * in `@agent-dock/application-executor`.
 */
export function createApplicationView(
  attemptId: string,
  isUrlAllowed: (url: string) => boolean,
  onBlockedNavigation?: (url: string) => void,
): ApplicationView {
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

  function guardNavigation(event: Electron.Event, url: string): void {
    if (isUrlAllowed(url)) return;
    event.preventDefault();
    onBlockedNavigation?.(url);
  }
  view.webContents.on('will-navigate', guardNavigation);
  view.webContents.on('will-redirect', guardNavigation);

  const hostWindow = new BaseWindow({ show: false, width: 1024, height: 768 });
  hostWindow.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });

  let attachedTo: BrowserWindow | undefined;
  let debuggerAttached = false;
  /** Set while shown, so the window's own `resize`/`closed` events can act on the live handoff
   * without either of them needing to know how it was started. */
  let onEscapeWhileShown: (() => void) | undefined;

  /** Sizes the view to fill `window`'s content area below the reserved banner strip. Recomputed on
   * every resize: a view left at stale bounds either clips the page or, worse, leaves app UI
   * exposed underneath an untrusted page's own rendering. */
  function fitToWindow(window: BrowserWindow): void {
    const bounds = window.getContentBounds();
    view.setBounds({
      x: 0,
      y: HANDOFF_BANNER_HEIGHT_PX,
      width: bounds.width,
      height: Math.max(0, bounds.height - HANDOFF_BANNER_HEIGHT_PX),
    });
  }

  // Registered once for the view's whole lifetime, for the same reason the debugger's `detach`
  // listener is: a listener added per `show()` would accumulate one closure per handoff with
  // nothing ever removing it. It does nothing unless a handoff is actually on screen.
  view.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') onEscapeWhileShown?.();
  });

  function handleHostResize(): void {
    if (attachedTo) fitToWindow(attachedTo);
  }

  /** The host window went away while the handoff was on screen (macOS "close all windows", then
   * `activate` builds a *new* window). Forgetting it here is what stops `hide()`/`destroy()` from
   * later calling `removeChildView` on a destroyed `BrowserWindow`. */
  function handleHostClosed(): void {
    attachedTo = undefined;
    onEscapeWhileShown = undefined;
  }

  // Registered once, unconditionally -- not inside `ensureDebuggerAttached` below, which runs on
  // every reattach after an external detach (DevTools opened, renderer crash). A `.on('detach', ...)`
  // call inside that function would add a new listener on every such cycle with nothing ever
  // removing the previous one, leaking one closure per cycle (confirmed as a real gap during #201's
  // review). This flag-flip has no per-attachment state to close over, so one listener for the
  // view's whole lifetime is all it ever needs.
  view.webContents.debugger.on('detach', () => {
    debuggerAttached = false;
  });

  function ensureDebuggerAttached(): void {
    if (debuggerAttached) return;
    // A detach we did not initiate (DevTools invoked on this view, or the OS killed the renderer)
    // is terminal for the executor using this transport -- there is nothing more this view can do
    // until a new one is created. The caller observes this via `webContents.debugger.isAttached()`
    // going false.
    view.webContents.debugger.attach('1.3');
    debuggerAttached = true;
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
    show(window, onEscape) {
      hostWindow.contentView.removeChildView(view);
      window.contentView.addChildView(view);
      attachedTo = window;
      onEscapeWhileShown = onEscape;
      fitToWindow(window);
      // A window that is resized (or closed) while a handoff is on screen. `once` for `closed`,
      // because that window is gone for good; `on` for `resize`, removed again in `hide()`.
      window.on('resize', handleHostResize);
      window.once('closed', handleHostClosed);
      // Without this the page renders but never receives a keystroke, which is useless for the two
      // things a handoff exists for (a CAPTCHA, a login). Guarded because a destroyed or
      // already-closing `webContents` throws on `focus()`, and a handoff failing to focus must
      // never take the whole review down with it.
      try {
        view.webContents.focus();
      } catch {
        // The view is going away; there is nothing to focus and nothing to clean up.
      }
    },
    hide(window) {
      if (attachedTo === window) {
        window.removeListener('resize', handleHostResize);
        window.removeListener('closed', handleHostClosed);
        window.contentView.removeChildView(view);
        hostWindow.contentView.addChildView(view);
        view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
        attachedTo = undefined;
        onEscapeWhileShown = undefined;
        // Focus followed the view in `show()`; hand it back rather than leaving the app with no
        // focused surface at all.
        try {
          window.webContents.focus();
        } catch {
          // The window is closing -- nothing to return focus to.
        }
      }
    },
    shownIn() {
      return attachedTo;
    },
    destroy() {
      if (attachedTo) {
        attachedTo.removeListener('resize', handleHostResize);
        attachedTo.removeListener('closed', handleHostClosed);
        attachedTo.contentView.removeChildView(view);
        attachedTo = undefined;
        onEscapeWhileShown = undefined;
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
