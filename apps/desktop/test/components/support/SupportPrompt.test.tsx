import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormReadiness, FormSnapshot } from '@agent-dock/application-executor';
import type { SupportPromptState } from '../../../electron/workspace/support-prompt.js';
import { ApplicationReviewSession } from '../../../src/components/applications/ApplicationReviewSession.js';
import { useEscapeToClose } from '../../../src/components/shell/useEscapeToClose.js';
import {
  SUPPORT_QUIET_DELAY_MS,
  SupportPromptProvider,
  useSupportPrompt,
} from '../../../src/components/support/index.js';
import type { ApplicationAttemptRecord } from '../../../src/window.js';
import { DEFAULT_SETTINGS, installVacancyRadarBridge, installWorkspaceBridge } from '../../workspace-bridge.js';

/**
 * #503: when the Support ask shows and when it does not. Every record is synthetic. The settings
 * bridge is stateful, like the real one, so the tests see what the app wrote.
 */

const TITLE = 'Support Open Vacancy Radar';
const FRESH: SupportPromptState = { answered: false, asks: 0, successesSinceDismissal: 0 };

const ATTEMPT = {
  id: 'attempt-support-1',
  vacancyKey: 'vac-support',
  canonicalUrl: 'https://jobs.example.invalid/apply/support',
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

let stored: SupportPromptState;
let getScanStatus: ReturnType<typeof vi.fn>;

function installBridges(initial: SupportPromptState = FRESH, executorOverrides: Record<string, unknown> = {}) {
  stored = initial;
  const workspace = installWorkspaceBridge({
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, supportPrompt: stored })),
    updateSettings: vi.fn(async (patch: { supportPrompt?: SupportPromptState }) => {
      if (patch.supportPrompt) stored = patch.supportPrompt;
      return { ...DEFAULT_SETTINGS, supportPrompt: stored };
    }),
  });
  getScanStatus = vi.fn().mockResolvedValue({ scanning: false });
  installVacancyRadarBridge({ getScanStatus } as never);
  Object.assign(workspace, {
    listApplicationArtifacts: vi.fn().mockResolvedValue([]),
    updateApplicationAttempt: vi.fn().mockResolvedValue(undefined),
    listApplicationAnswers: vi.fn().mockResolvedValue([]),
  });
  const executor = {
    resolveTargetPolicyId: vi.fn().mockResolvedValue('synthetic-policy'),
    openReview: vi.fn().mockResolvedValue({ snapshot: SNAPSHOT, screenshotBase64: 'ZmFrZQ==', readiness: READINESS }),
    closeReview: vi.fn().mockResolvedValue(undefined),
    hideHandoff: vi.fn().mockResolvedValue(undefined),
    submitReview: vi.fn().mockResolvedValue({ ok: true }),
    recordUserReportedSubmission: vi.fn().mockResolvedValue({ ok: true }),
    saveArtifact: vi.fn(),
    openArtifact: vi.fn(),
    ...executorOverrides,
  };
  (window as unknown as { applicationExecutor: unknown }).applicationExecutor = executor;
  return { workspace, executor };
}

function dialog() {
  return screen.queryByRole('dialog', { name: TITLE });
}

async function expectNoDialog() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SUPPORT_QUIET_DELAY_MS + 300));
  });
  expect(dialog()).not.toBeInTheDocument();
}

async function findDialog() {
  return screen.findByRole('dialog', { name: TITLE }, { timeout: 3000 });
}

/** A review session the way ApplicationsPage mounts it: gone once it resolves. */
function ReviewHost() {
  const [open, setOpen] = useState(true);
  return open ? <ApplicationReviewSession attempt={ATTEMPT} onClose={() => setOpen(false)} /> : <p>review closed</p>;
}

function renderReview(page = 'applications') {
  return render(
    <SupportPromptProvider page={page} welcomeOpen={false}>
      <ReviewHost />
    </SupportPromptProvider>,
  );
}

function SuccessButton() {
  const { recordSuccessMoment } = useSupportPrompt();
  return (
    <button type="button" onClick={recordSuccessMoment}>
      Record success
    </button>
  );
}

