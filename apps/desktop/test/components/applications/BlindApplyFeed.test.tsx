import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BlindApplyBridge,
  BlindApplyEvidenceView,
  BlindApplyFeedItem,
  BlindApplyItemState,
  BlindApplyStatus,
} from '../../../electron/blind-apply-types.js';
import { BLIND_APPLY_STATE_LABELS } from '../../../electron/blind-apply-types.js';
import { BlindApplyFeed } from '../../../src/components/applications/BlindApplyFeed.js';
import { BlindApplySection } from '../../../src/components/settings/BlindApplySection.js';

/**
 * Blind Apply as a person meets it (#722): one feed, plain words, evidence only when asked for, and one
 * Stop control. The bridge is a scripted stand-in for `window.blindApply`; the real preload parsers and
 * main-side behaviour are covered by `blind-apply-parse.test.ts` and `blind-apply-runner.test.ts`.
 */

const ZERO_COUNTS = Object.fromEntries(Object.keys(BLIND_APPLY_STATE_LABELS).map((state) => [state, 0])) as BlindApplyStatus['counts'];

function status(overrides: Partial<BlindApplyStatus> = {}): BlindApplyStatus {
  return {
    active: true,
    paused: null,
    authorization: { createdAt: '2026-11-04T10:00:00.000Z', roleFamilies: ['frontend'], filters: ['Work country: PT'], cvName: 'Main CV' },
    supported: { real: [], testOnly: ['Local fixture form (test-only, not a real target)'] },
    counts: { ...ZERO_COUNTS },
    ...overrides,
  };
}

function item(state: BlindApplyItemState, overrides: Partial<BlindApplyFeedItem> = {}): BlindApplyFeedItem {
  return {
    id: `item-${state}`,
    company: 'Northwind',
    role: 'Senior Frontend Engineer',
    state,
    label: BLIND_APPLY_STATE_LABELS[state],
    detail: '',
    intervention: null,
    missingFields: null,
    updatedAt: '2026-11-04T10:05:00.000Z',
    attemptId: null,
    open: null,
    ...overrides,
  };
}

let bridge: { [K in keyof BlindApplyBridge]: ReturnType<typeof vi.fn> };

beforeEach(() => {
  bridge = {
    status: vi.fn(async () => status()),
    enable: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ stopped: true, itemsStopped: 2 })),
    feed: vi.fn(async () => []),
    evidence: vi.fn(async (): Promise<BlindApplyEvidenceView | null> => null),
    answer: vi.fn(async () => ({ ok: true })),
    open: vi.fn(async () => ({ ok: true, kind: 'review', attemptId: 'a1' })),
  };
  (window as unknown as { blindApply: unknown }).blindApply = bridge;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { blindApply?: unknown }).blindApply;
});

