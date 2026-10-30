import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostingVerificationView } from '../../../electron/application-pipeline-types.js';
import { POSTING_UNVERIFIED_DETAIL as MAIN_UNVERIFIED_DETAIL } from '../../../electron/application-posting-verification.js';
import { PostingVerificationNotice } from '../../../src/components/applications/PostingVerificationNotice.js';
import {
  describePostingVerification,
  formatCheckedAt,
  isPostingFindingDetail,
  isPostingPreparationStopDetail,
  POSTING_UNVERIFIED_DETAIL,
} from '../../../src/components/applications/posting-verification-text.js';

// #720: a posting nobody could check automatically is not prepared until the person looks and records
// "It's open"; the time they said it, and the check that could not answer, sit under "How we know".

const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const POSTING_URL = 'https://careers.example.org/jobs/42';
const NOW = new Date('2026-10-30T12:00:00.000Z');

function view(overrides: Partial<PostingVerificationView> = {}): PostingVerificationView {
  return {
    attemptId: ATTEMPT_ID,
    status: 'unable_to_verify',
    checkedAt: '2026-10-30T11:58:00.000Z',
    source: null,
    sourceRef: null,
    reason: 'no_authoritative_source',
    httpStatus: null,
    contentVersion: null,
    deadline: null,
    noDeadlineStated: false,
    change: null,
    changeKind: null,
    resolution: null,
    reused: false,
    stale: false,
    invalidated: false,
    held: false,
    released: false,
    recheck: null,
    actions: ['confirm_open', 'open_posting'],
    ...overrides,
  };
}

function installPipeline(initial: PostingVerificationView, extra: Record<string, unknown> = {}) {
  const bridge = {
    postingVerification: vi.fn().mockResolvedValue(initial),
    verifyPosting: vi.fn().mockResolvedValue(initial),
    refreshFromPosting: vi.fn(),
    resume: vi.fn().mockResolvedValue({ ok: true, attemptId: ATTEMPT_ID, tailoringMode: 'ai', continued: 'queued' }),
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

describe('the "could not check" stop (#720)', () => {
  it('uses the same sentence main writes, and screens treat it as a stop the notice owns', () => {
    expect(POSTING_UNVERIFIED_DETAIL).toBe(MAIN_UNVERIFIED_DETAIL);
    expect(isPostingPreparationStopDetail(MAIN_UNVERIFIED_DETAIL)).toBe(true);
    expect(isPostingFindingDetail(MAIN_UNVERIFIED_DETAIL)).toBe(false);
  });

  it('asks for one explicit "It\'s open" and never calls the posting closed', async () => {
    const bridge = installPipeline(view());
    const onDone = vi.fn();
    render(<PostingVerificationNotice attemptId={ATTEMPT_ID} postingUrl={POSTING_URL} onDone={onDone} />);

    expect(await screen.findByText('We could not check whether this posting is still open.')).toBeInTheDocument();
    expect(screen.getByText("Nothing is prepared until you look at the posting and confirm it's open.")).toBeInTheDocument();
    expect(screen.queryByText(/looks closed/iu)).toBeNull();
    expect(screen.getByRole('link', { name: 'Open the posting' })).toHaveAttribute('href', POSTING_URL);
    // Nothing else can start preparation from here.
    expect(screen.queryByRole('button', { name: 'Prepare now' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: "It's open" }));
    await waitFor(() => expect(bridge.resume).toHaveBeenCalledWith(ATTEMPT_ID, { resolution: 'confirm_open' }));
    expect(bridge.resume).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('resumed'));
  });

  it('shows a refused confirmation instead of pretending it worked', async () => {
    installPipeline(view(), {
      resume: vi.fn().mockResolvedValue({ ok: false, attemptId: ATTEMPT_ID, tailoringMode: 'ai', detail: 'that posting finding is no longer current; check the posting again first' }),
    });
    const onDone = vi.fn();
    render(<PostingVerificationNotice attemptId={ATTEMPT_ID} postingUrl={POSTING_URL} onDone={onDone} />);
    fireEvent.click(await screen.findByRole('button', { name: "It's open" }));
    expect(await screen.findByText('that posting finding is no longer current; check the posting again first')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('shows the recorded resolution and its timestamp under "How we know"', async () => {
    const confirmedAt = '2026-10-30T11:59:00.000Z';
    installPipeline(view({ personConfirmedAt: confirmedAt, actions: ['open_posting'] }));
    render(<PostingVerificationNotice attemptId={ATTEMPT_ID} postingUrl={POSTING_URL} />);

    const howWeKnow = await screen.findByTestId('posting-how-we-know');
    expect(within(howWeKnow).getByText('How we know')).toBeInTheDocument();
    expect(within(howWeKnow).getByText(`You confirmed it's open on ${formatCheckedAt(confirmedAt)}.`)).toBeInTheDocument();
    expect(within(howWeKnow).getByText(`Checked ${formatCheckedAt('2026-10-30T11:58:00.000Z')}.`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "It's open" })).toBeNull();
  });

  it('never shows a confirmation time it was not given', () => {
    const text = describePostingVerification(view({ checkedAt: null }), NOW);
    expect(text.howWeKnow).toEqual([]);
    expect(text.howWeKnow.join(' ')).not.toMatch(/confirmed/iu);
  });
});

describe('Ashby wording (#720)', () => {
  it('a job the official board no longer lists is closed, with its source behind "How we know"', () => {
    const text = describePostingVerification(
      view({
        status: 'confirmed_closed',
        source: 'ashby',
        sourceRef: 'api.ashbyhq.com/posting-api/job-board/{board}',
        reason: 'not_listed',
        httpStatus: 200,
        actions: ['open_posting', 'prepare_anyway', 'check_again'],
      }),
      NOW,
    );
    expect(text.headline).toBe('This posting looks closed.');
    expect(text.lines).toContain("The employer's official job board no longer lists this posting.");
    expect(text.lines).toContain('Checked 2 min ago with Ashby.');
    expect(text.howWeKnow).toEqual([`Checked ${formatCheckedAt('2026-10-30T11:58:00.000Z')} with Ashby (api.ashbyhq.com).`]);
  });

  it('a missing board is "could not check", in plain words', () => {
    const text = describePostingVerification(view({ source: 'ashby', reason: 'board_not_found', actions: ['open_posting', 'check_again'] }), NOW);
    expect(text.headline).toBe('We could not check whether this posting is still open.');
    expect(text.lines).toContain("The employer's job board could not be found.");
    expect(text.lines).toContain('This does not mean the posting is closed.');
  });
});
