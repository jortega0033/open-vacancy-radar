import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationsTable } from '../../../src/components/applications/ApplicationsTable.js';
import type { ApplicationRecord, ApplicationStatus } from '../../../src/window.js';

function makeApplication(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    id: 'app-1',
    savedJobId: null,
    role: 'Senior Frontend Engineer',
    company: 'Redwood Software',
    location: 'Amsterdam',
    verification: null,
    status: 'preparing',
    appliedAt: null,
    nextStep: '',
    contact: '',
    cvId: null,
    letterId: null,
    notes: '',
    archived: false,
    ...overrides,
  };
}

const NOOP_PROPS = {
  onStatusChange: vi.fn(),
  onEdit: vi.fn(),
  onToggleArchive: vi.fn(),
  onDelete: vi.fn(),
};

describe('ApplicationsTable', () => {
  it('shows "Prepare interview" for recruiter_screen and interview, and hides it for every other status', () => {
    const preparable: ApplicationStatus[] = ['recruiter_screen', 'interview'];
    const notPreparable: ApplicationStatus[] = ['preparing', 'applied', 'offer', 'rejected', 'withdrawn'];

    for (const status of preparable) {
      const { unmount } = render(
        <ApplicationsTable
          applications={[makeApplication({ status })]}
          {...NOOP_PROPS}
          onPrepareInterview={vi.fn()}
        />,
      );
      expect(screen.getByRole('button', { name: /Prepare interview for/ })).toBeInTheDocument();
      unmount();
    }

    for (const status of notPreparable) {
      const { unmount } = render(
        <ApplicationsTable
          applications={[makeApplication({ status })]}
          {...NOOP_PROPS}
          onPrepareInterview={vi.fn()}
        />,
      );
      expect(screen.queryByRole('button', { name: /Prepare interview for/ })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('never shows the action when the caller does not wire up onPrepareInterview', () => {
    render(<ApplicationsTable applications={[makeApplication({ status: 'interview' })]} {...NOOP_PROPS} />);
    expect(screen.queryByRole('button', { name: /Prepare interview for/ })).not.toBeInTheDocument();
  });

  it('keeps Edit, Archive and Delete present and clickable alongside the new action, not replaced by it', () => {
    render(
      <ApplicationsTable
        applications={[makeApplication({ status: 'interview' })]}
        {...NOOP_PROPS}
        onPrepareInterview={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /Prepare interview for/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit Senior Frontend Engineer/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Archive Senior Frontend Engineer/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete Senior Frontend Engineer/ })).toBeInTheDocument();

    screen.getByRole('button', { name: /Edit Senior Frontend Engineer/ }).click();
    expect(NOOP_PROPS.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'app-1' }));
  });

  it('calls onPrepareInterview with the clicked record', () => {
    const onPrepareInterview = vi.fn();
    render(
      <ApplicationsTable
        applications={[makeApplication({ status: 'interview' })]}
        {...NOOP_PROPS}
        onPrepareInterview={onPrepareInterview}
      />,
    );
    screen.getByRole('button', { name: /Prepare interview for/ }).click();
    expect(onPrepareInterview).toHaveBeenCalledWith(expect.objectContaining({ id: 'app-1' }));
  });

  it('provides unique accessible names for delete buttons across multiple rows', () => {
    const applications = [
      makeApplication({ id: 'app-1', role: 'Frontend Engineer', company: 'Acme Corp' }),
      makeApplication({ id: 'app-2', role: 'Backend Engineer', company: 'Tech Inc' }),
      makeApplication({ id: 'app-3', role: 'DevOps Engineer', company: 'Cloud Co' }),
    ];
    render(<ApplicationsTable applications={applications} {...NOOP_PROPS} />);

    const deleteButtons = screen.getAllByRole('button', { name: /^Delete/ });
    expect(deleteButtons).toHaveLength(3);

    const deleteNames = deleteButtons.map((btn) => btn.getAttribute('aria-label'));
    expect(deleteNames).toEqual([
      'Delete Frontend Engineer at Acme Corp',
      'Delete Backend Engineer at Tech Inc',
      'Delete DevOps Engineer at Cloud Co',
    ]);

    const uniqueNames = new Set(deleteNames);
    expect(uniqueNames.size).toBe(deleteNames.length);
  });

  it('shows the linked attempt state, keeps the source of a sent state visible, and opens the attempt (#444)', () => {
    const onOpenAttempt = vi.fn();
    render(
      <ApplicationsTable
        applications={[
          makeApplication({
            id: 'a',
            status: 'applied',
            attempt: { attemptId: 'att-1', checkpoint: 'submitted', evidence: 'receipt_confirmed', at: '2026-10-02T14:05:00.000Z' },
          }),
          makeApplication({
            id: 'b',
            role: 'Data Engineer',
            attempt: { attemptId: 'att-2', checkpoint: 'user_reported', evidence: 'user_reported', at: '2026-10-02T14:05:00.000Z' },
          }),
          makeApplication({
            id: 'c',
            role: 'QA Engineer',
            attempt: { attemptId: 'att-3', checkpoint: 'submission_unknown', evidence: null, at: '2026-10-02T14:05:00.000Z' },
          }),
          makeApplication({ id: 'd', role: 'Manual entry' }),
        ]}
        {...NOOP_PROPS}
        onOpenAttempt={onOpenAttempt}
      />,
    );

    expect(screen.getByText('Receipt observed by this app')).toBeInTheDocument();
    expect(screen.getByText('Reported by you')).toBeInTheDocument();
    expect(screen.getByText('Not confirmed')).toBeInTheDocument();
    // A hand-entered row has no attempt and therefore no attempt link.
    expect(screen.getAllByRole('button', { name: /open the review/i })).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: /open the review for senior frontend engineer/i }));
    expect(onOpenAttempt).toHaveBeenCalledWith('att-1');
  });
});
