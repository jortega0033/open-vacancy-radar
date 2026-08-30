import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SavedJobsPage } from '../../../src/components/saved/index.js';
import type { SavedJobRecord } from '../../../src/window.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';

function makeJob(overrides: Partial<SavedJobRecord> = {}): SavedJobRecord {
  return {
    id: overrides.id ?? 'job-1',
    vacancyKey: null,
    role: 'Senior Frontend Engineer',
    company: 'Acme Corp',
    market: 'netherlands',
    location: 'Amsterdam',
    salary: 'EUR 6,500/month',
    arrangement: 'Hybrid',
    verification: 'Recognised sponsor',
    matchPercent: 82,
    sourceUrl: 'https://example.com/jobs/1',
    notes: '',
    status: 'considering',
    savedAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SavedJobsPage', () => {
  it('shows an empty state when there are no saved jobs', async () => {
    installWorkspaceBridge({ listSavedJobs: vi.fn().mockResolvedValue([]) });
    render(<SavedJobsPage />);

    await waitFor(() => expect(screen.getByText(/no saved jobs/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /add first job/i })).toBeInTheDocument();
    expect(screen.getByTestId('empty-state-illustration').getAttribute('style')).toContain(
      'empty-saved-jobs',
    );
  });

  it('renders the saved job list', async () => {
    installWorkspaceBridge({
      listSavedJobs: vi.fn().mockResolvedValue([
        makeJob({ id: 'a', role: 'Senior Frontend Engineer' }),
        makeJob({ id: 'b', role: 'Staff Frontend Architect', company: 'Redwood Software' }),
      ]),
    });

    render(<SavedJobsPage />);

    await waitFor(() => expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument());
    expect(screen.getByText('Staff Frontend Architect')).toBeInTheDocument();
    expect(screen.getByText('Redwood Software')).toBeInTheDocument();
  });

  it('filters the list by role or company, case-insensitively', async () => {
    installWorkspaceBridge({
      listSavedJobs: vi.fn().mockResolvedValue([
        makeJob({ id: 'a', role: 'Senior Frontend Engineer', company: 'Acme Corp' }),
        makeJob({ id: 'b', role: 'Backend Engineer', company: 'Redwood Software' }),
        makeJob({ id: 'c', role: 'Staff Architect', company: 'FRONTEND Widgets' }),
      ]),
    });

    render(<SavedJobsPage />);
    await waitFor(() => expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument());

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'frontend' } });

    expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument();
    expect(screen.getByText('Staff Architect')).toBeInTheDocument();
    expect(screen.queryByText('Backend Engineer')).not.toBeInTheDocument();
  });

  it('shows a distinct "no matches" state when the filter excludes everything', async () => {
    installWorkspaceBridge({
      listSavedJobs: vi.fn().mockResolvedValue([makeJob({ id: 'a', role: 'Senior Frontend Engineer' })]),
    });

    render(<SavedJobsPage />);
    await waitFor(() => expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument());

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nonexistent-role-xyz' } });

    await waitFor(() => expect(screen.getByText(/no saved jobs match that search/i)).toBeInTheDocument());
    expect(screen.getByTestId('empty-state-illustration').getAttribute('style')).toContain('no-results');
  });

  it('validates required fields and calls createSavedJob when adding a job', async () => {
    const createSavedJob = vi.fn().mockResolvedValue(
      makeJob({ id: 'new-1', role: 'New Role', company: 'New Co', status: 'considering' }),
    );
    installWorkspaceBridge({ listSavedJobs: vi.fn().mockResolvedValue([]), createSavedJob });

    render(<SavedJobsPage />);
    await waitFor(() => expect(screen.getByText(/no saved jobs/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /add job manually/i }));

    const dialog = await screen.findByRole('dialog', { name: /add saved job/i });

    // Submitting blank required fields shows the prototype's inline validation message and does
    // not call the bridge.
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));
    expect(await within(dialog).findByText(/role and company are required/i)).toBeInTheDocument();
    expect(createSavedJob).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText(/^role$/i), { target: { value: 'New Role' } });
    fireEvent.change(within(dialog).getByLabelText(/^company$/i), { target: { value: 'New Co' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(createSavedJob).toHaveBeenCalledTimes(1));
    expect(createSavedJob).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'New Role', company: 'New Co' }),
    );

    await waitFor(() => expect(screen.getByText('New Role')).toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: /add saved job/i })).not.toBeInTheDocument();
  });

  it('pre-fills the drawer on edit and calls updateSavedJob', async () => {
    const job = makeJob({ id: 'edit-1', role: 'Senior Frontend Engineer', company: 'Acme Corp' });
    const updateSavedJob = vi.fn().mockResolvedValue({ ...job, role: 'Staff Frontend Engineer' });
    installWorkspaceBridge({ listSavedJobs: vi.fn().mockResolvedValue([job]), updateSavedJob });

    render(<SavedJobsPage />);
    await waitFor(() => expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));

    const dialog = await screen.findByRole('dialog', { name: /edit saved job/i });
    expect(within(dialog).getByLabelText(/^role$/i)).toHaveValue('Senior Frontend Engineer');
    expect(within(dialog).getByLabelText(/^company$/i)).toHaveValue('Acme Corp');

    fireEvent.change(within(dialog).getByLabelText(/^role$/i), { target: { value: 'Staff Frontend Engineer' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(updateSavedJob).toHaveBeenCalledTimes(1));
    expect(updateSavedJob).toHaveBeenCalledWith('edit-1', expect.objectContaining({ role: 'Staff Frontend Engineer' }));
    await waitFor(() => expect(screen.getByText('Staff Frontend Engineer')).toBeInTheDocument());
  });

  it('deletes a job through the confirm dialog, then restores an equivalent record via undo', async () => {
    const job = makeJob({ id: 'del-1', role: 'Senior Frontend Engineer', company: 'Acme Corp' });
    const deleteSavedJob = vi.fn().mockResolvedValue({ deleted: true });
    const createSavedJob = vi.fn().mockResolvedValue(makeJob({ id: 'recreated-1', role: job.role, company: job.company }));
    installWorkspaceBridge({ listSavedJobs: vi.fn().mockResolvedValue([job]), deleteSavedJob, createSavedJob });

    render(<SavedJobsPage />);
    await waitFor(() => expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    const confirmDialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(deleteSavedJob).toHaveBeenCalledWith('del-1'));
    await waitFor(() => expect(screen.getByText(/no saved jobs/i)).toBeInTheDocument());

    const undoButton = await screen.findByRole('button', { name: /undo/i });
    fireEvent.click(undoButton);

    await waitFor(() => expect(createSavedJob).toHaveBeenCalledTimes(1));
    expect(createSavedJob).toHaveBeenCalledWith(
      expect.objectContaining({ role: job.role, company: job.company }),
    );
    await waitFor(() => expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument());
  });

  it('cancels a delete without calling deleteSavedJob', async () => {
    const job = makeJob({ id: 'keep-1' });
    const deleteSavedJob = vi.fn().mockResolvedValue({ deleted: true });
    installWorkspaceBridge({ listSavedJobs: vi.fn().mockResolvedValue([job]), deleteSavedJob });

    render(<SavedJobsPage />);
    await waitFor(() => expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    const confirmDialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(deleteSavedJob).not.toHaveBeenCalled();
    expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument();
  });

  it('updates status inline via the row select', async () => {
    const job = makeJob({ id: 'status-1', status: 'considering' });
    const updateSavedJob = vi.fn().mockResolvedValue({ ...job, status: 'applied' });
    installWorkspaceBridge({ listSavedJobs: vi.fn().mockResolvedValue([job]), updateSavedJob });

    render(<SavedJobsPage />);
    await waitFor(() => expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/status for senior frontend engineer/i), {
      target: { value: 'applied' },
    });

    await waitFor(() =>
      expect(updateSavedJob).toHaveBeenCalledWith('status-1', { status: 'applied' }),
    );
  });

  it('surfaces a load error without crashing', async () => {
    installWorkspaceBridge({ listSavedJobs: vi.fn().mockRejectedValue(new Error('database unreachable')) });

    render(<SavedJobsPage />);

    await waitFor(() => expect(screen.getByText(/database unreachable/i)).toBeInTheDocument());
  });
});
