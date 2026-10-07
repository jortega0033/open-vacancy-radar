import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationsPage } from '../../../src/components/applications/index.js';
import { SKIP_UNDO_MS } from '../../../src/components/applications/ApplicationsPage.js';
import type { ApplicationAttemptRecord } from '../../../src/window.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';

/**
 * #468: a skip can be undone from a toast and from the history drawer, and a failed preparation
 * can be tried again from that drawer. All records are synthetic.
 */

function makeAttempt(overrides: Partial<ApplicationAttemptRecord> = {}): ApplicationAttemptRecord {
  return {
    id: overrides.id ?? 'attempt-recovery-1',
    applicationId: null,
    vacancyKey: null,
    canonicalUrl: 'https://jobs.example.invalid/apply/recovery',
    employerKey: 'acme-corp',
    requisitionId: null,
    canonicalUrlKey: 'jobs.example.invalid/apply/recovery',
    company: 'Acme Corp',
    role: 'Senior Frontend Engineer',
    sourceCvId: null,
    sourceCvContentHash: 'hash-1',
    jdSnapshot: 'Synthetic job description.',
    jdSnapshotHash: 'jd-hash-1',
    jdComplete: true,
    workflowVersion: 'v1',
    tailoringMode: 'ai',
    checkpoint: 'ready',
    checkpointDetail: '',
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    submittedAt: null,
    formStructureHash: null,
    scheduledAutomaticSubmitAt: null,
    submissionMode: null,
    completionEvidence: null,
    supersedesAttemptId: null,
    reapplyReason: '',
    reapplyPreviousCvContentHash: null,
    preparedFields: null,
    ...overrides,
  };
}

/** A stateful stand-in for the workspace: the one attempt moves when it is patched. */
function installAttemptStore(initial: ApplicationAttemptRecord) {
  let current = initial;
  const updateApplicationAttempt = vi.fn(async (_id: string, patch: Partial<ApplicationAttemptRecord>) => {
    current = { ...current, ...patch };
    return current;
  });
  const getApplicationAttempt = vi.fn(async () => current);
  installWorkspaceBridge({
    listApplications: vi.fn().mockResolvedValue([]),
    listApplicationAttempts: vi.fn(async () => [current]),
    getApplicationAttempt,
    listApplicationArtifacts: vi.fn().mockResolvedValue([]),
    updateApplicationAttempt,
  });
  return {
    updateApplicationAttempt,
    getApplicationAttempt,
    setCurrent: (next: ApplicationAttemptRecord) => {
      current = next;
    },
  };
}

/** No compiled policy for the URL, so the review opens as the manual card with its Skip button. */
function installManualExecutor() {
  (window as unknown as { applicationExecutor: unknown }).applicationExecutor = {
    resolveTargetPolicyId: vi.fn().mockResolvedValue(null),
    openReview: vi.fn(),
    closeReview: vi.fn().mockResolvedValue(undefined),
    hideHandoff: vi.fn().mockResolvedValue(undefined),
  };
}

async function openHistoryRow() {
  fireEvent.click(screen.getByRole('tab', { name: 'Ready to apply' }));
  fireEvent.click(await screen.findByRole('button', { name: 'History (1)' }));
  fireEvent.click(await screen.findByRole('row', { name: /senior frontend engineer/i }));
  return screen.findByRole('dialog');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('skip undo (#468)', () => {
  it('keeps the undo up for at least 8 seconds', () => {
    expect(SKIP_UNDO_MS).toBeGreaterThanOrEqual(8_000);
  });

  it('shows "Skipped {role} at {company}." with Undo after a skip, and Undo returns the attempt to review', async () => {
    const attempt = makeAttempt({ checkpointDetail: 'Your application documents are ready.' });
    const store = installAttemptStore(attempt);
    installManualExecutor();

    render(<ApplicationsPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Ready to apply' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Skip' }));

    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('Skipped Senior Frontend Engineer at Acme Corp.');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));

    // Restores the checkpoint and detail the attempt had before the skip.
    await waitFor(() =>
      expect(store.updateApplicationAttempt).toHaveBeenLastCalledWith(attempt.id, {
        checkpoint: 'ready',
        checkpointDetail: 'Your application documents are ready.',
      }),
    );
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('does not touch an attempt that has moved on from skipped when Undo is pressed', async () => {
    const attempt = makeAttempt();
    const store = installAttemptStore(attempt);
    installManualExecutor();

    render(<ApplicationsPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Ready to apply' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Skip' }));
    const toast = await screen.findByRole('status');

    // Something else advanced the attempt in the meantime.
    store.setCurrent({ ...attempt, checkpoint: 'submitted' });
    store.updateApplicationAttempt.mockClear();
    store.getApplicationAttempt.mockClear();
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(store.getApplicationAttempt).toHaveBeenCalled());
    expect(store.updateApplicationAttempt).not.toHaveBeenCalled();
  });
});

describe('history drawer recovery (#468)', () => {
  it('offers Return to review for a skipped attempt and reopens the review', async () => {
    const attempt = makeAttempt({ checkpoint: 'skipped' });
    const store = installAttemptStore(attempt);
    installManualExecutor();

    render(<ApplicationsPage />);
    const drawer = await openHistoryRow();
    expect(within(drawer).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Return to review' }));

    await waitFor(() =>
      expect(store.updateApplicationAttempt).toHaveBeenCalledWith(attempt.id, { checkpoint: 'ready', checkpointDetail: '' }),
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent(/review application/i));
  });

  it('refuses to return an attempt to review once it is no longer skipped', async () => {
    const attempt = makeAttempt({ checkpoint: 'skipped' });
    const store = installAttemptStore(attempt);
    installManualExecutor();

    render(<ApplicationsPage />);
    const drawer = await openHistoryRow();
    store.setCurrent({ ...attempt, checkpoint: 'submitted' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Return to review' }));

    expect(await within(drawer).findByRole('alert')).toHaveTextContent('This application is no longer skipped.');
    expect(store.updateApplicationAttempt).not.toHaveBeenCalled();
  });

  it('offers Try again for a failed attempt, which queues preparation again and closes the drawer', async () => {
    const attempt = makeAttempt({ checkpoint: 'failed', checkpointDetail: 'preparing this application failed: offline' });
    installAttemptStore(attempt);
    const resume = vi.fn().mockResolvedValue({ ok: true, attemptId: attempt.id, tailoringMode: 'ai' });
    (window as unknown as { applicationPipeline: unknown }).applicationPipeline = { resume };

    render(<ApplicationsPage />);
    const drawer = await openHistoryRow();
    expect(within(drawer).queryByRole('button', { name: 'Return to review' })).not.toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(resume).toHaveBeenCalledWith(attempt.id));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows the reason inline when a retry is refused', async () => {
    const attempt = makeAttempt({ checkpoint: 'failed' });
    installAttemptStore(attempt);
    (window as unknown as { applicationPipeline: unknown }).applicationPipeline = {
      resume: vi.fn().mockResolvedValue({
        ok: false,
        attemptId: attempt.id,
        tailoringMode: 'ai',
        detail: 'this application is not waiting on a preparation blocker',
      }),
    };

    render(<ApplicationsPage />);
    const drawer = await openHistoryRow();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Try again' }));

    expect(await within(drawer).findByRole('alert')).toHaveTextContent('not waiting on a preparation blocker');
  });

  it('shows neither recovery action for a submitted attempt', async () => {
    installAttemptStore(makeAttempt({ checkpoint: 'submitted' }));

    render(<ApplicationsPage />);
    const drawer = await openHistoryRow();
    expect(within(drawer).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Return to review' })).not.toBeInTheDocument();
  });
});
