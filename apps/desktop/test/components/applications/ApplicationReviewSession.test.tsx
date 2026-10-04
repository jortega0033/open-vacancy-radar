import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FormReadiness, FormSnapshot } from '@agent-dock/application-executor';
import {
  FIXTURE_FORM_URLS,
  resolvePolicyIdForCanonicalUrl,
  setAutoApplyEnabled,
} from '../../../electron/application-target-policies.js';
import { ApplicationReviewSession } from '../../../src/components/applications/ApplicationReviewSession.js';
import type { ApplicationAttemptRecord } from '../../../src/window.js';
import { activeProviderLimit, resetProviderLimitsForTest } from '../../../src/provider-limits.js';

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

describe('ApplicationReviewSession when Claude hit its usage limit (#546)', () => {
  const LIMIT_DETAIL = "Automatic CV tailoring stopped: You've hit your session limit · resets 10:10pm";

  function blockedAttempt(overrides: Partial<ApplicationAttemptRecord>): ApplicationAttemptRecord {
    return { ...ATTEMPT, checkpoint: 'needs_user', checkpointDetail: LIMIT_DETAIL, ...overrides } as ApplicationAttemptRecord;
  }

  /** Lets the session's opening effect and its promises settle under fake timers. */
  async function settle() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  afterEach(() => {
    vi.useRealTimers();
    resetProviderLimitsForTest();
  });

  it('unlocks Try again just after the reset time passes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date(2026, 9, 4, 21, 0, 0));
    installBridges();
    render(<ApplicationReviewSession attempt={blockedAttempt({ updatedAt: new Date(2026, 9, 4, 21, 0, 0).toISOString() })} onClose={vi.fn()} />);
    await settle();

    expect(screen.getByText(/Claude has reached its usage limit until 10:10pm\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Try again after / })).toBeDisabled();

    // 22:09: still waiting.
    act(() => vi.advanceTimersByTime(69 * 60_000));
    expect(screen.getByRole('button', { name: /^Try again after / })).toBeDisabled();

    // A few seconds after 22:10, not up to a minute late.
    act(() => vi.advanceTimersByTime(60_000 + 2_000));
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enables Try again at once for a different attempt whose reset passed long ago, and records no stale limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date(2026, 9, 4, 21, 0, 0));
    installBridges();
    const { rerender } = render(
      <ApplicationReviewSession attempt={blockedAttempt({ updatedAt: new Date(2026, 9, 4, 21, 0, 0).toISOString() })} onClose={vi.fn()} />,
    );
    await settle();
    expect(screen.getByRole('button', { name: /^Try again after / })).toBeDisabled();

    // The clock moves on without any timer firing (a sleeping machine), and the queue steps to an
    // attempt whose own reset, 22:30, is already behind it at 23:00.
    vi.setSystemTime(new Date(2026, 9, 4, 23, 0, 0));
    resetProviderLimitsForTest();
    rerender(
      <ApplicationReviewSession
        attempt={blockedAttempt({
          id: '22222222-2222-4222-8222-222222222222',
          checkpointDetail: "Automatic CV tailoring stopped: You've hit your session limit · resets 10:30pm",
          updatedAt: new Date(2026, 9, 4, 22, 20, 0).toISOString(),
        })}
        onClose={vi.fn()}
      />,
    );
    await settle();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(activeProviderLimit('claude')).toBeUndefined();

    // And an attempt from days ago is enabled at once too.
    rerender(
      <ApplicationReviewSession
        attempt={blockedAttempt({ id: '33333333-3333-4333-8333-333333333333', updatedAt: new Date(2026, 9, 1, 21, 0, 0).toISOString() })}
        onClose={vi.fn()}
      />,
    );
    await settle();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(activeProviderLimit('claude')).toBeUndefined();
  });

  it('does not take a non-provider blocker that mentions 429 for a Claude limit', async () => {
    installBridges();
    render(
      <ApplicationReviewSession
        attempt={blockedAttempt({ checkpointDetail: 'the employer page answered 429 Too Many Requests while loading' })}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText('This application needs your attention.')).toBeInTheDocument();
    expect(screen.queryByText(/usage limit/)).not.toBeInTheDocument();
    expect(activeProviderLimit('claude')).toBeUndefined();
  });

  it('shows the limit for a field-map run that hit it', async () => {
    installBridges();
    render(
      <ApplicationReviewSession
        attempt={blockedAttempt({ checkpointDetail: "working out what goes in each field did not finish: You've hit your session limit" })}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText(/^Claude has reached its usage limit\. Preparing an application needs Claude/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
  });
});

describe('ApplicationReviewSession under the auto-apply kill switch', () => {
  it('routes the one URL a compiled policy covers to the manual card, never the swipe card', async () => {
    const { openReview } = installBridges();

    render(<ApplicationReviewSession attempt={ATTEMPT} onClose={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Open employer site' })).toBeInTheDocument();
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
