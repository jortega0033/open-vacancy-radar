import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormReadiness, FormSnapshot } from '@agent-dock/application-executor';
import type { PostingVerificationView } from '../../../electron/application-pipeline-types.js';
import {
  POSTING_CHANGED_DETAIL as MAIN_CHANGED_DETAIL,
  POSTING_CLOSED_DETAIL as MAIN_CLOSED_DETAIL,
} from '../../../electron/application-posting-verification.js';
import { ApplicationAttemptDrawer } from '../../../src/components/applications/ApplicationAttemptDrawer.js';
import { ApplicationReviewSession } from '../../../src/components/applications/ApplicationReviewSession.js';
import { PostingVerificationNotice } from '../../../src/components/applications/PostingVerificationNotice.js';
import {
  describePostingVerification,
  formatCheckedAgo,
  isPostingFindingDetail,
  POSTING_CHANGED_DETAIL,
  POSTING_CLOSED_DETAIL,
} from '../../../src/components/applications/posting-verification-text.js';
import type { ApplicationAttemptRecord } from '../../../src/window.js';

const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const POSTING_URL = 'https://boards.greenhouse.io/northwind/jobs/4012345';
const NOW = new Date('2026-10-29T12:00:00.000Z');

function view(overrides: Partial<PostingVerificationView> = {}): PostingVerificationView {
  return {
    attemptId: ATTEMPT_ID,
    status: 'confirmed_open',
    checkedAt: '2026-10-29T10:00:00.000Z',
    source: 'greenhouse',
    sourceRef: 'boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}',
    reason: 'verified_open',
    httpStatus: 200,
    contentVersion: 1,
    deadline: null,
    noDeadlineStated: true,
    change: null,
    changeKind: null,
    resolution: null,
    reused: false,
    stale: false,
    invalidated: false,
    held: false,
    released: false,
    recheck: null,
    actions: ['check_again'],
    ...overrides,
  };
}

const CLOSED = view({ status: 'confirmed_closed', reason: 'not_found', httpStatus: 404, noDeadlineStated: false, actions: ['open_posting', 'prepare_anyway', 'check_again'] });
const CHANGED = view({
  status: 'materially_changed',
  contentVersion: 2,
  noDeadlineStated: false,
  change: { added: ['Eight years of TypeScript experience is required.'], removed: ['Five years of TypeScript experience is required.'] },
  actions: ['refresh', 'keep_current', 'open_posting'],
});
const UNABLE = (reason: PostingVerificationView['reason']): PostingVerificationView =>
  view({ status: 'unable_to_verify', reason, httpStatus: null, noDeadlineStated: false, contentVersion: null, actions: ['open_posting', 'check_again'] });

function installPipeline(initial: PostingVerificationView, extra: Record<string, unknown> = {}) {
  const bridge = {
    postingVerification: vi.fn().mockResolvedValue(initial),
    verifyPosting: vi.fn().mockResolvedValue(initial),
    refreshFromPosting: vi.fn().mockResolvedValue({ ok: true, attemptId: ATTEMPT_ID, tailoringMode: 'ai' }),
    resume: vi.fn().mockResolvedValue({ ok: true, attemptId: ATTEMPT_ID, tailoringMode: 'ai' }),
    ...extra,
  };
  (window as unknown as { applicationPipeline: unknown }).applicationPipeline = bridge;
  return bridge;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { applicationPipeline?: unknown }).applicationPipeline;
});

