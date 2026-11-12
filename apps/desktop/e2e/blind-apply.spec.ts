import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from './fixtures.js';

/**
 * Blind Apply (#722) against the real built app and a real Chromium-rendered DOM.
 *
 * What this layer proves that the unit suites cannot: the bridge the renderer actually gets, and that the
 * three synthetic fixture pages are read by a real CDP connection into the labels, challenge flag and
 * option lists the exact-label rules depend on. Everything is a local file:// fixture or an empty
 * throwaway workspace: no employer is contacted, no real CV or profile exists, no native dialog is shown.
 *
 * The send itself, the Stop boundary, duplicate/closed handling and restart recovery are proven against
 * the real runner, store and review session in `test/blind-apply-runner.test.ts` and
 * `test/application-review-session.test.ts`: the preparation step needs an AI session that a throwaway
 * e2e workspace does not have.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const url = (name: string) => pathToFileURL(join(FIXTURES, name)).href;
const POLICY_ID = 'ashby-fixture-test-only';

test.describe('Blind Apply (#722)', () => {
  test('the bridge is exactly the fixed surface, off by default, and supports no real site', async ({ window }) => {
    const surface = await window.evaluate(() => Object.keys(self.blindApply).sort());
    expect(surface).toEqual(['answer', 'enable', 'evidence', 'feed', 'open', 'status', 'stop']);

    const status = await window.evaluate(() => self.blindApply.status());
    expect(status.active).toBe(false);
    expect(status.authorization).toBeNull();
    // Honest about coverage: only the local test form can receive anything in this build.
    expect(status.supported.real).toEqual([]);
    expect(status.supported.testOnly).toHaveLength(1);
    expect(await window.evaluate(() => self.blindApply.feed())).toEqual([]);
  });

  test('cannot be turned on without a CV and profile, and a Stop with nothing on does nothing', async ({ window }) => {
    // Refused before any dialog is built: nothing to confirm, nothing recorded.
    const enabled = await window.evaluate(() => self.blindApply.enable());
    expect(enabled.ok).toBe(false);
    expect(await window.evaluate(() => self.blindApply.stop())).toEqual({ stopped: false, itemsStopped: 0 });
    expect((await window.evaluate(() => self.blindApply.status())).active).toBe(false);
  });

  test('has no way to name a filter, a policy or a limit', async ({ window }) => {
    expect(await window.evaluate(() => self.blindApply.enable.length)).toBe(0);
    const unknown = await window.evaluate(() => self.blindApply.evidence('no-such-item'));
    expect(unknown).toBeNull();
    const answer = await window.evaluate(() => self.blindApply.answer({ itemId: 'no-such-item', answers: [], remember: true }));
    expect(answer).toEqual({ ok: false, reason: 'not_waiting' });
    const open = await window.evaluate(() => self.blindApply.open('no-such-item'));
    expect(open).toEqual({ ok: false, reason: 'not_openable' });
  });

  test('the supported fixture is read by real Chromium into the labels the exact-label rules expect', async ({ window }) => {
    const opened = await window.evaluate(
      async ({ attemptId, policyId, targetUrl }) => self.applicationExecutor.openReview({ attemptId, policyId, targetUrl }),
      { attemptId: randomUUID(), policyId: POLICY_ID, targetUrl: url('blind-apply-supported-form.html') },
    );
    expect(opened.snapshot.challengeDetected).toBe(false);
    const labels = opened.snapshot.fields.map((field) => field.label.replace(/\s*\*\s*$/u, '').trim());
    expect(labels).toEqual(expect.arrayContaining(['Full name', 'Email address', 'Phone number', 'Current location', 'Preferred work arrangement', 'Resume']));
    const arrangement = opened.snapshot.fields.find((field) => field.label.startsWith('Preferred work arrangement'));
    expect(arrangement?.controlType).toBe('select');
    expect(arrangement?.options?.map((option) => option.label)).toEqual(['Select one', 'Remote', 'Hybrid', 'On-site']);
    expect(opened.snapshot.submitControls).toHaveLength(1);
  });

  test('the missing-answer fixture shows two required questions no stored detail answers', async ({ window }) => {
    const opened = await window.evaluate(
      async ({ attemptId, policyId, targetUrl }) => self.applicationExecutor.openReview({ attemptId, policyId, targetUrl }),
      { attemptId: randomUUID(), policyId: POLICY_ID, targetUrl: url('blind-apply-missing-answer-form.html') },
    );
    const required = opened.snapshot.fields.filter((field) => field.required).map((field) => field.label.replace(/\s*\*\s*$/u, '').trim());
    expect(required).toEqual(expect.arrayContaining(['Highest level of education', 'Years of experience with React']));
  });

  test('the bot-check fixture is flagged as a challenge by real Chromium', async ({ window }) => {
    const opened = await window.evaluate(
      async ({ attemptId, policyId, targetUrl }) => self.applicationExecutor.openReview({ attemptId, policyId, targetUrl }),
      { attemptId: randomUUID(), policyId: POLICY_ID, targetUrl: url('blind-apply-captcha-form.html') },
    );
    expect(opened.snapshot.challengeDetected).toBe(true);
  });
});
