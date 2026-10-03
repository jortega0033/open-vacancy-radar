import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduledSendBanner } from '../../../src/components/shell/ScheduledSendBanner.js';
import type { ApplicationAttemptRecord } from '../../../src/window.js';

const NOW = new Date('2026-10-03T14:03:00.000Z');

function scheduled(overrides: Partial<ApplicationAttemptRecord> = {}): ApplicationAttemptRecord {
  return {
    id: 'att-1',
    company: 'Northwind',
    role: 'Platform Engineer',
    checkpoint: 'ready',
    scheduledAutomaticSubmitAt: '2026-10-03T14:05:00.000Z',
    ...overrides,
  } as ApplicationAttemptRecord;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ScheduledSendBanner (#445)', () => {
  it('renders nothing when no send is scheduled', () => {
    const { container } = render(<ScheduledSendBanner attempts={[]} onReview={vi.fn()} onCancel={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('counts down live from the stored deadline and names the company', () => {
    render(<ScheduledSendBanner attempts={[scheduled()]} onReview={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Northwind')).toBeInTheDocument();
    expect(screen.getByText('2:00')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText('1:30')).toBeInTheDocument();
    // The sentence a screen reader hears changes by the minute, not by the second.
    expect(screen.getByText('2 min.')).toBeInTheDocument();
  });

  it('gives Cancel an accessible name with role and company, and Review opens that exact attempt', () => {
    const onReview = vi.fn();
    render(<ScheduledSendBanner attempts={[scheduled()]} onReview={onReview} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Cancel sending Platform Engineer at Northwind' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(onReview).toHaveBeenCalledWith('att-1');
  });

  it('confirms a cancel only after the backend accepts it', async () => {
    vi.useRealTimers();
    const onCancel = vi.fn().mockResolvedValue({ status: 'cancelled' });
    render(<ScheduledSendBanner attempts={[scheduled({ scheduledAutomaticSubmitAt: new Date(Date.now() + 120_000).toISOString() })]} onReview={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel sending/i }));
    expect(await screen.findByText('Sending cancelled. Platform Engineer is back in Review.')).toBeInTheDocument();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('says it was too late when the send had already started, instead of claiming a cancel', async () => {
    vi.useRealTimers();
    const onCancel = vi.fn().mockResolvedValue({ status: 'too_late', checkpoint: 'submitted' });
    render(<ScheduledSendBanner attempts={[scheduled({ scheduledAutomaticSubmitAt: new Date(Date.now() + 120_000).toISOString() })]} onReview={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel sending/i }));
    expect(await screen.findByText(/too late to cancel/i)).toBeInTheDocument();
    expect(screen.queryByText(/sending cancelled/i)).not.toBeInTheDocument();
  });

  it('keeps the schedule and says so when the cancel fails', async () => {
    vi.useRealTimers();
    const onCancel = vi.fn().mockRejectedValue(new Error('boom'));
    render(<ScheduledSendBanner attempts={[scheduled({ scheduledAutomaticSubmitAt: new Date(Date.now() + 120_000).toISOString() })]} onReview={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel sending/i }));
    const notice = await screen.findByText(/could not cancel sending to northwind/i);
    expect(notice).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /cancel sending platform engineer/i })).toBeEnabled());
  });

  it('shows no stale Cancel once the deadline has passed', () => {
    render(
      <ScheduledSendBanner
        attempts={[scheduled({ scheduledAutomaticSubmitAt: '2026-10-03T14:02:00.000Z' })]}
        onReview={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/now\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancel sending/i })).not.toBeInTheDocument();
    const status = screen.getAllByRole('status')[0]!;
    expect(within(status).getByRole('button', { name: 'Review' })).toBeInTheDocument();
  });
});