describe('posting check wording', () => {
  it('keeps the renderer sentences identical to the ones main writes into the application', () => {
    expect(POSTING_CLOSED_DETAIL).toBe(MAIN_CLOSED_DETAIL);
    expect(POSTING_CHANGED_DETAIL).toBe(MAIN_CHANGED_DETAIL);
    expect(isPostingFindingDetail(MAIN_CLOSED_DETAIL)).toBe(true);
    expect(isPostingFindingDetail(MAIN_CHANGED_DETAIL)).toBe(true);
    expect(isPostingFindingDetail('Your cover letter still needs attention.')).toBe(false);
  });

  it('only a positive closure is called closed; every inability says it is not closure', () => {
    for (const reason of ['timeout', 'denied', 'login_wall', 'rate_limited', 'server_error', 'network_error', 'no_authoritative_source'] as const) {
      const text = describePostingVerification(UNABLE(reason), NOW);
      expect(text.headline).toBe('We could not check whether this posting is still open.');
      expect(text.lines).toContain('This does not mean the posting is closed.');
      expect(`${text.headline} ${text.lines.join(' ')}`).not.toMatch(/looks closed/iu);
    }
    expect(describePostingVerification(CLOSED, NOW).headline).toBe('This posting looks closed.');
  });

  it('shows the observation time it was given, not the time it is read', () => {
    expect(formatCheckedAgo('2026-10-29T10:00:00.000Z', NOW)).toBe('2 hours ago');
    expect(formatCheckedAgo('2026-10-26T12:00:00.000Z', NOW)).toBe('3 days ago');
    expect(describePostingVerification(view(), NOW).lines).toContain('Checked 2 hours ago with Greenhouse.');
  });

  it('reports an unknown deadline as unknown and a stated one with its date', () => {
    expect(describePostingVerification(view({ noDeadlineStated: true }), NOW).lines).toContain('The posting states no deadline.');
    const stated = describePostingVerification(
      view({ deadline: { date: '2026-11-15', excerpt: 'Apply by 15 November 2026' }, noDeadlineStated: false }),
      NOW,
    );
    expect(stated.lines.join(' ')).toMatch(/states a deadline of .*2026/u);
    const passed = describePostingVerification(
      view({ deadline: { date: '2026-10-01', excerpt: 'Apply by 1 October 2026' }, noDeadlineStated: false }),
      NOW,
    );
    expect(passed.tone).toBe('warning');
    expect(passed.lines.join(' ')).toContain('which has passed');
  });

  it('never claims a stored finding is a fresh check when nothing was checked', () => {
    expect(describePostingVerification(view({ status: 'not_checked', checkedAt: null, noDeadlineStated: false }), NOW).headline).toBe(
      'The posting has not been checked yet.',
    );
  });
});

