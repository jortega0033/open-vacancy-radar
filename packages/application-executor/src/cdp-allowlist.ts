/**
 * The frozen CDP method allowlist (#196 §4.4): every Chrome DevTools Protocol method the executor
 * may ever send, and nothing else. A constant, not a builder, comparable by identity -- the same
 * discipline `CLAUDE_HARDENING_ARGS` in `packages/agent-runtime/src/providers/claude/build-args.ts`
 * already applies to a different privileged surface, for the same reason: no caller can compose a
 * weaker or wider set, because there is no input that produces one.
 *
 * `DOM.*`/`Accessibility.*` build a real field snapshot from structured data, not injected
 * JavaScript -- stronger than the usual browser-automation approach, not merely equivalent.
 * `Input.*` dispatches real input/key/mouse events, so React-controlled fields respond correctly.
 * `Page.navigate`/`captureScreenshot`/`getFrameTree` cover the `openTarget`/`capture` actions and
 * iframe traversal. Nothing here can execute arbitrary script, read network traffic, touch
 * storage, or attach to a different target.
 */
export const ALLOWED_CDP_METHODS: readonly string[] = Object.freeze([
  'DOM.getDocument',
  'DOM.querySelectorAll',
  'DOM.getAttributes',
  'DOM.describeNode',
  'DOM.getBoxModel',
  'DOM.focus',
  'DOM.setFileInputFiles',
  'Accessibility.getFullAXTree',
  'Input.insertText',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Page.navigate',
  'Page.captureScreenshot',
  'Page.getFrameTree',
]);

/**
 * Method name prefixes (domains) that are structurally denied in their entirety, regardless of
 * the specific method -- listed explicitly, rather than left as "everything `ALLOWED_CDP_METHODS`
 * doesn't mention," so the exclusion of the single most load-bearing domain (`Runtime`, which is
 * what makes every other control on this list decorative if it leaks through) is a named,
 * reviewable fact rather than an implication.
 *
 * This file deliberately never writes the domain name directly adjacent to the word "evaluate" in
 * a quoted form (bare or unquoted prose mentions, like the previous sentence, are fine) -- see this
 * package's own prohibition test in test/cdp-allowlist.test.ts, which scans production source for
 * exactly that combination.
 */
export const DENIED_CDP_DOMAINS: readonly string[] = Object.freeze([
  'Runtime',
  'Network',
  'Fetch',
  'Storage',
  'Target',
  'Browser',
  'Emulation',
  'Debugger',
  'Security',
]);

export function isAllowedCdpMethod(method: string): boolean {
  return (ALLOWED_CDP_METHODS as readonly string[]).includes(method);
}

export class CdpMethodNotAllowedError extends Error {
  constructor(public readonly method: string) {
    super(`CDP method "${method}" is not on the executor's allowlist`);
    this.name = 'CdpMethodNotAllowedError';
  }
}

/** Throws unless `method` is exactly one of `ALLOWED_CDP_METHODS`. Every call site that ultimately
 * reaches a real CDP transport goes through this first -- see `executor.ts`. */
export function assertAllowedCdpMethod(method: string): void {
  if (!isAllowedCdpMethod(method)) throw new CdpMethodNotAllowedError(method);
}