function renderHarness(props: { page?: string; welcomeOpen?: boolean; extra?: React.ReactNode } = {}) {
  const tree = (page: string, welcomeOpen: boolean, extra?: React.ReactNode) => (
    <SupportPromptProvider page={page} welcomeOpen={welcomeOpen}>
      <SuccessButton />
      {extra}
    </SupportPromptProvider>
  );
  const result = render(tree(props.page ?? 'search', props.welcomeOpen ?? false, props.extra));
  return {
    ...result,
    update: (next: { page?: string; welcomeOpen?: boolean; extra?: React.ReactNode }) =>
      result.rerender(tree(next.page ?? props.page ?? 'search', next.welcomeOpen ?? props.welcomeOpen ?? false, next.extra)),
  };
}

function recordSuccess() {
  fireEvent.click(screen.getByRole('button', { name: 'Record success' }));
}

function OtherOverlay() {
  useEscapeToClose(() => {});
  return <p>another overlay</p>;
}

const stopNavigation = (event: Event) => event.preventDefault();

beforeEach(() => {
  // jsdom does not implement navigation; the real click is handed to Electron's window-open handler.
  document.addEventListener('click', stopNavigation);
});

afterEach(() => {
  document.removeEventListener('click', stopNavigation);
  vi.restoreAllMocks();
});

describe('Support ask trigger (#503)', () => {
  it('shows after the review dialog closes on an ok submitReview', async () => {
    const { executor } = installBridges();
    renderReview();
    fireEvent.click(await screen.findByRole('button', { name: /submit application/i }));

    expect(await findDialog()).toBeInTheDocument();
    expect(executor.submitReview).toHaveBeenCalledTimes(1);
    expect(screen.getByText('review closed')).toBeInTheDocument();
    // The first ask changes no counter: only a dismissal counts.
    expect(stored).toEqual(FRESH);
  });

  it('shows after an ok recordUserReportedSubmission from the error screen', async () => {
    installBridges(FRESH, {
      submitReview: vi.fn().mockResolvedValue({ ok: false, reason: 'submission_outcome_unresolved' }),
    });
    renderReview();
    fireEvent.click(await screen.findByRole('button', { name: /submit application/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'I already applied' }));

    expect(await findDialog()).toBeInTheDocument();
  });

  it('never shows for a refused submission, whatever the person does on the error screen', async () => {
    installBridges(FRESH, {
      submitReview: vi.fn().mockResolvedValue({ ok: false, reason: 'form_not_ready', detail: 'Full name is empty' }),
    });
    renderReview();
    fireEvent.click(await screen.findByRole('button', { name: /submit application/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not sent.');
    await expectNoDialog();
  });

  it('never shows for a failed recordUserReportedSubmission', async () => {
    installBridges(FRESH, {
      submitReview: vi.fn().mockResolvedValue({ ok: false, reason: 'submission_outcome_unresolved' }),
      recordUserReportedSubmission: vi.fn().mockResolvedValue({ ok: false, reason: 'already_observed' }),
    });
    renderReview();
    fireEvent.click(await screen.findByRole('button', { name: /submit application/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'I already applied' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Already sent.');
    await expectNoDialog();
  });

  it('never shows for a skip, which also resolves the review dialog', async () => {
    const { executor } = installBridges();
    renderReview();
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    await screen.findByText('review closed');
    await expectNoDialog();
    expect(executor.submitReview).not.toHaveBeenCalled();
  });

  it('never shows at app start', async () => {
    installBridges();
    renderHarness();
    await expectNoDialog();
  });
});

describe('Support ask guard (#503)', () => {
  it('waits while another overlay is open and shows at the next page change', async () => {
    installBridges();
    const view = renderHarness({ extra: <OtherOverlay /> });
    recordSuccess();
    await expectNoDialog();

    view.update({ extra: null, page: 'saved' });
    expect(await findDialog()).toBeInTheDocument();
  });

  it('counts an overlay whose Escape handling is disabled, such as a review mid-submit', async () => {
    installBridges();
    function BusyOverlay() {
      useEscapeToClose(() => {}, true);
      return <p>busy overlay</p>;
    }
    const view = renderHarness({ extra: <BusyOverlay /> });
    recordSuccess();
    await expectNoDialog();
    view.update({ extra: null, page: 'saved' });
    expect(await findDialog()).toBeInTheDocument();
  });

  it('waits while the Welcome modal is open', async () => {
    installBridges();
    const view = renderHarness({ welcomeOpen: true });
    recordSuccess();
    await expectNoDialog();

    view.update({ welcomeOpen: false });
    expect(await findDialog()).toBeInTheDocument();
  });

  it('waits while a scan is running', async () => {
    installBridges();
    getScanStatus.mockResolvedValue({ scanning: true });
    const view = renderHarness();
    recordSuccess();
    await expectNoDialog();

    getScanStatus.mockResolvedValue({ scanning: false });
    view.update({ page: 'saved' });
    expect(await findDialog()).toBeInTheDocument();
  });

  it('does not show once the person answered in Settings in the meantime', async () => {
    installBridges();
    const view = renderHarness({ extra: <OtherOverlay /> });
    recordSuccess();
    await expectNoDialog();

    stored = { ...FRESH, answered: true };
    view.update({ extra: null, page: 'saved' });
    await expectNoDialog();
  });
});

describe('Support ask frequency cap (#503)', () => {
  it('after one "Not now" stays away for 4 more successes, shows on the 5th, and a second "Not now" ends it', async () => {
    installBridges();
    renderHarness();

    recordSuccess();
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }, { timeout: 3000 }));
    await waitFor(() => expect(stored).toEqual({ answered: false, asks: 1, successesSinceDismissal: 0 }));
    expect(dialog()).not.toBeInTheDocument();

    for (let success = 1; success <= 4; success += 1) {
      recordSuccess();
      await waitFor(() => expect(stored.successesSinceDismissal).toBe(success));
    }
    await expectNoDialog();

    recordSuccess();
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }, { timeout: 3000 }));
    await waitFor(() => expect(stored).toEqual({ answered: false, asks: 2, successesSinceDismissal: 0 }));

    for (let i = 0; i < 6; i += 1) recordSuccess();
    await expectNoDialog();
    expect(stored).toEqual({ answered: false, asks: 2, successesSinceDismissal: 0 });
  });

  it('never shows again after Star or Coffee', async () => {
    installBridges({ answered: true, asks: 1, successesSinceDismissal: 4 });
    renderHarness();
    recordSuccess();
    recordSuccess();
    await expectNoDialog();
    expect(stored.answered).toBe(true);
  });
});

