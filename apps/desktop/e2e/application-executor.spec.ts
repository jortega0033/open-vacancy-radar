import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from './fixtures.js';

/**
 * Drives `self.applicationExecutor` (issue #201) through a real Electron `WebContentsView` and a
 * real `webContents.debugger` CDP session, against the local, test-only fixture form
 * (`fixtures/ashby-application-form.html`) -- never a real employer-hosted page (see that fixture's
 * own header comment and `application-target-policies.ts`'s `FIXTURE_REVIEW_POLICY`).
 *
 * `packages/application-executor`'s own suite proves the executor/validator logic against a fake
 * CDP transport; `application-view.test.ts` and `application-review-session.test.ts` prove the
 * Electron wiring against a mocked `electron`. This is the one layer neither can reach: a real CDP
 * connection actually reading and mutating a real Chromium-rendered DOM.
 */
const FIXTURE_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ashby-application-form.html')).href;
const POLICY_ID = 'ashby-fixture-test-only';

test.describe('applicationExecutor (#201)', () => {
  test('opens a real review, snapshots every fillable field, fills/selects them, and never submits', async ({ window }) => {
    const attemptId = randomUUID();

    const opened = await window.evaluate(
      async ({ attemptId, policyId, targetUrl }) => self.applicationExecutor.openReview({ attemptId, policyId, targetUrl }),
      { attemptId, policyId: POLICY_ID, targetUrl: FIXTURE_URL },
    );

    // Real DOM extraction over a real CDP connection: 11 fillable controls (4 text-like inputs,
    // 1 select, 3 radios, 1 file, 1 textarea, 1 checkbox) -- the fixture's hidden honeypot input
    // must not appear at all.
    expect(opened.snapshot.fields).toHaveLength(11);
    expect(opened.snapshot.fields.some((f) => f.label === 'referralSource')).toBe(false);
    expect(opened.screenshotBase64.length).toBeGreaterThan(100);

    const byLabel = (label: string) => {
      const field = opened.snapshot.fields.find((f) => f.label === label);
      if (!field) throw new Error(`fixture field "${label}" not found in snapshot`);
      return field;
    };

    // The consent checkbox is structurally excluded, over a real CDP-extracted DOM -- proving the
    // classification regex actually runs against real browser-rendered attributes, not just the
    // hand-built fixture trees packages/application-executor's own tests use.
    expect(byLabel('agreeToTerms').classification).toBe('consent_field');

    const fullName = byLabel('fullName');
    const email = byLabel('email');
    const phone = byLabel('phone');
    const linkedIn = byLabel('linkedInUrl');
    const coverLetter = byLabel('coverLetter');
    const workAuth = byLabel('workAuthorization');
    const yesOption = workAuth.options?.find((o) => o.label === 'Yes');
    if (!yesOption) throw new Error('fixture "Yes" option not found on workAuthorization');
    const resume = byLabel('resume');
    const consent = byLabel('agreeToTerms');
    const radios = opened.snapshot.fields.filter((f) => f.label === 'workArrangement');
    expect(radios).toHaveLength(3);

    const valueTable = [
      { valueRef: 'v0000000000000001', value: 'Ada Lovelace', provenance: 'profile' as const },
      { valueRef: 'v0000000000000002', value: 'ada@example.com', provenance: 'cv' as const },
      { valueRef: 'v0000000000000003', value: '+1 555 0100', provenance: 'profile' as const },
      { valueRef: 'v0000000000000004', value: 'https://linkedin.com/in/ada', provenance: 'profile' as const },
      { valueRef: 'v0000000000000005', value: 'I would love to join this team.', provenance: 'user_answer' as const },
    ];

    const applied = await window.evaluate(
      async (input) => self.applicationExecutor.applyFieldMap(input),
      {
        attemptId,
        valueTable,
        fieldMap: {
          attemptId,
          snapshotGeneration: opened.snapshot.generation,
          assignments: [
            { fieldRef: fullName.fieldRef, source: { kind: 'value', valueRef: 'v0000000000000001' } },
            { fieldRef: email.fieldRef, source: { kind: 'value', valueRef: 'v0000000000000002' } },
            { fieldRef: phone.fieldRef, source: { kind: 'value', valueRef: 'v0000000000000003' } },
            { fieldRef: linkedIn.fieldRef, source: { kind: 'value', valueRef: 'v0000000000000004' } },
            { fieldRef: coverLetter.fieldRef, source: { kind: 'value', valueRef: 'v0000000000000005' } },
            { fieldRef: workAuth.fieldRef, source: { kind: 'option', optionRef: yesOption.optionRef } },
          ],
          // Real applicant-tracking forms always have at least one field this executor cannot or
          // must not fill on its own (a file upload, a radio group v1 doesn't group, a consent
          // checkbox) -- rule 9 requires every one of them be explicitly accounted for here, never
          // silently absent.
          unmapped: [
            { fieldRef: resume.fieldRef, reason: 'needs_user' },
            { fieldRef: consent.fieldRef, reason: 'consent_field' },
            ...radios.map((radio) => ({ fieldRef: radio.fieldRef, reason: 'needs_user' as const })),
          ],
        },
      },
    );

    expect(applied).toEqual({ ok: true, appliedCount: 6 });

    // Nothing here ever calls a submit action -- there is no such channel, and no such method on
    // `ApplicationExecutor` at all (see packages/application-executor/src/target-policy.ts's
    // `ExecutorAction` type). The one and only way this review ends is the explicit close below.
    await window.evaluate(async (attemptId) => self.applicationExecutor.closeReview(attemptId), attemptId);

    // The attempt id is free to reopen, proving close() actually released it rather than merely
    // detaching the CDP session.
    const reopened = await window.evaluate(
      async ({ attemptId, policyId, targetUrl }) => self.applicationExecutor.openReview({ attemptId, policyId, targetUrl }),
      { attemptId, policyId: POLICY_ID, targetUrl: FIXTURE_URL },
    );
    expect(reopened.snapshot.fields).toHaveLength(11);
    await window.evaluate(async (attemptId) => self.applicationExecutor.closeReview(attemptId), attemptId);
  });

  test('refuses to navigate a real review outside the resolved policy origin allowlist', async ({ window }) => {
    const attemptId = randomUUID();
    await expect(
      window.evaluate(
        async ({ attemptId, policyId }) =>
          self.applicationExecutor.openReview({ attemptId, policyId, targetUrl: 'https://not-the-fixture.example/apply' }),
        { attemptId, policyId: POLICY_ID },
      ),
    ).rejects.toThrow(/not allowed by policy/);
  });

  test('refuses an unknown policy id before ever opening a browser view', async ({ window }) => {
    const attemptId = randomUUID();
    await expect(
      window.evaluate(
        async ({ attemptId, targetUrl }) =>
          self.applicationExecutor.openReview({ attemptId, policyId: 'not-a-real-policy', targetUrl }),
        { attemptId, targetUrl: FIXTURE_URL },
      ),
    ).rejects.toThrow(/unknown application target policy/);
  });

  test('refuses an arbitrary local file:// URL even under a policy that allows a different local file', async ({ window }) => {
    // Regression test for a real gap found in #201's review: every file:// URL's origin serializes
    // to the same literal string "null" (WHATWG URL spec), so an origin-only allowlist check would
    // let ANY local file through once one file:// target was permitted. `exactFileUrls` checks the
    // full URL instead -- this proves it against a real Electron process, not just a unit test.
    const OTHER_LOCAL_FILE_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'not-a-target.html')).href;
    const attemptId = randomUUID();
    await expect(
      window.evaluate(
        async ({ attemptId, policyId, targetUrl }) => self.applicationExecutor.openReview({ attemptId, policyId, targetUrl }),
        { attemptId, policyId: POLICY_ID, targetUrl: OTHER_LOCAL_FILE_URL },
      ),
    ).rejects.toThrow(/not allowed by policy/);
  });

  test('blocks a real same-tab, script-driven navigation to an off-policy local file', async ({ window }) => {
    // Regression test for the other real gap #201's review found: openTarget only checks the URL
    // once, before its own Page.navigate call -- nothing re-validated a same-tab redirect or a
    // page-driven navigation afterward. This fixture's own script fires `location.href` to an
    // unlisted local file as soon as it loads; if application-view.ts's `will-navigate` guard
    // didn't block it, the browser would actually leave this page.
    const REDIRECT_ATTEMPT_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'redirect-attempt.html')).href;
    const attemptId = randomUUID();

    const opened = await window.evaluate(
      async ({ attemptId, policyId, targetUrl }) => self.applicationExecutor.openReview({ attemptId, policyId, targetUrl }),
      { attemptId, policyId: POLICY_ID, targetUrl: REDIRECT_ATTEMPT_URL },
    );

    const fieldLabels = opened.snapshot.fields.map((f) => f.label);
    expect(fieldLabels).toContain('onRedirectAttemptPage');
    expect(fieldLabels).not.toContain('onNotATargetPage');

    await window.evaluate(async (attemptId) => self.applicationExecutor.closeReview(attemptId), attemptId);
  });
});
