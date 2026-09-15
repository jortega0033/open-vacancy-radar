/**
 * Compiled per-ATS policy (#196 §6.1), mirroring `McpProviderPolicy`'s shape and the reasoning
 * behind it: "compiled reviewed policies, fixed endpoints/tools/arguments" per #128's own
 * language. A `readonly ApplicationTargetPolicy[]` lives in application code, reviewed in a PR --
 * never JSON, never a settings screen, never an environment variable, never a database row. This
 * package defines the shape only; the actual compiled list of targets belongs to the app that
 * consumes this package; issue #197's terms register is the evidence base each entry cites.
 */

export type ExecutorAction = 'openTarget' | 'snapshot' | 'fill' | 'select' | 'attach' | 'capture' | 'handoff' | 'submit';
/*
 * `submit` was deliberately absent from this type through #201 (#196 §9's first approval
 * condition: no submit code path in that slice's build, not even behind a flag) -- adding it back
 * is itself the visible, reviewable diff that condition was written to require. It is real now
 * (#202), but the executor package still enforces only its own structural half of the safety
 * story: this action is off by default (`killSwitches.submit`), a policy must name it in
 * `allowedActions` to compile it in at all, and `executor.ts`'s `submit()` only ever clicks a
 * control `submit-control.ts`'s `resolveSubmitControl` unambiguously identified -- it never
 * guesses among candidates. None of that is a substitute for the actual safety property: the
 * *caller* (the main-process orchestration, not this package) is what must never invoke `submit`
 * except immediately after a specific human's explicit, per-instance confirmation of that exact
 * filled application. An automatic-mode unlock (a platform earning the right to skip that
 * per-instance confirmation after a tracked run of prior successful manual ones) is a decision the
 * orchestrator makes, never this package -- `ApplicationExecutor` has no concept of "automatic".
 */

export interface ApplicationTargetPolicy {
  id: string;
  displayName: string;
  /** Exact origins only. No wildcard, no suffix matching -- the same rule `will-navigate` already
   * applies elsewhere in this app by comparing real origins, never `startsWith`. Meaningless for a
   * `file://` target: every `file://` URL's origin serializes to the same literal string `"null"`
   * (WHATWG URL spec), so `origins` alone cannot scope such a target to one specific file -- use
   * `exactFileUrls` for that case instead. A real http(s) policy leaves `exactFileUrls` empty. */
  origins: readonly string[];
  /** Exact `file://` URLs this policy allows, checked instead of `origins` when the target URL's
   * scheme is `file:`. Local/fixture-testing only (issue #201's own fixture policy is the only
   * real user of this today) -- a real employer target is never `file://`. */
  exactFileUrls?: readonly string[];
  /**
   * Sub-frame origins this policy authorizes a *field fill* into, beyond the target's own
   * `origins`. Empty (absent) by default, and deliberately separate from `origins`: navigating the
   * top-level view to an origin and typing an applicant's real answers into a third party's
   * embedded widget are different grants, and the second one is the dangerous one.
   *
   * The case this exists for is the legitimate one -- an employer page that hosts its actual
   * application form in an ATS vendor's iframe, where refusing every cross-origin frame outright
   * would make the target permanently unfillable. Everything else a real careers page embeds (a
   * chat widget, a cookie-consent banner, a job-alert signup, an ad) is a third party whose fields
   * carry perfectly ordinary labels, and `Input.insertText` fires real DOM events that such a
   * widget's own script reads live -- so a wrong-frame fill hands real answers to code the target
   * site does not control. Like every other field on this shape, an entry here is a reviewed code
   * change to a compiled policy, never configuration.
   */
  allowedSubFrameOrigins?: readonly string[];
  adapter: string;
  termsRegisterEntry: string;
  termsVersion: string;
  /** YYYY-MM-DD */
  termsReviewedAt: string;
  allowedActions: readonly ExecutorAction[];
  uploadConstraints: { maxBytes: number; mimeTypes: readonly string[] };
  rateLimits: { perDay: number; perEmployerPerDay: number; minIntervalMs: number };
  /**
   * `submit` stays in this shape (unlike `ExecutorAction` above) so a future policy can compile it
   * in explicitly, defaulting `false` here -- #196 §9's sixth approval condition: a target reaches
   * submit-capable only by a reviewed code change to its own policy entry, never configuration.
   */
  killSwitches: { navigate: boolean; fill: boolean; upload: boolean; submit: boolean };
  /**
   * Issue #203 scope item 6: automatic (unattended) submission may run only against a target whose
   * own register entry (`termsRegisterEntry`) reaches a clean, unconditional `eligible_for_review`
   * in #197's register, WITH no live caveat left unresolved (a documented CAPTCHA/bot-scoring risk,
   * an unresolved terms-scope question) -- the register's status column is not by itself a safe
   * allow-list token, per that register's own findings. This field is the one place that whole
   * judgment call is recorded: `true` only when a human reviewer has confirmed, for this exact
   * policy entry, that no caveat remains. No default -- every policy, including the fixture, must
   * set this explicitly rather than inherit a value that could silently authorize automation.
   * Deliberately has no bearing on manual (#202) submission, which every target already requires
   * regardless of this flag.
   */
  termsEligibleForAutomation: boolean;
  maxSteps: number;
  /** The bound `executor.ts`'s `send()` races every individual CDP call against (`withTimeout`),
   * so a target whose page stops answering (a hung navigation, a renderer wedged behind a modal
   * CDP itself never reports) fails the in-flight step with an `ExecutorTimeoutError` rather than
   * leaving the caller awaiting a command that may never resolve. Per-call, not per-attempt: a
   * multi-step attempt that legitimately takes longer than this in total is not itself timed out,
   * only a single CDP round trip that individually exceeds it. */
  timeoutMs: number;
  maximumSnapshotBytes: number;
}

