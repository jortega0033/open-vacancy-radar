import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationDrawer } from '../../../src/components/applications/ApplicationDrawer.js';
import { STATUS_HISTORY_LEGACY_LINE, statusEventSourceLabel } from '../../../src/components/applications/StatusHistory.js';
import type { ApplicationRecord, ApplicationStatusEventEntry, ApplicationStatusEventRecord } from '../../../src/window.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';

/** #708 as the person meets it in the drawer: an optional date on a real change, and a read-only history. */

const RECORD: ApplicationRecord = {
  id: 'app-1',
  savedJobId: null,
  role: 'Platform Engineer',
  company: 'Northwind',
  location: 'Remote',
  verification: null,
  status: 'applied',
  appliedAt: null,
  nextStep: '',
  contact: '',
  cvId: null,
  letterId: null,
  notes: '',
  archived: false,
};

const EVENTS: ApplicationStatusEventEntry[] = [
  {
    readable: false,
    id: 'e3',
    applicationId: 'app-1',
    eventVersion: 2,
    recordedAt: '2026-11-12T10:00:00.000Z',
  },
  {
    readable: true,
    id: 'e2',
    applicationId: 'app-1',
    eventVersion: 1,
    fromStatus: 'applied',
    toStatus: 'interview',
    source: 'user_set',
    via: 'application_edit',
    attemptId: null,
    evidence: null,
    occurredOn: '2026-11-05',
    observedAt: null,
    recordedAt: '2026-11-10T10:00:00.000Z',
  },
  {
    readable: true,
    id: 'e1',
    applicationId: 'app-1',
    eventVersion: 1,
    fromStatus: 'preparing',
    toStatus: 'applied',
    source: 'app_observed',
    via: 'attempt_sync',
    attemptId: 'att-1',
    evidence: 'receipt_confirmed',
    occurredOn: null,
    observedAt: '2026-11-03T08:00:00.000Z',
    recordedAt: '2026-11-03T09:00:00.000Z',
  },
];

function renderDrawer(onSubmit = vi.fn().mockResolvedValue(undefined), record: ApplicationRecord | null = RECORD) {
  render(
    <ApplicationDrawer
      mode={record ? 'edit' : 'create'}
      record={record}
      savedJobs={[]}
      cvDocuments={[]}
      letters={[]}
      onCancel={vi.fn()}
      onSubmit={onSubmit}
    />,
  );
  return onSubmit;
}

describe('ApplicationDrawer status date and history (#708)', () => {
  let bridge: ReturnType<typeof installWorkspaceBridge>;
  beforeEach(() => {
    bridge = installWorkspaceBridge({ listApplicationStatusEvents: vi.fn().mockResolvedValue(EVENTS) });
  });

  it('shows the date field only while the status differs from the saved one, empty, and clears it when put back', () => {
    renderDrawer();
    expect(screen.queryByLabelText('Date this happened')).toBeNull();

    fireEvent.change(screen.getByDisplayValue('Applied'), { target: { value: 'interview' } });
    const field = screen.getByLabelText('Date this happened') as HTMLInputElement;
    expect(field.value).toBe('');
    fireEvent.change(field, { target: { value: '2026-11-05' } });

    fireEvent.change(screen.getByDisplayValue('Interview'), { target: { value: 'applied' } });
    expect(screen.queryByLabelText('Date this happened')).toBeNull();
    fireEvent.change(screen.getByDisplayValue('Applied'), { target: { value: 'interview' } });
    expect((screen.getByLabelText('Date this happened') as HTMLInputElement).value).toBe('');
  });

  it('sends the typed date with the change, and null when left empty or the status is unchanged', async () => {
    const onSubmit = renderDrawer();
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ status: 'applied', statusOccurredOn: null });

    fireEvent.change(screen.getByDisplayValue('Applied'), { target: { value: 'rejected' } });
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1]![0]).toMatchObject({ status: 'rejected', statusOccurredOn: null });

    fireEvent.change(screen.getByLabelText('Date this happened'), { target: { value: '2026-11-05' } });
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(3));
    expect(onSubmit.mock.calls[2]![0]).toMatchObject({ status: 'rejected', statusOccurredOn: '2026-11-05' });
  });

  it('lists the history with who said so, "date not given" for an unknown date, and the legacy line', async () => {
    renderDrawer();
    expect(bridge.listApplicationStatusEvents).toHaveBeenCalledWith('app-1');
    expect(await screen.findByText(/Set by you\./)).toBeTruthy();
    expect(screen.getByText(/Date not given\./)).toBeTruthy();
    expect(screen.getByText(/This app saw the employer confirmation\./)).toBeTruthy();
    expect(screen.getByText(/Happened on /)).toBeTruthy();
    expect(screen.getByText(/Recorded by a newer version of the app/)).toBeTruthy();
    expect(screen.getByText(STATUS_HISTORY_LEGACY_LINE)).toBeTruthy();
  });

  it('shows no history in create mode', () => {
    renderDrawer(undefined, null);
    expect(screen.queryByLabelText('Status history')).toBeNull();
    expect(bridge.listApplicationStatusEvents).not.toHaveBeenCalled();
  });
});

describe('statusEventSourceLabel (#708)', () => {
  const base = EVENTS[1] as ApplicationStatusEventRecord;
  it('names who asserted the change, never a cause', () => {
    expect(statusEventSourceLabel({ ...base, source: 'user_set', evidence: 'user_statement' })).toBe('You reported sending it.');
    expect(statusEventSourceLabel({ ...base, source: 'user_set', evidence: null })).toBe('Set by you.');
    expect(statusEventSourceLabel({ ...base, source: 'app_observed', evidence: 'receipt_confirmed' })).toBe(
      'This app saw the employer confirmation.',
    );
    expect(statusEventSourceLabel({ ...base, source: 'app_observed', evidence: 'not_recorded' })).toMatch(/No confirmation was recorded/);
  });
});