describe('PostingVerificationNotice', () => {
  it('open and unchanged is one quiet line with no gate: a status, a check-again link, no alert, no dialog', async () => {
    installPipeline(view());
    render(<PostingVerificationNotice attemptId={ATTEMPT_ID} postingUrl={POSTING_URL} />);

    const region = await screen.findByRole('region', { name: 'Posting check' });
    expect(within(region).getByRole('status')).toHaveTextContent('The posting is still open.');
    expect(within(region).queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(region).getAllByRole('button').map((button) => button.textContent)).toEqual(['Check again']);
  });

  it('reads the stored check without contacting the posting', async () => {
    const bridge = installPipeline(view());
    render(<PostingVerificationNotice attemptId={ATTEMPT_ID} postingUrl={POSTING_URL} />);
    await screen.findByRole('region', { name: 'Posting check' });
    expect(bridge.postingVerification).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(bridge.verifyPosting).not.toHaveBeenCalled();
  });

  it('a closed posting is a warning with a way to check it yourself and to continue anyway', async () => {
    const bridge = installPipeline(CLOSED);
    const onDone = vi.fn();
    render(<PostingVerificationNotice attemptId={ATTEMPT_ID} postingUrl={POSTING_URL} onDone={onDone} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This posting looks closed.');
    const open = screen.getByRole('link', { name: 'Open the posting' });
    expect(open).toHaveAttribute('href', POSTING_URL);
    expect(open).toHaveAttribute('target', '_blank');

    fireEvent.click(screen.getByRole('button', { name: 'Get ready anyway' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('resumed'));
    expect(bridge.resume).toHaveBeenCalledWith(ATTEMPT_ID, { resolution: 'prepare_anyway' });
  });

  it('changed requirements are listed before anything is regenerated, with refresh and keep as the person\'s choices', async () => {
    const bridge = installPipeline(CHANGED);
    const onDone = vi.fn();
    render(<PostingVerificationNotice attemptId={ATTEMPT_ID} postingUrl={POSTING_URL} onDone={onDone} />);

    await screen.findByText('The requirements in this posting changed since it was read.');
    expect(screen.getByText('Eight years of TypeScript experience is required.')).toBeInTheDocument();
    expect(screen.getByText('Five years of TypeScript experience is required.')).toBeInTheDocument();
    // Nothing was refreshed just by looking at it.
    expect(bridge.refreshFromPosting).not.toHaveBeenCalled();
    expect(bridge.resume).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Keep my application' }));
    await waitFor(() => expect(bridge.resume).toHaveBeenCalledWith(ATTEMPT_ID, { resolution: 'keep_current' }));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh from the updated posting' }));
    await waitFor(() => expect(bridge.refreshFromPosting).toHaveBeenCalledWith(ATTEMPT_ID));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('refreshed'));
  });

  it('shows why a check could not run and offers a retry without calling it closed', async () => {
    const bridge = installPipeline(UNABLE('denied'), { verifyPosting: vi.fn().mockResolvedValue(view()) });
    render(<PostingVerificationNotice attemptId={ATTEMPT_ID} postingUrl={POSTING_URL} />);

    expect(await screen.findByText('We could not check whether this posting is still open.')).toBeInTheDocument();
    expect(screen.getByText('The site declined the check. It may need you to sign in.')).toBeInTheDocument();
    expect(screen.queryByText(/looks closed/iu)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(bridge.verifyPosting).toHaveBeenCalledWith(ATTEMPT_ID, { force: true }));
    expect(await screen.findByText('The posting is still open.')).toBeInTheDocument();
  });

  it('shows a refused action instead of pretending it worked', async () => {
    installPipeline(CHANGED, { refreshFromPosting: vi.fn().mockResolvedValue({ ok: false, attemptId: ATTEMPT_ID, tailoringMode: 'ai', detail: 'this application was already sent' }) });
    const onDone = vi.fn();
    render(<PostingVerificationNotice attemptId={ATTEMPT_ID} postingUrl={POSTING_URL} onDone={onDone} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh from the updated posting' }));
    expect(await screen.findByText('this application was already sent')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('a sent application explains that its documents stay as they were and offers no action', async () => {
    installPipeline(view({ status: 'not_applicable', checkedAt: null, source: null, sourceRef: null, reason: null, noDeadlineStated: false, actions: [] }));
    render(<PostingVerificationNotice attemptId={ATTEMPT_ID} postingUrl={POSTING_URL} />);
    expect(await screen.findByText('The posting is not rechecked after you apply.')).toBeInTheDocument();
    expect(screen.getByText('The documents you used stay exactly as they were.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a held package says it is paused and that Keep puts it back exactly as it was', async () => {
    const bridge = installPipeline(
      { ...CHANGED, held: true, changeKind: 'requirements' },
      { resume: vi.fn().mockResolvedValue({ ok: true, attemptId: ATTEMPT_ID, tailoringMode: 'ai', continued: 'restored' }) },
    );
    const onDone = vi.fn();
    render(<PostingVerificationNotice attemptId={ATTEMPT_ID} postingUrl={POSTING_URL} onDone={onDone} />);
    expect(await screen.findByText(/Your prepared application is paused until you choose\. Keep my application puts it back exactly as it was/u)).toBeInTheDocument();
    bridge.postingVerification.mockResolvedValue({ ...CHANGED, resolution: 'keep_current', held: false, actions: ['open_posting', 'check_again'] });
    fireEvent.click(screen.getByRole('button', { name: 'Keep my application' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('restored'));
    // Nothing was queued, so the notice re-reads and shows the recorded decision in place.
    expect(await screen.findByText('You chose to keep your application as prepared.')).toBeInTheDocument();
  });

  it('a large rewrite with no requirement signal is called a text change, never changed requirements', () => {
    const text = describePostingVerification({ ...CHANGED, changeKind: 'text' }, NOW);
    expect(text.headline).toBe('The posting text changed a lot since it was read.');
    expect(`${text.headline} ${text.lines.join(' ')}`).not.toMatch(/requirements/iu);
  });

  it('a later check that could not run is shown beside the finding, which still stands', () => {
    const text = describePostingVerification({ ...CLOSED, recheck: { checkedAt: '2026-10-29T11:30:00.000Z', reason: 'timeout' } }, NOW);
    expect(text.headline).toBe('This posting looks closed.');
    expect(text.lines).toContain('A later check could not reach the posting. The check timed out. This finding still stands.');
  });

  it('a link with no authoritative route shows no useless "Check again"', async () => {
    installPipeline(view({ status: 'unable_to_verify', reason: 'no_authoritative_source', source: null, sourceRef: null, noDeadlineStated: false, actions: ['open_posting'] }));
    render(<PostingVerificationNotice attemptId={ATTEMPT_ID} postingUrl={POSTING_URL} />);
    expect(await screen.findByText('This job source cannot be checked automatically.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open the posting' })).toBeInTheDocument();
  });

  it('says so when the stored check cannot be loaded, without calling the posting closed', async () => {
    installPipeline(view(), { postingVerification: vi.fn().mockRejectedValue(new Error('ipc failed')) });
    render(<PostingVerificationNotice attemptId={ATTEMPT_ID} postingUrl={POSTING_URL} />);
    expect(await screen.findByText('We could not load the posting check. This does not mean the posting is closed.')).toBeInTheDocument();
  });

  it('shows a pending label while a check runs and updates nothing after the notice is gone', async () => {
    let finish!: (value: PostingVerificationView) => void;
    const bridge = installPipeline(view(), {
      verifyPosting: vi.fn(() => new Promise<PostingVerificationView>((resolve) => {
        finish = resolve;
      })),
    });
    const onDone = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { unmount } = render(<PostingVerificationNotice attemptId={ATTEMPT_ID} postingUrl={POSTING_URL} onDone={onDone} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeDisabled();
    unmount();
    await act(async () => finish(CLOSED));
    expect(bridge.verifyPosting).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('renders nothing when the bridge predates the check, instead of failing the screen', async () => {
    (window as unknown as { applicationPipeline: unknown }).applicationPipeline = {};
    const { container } = render(<PostingVerificationNotice attemptId={ATTEMPT_ID} postingUrl={POSTING_URL} />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });
});

const ATTEMPT = {
  id: ATTEMPT_ID,
  vacancyKey: 'vac-1',
  canonicalUrl: POSTING_URL,
  company: 'Northwind Freight',
  role: 'Logistics Platform Engineer',
  checkpoint: 'needs_user',
  checkpointDetail: MAIN_CHANGED_DETAIL,
  jdSnapshot: 'Job description text.',
  jdComplete: true,
  updatedAt: '2026-10-29T11:00:00.000Z',
} as unknown as ApplicationAttemptRecord;

describe('the application drawer', () => {
  it('shows the posting check on the application the person already opens, and refresh reaches the page', async () => {
    installPipeline(CHANGED);
    (window as unknown as { workspace: unknown }).workspace = { listApplicationArtifacts: vi.fn().mockResolvedValue([]) };
    const onChanged = vi.fn();
    render(<ApplicationAttemptDrawer attempt={ATTEMPT} onClose={vi.fn()} onChanged={onChanged} />);

    const region = await screen.findByRole('region', { name: 'Posting check' });
    expect(region).toHaveAttribute('data-status', 'materially_changed');
    fireEvent.click(within(region).getByRole('button', { name: 'Refresh from the updated posting' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('retried'));
  });
});

describe('the review dialog (resuming a prepared application)', () => {
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

  function installExecutor(current: ApplicationAttemptRecord) {
    const openReview = vi.fn().mockResolvedValue({ snapshot: SNAPSHOT, screenshotBase64: 'ZmFrZQ==', readiness: READINESS });
    (window as unknown as { applicationExecutor: unknown }).applicationExecutor = {
      resolveTargetPolicyId: vi.fn(async () => 'fixture-policy'),
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
      getApplicationAttempt: vi.fn().mockResolvedValue(current),
      listApplicationAnswers: vi.fn().mockResolvedValue([]),
      saveApplicationAnswer: vi.fn(),
    };
    return { openReview };
  }

  const READY = { ...ATTEMPT, checkpoint: 'ready', checkpointDetail: '' } as ApplicationAttemptRecord;

  it('checks once before the review opens and carries on untouched when the posting is open and unchanged', async () => {
    const bridge = installPipeline(view());
    const { openReview } = installExecutor(READY);
    render(<ApplicationReviewSession attempt={READY} onClose={vi.fn()} />);

    await waitFor(() => expect(openReview).toHaveBeenCalledTimes(1));
    expect(bridge.verifyPosting).toHaveBeenCalledTimes(1);
    expect(bridge.verifyPosting).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(bridge.verifyPosting.mock.invocationCallOrder[0]).toBeLessThan(openReview.mock.invocationCallOrder[0]!);
    // The unchanged case adds a single quiet line and no extra decision.
    expect(await screen.findByText('The posting is still open.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh from the updated posting' })).toBeNull();
  });

  it('a changed posting stops the stale package from being opened for review and asks for a decision first', async () => {
    const bridge = installPipeline(CHANGED);
    bridge.verifyPosting.mockResolvedValue({ ...CHANGED, invalidated: true });
    const invalidated = { ...ATTEMPT, checkpoint: 'needs_user', checkpointDetail: MAIN_CHANGED_DETAIL } as ApplicationAttemptRecord;
    const { openReview } = installExecutor(invalidated);
    render(<ApplicationReviewSession attempt={READY} onClose={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Refresh from the updated posting' })).toBeInTheDocument();
    expect(openReview).not.toHaveBeenCalled();
    // The generic "Resume" retry would only re-run into the same stop, so it is not offered.
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
  });

  it('a closed posting on a prepared package asks for the same explicit choice; Get ready anyway reopens the review', async () => {
    const heldClosed = { ...CLOSED, held: true, invalidated: true };
    const bridge = installPipeline(heldClosed, {
      resume: vi.fn().mockResolvedValue({ ok: true, attemptId: ATTEMPT_ID, tailoringMode: 'ai', continued: 'restored' }),
    });
    const heldAttempt = { ...ATTEMPT, checkpoint: 'needs_user', checkpointDetail: MAIN_CLOSED_DETAIL } as ApplicationAttemptRecord;
    const { openReview } = installExecutor(heldAttempt);
    const onClose = vi.fn();
    render(<ApplicationReviewSession attempt={READY} onClose={onClose} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Get ready anyway' }));
    expect(openReview).not.toHaveBeenCalled();
    // Restored exactly as it was: the dialog reads the application again and opens the review.
    (window as unknown as { workspace: { getApplicationAttempt: ReturnType<typeof vi.fn> } }).workspace.getApplicationAttempt.mockResolvedValue(READY);
    bridge.verifyPosting.mockResolvedValue({ ...CLOSED, resolution: 'prepare_anyway', actions: ['open_posting', 'check_again'] });
    await waitFor(() => expect(openReview).toHaveBeenCalledTimes(1));
    expect(bridge.resume).toHaveBeenCalledWith(ATTEMPT_ID, { resolution: 'prepare_anyway' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a check that cannot run never blocks the review', async () => {
    const bridge = installPipeline(UNABLE('timeout'));
    bridge.verifyPosting.mockRejectedValue(new Error('ipc failed'));
    const { openReview } = installExecutor(READY);
    render(<ApplicationReviewSession attempt={READY} onClose={vi.fn()} />);
    await waitFor(() => expect(openReview).toHaveBeenCalledTimes(1));
  });
});
