import type { IpcMainInvokeEvent } from 'electron';

/**
 * Sender verification for every `ipcMain.handle` channel (ADI-16).
 *
 * ## The gap this closes
 *
 * `ipcMain.handle(channel, listener)` is process-global: it answers **any** frame in **any**
 * `WebContents` this process hosts. Before this module, only the three `workspace-grant:*` channels
 * and `workspace:start-session` looked at who was calling, and even they only used `event.sender.id`
 * to bind a *grant* to a `WebContents` -- an authorization check on a handle, not an authentication
 * check on the caller. Every one of the other forty-two channels ran its body for whatever frame
 * happened to invoke it: an `<iframe>`, a `<webview>`, a devtools-hosted page, a child window some
 * future edit opens. Several of those channels write the user's databases, open native dialogs, and
 * write files to disk.
 *
 * That is a trust-boundary bug rather than a theoretical one, because the whole point of ADI-06/07/13
 * is that the *renderer* is the untrusted side of this process boundary. A boundary that carefully
 * refuses to tell the renderer a filesystem path, while accepting `system:save-file` from any frame
 * that can reach the channel, is only half a boundary.
 *
 * ## What "the main window's own top-level frame" means here, concretely
 *
 * Two conditions, both required, checked in `isFromMainWindowFrame` below:
 *
 *  1. **The right `WebContents`.** `event.sender.id` must equal the id captured when `createWindow()`
 *     built the app's one window. This is the same mechanism, and the same reasoning, the ADI-06
 *     grant channels already used: `WebContents.id` is assigned by Electron in the main process and
 *     is not something a renderer can set, forge, or send. A second window, a `<webview>` (which is
 *     its own `WebContents`), and the devtools' own page all fail here.
 *
 *  2. **The top-level frame of that `WebContents`, not merely *a* frame inside it.** `event.senderFrame`
 *     is Electron's per-frame attribution -- available since the `WebFrameMain` API landed, and
 *     present in this app's Electron 44 (see `IpcMainInvokeEvent.senderFrame` in electron.d.ts). It
 *     must be the frame whose `frameTreeNodeId` matches `event.sender.mainFrame`'s, and it must have
 *     no parent. `frameTreeNodeId` is the identity to compare on rather than object identity or
 *     `routingId`: Electron's own docs describe it as browser-global, fixed at frame creation, and
 *     constant for the frame's lifetime, whereas `WebFrameMain` *instances* are re-created across a
 *     cross-process navigation and `routingId` is only unique within one renderer process.
 *
 * Condition 2 is why this does not stop at `event.sender.id`. `sender.id` alone answers "which
 * WebContents", and a subframe of the main window shares its parent's `WebContents`. This app sets
 * `nodeIntegrationInSubFrames: false` (the default) so a subframe has no preload bridge today, but
 * "today's Electron flag" is exactly the kind of thing a later edit changes without reading this
 * file -- and `senderFrame` costs one comparison.
 *
 * ## Fail-closed, deliberately
 *
 * Anything the check cannot positively confirm is a rejection: no window recorded yet, a null
 * `senderFrame` (Electron returns null once the frame has navigated away or been destroyed), a
 * `WebContents` that throws on property access because it is being torn down. None of those states
 * can produce a *legitimate* answer -- there is no live page waiting for one -- so refusing costs
 * nothing and guessing would cost the whole check.
 *
 * ## Why this is a registrar and not a per-handler wrapper
 *
 * `createGuardedIpc(ipcMain, ...)` returns an object with the same `handle(channel, listener)` shape
 * `ipcMain` has, so applying it to all forty-six call sites in main.ts was renaming the receiver, not
 * rewriting forty-six handler bodies -- and `registerAgentWorkspaceHandlers` (ADI-07), which already
 * took its registrar as a parameter, is covered by being handed this one instead of `ipcMain`.
 * `test/ipc-sender-guard.test.ts` then has a single, mechanical thing to assert: that `ipcMain.handle`
 * appears nowhere in `electron/`, so a handler added later without the guard fails a test rather
 * than shipping unverified.
 */

/**
 * The part of Electron's `WebFrameMain` this check reads.
 *
 * Structural rather than an `import type { WebFrameMain }` so a unit test can build a fake event
 * without an Electron runtime, exactly as `agent-workspace-ipc.ts` narrows `ipcMain` to the one
 * method it uses. `WebFrameMain` is assignable to it.
 */
export interface SenderFrameIdentity {
  /** Browser-global, fixed at frame creation, constant for the frame's lifetime. */
  readonly frameTreeNodeId: number;
  /** `null` exactly when this frame is the top frame of its hierarchy. */
  readonly parent: unknown;
}

/** The part of Electron's `WebContents` this check reads. */
export interface SenderWebContentsIdentity {
  readonly id: number;
  readonly mainFrame: SenderFrameIdentity | null | undefined;
}

/**
 * The part of Electron's `IpcMainInvokeEvent` this check reads. `IpcMainInvokeEvent` is assignable
 * to it, which is what lets `createGuardedIpc` hand the real event straight through.
 */
export interface GuardedInvokeEvent {
  readonly sender: SenderWebContentsIdentity | null | undefined;
  readonly senderFrame: SenderFrameIdentity | null | undefined;
}

/**
 * The one message a rejected caller ever sees. Fixed text: a refusal must not describe what the
 * check looked at, and this string crosses back to the (untrusted) renderer as a rejected promise.
 */
export const IPC_SENDER_REJECTED_MESSAGE = 'this channel is not available to this sender';

/** Thrown in place of running a handler whose sender could not be verified. */
export class IpcSenderRejectedError extends Error {
  constructor(readonly channel: string) {
    super(IPC_SENDER_REJECTED_MESSAGE);
    this.name = 'IpcSenderRejectedError';
  }
}

