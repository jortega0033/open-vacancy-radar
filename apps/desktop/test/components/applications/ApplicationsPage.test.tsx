import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationsPage } from '../../../src/components/applications/index.js';
import type { ApplicationAttemptRecord, ApplicationRecord } from '../../../src/window.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';

function makeAttempt(overrides: Partial<ApplicationAttemptRecord> = {}): ApplicationAttemptRecord {
  return {
    id: overrides.id ?? 'attempt-1',
    applicationId: null,
    vacancyKey: null,
    canonicalUrl: 'https://jobs.example.com/apply/123',
    company: 'Acme Corp',
    role: 'Senior Frontend Engineer',
    sourceCvId: null,
    sourceCvContentHash: 'hash-1',
    jdSnapshot: 'We are looking for a Senior Frontend Engineer to join our team.',
    jdSnapshotHash: 'jd-hash-1',
    jdComplete: true,
    workflowVersion: 'v1',
    checkpoint: 'ready',
    checkpointDetail: '',
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    submittedAt: null,
    ...overrides,
  };
}

function makeApplication(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    id: overrides.id ?? 'app-1',
    savedJobId: null,
    role: 'Senior Frontend Engineer',
    company: 'Acme Corp',
    location: 'Amsterdam',
    verification: 'Recognised sponsor',
    status: 'applied',
    appliedAt: '2026-08-20T10:00:00.000Z',
    nextStep: 'Technical interview',
    contact: 'Jane Recruiter',
    cvId: null,
    letterId: null,
    notes: '',
    archived: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ApplicationsPage', () => {
  it('loads the active tab by default and switches filters via the tab bar', async () => {
    const listApplications = vi.fn().mockResolvedValue([]);
    installWorkspaceBridge({ listApplications });

    render(<ApplicationsPage />);

    await waitFor(() => expect(listApplications).toHaveBeenCalledWith('active'));

    fireEvent.click(screen.getByRole('tab', { name: 'Archived' }));
    await waitFor(() => expect(listApplications).toHaveBeenCalledWith('archived'));

    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    await waitFor(() => expect(listApplications).toHaveBeenCalledWith('all'));
  });

  it('shows a distinct empty state per tab', async () => {
    installWorkspaceBridge({ listApplications: vi.fn().mockResolvedValue([]) });

    render(<ApplicationsPage />);
    await waitFor(() => expect(screen.getByText('No applications yet')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: 'Archived' }));
    await waitFor(() => expect(screen.getByText('No archived applications')).toBeInTheDocument());
  });

  it('renders the fetched applications sorted by most recently applied first', async () => {
    installWorkspaceBridge({
      listApplications: vi.fn().mockResolvedValue([
        makeApplication({ id: 'older', role: 'Older Application', appliedAt: '2026-01-01T00:00:00.000Z' }),
        makeApplication({ id: 'newer', role: 'Newer Application', appliedAt: '2026-08-01T00:00:00.000Z' }),
      ]),
    });

    render(<ApplicationsPage />);

    await waitFor(() => expect(screen.getByText('Newer Application')).toBeInTheDocument());
    const [firstRow, secondRow] = screen.getAllByRole('row').slice(1); // drop the header row
    expect(within(firstRow!).getByText('Newer Application')).toBeInTheDocument();
    expect(within(secondRow!).getByText('Older Application')).toBeInTheDocument();
  });

  it('updates status inline via the row select, sending only the status field', async () => {
    const app = makeApplication({ id: 'status-1', status: 'applied' });
    const updateApplication = vi.fn().mockResolvedValue({ ...app, status: 'interview' });
    installWorkspaceBridge({ listApplications: vi.fn().mockResolvedValue([app]), updateApplication });

    render(<ApplicationsPage />);
    await waitFor(() => expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument());

    const row = screen.getByRole('row', { name: /senior frontend engineer/i });
    fireEvent.change(within(row).getByLabelText('Application status'), { target: { value: 'interview' } });

    await waitFor(() => expect(updateApplication).toHaveBeenCalledWith('status-1', { status: 'interview' }));
  });

  it('validates required fields and calls createApplication when adding a new application', async () => {
    const createApplication = vi
      .fn()
      .mockResolvedValue(makeApplication({ id: 'new-1', role: 'New Role', company: 'New Co', appliedAt: null }));
    installWorkspaceBridge({ listApplications: vi.fn().mockResolvedValue([]), createApplication });

    render(<ApplicationsPage />);
    await waitFor(() => expect(screen.getByText('No applications yet')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^add application$/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/new application/i)).toBeInTheDocument();

    // Submitting blank required fields shows the drawer's inline validation and never reaches
    // the bridge.
    fireEvent.click(within(dialog).getByRole('button', { name: /create application/i }));
    expect(await within(dialog).findByText(/role and company are required/i)).toBeInTheDocument();
    expect(createApplication).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('Role *'), { target: { value: 'New Role' } });
    fireEvent.change(within(dialog).getByLabelText('Company *'), { target: { value: 'New Co' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /create application/i }));

    await waitFor(() => expect(createApplication).toHaveBeenCalledTimes(1));
    expect(createApplication).toHaveBeenCalledWith(expect.objectContaining({ role: 'New Role', company: 'New Co' }));

    await waitFor(() => expect(screen.getByText('New Role')).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('pre-fills the drawer on edit and calls updateApplication with the changed fields', async () => {
    const app = makeApplication({ id: 'edit-1', role: 'Senior Frontend Engineer', company: 'Acme Corp' });
    const updateApplication = vi.fn().mockResolvedValue({ ...app, role: 'Staff Frontend Engineer' });
    installWorkspaceBridge({ listApplications: vi.fn().mockResolvedValue([app]), updateApplication });

    render(<ApplicationsPage />);
    await waitFor(() => expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/edit application/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Role *')).toHaveValue('Senior Frontend Engineer');
    expect(within(dialog).getByLabelText('Company *')).toHaveValue('Acme Corp');

    fireEvent.change(within(dialog).getByLabelText('Role *'), { target: { value: 'Staff Frontend Engineer' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateApplication).toHaveBeenCalledTimes(1));
    expect(updateApplication).toHaveBeenCalledWith(
      'edit-1',
      expect.objectContaining({ role: 'Staff Frontend Engineer', company: 'Acme Corp' }),
    );
    await waitFor(() => expect(screen.getByText('Staff Frontend Engineer')).toBeInTheDocument());
  });

  it('deletes an application through the confirm dialog, then restores an equivalent record via undo', async () => {
    const app = makeApplication({ id: 'del-1', role: 'Senior Frontend Engineer', company: 'Acme Corp' });
    const deleteApplication = vi.fn().mockResolvedValue({ deleted: true });
    const createApplication = vi
      .fn()
      .mockResolvedValue(makeApplication({ id: 'recreated-1', role: app.role, company: app.company }));
    installWorkspaceBridge({
      listApplications: vi.fn().mockResolvedValue([app]),
      deleteApplication,
      createApplication,
    });

    render(<ApplicationsPage />);
    await waitFor(() => expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    const confirmDialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(deleteApplication).toHaveBeenCalledWith('del-1'));
    await waitFor(() => expect(screen.getByText('No applications yet')).toBeInTheDocument());

    const undoButton = await screen.findByRole('button', { name: /undo/i });
    fireEvent.click(undoButton);

    await waitFor(() => expect(createApplication).toHaveBeenCalledTimes(1));
    expect(createApplication).toHaveBeenCalledWith(expect.objectContaining({ role: app.role, company: app.company }));
    await waitFor(() => expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument());
  });

  it('cancels a delete without calling deleteApplication', async () => {
    const app = makeApplication({ id: 'keep-1' });
    const deleteApplication = vi.fn().mockResolvedValue({ deleted: true });
    installWorkspaceBridge({ listApplications: vi.fn().mockResolvedValue([app]), deleteApplication });

    render(<ApplicationsPage />);
    await waitFor(() => expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    const confirmDialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(deleteApplication).not.toHaveBeenCalled();
    expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument();
  });

  it('surfaces a load error without crashing', async () => {
    installWorkspaceBridge({ listApplications: vi.fn().mockRejectedValue(new Error('database unreachable')) });

    render(<ApplicationsPage />);

    await waitFor(() => expect(screen.getByText(/database unreachable/i)).toBeInTheDocument());
  });

  describe('In progress tab (issue #202)', () => {
    it('loads attempts only when the tab is opened, never alongside the applications tabs', async () => {
      const listApplications = vi.fn().mockResolvedValue([]);
      const listApplicationAttempts = vi.fn().mockResolvedValue([]);
      installWorkspaceBridge({ listApplications, listApplicationAttempts });

      render(<ApplicationsPage />);
      await waitFor(() => expect(listApplications).toHaveBeenCalledWith('active'));
      expect(listApplicationAttempts).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('tab', { name: 'In progress' }));
      await waitFor(() => expect(listApplicationAttempts).toHaveBeenCalledTimes(1));
    });

    it('shows an empty state when there are no in-progress attempts', async () => {
      installWorkspaceBridge({
        listApplications: vi.fn().mockResolvedValue([]),
        listApplicationAttempts: vi.fn().mockResolvedValue([]),
      });

      render(<ApplicationsPage />);
      fireEvent.click(screen.getByRole('tab', { name: 'In progress' }));

      await waitFor(() => expect(screen.getByText('Nothing in progress')).toBeInTheDocument());
    });

    it('renders attempts sorted by most recently updated, with a readable checkpoint label', async () => {
      installWorkspaceBridge({
        listApplications: vi.fn().mockResolvedValue([]),
        listApplicationAttempts: vi.fn().mockResolvedValue([
          makeAttempt({ id: 'older', role: 'Older Attempt', updatedAt: '2026-01-01T00:00:00.000Z', checkpoint: 'needs_user' }),
          makeAttempt({ id: 'newer', role: 'Newer Attempt', updatedAt: '2026-08-01T00:00:00.000Z', checkpoint: 'tailoring' }),
        ]),
      });

      render(<ApplicationsPage />);
      fireEvent.click(screen.getByRole('tab', { name: 'In progress' }));

      await waitFor(() => expect(screen.getByText('Newer Attempt')).toBeInTheDocument());
      const [firstRow, secondRow] = screen.getAllByRole('row').slice(1);
      expect(within(firstRow!).getByText('Newer Attempt')).toBeInTheDocument();
      expect(within(firstRow!).getByText('Tailoring CV')).toBeInTheDocument();
      expect(within(secondRow!).getByText('Older Attempt')).toBeInTheDocument();
      expect(within(secondRow!).getByText('Needs your input')).toBeInTheDocument();
    });

    it('opens a read-only detail drawer with the checkpoint, JD snapshot, and documents; has no edit affordance', async () => {
      const attempt = makeAttempt({
        checkpointDetail: 'Waiting for you to review the tailored CV.',
        jdSnapshot: 'Full job description text here.',
      });
      const listApplicationArtifacts = vi.fn().mockResolvedValue([
        { id: 'art-1', attemptId: attempt.id, kind: 'cv_pdf', fileName: 'cv.pdf', mimeType: 'application/pdf', byteSize: 51200, contentHash: 'h', storagePath: '', createdAt: '2026-08-20T10:00:00.000Z' },
      ]);
      installWorkspaceBridge({
        listApplications: vi.fn().mockResolvedValue([]),
        listApplicationAttempts: vi.fn().mockResolvedValue([attempt]),
        listApplicationArtifacts,
      });

      render(<ApplicationsPage />);
      fireEvent.click(screen.getByRole('tab', { name: 'In progress' }));
      await waitFor(() => expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('row', { name: /senior frontend engineer/i }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Waiting for you to review the tailored CV.')).toBeInTheDocument();
      expect(listApplicationArtifacts).toHaveBeenCalledWith(attempt.id);
      await waitFor(() => expect(within(dialog).getByText('Tailored CV')).toBeInTheDocument());
      expect(within(dialog).queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();

      // Two buttons share the accessible name "Close" here (the header's icon button and the
      // footer's text button); the footer one is the second in document order.
      const closeButtons = within(dialog).getAllByRole('button', { name: /^close$/i });
      fireEvent.click(closeButtons[closeButtons.length - 1]!);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('surfaces an attempts load error without crashing', async () => {
      installWorkspaceBridge({
        listApplications: vi.fn().mockResolvedValue([]),
        listApplicationAttempts: vi.fn().mockRejectedValue(new Error('workspace unreachable')),
      });

      render(<ApplicationsPage />);
      fireEvent.click(screen.getByRole('tab', { name: 'In progress' }));

      await waitFor(() => expect(screen.getByText(/workspace unreachable/i)).toBeInTheDocument());
    });

    it('hides the "Add application" button while on the In progress tab', async () => {
      installWorkspaceBridge({
        listApplications: vi.fn().mockResolvedValue([]),
        listApplicationAttempts: vi.fn().mockResolvedValue([]),
      });

      render(<ApplicationsPage />);
      expect(screen.getByRole('button', { name: /^add application$/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: 'In progress' }));
      await waitFor(() => expect(screen.getByText('Nothing in progress')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /^add application$/i })).not.toBeInTheDocument();
    });
  });
});
