import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FormReadiness, FormSnapshot } from '@agent-dock/application-executor';
import { ApplicationReviewSession } from '../../../src/components/applications/ApplicationReviewSession.js';
import type { ApplicationAttemptRecord } from '../../../src/window.js';

/**
 * #468 and #469 at the dialog level: what the error screen says about whether anything was sent
 * and what it lets a person do next, and which layout the review dialog picks for the window.
 * Every record here is synthetic.
 */

const ATTEMPT = {
  id: 'attempt-outcomes-1',
  vacancyKey: 'vac-outcomes',
  canonicalUrl: 'https://jobs.example.invalid/apply/outcomes',
  company: 'Example Works',
  role: 'Staff Designer',
  checkpoint: 'ready',
  checkpointDetail: '',
  jdSnapshot: 'Synthetic job description.',
} as unknown as ApplicationAttemptRecord;

const SNAPSHOT: FormSnapshot = {
  generation: 1,
  capturedAt: '2026-01-01T00:00:00.000Z',
  challengeDetected: false,
  activeFrameId: 0,
  pageStateFingerprint: 'fingerprint',
  submitControls: [],
  fields: [{ fieldRef: 'f1', label: 'Full name', controlType: 'text', required: true, frameId: 0, active: true }],
};

const READINESS: FormReadiness = {
  ready: true,
  verifiedFilledCount: 1,
  discoveredFieldCount: 1,
  requiredFieldCount: 1,
  requiredFieldsSatisfied: 1,
  blockers: [],
};

function installBridges(overrides: Record<string, unknown> = {}) {
  const executor = {
    resolveTargetPolicyId: vi.fn().mockResolvedValue('synthetic-policy'),
    openReview: vi.fn().mockResolvedValue({ snapshot: SNAPSHOT, screenshotBase64: 'ZmFrZQ==', readiness: READINESS }),
    closeReview: vi.fn().mockResolvedValue(undefined),
    hideHandoff: vi.fn().mockResolvedValue(undefined),
    submitReview: vi.fn(),
    recordUserReportedSubmission: vi.fn(),
    saveArtifact: vi.fn(),
    openArtifact: vi.fn(),
    ...overrides,
  };
  const workspace = {
    listApplicationArtifacts: vi.fn().mockResolvedValue([]),
    updateApplicationAttempt: vi.fn().mockResolvedValue(undefined),
    listApplicationAnswers: vi.fn().mockResolvedValue([]),
    saveApplicationAnswer: vi.fn(),
  };
  (window as unknown as { applicationExecutor: unknown }).applicationExecutor = executor;
  (window as unknown as { workspace: unknown }).workspace = workspace;
  return { executor, workspace };
}

async function submitFromReview() {
  fireEvent.click(await screen.findByRole('button', { name: /submit application/i }));
  // The second deliberate action (#443): the final confirmation.
  fireEvent.click(await screen.findByRole('button', { name: /^send application$/i }));
}

