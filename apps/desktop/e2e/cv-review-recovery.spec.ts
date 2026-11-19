import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ensureLightTheme, goto, launchApp } from './fixtures.js';
import { APPLY_COMPANY, APPLY_ROLE } from './apply-workspace-seed.js';
import {
  RECOVERY_CV_NAME,
  RECOVERY_LANGUAGES,
  RECOVERY_SKILLS,
  REVIEW_REQUIRED_DETAIL,
  seedCvReviewRecovery,
  type SeededRecovery,
} from './seed-cv-review-recovery.js';

/**
 * #756 / #757 in the real built app, with synthetic data and no AI tool installed: Apply on a CV
 * whose preparation stopped for want of a review offers the review in place, keeps the selected
 * application, restarts preparation only after Save (never after Cancel), and the CV the pipeline
 * renders keeps its Skills and Languages sections. Nothing can reach a real employer: the link is
 * on the reserved `.invalid` domain and the app never submits for a manual target.
 */

interface AttemptView {
  checkpoint: string;
  checkpointDetail: string;
  tailoringMode: string;
}

async function readAttempt(window: Page, attemptId: string): Promise<AttemptView> {
  return window.evaluate(async (id) => {
    const bridge = (window as unknown as { workspace: { getApplicationAttempt(id: string): Promise<AttemptView> } }).workspace;
    const attempt = await bridge.getApplicationAttempt(id);
    return { checkpoint: attempt.checkpoint, checkpointDetail: attempt.checkpointDetail, tailoringMode: attempt.tailoringMode };
  }, attemptId);
}

