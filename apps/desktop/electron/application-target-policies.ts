import type { ApplicationTargetPolicy } from '@agent-dock/application-executor';

/**
 * The compiled `ApplicationTargetPolicy` table (#196 §6.1, issue #201). Per that interface's own
 * doc comment: "a `readonly ApplicationTargetPolicy[]` lives in application code, reviewed in a
 * PR -- never JSON, never a settings screen, never an environment variable, never a database row."
 * `resolveApplicationTargetPolicy` is the only way any caller (IPC handler included) ever reaches
 * one of these; there is no path from renderer input to a policy object that did not already exist
 * in this file before the app was built.
 *
 * As of #197's terms-of-service register (docs/application-target-evidence.md), no real
 * applicant-tracking system was found cleanly eligible for automated interaction -- Ashby
 * specifically is `insufficient_evidence`. The one entry below is therefore NOT a real, live
 * target: it is the local, file://-only fixture form (e2e/fixtures/ashby-application-form.html)
 * that exercises this executor for real over a genuine CDP connection, without this app ever
 * pointing the executor at an actual employer-hosted page. `origins: ['null']` is not a typo --
 * every `file://` URL's origin serializes to the literal string `"null"` (WHATWG URL spec), which
 * is also why this policy can never match a real `https://` target by accident.
 */
export const FIXTURE_REVIEW_POLICY: ApplicationTargetPolicy = {
  id: 'ashby-fixture-test-only',
  displayName: 'Local fixture form (test-only, not a real target)',
  origins: ['null'],
  adapter: 'generic-html-form',
  termsRegisterEntry: 'ashby',
  termsVersion: 'n/a (local fixture, not a live target)',
  termsReviewedAt: '2026-01-01',
  allowedActions: ['openTarget', 'snapshot', 'fill', 'select', 'attach', 'capture', 'handoff'],
  uploadConstraints: { maxBytes: 10 * 1024 * 1024, mimeTypes: ['application/pdf'] },
  rateLimits: { perDay: 1000, perEmployerPerDay: 1000, minIntervalMs: 0 },
  killSwitches: { navigate: false, fill: false, upload: false, submit: true },
  maxSteps: 100,
  timeoutMs: 60_000,
  maximumSnapshotBytes: 2 * 1024 * 1024,
};

const APPLICATION_TARGET_POLICIES: readonly ApplicationTargetPolicy[] = [FIXTURE_REVIEW_POLICY];

export function resolveApplicationTargetPolicy(policyId: string): ApplicationTargetPolicy | undefined {
  return APPLICATION_TARGET_POLICIES.find((policy) => policy.id === policyId);
}