describe('SupportDialog (#503)', () => {
  async function openDialog() {
    installBridges();
    renderHarness();
    const trigger = screen.getByRole('button', { name: 'Record success' });
    trigger.focus();
    recordSuccess();
    await findDialog();
    return trigger;
  }

  it('has an accessible name, the copy from the ticket and three actions with visible text', async () => {
    await openDialog();
    const box = screen.getByRole('dialog', { name: TITLE });
    expect(box).toHaveAccessibleDescription(
      'OVR is free, open source and made by one person. If it helped you apply, a star on GitHub or a coffee helps keep it going.',
    );
    expect(screen.getByRole('link', { name: 'Star on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/jortega0033/open-vacancy-radar',
    );
    expect(screen.getByRole('link', { name: 'Buy me a coffee' })).toHaveAttribute(
      'href',
      'https://buymeacoffee.com/jortega0033',
    );
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
  });

  it('opens both links through the existing external path and never from script', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await openDialog();
    for (const name of ['Star on GitHub', 'Buy me a coffee']) {
      const link = screen.getByRole('link', { name });
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('moves focus in on open and returns it on close', async () => {
    const trigger = await openDialog();
    expect(screen.getByRole('button', { name: 'Not now' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(dialog()).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('Star on GitHub and Buy me a coffee count as answered and close the dialog', async () => {
    for (const name of ['Star on GitHub', 'Buy me a coffee']) {
      await openDialog();
      fireEvent.click(screen.getByRole('link', { name }));
      await waitFor(() => expect(stored).toEqual({ answered: true, asks: 0, successesSinceDismissal: 0 }));
      expect(dialog()).not.toBeInTheDocument();
      document.body.innerHTML = '';
    }
  });

  it('Escape behaves like Not now', async () => {
    await openDialog();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(stored).toEqual({ answered: false, asks: 1, successesSinceDismissal: 0 }));
    expect(dialog()).not.toBeInTheDocument();
  });

  it('a backdrop click behaves like Not now', async () => {
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(stored).toEqual({ answered: false, asks: 1, successesSinceDismissal: 0 }));
    expect(dialog()).not.toBeInTheDocument();
  });
});