/**
 * Whether `event` genuinely came from the top-level frame of the main window's `WebContents`.
 *
 * `expectedWebContentsId` is the id captured at window creation; `undefined` means no window has
 * been created (or the one that was has been destroyed), which is a rejection rather than a
 * wildcard. Never throws: every property read here can throw on a `WebContents` mid-teardown, and a
 * guard that throws a *different* error than its own refusal would leak which branch it reached.
 */
export function isFromMainWindowFrame(
  event: GuardedInvokeEvent,
  expectedWebContentsId: number | undefined,
): boolean {
  if (typeof expectedWebContentsId !== 'number') return false;

  try {
    // 1. The right WebContents. Assigned in this process; a renderer cannot claim a different one.
    const sender = event.sender;
    if (!sender || typeof sender.id !== 'number' || sender.id !== expectedWebContentsId) return false;

    // 2a. A frame Electron can still attribute the message to. Null once the frame navigated away
    //     or was destroyed -- states in which no live page is waiting for an answer.
    const senderFrame = event.senderFrame;
    if (!senderFrame || typeof senderFrame.frameTreeNodeId !== 'number') return false;

    // 2b. A top-level frame, not a subframe. Checked twice, on two independent facts: a top frame
    //     has no parent, and it is the WebContents' own `mainFrame`. Either alone would do; both
    //     together mean a future Electron change to one of them cannot silently widen this.
    if (senderFrame.parent !== null && senderFrame.parent !== undefined) return false;

    const mainFrame = sender.mainFrame;
    if (!mainFrame || typeof mainFrame.frameTreeNodeId !== 'number') return false;

    // Read fresh at dispatch, never captured: a cross-process navigation replaces the WebFrameMain
    // instance, so a captured reference would start rejecting the real renderer after a reload.
    return senderFrame.frameTreeNodeId === mainFrame.frameTreeNodeId;
  } catch {
    // A `WebContents` being torn down throws on property access. Fail closed.
    return false;
  }
}

export interface IpcSenderGuardDeps {
  /**
   * The main window's `WebContents` id, read fresh on every invocation rather than captured, so a
   * window that is recreated (macOS `activate`) or destroyed is reflected immediately. `undefined`
   * before the first window exists, and again after it is gone.
   */
  mainWindowWebContentsId: () => number | undefined;
  /** Called on every rejection, for logging. Must not throw; must not receive the payload. */
  onRejected?: (info: { channel: string }) => void;
}

/** An `ipcMain.handle` listener, in the shape `ipcMain.handle` itself declares. */
export type IpcInvokeListener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/** The one method of `ipcMain` this module needs, named so a test can pass a stub. */
export interface IpcHandleTarget {
  handle(channel: string, listener: IpcInvokeListener): void;
}

/**
 * A private brand with no runtime representation -- it exists only so `GuardedIpcHandle` cannot be
 * satisfied structurally. `IpcHandleTarget`/`IpcHandleRegistrar`-shaped objects are otherwise
 * interchangeable to TypeScript (both are just `{ handle(channel, listener): void }`), which means a
 * future module that takes an "ipc registrar" parameter and is wired to raw `ipcMain` by mistake would
 * typecheck fine and pass a name-based test that only checks which identifier was used at the call
 * site. Requiring this brand turns that mistake into a compile error instead: only the object
 * `createGuardedIpc` actually returns carries it, so passing anything else -- `ipcMain` included --
 * fails to typecheck, with no test needed to catch it.
 */
declare const guardedIpcBrand: unique symbol;

/** The object `createGuardedIpc` returns. Require this type, not `IpcHandleTarget`, wherever a
 * registration must go through the sender guard -- see the brand's own comment for why. */
export type GuardedIpcHandle = IpcHandleTarget & { readonly [guardedIpcBrand]: true };

/**
 * Wraps one listener so `isFromMainWindowFrame` runs **before** it, and the listener does not run at
 * all when the check fails.
 *
 * Exported on its own (rather than only through `createGuardedIpc`) so the guard's own unit test can
 * exercise the decision directly, and so a future one-off registration outside the registrar has a
 * supported way to be guarded.
 */
export function guardIpcListener(
  channel: string,
  listener: IpcInvokeListener,
  deps: IpcSenderGuardDeps,
): IpcInvokeListener {
  return function guardedListener(event: IpcMainInvokeEvent, ...args: unknown[]): unknown {
    if (!isFromMainWindowFrame(event, deps.mainWindowWebContentsId())) {
      deps.onRejected?.({ channel });
      // Throwing rather than returning `undefined`: `ipcMain.handle` turns a throw into a rejected
      // promise in the renderer, whereas `undefined` would arrive looking like a successful empty
      // answer and flow on into code that cannot tell the two apart.
      throw new IpcSenderRejectedError(channel);
    }
    return listener(event, ...args);
  };
}

/**
 * `ipcMain`, with sender verification in front of every registration made through it.
 *
 * Deliberately the same `handle(channel, listener)` shape as `ipcMain` and as ADI-07's
 * `IpcHandleRegistrar`, so main.ts's registrations and `registerAgentWorkspaceHandlers` both take it
 * with no other change.
 */
export function createGuardedIpc(ipc: IpcHandleTarget, deps: IpcSenderGuardDeps): GuardedIpcHandle {
  // The cast is the one place this brand is minted: nothing else in this codebase may claim to
  // produce a `GuardedIpcHandle`, since the entire point is that only real output of this function
  // carries it (see the brand's own doc comment on why that matters).
  return {
    handle(channel: string, listener: IpcInvokeListener): void {
      ipc.handle(channel, guardIpcListener(channel, listener, deps));
    },
  } as GuardedIpcHandle;
}
