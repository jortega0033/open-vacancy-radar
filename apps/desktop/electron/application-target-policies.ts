import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
 * pointing the executor at an actual employer-hosted page.
 *
 * `exactFileUrls`, not `origins`, is what scopes this to that one file: every `file://` URL's
 * origin serializes to the same literal string `"null"` (WHATWG URL spec), so an `origins: ['null']`
 * entry -- this policy's original shape, confirmed as a real gap during #201's review against a
 * live Electron process -- would match ANY local file, not just the fixture. `exactFileUrls` checks
 * the full URL instead, and is computed relative to this file's own location so it can never
 * resolve to a path outside this repo's `e2e/fixtures/` folder.
 */
function fixtureUrl(fileName: string): string {
  return pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'e2e', 'fixtures', fileName)).href;
}

const FIXTURE_FORM_URL = fixtureUrl('ashby-application-form.html');
/** Deliberately allowlisted despite immediately trying to redirect itself off-policy -- it exists
 * to prove the runtime navigation guard, not to be a real target. See its own file header comment
 * and `not-a-target.html`, its (deliberately unlisted) redirect destination. */
const REDIRECT_ATTEMPT_URL = fixtureUrl('redirect-attempt.html');

export const FIXTURE_REVIEW_POLICY: ApplicationTargetPolicy = {
  id: 'ashby-fixture-test-only',
  displayName: 'Local fixture form (test-only, not a real target)',
  origins: [],
  exactFileUrls: [FIXTURE_FORM_URL, REDIRECT_ATTEMPT_URL],
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
