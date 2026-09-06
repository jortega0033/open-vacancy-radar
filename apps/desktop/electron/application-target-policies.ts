import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isNavigationAllowed, type ApplicationTargetPolicy } from '@agent-dock/application-executor';

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
  // 'submit' is enabled here deliberately, unlike a real policy would be by default (#196 SS9):
  // this policy can never resolve to a real employer page regardless of allowedActions/killSwitches
  // (exactFileUrls-only, origins empty -- see this file's own header comment), so there is no real
  // submission this enables. It exists so issue #202's orchestration (application-review-session.ts's
  // submitApplicationReview) has a genuine end-to-end fixture path to test the whole
  // fill -> review -> confirm -> submit flow against, per that issue's own acceptance criteria.
  allowedActions: ['openTarget', 'snapshot', 'fill', 'select', 'attach', 'capture', 'handoff', 'submit'],
  uploadConstraints: { maxBytes: 10 * 1024 * 1024, mimeTypes: ['application/pdf'] },
  rateLimits: { perDay: 1000, perEmployerPerDay: 1000, minIntervalMs: 0 },
  killSwitches: { navigate: false, fill: false, upload: false, submit: false },
  // Same reasoning as 'submit' above: `true` here authorizes nothing real, since this policy can
  // never resolve to an actual employer page. It exists so issue #203's automatic-mode orchestration
  // has a genuine end-to-end fixture path to test against. No real policy gets this without a named
  // human reviewer confirming its #197 register entry has no live caveat left -- see this field's
  // own doc comment on `ApplicationTargetPolicy`.
  termsEligibleForAutomation: true,
  maxSteps: 100,
  timeoutMs: 60_000,
  maximumSnapshotBytes: 2 * 1024 * 1024,
};

const APPLICATION_TARGET_POLICIES: readonly ApplicationTargetPolicy[] = [FIXTURE_REVIEW_POLICY];

export function resolveApplicationTargetPolicy(policyId: string): ApplicationTargetPolicy | undefined {
  return APPLICATION_TARGET_POLICIES.find((policy) => policy.id === policyId);
}

/**
 * Which compiled policy (if any) governs `url`, found the same way `isNavigationAllowed` itself
 * checks -- so this can never claim a policy applies to a URL that policy would then refuse to
 * navigate to. An `ApplicationAttemptRecord` carries a `canonicalUrl` but no `policyId` field of
 * its own (#198's schema predates any real target existing to reference); this is how a caller
 * that only has the URL -- the review UI, primarily -- finds the right policy to open a review
 * with, without this app needing a whole separate URL-to-policy mapping table for what is, today,
 * a single fixture entry. Returns `undefined` for any URL no compiled policy covers, which is
 * every real (non-fixture) URL today -- see this file's own header comment on why.
 */
export function resolvePolicyIdForCanonicalUrl(url: string): string | undefined {
  return APPLICATION_TARGET_POLICIES.find((policy) => isNavigationAllowed(policy, url))?.id;
}