function setViewportWide(wide: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: wide,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('ApplicationReviewSession error screen (#468)', () => {
  it('says not sent for a refusal before submit and offers Try again, Open the live page and Skip for now', async () => {
    const { executor } = installBridges({
      submitReview: vi.fn().mockResolvedValue({ ok: false, reason: 'form_not_ready', detail: 'Full name is empty' }),
    });
    render(<ApplicationReviewSession attempt={ATTEMPT} onClose={vi.fn()} />);
    await submitFromReview();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Not sent. The form still has checks to finish.');
    expect(alert).toHaveTextContent('Full name is empty');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Open the live page' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(executor.openReview).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: /submit application/i })).toBeInTheDocument();
  });

  it('keeps Try again locked after an unconfirmed submit until the employer page was opened', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    installBridges({
      submitReview: vi.fn().mockResolvedValue({ ok: false, reason: 'submission_unknown', detail: 'The page went blank.' }),
    });
    render(<ApplicationReviewSession attempt={ATTEMPT} onClose={vi.fn()} />);
    await submitFromReview();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'We could not confirm whether this was sent. Check the employer site before trying again.',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
    // Skipping would bury an application that may have gone out, so it is not offered here.
    expect(screen.queryByRole('button', { name: 'Skip for now' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open the live page' }));
    expect(open).toHaveBeenCalledWith(ATTEMPT.canonicalUrl, '_blank', 'noopener,noreferrer');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('reports an error thrown after the submit started as could not be confirmed, never as not sent', async () => {
    installBridges({ submitReview: vi.fn().mockRejectedValue(new Error('IPC channel closed')) });
    render(<ApplicationReviewSession attempt={ATTEMPT} onClose={vi.fn()} />);
    await submitFromReview();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We could not confirm whether this was sent.');
    expect(alert).not.toHaveTextContent('Not sent.');
    expect(alert).toHaveTextContent('IPC channel closed');
  });

  it('skips from the error screen without calling submitReview, and tells the parent', async () => {
    const onClose = vi.fn();
    const onSkipped = vi.fn();
    const submitReview = vi.fn().mockResolvedValue({ ok: false, reason: 'captcha_detected' });
    const { workspace } = installBridges({ submitReview });
    render(<ApplicationReviewSession attempt={ATTEMPT} onClose={onClose} onSkipped={onSkipped} />);
    await submitFromReview();
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }));

    await waitFor(() => expect(workspace.updateApplicationAttempt).toHaveBeenCalledWith(ATTEMPT.id, { checkpoint: 'skipped' }));
    expect(onSkipped).toHaveBeenCalledWith(ATTEMPT);
    expect(onClose).toHaveBeenCalledWith('resolved');
    expect(submitReview).toHaveBeenCalledTimes(1);
  });

  it('calls onSkipped for a normal skip from the review card too', async () => {
    const onSkipped = vi.fn();
    installBridges();
    render(<ApplicationReviewSession attempt={ATTEMPT} onClose={vi.fn()} onSkipped={onSkipped} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(onSkipped).toHaveBeenCalledWith(ATTEMPT));
  });

  it('lets a person record that they applied after an unconfirmed submit', async () => {
    const onClose = vi.fn();
    const recordUserReportedSubmission = vi.fn().mockResolvedValue({ ok: true });
    installBridges({
      submitReview: vi.fn().mockResolvedValue({ ok: false, reason: 'submission_outcome_unresolved' }),
      recordUserReportedSubmission,
    });
    render(<ApplicationReviewSession attempt={ATTEMPT} onClose={onClose} />);
    await submitFromReview();
    fireEvent.click(await screen.findByRole('button', { name: 'I already applied' }));

    await waitFor(() => expect(recordUserReportedSubmission).toHaveBeenCalledWith(ATTEMPT.id));
    expect(onClose).toHaveBeenCalledWith('resolved');
  });

  it('says already sent, with no retry, when the application is already recorded as submitted', async () => {
    const onClose = vi.fn();
    installBridges({
      submitReview: vi.fn().mockResolvedValue({ ok: false, reason: 'submission_unknown' }),
      recordUserReportedSubmission: vi.fn().mockResolvedValue({ ok: false, reason: 'already_observed' }),
    });
    render(<ApplicationReviewSession attempt={ATTEMPT} onClose={onClose} />);
    await submitFromReview();
    fireEvent.click(await screen.findByRole('button', { name: 'I already applied' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Already sent.');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledWith('resolved');
  });

  it('writes the open failure as a not sent sentence with Try again, and hides the live page link without a URL', async () => {
    installBridges({ openReview: vi.fn().mockRejectedValue(new Error('the page did not respond')) });
    render(<ApplicationReviewSession attempt={{ ...ATTEMPT, canonicalUrl: '' }} onClose={vi.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Not sent. We could not open a review for this attempt.');
    expect(alert).toHaveTextContent('the page did not respond');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Open the live page' })).not.toBeInTheDocument();
  });

  it('keeps Close available on every error screen', async () => {
    installBridges({ submitReview: vi.fn().mockResolvedValue({ ok: false, reason: 'submission_unknown' }) });
    render(<ApplicationReviewSession attempt={ATTEMPT} onClose={vi.fn()} />);
    await submitFromReview();
    await screen.findByRole('alert');
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0);
  });
});

describe('ApplicationReviewSession layout (#469)', () => {
  it('uses the compact layout, with the screenshot behind a disclosure, when the window is narrow', async () => {
    setViewportWide(false);
    installBridges();
    render(<ApplicationReviewSession attempt={ATTEMPT} onClose={vi.fn()} />);

    const layout = await screen.findByTestId('review-layout');
    expect(layout).toHaveAttribute('data-layout', 'compact');
    expect(screen.queryByTestId('review-screenshot-pane')).not.toBeInTheDocument();
    expect(screen.getByText('Review application form').closest('details')).not.toBeNull();
    expect(screen.getByRole('dialog').firstElementChild?.className).toContain('max-w-md');
  });

  it('uses two panes about 1100px wide with the screenshot always visible when the window is wide', async () => {
    setViewportWide(true);
    installBridges();
    render(<ApplicationReviewSession attempt={ATTEMPT} onClose={vi.fn()} />);

    const layout = await screen.findByTestId('review-layout');
    expect(layout).toHaveAttribute('data-layout', 'wide');
    const pane = screen.getByTestId('review-screenshot-pane');
    const preview = within(pane).getByRole('img', { name: /live application page preview for staff designer at example works/i });
    expect(preview.closest('details')).toBeNull();
    // The height cap from the compact layout is gone.
    expect(preview.closest('[class*="max-h-72"]')).toBeNull();
    expect(screen.getByRole('dialog').firstElementChild?.className).toContain('max-w-[min(1100px');
    // The decorative card stack is dropped so the content being approved gets the room.
    expect(screen.queryAllByTestId('swipe-card-back')).toHaveLength(0);
    // The decision panel is still there with its accessible names.
    expect(screen.getByRole('group', { name: /application decision card for staff designer at example works/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit application/i })).toBeEnabled();
  });

  it('opens the screenshot at its original size, closes on Escape without ending the review, and restores focus', async () => {
    setViewportWide(true);
    installBridges();
    const onClose = vi.fn();
    render(<ApplicationReviewSession attempt={ATTEMPT} onClose={onClose} />);

    const opener = await screen.findByRole('button', { name: 'View full size' });
    opener.focus();
    fireEvent.click(opener);

    const full = await screen.findByRole('dialog', { name: 'Form screenshot at original size' });
    expect(within(full).getByRole('img').className).toContain('max-w-none');
    expect(within(full).getByRole('button', { name: 'Close full size view' })).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Form screenshot at original size' })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'View full size' })).toHaveFocus();
    expect(screen.getByTestId('review-layout')).toBeInTheDocument();
  });

  it('keeps the compact error and manual screens at the narrow dialog width even on a wide window', async () => {
    setViewportWide(true);
    installBridges({ openReview: vi.fn().mockRejectedValue(new Error('offline')) });
    render(<ApplicationReviewSession attempt={ATTEMPT} onClose={vi.fn()} />);
    await screen.findByRole('alert');
    expect(screen.getAllByRole('dialog')[0]?.firstElementChild?.className).toContain('max-w-md');
  });
});