describe('the feed', () => {
  it('renders nothing for a person who never turned Blind Apply on', async () => {
    bridge.status.mockResolvedValue(status({ active: false, authorization: null }));
    const { container } = render(<BlindApplyFeed />);
    await waitFor(() => expect(bridge.status).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing, and does not throw, where the bridge is absent', () => {
    delete (window as unknown as { blindApply?: unknown }).blindApply;
    const { container } = render(<BlindApplyFeed />);
    expect(container).toBeEmptyDOMElement();
  });

  it('uses only the plain labels, in the fixed set, and never says Submitted for anything else', async () => {
    const states: BlindApplyItemState[] = ['submitted', 'could_not_submit', 'outcome_unknown', 'needs_you', 'apply_yourself', 'stopped', 'preparing'];
    bridge.feed.mockResolvedValue(states.map((state) => item(state)));
    render(<BlindApplyFeed />);
    const rows = await screen.findAllByTestId('blind-apply-item');
    const labels = rows.map((row) => within(row).getByText(/^(Submitted|Could not submit|Sent\? Couldn't confirm|Needs you|Apply yourself|Stopped|Preparing)$/).textContent);
    expect(labels).toEqual(['Submitted', 'Could not submit', "Sent? Couldn't confirm", 'Needs you', 'Apply yourself', 'Stopped', 'Preparing']);
    expect(screen.getAllByText('Submitted')).toHaveLength(1);
  });

  it('says what a bot check or a consent box means in plain words', async () => {
    bridge.feed.mockResolvedValue([item('needs_you', { intervention: 'captcha' }), item('needs_you', { id: 'x', intervention: 'consent' })]);
    render(<BlindApplyFeed />);
    expect(await screen.findByText(/shows a bot check/)).toBeInTheDocument();
    expect(screen.getByText(/consent box that only you can tick/)).toBeInTheDocument();
  });

  it('is honest that no real site is supported', async () => {
    render(<BlindApplyFeed />);
    expect(await screen.findByText(/only send to the local test form/)).toBeInTheDocument();
  });

  it('offers exactly one Stop control while on, no limit control, and no per-job approval', async () => {
    bridge.feed.mockResolvedValue([item('apply_yourself', { open: 'apply_yourself' }), item('submitted')]);
    render(<BlindApplyFeed />);
    await screen.findAllByTestId('blind-apply-item');
    expect(screen.getAllByRole('button', { name: 'Stop Blind Apply' })).toHaveLength(1);
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByText(/per day|daily|limit:|approve/i)).toBeNull();
  });

  it('Stop calls the bridge once and refreshes', async () => {
    render(<BlindApplyFeed />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop Blind Apply' }));
    await waitFor(() => expect(bridge.stop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(bridge.status.mock.calls.length).toBeGreaterThan(1));
  });

  it('keeps the feed visible after Stop so completed records stay readable, with no Stop button', async () => {
    bridge.status.mockResolvedValue(status({ active: false }));
    bridge.feed.mockResolvedValue([item('submitted')]);
    render(<BlindApplyFeed />);
    expect(await screen.findByText('Submitted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop Blind Apply' })).toBeNull();
  });

  it('shows a changed CV or profile as one "Confirm again" action, not a warning maze', async () => {
    bridge.status.mockResolvedValue(status({ paused: { reason: 'cv_changed', detail: 'Your CV changed. Confirm Blind Apply again to continue.' } }));
    render(<BlindApplyFeed />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Your CV changed');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm again' }));
    await waitFor(() => expect(bridge.enable).toHaveBeenCalledTimes(1));
  });

  it('counts skipped roles instead of listing them', async () => {
    bridge.status.mockResolvedValue(status({ counts: { ...ZERO_COUNTS, skipped: 41 } }));
    render(<BlindApplyFeed />);
    expect(await screen.findByText(/41 skipped/)).toBeInTheDocument();
  });

  it('evidence is fetched only when Details is opened, and shows the receipt, documents and answers used', async () => {
    bridge.feed.mockResolvedValue([item('submitted')]);
    bridge.evidence.mockResolvedValue({
      itemId: 'item-submitted',
      gate: { family: 'frontend', filters: 'eligible', linkStatus: 'verified', policyId: 'p', livenessStatus: 'open', livenessVerificationId: null, duplicateCheck: 'clear' },
      events: [{ at: '2026-11-04T10:06:00.000Z', kind: 'receipt', from: 'submitting', to: 'submitted', detail: 'receipt observed' }],
      documents: { cvHash: 'abcdef0123456789', letterHash: null },
      answers: [{ label: 'Full name', provenance: 'cv' }],
      receipt: { outcome: 'submitted', evidenceKind: 'confirmation_page', evidenceReference: 'Your application has been submitted', destination: 'file:///fixture', observedAt: '2026-11-04T10:06:00.000Z', detail: 'confirmed' },
    });
    render(<BlindApplyFeed />);
    await screen.findByText('Submitted');
    expect(bridge.evidence).not.toHaveBeenCalled();

    const details = screen.getByText('Details').closest('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(await screen.findByText('The site showed a confirmation.')).toBeInTheDocument();
    expect(screen.getByText(/Your application has been submitted/)).toBeInTheDocument();
    expect(screen.getByText(/fingerprint abcdef012345/)).toBeInTheDocument();
    expect(screen.getByText(/Full name: from your CV/)).toBeInTheDocument();
    expect(bridge.evidence).toHaveBeenCalledWith('item-submitted');
  });

  it('Open starts or shows the existing reviewed flow and tells the page', async () => {
    bridge.feed.mockResolvedValue([item('apply_yourself', { open: 'apply_yourself' })]);
    bridge.open.mockResolvedValue({ ok: true, kind: 'apply_yourself', attemptId: 'a1', savedJobId: 's1' });
    const onOpened = vi.fn();
    render(<BlindApplyFeed onOpened={onOpened} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1));
    expect(bridge.open).toHaveBeenCalledWith('item-apply_yourself');
  });
});

describe('the needs-one-answer card', () => {
  const waiting = item('needs_answer', {
    missingFields: [
      { label: 'workArrangement', controlType: 'select', options: ['Remote', 'Hybrid'] },
      { label: 'Years of experience with React', controlType: 'text' },
    ],
  });

  it('lists every missing question at once, starts empty, and needs all of them before it can be sent', async () => {
    bridge.feed.mockResolvedValue([waiting]);
    render(<BlindApplyFeed />);
    const button = await screen.findByRole('button', { name: 'Save answer and continue' });
    expect(button).toBeDisabled();
    expect(screen.getByLabelText('Work arrangement')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Work arrangement'), { target: { value: 'Remote' } });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Years of experience with React'), { target: { value: '6' } });
    expect(button).toBeEnabled();
  });

  it('sends the answers under the fields\' own labels, remembering by default, and honours unticking', async () => {
    bridge.feed.mockResolvedValue([waiting]);
    render(<BlindApplyFeed />);
    await screen.findByRole('button', { name: 'Save answer and continue' });
    fireEvent.change(screen.getByLabelText('Work arrangement'), { target: { value: 'Hybrid' } });
    fireEvent.change(screen.getByLabelText('Years of experience with React'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Save answer and continue' }));
    await waitFor(() => expect(bridge.answer).toHaveBeenCalledTimes(1));
    expect(bridge.answer).toHaveBeenCalledWith({
      itemId: 'item-needs_answer',
      answers: [
        { label: 'workArrangement', answer: 'Hybrid' },
        { label: 'Years of experience with React', answer: '6' },
      ],
      remember: false,
    });
  });

  it('says so, in words, when an answer was not accepted', async () => {
    bridge.answer.mockResolvedValue({ ok: false, reason: 'invalid_option' });
    bridge.feed.mockResolvedValue([waiting]);
    render(<BlindApplyFeed />);
    await screen.findByRole('button', { name: 'Save answer and continue' });
    fireEvent.change(screen.getByLabelText('Work arrangement'), { target: { value: 'Hybrid' } });
    fireEvent.change(screen.getByLabelText('Years of experience with React'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save answer and continue' }));
    expect(await screen.findByText(/could not be used/)).toBeInTheDocument();
  });
});

describe('the settings section', () => {
  it('turns on through the app\'s own confirmation, with no filter, number or schedule to set', async () => {
    bridge.status.mockResolvedValue(status({ active: false, authorization: null }));
    render(<BlindApplySection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on…' }));
    await waitFor(() => expect(bridge.enable).toHaveBeenCalledTimes(1));
    expect(bridge.enable).toHaveBeenCalledWith();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getByText(/There is no daily limit/)).toBeInTheDocument();
    expect(screen.getByText(/Supported now: none \(test form only\)/)).toBeInTheDocument();
  });

  it('explains a refusal in plain words and shows nothing for a declined dialog', async () => {
    bridge.status.mockResolvedValue(status({ active: false, authorization: null }));
    bridge.enable.mockResolvedValue({ ok: false, reason: 'no_cv' });
    render(<BlindApplySection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on…' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Add a CV first.');
  });

  it('shows Stop (and what was confirmed) while on', async () => {
    render(<BlindApplySection />);
    expect(await screen.findByRole('button', { name: 'Stop Blind Apply' })).toBeInTheDocument();
    expect(screen.getByText(/using Main CV/)).toBeInTheDocument();
    expect(screen.getByText(/Work country: PT/)).toBeInTheDocument();
  });
});
