/**
 * Compiled per-ATS policy (#196 §6.1), mirroring `McpProviderPolicy`'s shape and the reasoning
 * behind it: "compiled reviewed policies, fixed endpoints/tools/arguments" per #128's own
 * language. A `readonly ApplicationTargetPolicy[]` lives in application code, reviewed in a PR --
 * never JSON, never a settings screen, never an environment variable, never a database row. This
 * package defines the shape only; the actual compiled list of targets belongs to the app that
 * consumes this package; issue #197's terms register is the evidence base each entry cites.
 */

export type ExecutorAction = 'openTarget' | 'snapshot' | 'fill' | 'select' | 'attach' | 'capture' | 'handoff';
/*
 * `submit` is deliberately not a member of `ExecutorAction` at all -- not "excluded by an unset
 * kill switch," absent from the type. #196 §9's first approval condition is that no submit code
 * path exists in this slice's build, not even behind a flag; the type system is one more place
 * that condition holds, since adding it back would be a visible, reviewable diff to this file.
 */

export interface ApplicationTargetPolicy {
  id: string;
  displayName: string;
  /** Exact origins only. No wildcard, no suffix matching -- the same rule `will-navigate` already
   * applies elsewhere in this app by comparing real origins, never `startsWith`. */
  origins: readonly string[];
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
  maxSteps: number;
  timeoutMs: number;
  maximumSnapshotBytes: number;
}

/** Whether `origin` is one of `policy.origins`, by exact match. No normalization beyond what
 * `URL` itself does (trailing slash, case) -- a policy author writes the origin exactly as the
 * target actually serves it. */
export function isOriginAllowed(policy: ApplicationTargetPolicy, origin: string): boolean {
  return policy.origins.includes(origin);
}

export function isActionAllowed(policy: ApplicationTargetPolicy, action: ExecutorAction): boolean {
  if (action === 'fill' && policy.killSwitches.fill) return false;
  if (action === 'attach' && policy.killSwitches.upload) return false;
  if (action === 'openTarget' && policy.killSwitches.navigate) return false;
  return policy.allowedActions.includes(action);
}