/**
 * Whether `url` is allowed to navigate to under `policy` -- the real check `openTarget` (and, at
 * the Electron layer, every subsequent same-tab navigation/redirect) must pass. For a `file:` URL
 * this checks the *exact* URL against `policy.exactFileUrls`, never `policy.origins`: origin-only
 * matching would let any `file://` URL through, since they all share the same opaque origin
 * (confirmed against a real Electron process during #201's review -- see this function's own git
 * history). For every other scheme, this is the exact-origin check `origins` has always been.
 */
export function isNavigationAllowed(policy: ApplicationTargetPolicy, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'file:') {
    return (policy.exactFileUrls ?? []).includes(url);
  }
  return policy.origins.includes(parsed.origin);
}

/**
 * Whether a field living in a frame whose origin is `frameOrigin` may be written to at all, given
 * the top document's own origin. The companion to `isNavigationAllowed` above and deliberately not
 * the same check: that one answers "may the view go here?", this one answers "may an applicant's
 * real answer be typed into this particular document?" -- a question nothing in this package used
 * to ask, so the frame holding the most fields won the active-form contest on field count and
 * geometry alone, no matter whose document it was.
 *
 * The four ways a frame passes, in order:
 *
 *  - Its origin is unknown (`undefined`). That is not a permissive guess: `dom-extract.ts` returns
 *    `undefined` only when nothing in the read distinguished this frame's origin from its
 *    embedder's -- an `<iframe>` with no `src`, an `<iframe srcdoc>`, a relative `src`, or a
 *    hand-built tree carrying no URLs at all. Every one of those genuinely *is* the embedder's
 *    origin, and refusing them would break same-origin pages to no benefit.
 *  - It matches the top document's own origin, the ordinary same-origin frame.
 *  - It is one of the policy's own `origins`. Those are the origins a human reviewer already
 *    authorized this target to span, in code, in a PR -- a frame served from one of them is the
 *    target's own content, not a third party.
 *  - It is explicitly listed in `allowedSubFrameOrigins`, the narrow grant described on that field.
 *
 * An opaque origin (`"null"`, what a `data:` or sandboxed document serializes to) is refused before
 * any of that: an opaque origin is not same-origin with anything, including another document whose
 * origin serializes to the same four characters, so comparing it by string equality would be a bug
 * dressed as a check.
 */
export function isFrameFillAllowed(
  policy: ApplicationTargetPolicy,
  topFrameOrigin: string | undefined,
  frameOrigin: string | undefined,
): boolean {
  if (frameOrigin === undefined) return true;
  if (frameOrigin === 'null') return false;
  if (topFrameOrigin !== undefined && frameOrigin === topFrameOrigin) return true;
  if (policy.origins.includes(frameOrigin)) return true;
  return (policy.allowedSubFrameOrigins ?? []).includes(frameOrigin);
}

export function isActionAllowed(policy: ApplicationTargetPolicy, action: ExecutorAction): boolean {
  if (action === 'fill' && policy.killSwitches.fill) return false;
  if (action === 'attach' && policy.killSwitches.upload) return false;
  if (action === 'openTarget' && policy.killSwitches.navigate) return false;
  if (action === 'submit' && policy.killSwitches.submit) return false;
  return policy.allowedActions.includes(action);
}
