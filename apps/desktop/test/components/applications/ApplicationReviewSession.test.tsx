import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FormReadiness, FormSnapshot } from '@agent-dock/application-executor';
import {
  FIXTURE_FORM_URLS,
  resolvePolicyIdForCanonicalUrl,
  setAutoApplyEnabled,
} from '../../../electron/application-target-policies.js';
import { ApplicationReviewSession } from '../../../src/components/applications/ApplicationReviewSession.js';
import type { ApplicationAttemptRecord } from '../../../src/window.js';

/**
 * What the auto-apply kill switch actually does to the screen a person sees.
 *
 * `ApplicationReviewSession` already routes on one thing: whether `resolveTargetPolicyId` hands back
 * a policy. So no routing change was needed for the MVP decision to turn auto-apply off -- but
 * "already correct" is a claim worth a test rather than a reading, which is what this file is. The
 * bridge stub below calls the *real* main-process resolver rather than a hard-coded `null`, so the
 * switch is genuinely what decides which card renders here.
 *
 * The attempt deliberately points at the local fixture form: the one URL the compiled policy table
 * does cover. If the switch can send even that to the manual card, no real employer URL can reach
 * `ApplicationReviewSwipeCard` through this path either -- which is why that component and its own
 * suite stay exactly as they are, unreachable rather than deleted.
 */

const ATTEMPT = {
  id: '11111111-1111-4111-8111-111111111111',
  vacancyKey: 'vac-1',
  canonicalUrl: FIXTURE_FORM_URLS.withoutUpload,
  company: 'Acme Corp',
  role: 'Senior Engineer',
  checkpoint: 'ready',
  checkpointDetail: 'Your application documents are ready.',
  jdSnapshot: 'Job description text.',
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

/** The `window` bridges this session talks to, with `resolveTargetPolicyId` wired to the real
 * resolver so the kill switch -- not the stub -- decides what comes back. */
function installBridges() {
  const openReview = vi.fn().mockResolvedValue({ snapshot: SNAPSHOT, screenshotBase64: 'ZmFrZQ==', readiness: READINESS });
  (window as unknown as { applicationExecutor: unknown }).applicationExecutor = {
    resolveTargetPolicyId: vi.fn(async (url: string) => resolvePolicyIdForCanonicalUrl(url) ?? null),
    openReview,
    closeReview: vi.fn().mockResolvedValue(undefined),
    hideHandoff: vi.fn().mockResolvedValue(undefined),
    submitReview: vi.fn(),
    saveArtifact: vi.fn(),
    openArtifact: vi.fn(),
    recordUserReportedSubmission: vi.fn(),
  };
  (window as unknown as { workspace: unknown }).workspace = {
    listApplicationArtifacts: vi.fn().mockResolvedValue([]),
    updateApplicationAttempt: vi.fn().mockResolvedValue(undefined),
    getApplicationAttempt: vi.fn().mockResolvedValue(ATTEMPT),
    listApplicationAnswers: vi.fn().mockResolvedValue([]),
    saveApplicationAnswer: vi.fn(),
  };
  return { openReview };
}

afterEach(() => {
  setAutoApplyEnabled(false);
});

describe('ApplicationReviewSession under the auto-apply kill switch', () => {
  it('routes the one URL a compiled policy covers to the manual card, never the swipe card', async () => {
    const { openReview } = installBridges();

    render(<ApplicationReviewSession attempt={ATTEMPT} onClose={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Continue on employer site' })).toBeInTheDocument();
    expect(screen.getByTestId('manual-application-swipe-card')).toBeInTheDocument();
    expect(screen.queryByTestId('application-swipe-card')).not.toBeInTheDocument();
    // Nothing opened a browser view either: with no policy there is no target to open one against.
    expect(openReview).not.toHaveBeenCalled();
  });

  it('is the switch doing it: the same attempt reaches the swipe card once auto-apply is on', async () => {
    setAutoApplyEnabled(true);
    const { openReview } = installBridges();

    render(<ApplicationReviewSession attempt={ATTEMPT} onClose={vi.fn()} />);

    expect(await screen.findByTestId('application-swipe-card')).toBeInTheDocument();
    expect(screen.queryByTestId('manual-application-swipe-card')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(openReview).toHaveBeenCalledWith({
        attemptId: ATTEMPT.id,
        policyId: 'ashby-fixture-test-only',
        targetUrl: ATTEMPT.canonicalUrl,
      }),
    );
  });
});