async function openApplyWorkspace(window: Page) {
  const sidebar = window.getByRole('complementary', { name: 'Main' });
  await sidebar.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(window.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
  await window.getByRole('button', { name: 'Apply', exact: true }).click();
  const workspace = window.getByRole('region', { name: `${APPLY_ROLE} at ${APPLY_COMPANY}` });
  await expect(workspace).toBeVisible();
  return workspace;
}

async function withApp(
  seeded: SeededRecovery,
  appId: string,
  body: (electronApp: ElectronApplication, window: Page) => Promise<void>,
): Promise<void> {
  try {
    const electronApp = await launchApp(seeded.userDataDir, { appId, vacancyEngineDataRoot: seeded.vacancyEngineDataRoot });
    try {
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      await ensureLightTheme(window);
      await body(electronApp, window);
    } finally {
      await electronApp.close();
    }
  } finally {
    await seeded.cleanup();
  }
}

/** Waits for the restarted preparation to settle on its next needs-user stop and returns it. */
async function waitForSettled(window: Page, attemptId: string, previousDetail: string): Promise<AttemptView> {
  // Leaving the old stop (queued/preparing) and arriving at the new one can happen between two
  // polls, so only the new stop itself is awaited.
  await expect
    .poll(
      async () => {
        const attempt = await readAttempt(window, attemptId);
        return attempt.checkpoint === 'needs_user' && attempt.checkpointDetail !== previousDetail ? attempt.checkpointDetail : '';
      },
      { timeout: 90_000 },
    )
    .not.toBe('');
  return readAttempt(window, attemptId);
}

test('Apply offers Review this CV in place; Cancel changes nothing, Save restarts preparation for the same job', async () => {
  test.setTimeout(240_000);
  const seeded = await seedCvReviewRecovery('ovr-cv-review-recovery');
  await withApp(seeded, `ovr-e2e-cv-review-${process.pid}`, async (_electronApp, window) => {
    const workspace = await openApplyWorkspace(window);

    // The one-line reason, the one button that fixes it, and no futile retry.
    await expect(workspace.getByText('Your CV has not been reviewed yet, so it could not be tailored.')).toBeVisible();
    await expect(workspace.getByRole('status').first()).toContainText('Your CV needs a review before it can be tailored.');
    const review = workspace.getByRole('button', { name: 'Review this CV' });
    await expect(review).toBeVisible();
    await expect(workspace.getByRole('button', { name: /try again/i })).toHaveCount(0);
    await expect(workspace.getByRole('button', { name: 'Use my CV as it is' })).toBeVisible();

    // Cancel: the review closes, the application is still selected and untouched.
    await review.click();
    const drawer = window.getByRole('dialog', { name: 'Edit CV' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Redwood Software', { exact: false })).toBeVisible();
    await expect(drawer.getByLabel('Skills')).toHaveValue(RECOVERY_SKILLS.join(', '));
    await expect(drawer.getByLabel('Languages')).toHaveValue(RECOVERY_LANGUAGES);
    // One Location field, not two (#757).
    await expect(drawer.getByLabel('Location', { exact: true })).toHaveCount(1);
    await drawer.getByRole('button', { name: 'Cancel' }).click();
    await expect(drawer).toHaveCount(0);
    await expect(workspace).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Review this CV' })).toBeVisible();
    expect(await readAttempt(window, seeded.attemptId)).toMatchObject({ checkpoint: 'needs_user', checkpointDetail: REVIEW_REQUIRED_DETAIL });

    // Save: the review is stamped and the same application restarts preparation in place.
    await workspace.getByRole('button', { name: 'Review this CV' }).click();
    await expect(window.getByRole('dialog', { name: 'Edit CV' })).toBeVisible();
    await window.getByRole('dialog', { name: 'Edit CV' }).getByRole('button', { name: 'Confirm and save' }).click();
    await expect(window.getByRole('dialog', { name: 'Edit CV' })).toHaveCount(0);
    await expect(workspace).toBeVisible();
    const settled = await waitForSettled(window, seeded.attemptId, REVIEW_REQUIRED_DETAIL);
    // Preparation ran again for this job: its next stop is a different one (the posting could not be
    // checked on the reserved domain), never the review it just had.
    expect(settled.checkpointDetail).not.toContain('no reviewed source record');
    expect(settled.tailoringMode).toBe('ai');
    await expect(workspace.getByRole('button', { name: 'Review this CV' })).toHaveCount(0);
  });
});

test('Use my CV as it is renders a CV whose PDF keeps the Skills and Languages sections', async () => {
  test.setTimeout(300_000);
  const seeded = await seedCvReviewRecovery('ovr-cv-review-pdf');
  const userDataDir = seeded.userDataDir;
  await withApp(seeded, `ovr-e2e-cv-review-pdf-${process.pid}`, async (_electronApp, window) => {
    const workspace = await openApplyWorkspace(window);
    await workspace.getByRole('button', { name: 'Use my CV as it is' }).click();
    const unverified = await waitForSettled(window, seeded.attemptId, REVIEW_REQUIRED_DETAIL);
    expect(unverified.tailoringMode).toBe('original');

    // The reserved domain cannot be checked, so the person confirms the posting is open (#720).
    const itsOpen = window.getByRole('button', { name: "It's open" });
    await expect(itsOpen).toBeVisible({ timeout: 30_000 });
    await itsOpen.click();
    const prepared = await waitForSettled(window, seeded.attemptId, unverified.checkpointDetail);
    // The CV is rendered from the reviewed records, whatever happened to the letter.
    expect(prepared.checkpointDetail).toMatch(/Your application documents are ready\.|Your tailored CV is ready\./u);
    expect(prepared.checkpointDetail).not.toContain('without any skills');

    // Both documents are staged under the attempt's own folder; the CV is the one with the sections.
    const artifactRoot = join(userDataDir, 'application-artifacts', seeded.attemptId);
    const files = (await readdir(artifactRoot)).filter((file) => file.endsWith('.pdf'));
    expect(files.length, `PDFs under ${artifactRoot}`).toBeGreaterThan(0);
    const { extractText } = await import('unpdf');
    const texts: string[] = [];
    for (const file of files) {
      const { text } = await extractText(new Uint8Array(await readFile(join(artifactRoot, file))), { mergePages: true });
      texts.push(text.replace(/\s+/gu, ' '));
    }
    // The template upper-cases section headings with CSS, so the extracted text reads "SKILLS".
    const skillsPattern = new RegExp(`SKILLS ${RECOVERY_SKILLS.join(', ')}`, 'iu');
    const languagesPattern = new RegExp(`LANGUAGES ${RECOVERY_LANGUAGES.replace(/[()]/gu, '\\$&')}`, 'iu');
    const cvText = texts.find((text) => skillsPattern.test(text));
    expect(cvText, `a CV PDF with a Skills section among: ${texts.join(' || ')}`).toBeDefined();
    expect(cvText).toMatch(languagesPattern);
    expect(cvText).toMatch(/EXPERIENCE Frontend Developer, Redwood Software/iu);
  });
});

test('a reviewed CV with no skills says so on the CV page and in its review, without blocking Save', async () => {
  test.setTimeout(180_000);
  const seeded = await seedCvReviewRecovery('ovr-cv-no-skills', { skills: [] });
  await withApp(seeded, `ovr-e2e-cv-no-skills-${process.pid}`, async (_electronApp, window) => {
    await goto(window, 'CV');
    const row = window.getByRole('row', { name: new RegExp(RECOVERY_CV_NAME.replace('.', '\\.')) });
    await expect(row.getByText('Yes', { exact: true })).toBeVisible();
    await expect(row.getByText(/no skills listed/i)).toBeVisible();
    await row.getByRole('button', { name: `Add skills to ${RECOVERY_CV_NAME}` }).click();
    const drawer = window.getByRole('dialog', { name: 'Edit CV' });
    await expect(drawer.getByTestId('cv-drawer-skills-missing')).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Confirm and save' })).toBeEnabled();
    await drawer.getByLabel('Skills').fill('React');
    await expect(drawer.getByTestId('cv-drawer-skills-missing')).toHaveCount(0);
    await drawer.getByRole('button', { name: 'Confirm and save' }).click();
    await expect(drawer).toHaveCount(0);
    await expect(row.getByText(/no skills listed/i)).toHaveCount(0);
  });
});
