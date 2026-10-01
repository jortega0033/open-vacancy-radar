## Objective
Verify the sender frame on every Electron IPC handler, not just the three ADI-06 added, closing a real gap in the renderer trust boundary this repo has spent several tickets building.

## Why this is urgent, not speculative
Verified directly: this repo has 46 `ipcMain.handle` registrations across its seven preload namespaces (`agentDock`, `vacancyRadar`, `workspace`, `cv`, `system`, `workspaceGrant`, `agentWorkspace`), and only the three `workspaceGrant` handlers (built in ADI-06/13) bind and check `event.sender.id`/WebContents identity. Every other handler trusts that any IPC message on its channel came from the legitimate renderer, with no verification.

ADI-06 built an unusually careful workspace trust boundary specifically because a renderer-originated message can't be blindly trusted with filesystem/session authority -- but that boundary currently sits on top of an *unverified sender* for every OTHER channel. A compromised or malicious renderer context (e.g. via a supply-chain-compromised dependency loaded into a webview, or a devtools-open user pasting untrusted script) could, on any of the other 43 handlers, send a message indistinguishable from a legitimate one.

Upstream closed this generally (commit `5873f3f`, PR #70): an `ipc-sender-guard.ts`-equivalent wrapping every `ipcMain.handle` registration with a check that the message genuinely originates from the main window's top-level frame (`isFromMainWindowFrame`), not merely from *a* frame that happens to share the process. The same commit also hardened `allowed-external-url.ts` (absolute `https:` only, non-empty host, no embedded userinfo, rejecting UNC/bare paths) -- OVR's own `external-url.ts` currently allows `http:` in addition to `https:` and doesn't check for embedded userinfo, a smaller but related gap.

## Scope
- A new `apps/desktop/electron/ipc-sender-guard.ts` (or equivalent): a wrapper function verifying `event.senderFrame`/`event.sender` genuinely corresponds to the main window's top-level frame before an `ipcMain.handle` callback runs at all.
- Apply the wrapper to all 46 existing handler registrations across all seven namespaces in `main.ts` -- this should be a mechanical, low-risk change per-handler (wrap, don't rewrite the handler body), but the volume means it needs careful, systematic coverage, not a partial pass.
- Harden `apps/desktop/electron/external-url.ts` (or wherever the equivalent lives) to require `https:` only (not `http:`), a non-empty host, and reject embedded userinfo (`user:pass@host`) and UNC/bare-path forms, matching upstream's `allowed-external-url.ts`.

## Non-goals
Do not change any handler's actual business logic or the shape of its request/response -- this is purely an added verification layer in front of the existing dispatch, not a redesign of any individual IPC surface.

## Dependencies
None -- this wraps existing, already-shipped handlers.

## Acceptance criteria
- [ ] Every `ipcMain.handle` registration in the codebase is wrapped by the sender guard; a mechanical test (grepping for `ipcMain.handle` calls and confirming each is guarded) should exist so a future handler added without the wrapper fails a test rather than silently shipping unguarded.
- [ ] A message crafted to look like it came from a non-main-window frame is rejected before the handler's own logic runs, for a representative sample of handlers across all seven namespaces (not just `workspaceGrant`, which already has its own narrower check).
- [ ] `external-url.ts` rejects `http:`, embedded userinfo, and UNC/bare-path forms; only well-formed `https:` URLs with a non-empty host are allowed through.
- [ ] No legitimate, existing IPC call from the real renderer is broken by the added check -- the full existing test suite (preload, component, e2e) passes unchanged.

## Tests
A repo-wide mechanical test asserting every `ipcMain.handle(...)` call site is wrapped by the guard (grep-based or AST-based, matching this repo's existing exhaustiveness-check conventions from ADI-05/07). A unit test on the guard itself constructing a fake `IpcMainInvokeEvent`-shaped object with a non-main-window sender and confirming rejection. An `external-url.ts` test table covering `http:`, embedded userinfo, UNC paths, and bare paths as rejected, and a well-formed `https://host/path` as accepted.

## Rollback
Remove the wrapper from `main.ts`'s registrations; each handler reverts to its pre-this-ticket behavior. No persisted state depends on this.

## Stop conditions
Stop if the sender-verification check has any false-positive path that would reject a legitimate call from the app's own real renderer under any supported configuration (multiple windows, if any; a reload; a navigation within the app).

## Ownership and routing
Security Engineer, supported by Frontend Developer. Strongest reasoning model at high reasoning. Independent review required, given this is a trust-boundary change touching every IPC surface in the desktop app.
