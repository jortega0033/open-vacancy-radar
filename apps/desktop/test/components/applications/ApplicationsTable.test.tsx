import { render, screen } from '@testing-library/react';
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
      expect(screen.getByRole('button', { name: 'Prepare interview' })).toBeInTheDocument();
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
      expect(screen.queryByRole('button', { name: 'Prepare interview' })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('never shows the action when the caller does not wire up onPrepareInterview', () => {
    render(<ApplicationsTable applications={[makeApplication({ status: 'interview' })]} {...NOOP_PROPS} />);
    expect(screen.queryByRole('button', { name: 'Prepare interview' })).not.toBeInTheDocument();
  });

  it('keeps Edit, Archive and Delete present and clickable alongside the new action, not replaced by it', () => {
    render(
      <ApplicationsTable
        applications={[makeApplication({ status: 'interview' })]}
        {...NOOP_PROPS}
        onPrepareInterview={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Prepare interview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();

    screen.getByRole('button', { name: 'Edit' }).click();
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
    screen.getByRole('button', { name: 'Prepare interview' }).click();
    expect(onPrepareInterview).toHaveBeenCalledWith(expect.objectContaining({ id: 'app-1' }));
  });
});
