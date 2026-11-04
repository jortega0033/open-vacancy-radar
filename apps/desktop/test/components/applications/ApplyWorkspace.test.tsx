import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplyWorkspace } from '../../../src/components/applications/ApplyWorkspace.js';
import type { ApplicationArtifactSummary, ApplicationAttemptRecord } from '../../../src/window.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';
import { resetProviderLimitsForTest } from '../../../src/provider-limits.js';

const DOCS_READY =
  'CV tailored. Your application documents are ready. This employer site is not approved for automated submission, so apply on the site yourself and mark the attempt when you finish.';

function makeAttempt(overrides: Partial<ApplicationAttemptRecord> = {}): ApplicationAttemptRecord {
  return {
    id: 'attempt-1',
    applicationId: null,
    vacancyKey: 'vac-1',
    canonicalUrl: 'https://jobs.example.com/apply/123',
    employerKey: 'acme',
    requisitionId: null,
    canonicalUrlKey: 'jobs.example.com/apply/123',
    company: 'Acme Corp',
    role: 'Frontend Engineer',
    sourceCvId: null,
    sourceCvContentHash: 'hash',
    jdSnapshot: 'Build interfaces.',
    jdSnapshotHash: 'jd',
    jdComplete: true,
    workflowVersion: 'v1',
    tailoringMode: 'ai',
    checkpoint: 'needs_user',
    checkpointDetail: DOCS_READY,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
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

function artifact(kind: ApplicationArtifactSummary['kind'], id: string): ApplicationArtifactSummary {
  return { id, attemptId: 'attempt-1', kind, fileName: `${id}.pdf` } as ApplicationArtifactSummary;
}

const CV = artifact('cv_pdf', 'cv-1');
const LETTER = artifact('cover_letter_pdf', 'letter-1');

interface Setup {
  attempts?: ApplicationAttemptRecord[];
  sequence?: ApplicationAttemptRecord[];
  documents?: ApplicationArtifactSummary[];
  policyId?: string | null;
  executor?: Record<string, unknown>;
  pipeline?: Record<string, unknown>;
}

function setup({ attempts = [], sequence, documents = [CV, LETTER], policyId = null, executor = {}, pipeline = {} }: Setup = {}) {
  const queue = [...(sequence ?? [makeAttempt()])];
  const getApplicationAttempt = vi.fn(async () => (queue.length > 1 ? queue.shift()! : queue[0]!));
  const workspace = installWorkspaceBridge({
    getApplicationAttempt,
    listApplicationArtifacts: vi.fn().mockResolvedValue(documents),
    listApplicationAttempts: vi.fn().mockResolvedValue(attempts),
    updateApplicationAttempt: vi.fn().mockResolvedValue(makeAttempt({ checkpoint: 'skipped' })),
  });
  const applicationExecutor = {
    resolveTargetPolicyId: vi.fn().mockResolvedValue(policyId),
    recordUserReportedSubmission: vi.fn().mockResolvedValue({ ok: true }),
    saveArtifact: vi.fn().mockResolvedValue({ saved: true }),
    openArtifact: vi.fn().mockResolvedValue({ opened: true }),
    openReview: vi.fn(),
    closeReview: vi.fn().mockResolvedValue(undefined),
    hideHandoff: vi.fn().mockResolvedValue(undefined),
    ...executor,
  };
  (window as unknown as { applicationExecutor: unknown }).applicationExecutor = applicationExecutor;
  const applicationPipeline = {
    resume: vi.fn().mockResolvedValue({ ok: true, attemptId: 'attempt-1', tailoringMode: 'ai' }),
    retryTailoring: vi.fn().mockResolvedValue({ ok: true, attemptId: 'attempt-1', tailoringMode: 'ai' }),
    useOriginalCv: vi.fn().mockResolvedValue({ ok: true, attemptId: 'attempt-1', tailoringMode: 'original' }),
    ...pipeline,
  };
  (window as unknown as { applicationPipeline: unknown }).applicationPipeline = applicationPipeline;
  return { workspace, getApplicationAttempt, applicationExecutor, applicationPipeline };
}

function renderWorkspace(props: Partial<Parameters<typeof ApplyWorkspace>[0]> = {}) {
  const onClose = vi.fn();
  const onOpenAttempt = vi.fn();
  const onChanged = vi.fn();
  render(
    <ApplyWorkspace
      attemptId="attempt-1"
      closeLabel="Back to the vacancy"
      onClose={onClose}
      onOpenAttempt={onOpenAttempt}
      onChanged={onChanged}
      {...props}
    />,
  );
  return { onClose, onOpenAttempt, onChanged };
}

let openSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ApplyWorkspace (#657)', () => {
  it('is a labelled page region, never a dialog, and focuses its heading on arrival', async () => {
    setup();
    renderWorkspace();
    const region = await screen.findByRole('region', { name: 'Frontend Engineer at Acme Corp' });
    expect(within(region).getByRole('heading', { level: 2 })).toHaveFocus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('streams preparation progress in a polite live region and turns ready in place', async () => {
    const preparing = makeAttempt({ checkpoint: 'tailoring', checkpointDetail: '' });
    setup({ sequence: [preparing, preparing, makeAttempt()] });
    renderWorkspace();

    const status = await screen.findByTestId('apply-workspace-status');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    await waitFor(() => expect(status).toHaveTextContent('Writing your CV for this job'));
    const steps = screen.getByRole('list', { name: 'Preparation steps' });
    expect(within(steps).getByText('Checking the posting')).toBeInTheDocument();
    expect(within(steps).getByText(/\(in progress\)/)).toBeInTheDocument();

    await waitFor(() => expect(status).toHaveTextContent("Your CV and letter are ready. You apply on Acme Corp's site."), {
      timeout: 5_000,
    });
    expect(screen.queryByRole('list', { name: 'Preparation steps' })).not.toBeInTheDocument();
    expect(screen.getByText('Ready to review')).toBeInTheDocument();
    expect(screen.queryByText(/Needs your input/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not approved for automated submission/)).not.toBeInTheDocument();
  });

  it('shows the CV and letter together with labelled Open and Save copy actions', async () => {
    const { applicationExecutor } = setup();
    renderWorkspace();
    await screen.findByText('Ready to review');

    const documents = screen.getByRole('region', { name: 'Your documents' });
    const labels = within(documents).getAllByRole('listitem').map((item) => item.firstChild?.textContent);
    expect(labels).toEqual(['Tailored CV', 'Cover letter']);
    fireEvent.click(within(documents).getByRole('button', { name: 'Open Tailored CV' }));
    await waitFor(() => expect(applicationExecutor.openArtifact).toHaveBeenCalledWith('cv-1'));
    fireEvent.click(within(documents).getByRole('button', { name: 'Save copy of Cover letter' }));
    await waitFor(() => expect(applicationExecutor.saveArtifact).toHaveBeenCalledWith('letter-1'));
    expect(await within(documents).findByText('Saved a copy of the cover letter.')).toBeInTheDocument();
  });

  it('runs Approve package, Open the employer form and I submitted it from the same workspace', async () => {
    const { applicationExecutor } = setup();
    const { onChanged } = renderWorkspace();
    await screen.findByText('Ready to review');

    // Before approval there is one primary action and nothing opens the employer site yet.
    expect(screen.queryByRole('button', { name: 'Open the employer form' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve package' }));

    const open = await screen.findByRole('button', { name: 'Open the employer form' });
    expect(open).toHaveFocus();
    fireEvent.click(open);
    expect(openSpy).toHaveBeenCalledWith('https://jobs.example.com/apply/123', '_blank', 'noopener,noreferrer');
    // Opening the employer page records nothing on its own (#271).
    expect(applicationExecutor.recordUserReportedSubmission).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'I submitted it' }));
    await waitFor(() => expect(applicationExecutor.recordUserReportedSubmission).toHaveBeenCalledWith('attempt-1'));
    expect(await screen.findByText(/Recorded\. Frontend Engineer at Acme Corp is marked as applied\./)).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it('records I submitted it once, even on a double click', async () => {
    let resolveRecord!: (value: { ok: boolean }) => void;
    const recordUserReportedSubmission = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => { resolveRecord = resolve; }));
    setup({ executor: { recordUserReportedSubmission } });
    renderWorkspace();
    await screen.findByText('Ready to review');
    fireEvent.click(screen.getByRole('button', { name: 'Approve package' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open the employer form' }));
    const submitted = screen.getByRole('button', { name: 'I submitted it' });
    fireEvent.click(submitted);
    fireEvent.click(submitted);
    expect(recordUserReportedSubmission).toHaveBeenCalledTimes(1);
    await act(async () => resolveRecord({ ok: true }));
  });

  it('keeps the second opinion optional and reachable from the workspace', async () => {
    setup();
    const get = vi.fn().mockResolvedValue({ status: 'none' });
    (window as unknown as { applicationCritique: unknown }).applicationCritique = { get, run: vi.fn(), cancel: vi.fn() };
    renderWorkspace();
    await screen.findByText('Ready to review');

    const summary = screen.getByText('Second opinion (optional)');
    expect(get).not.toHaveBeenCalled();
    const details = summary.closest('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    await waitFor(() => expect(get).toHaveBeenCalledWith('attempt-1'));
  });

  it('shows a missing letter on the page with Try again, Generate letter and the employer form', async () => {
    const detail = 'Your tailored CV is ready. Cover letter blocker: unsupported source facts. Use Generate letter.';
    const { applicationPipeline } = setup({ sequence: [makeAttempt({ checkpointDetail: detail })], documents: [CV] });
    const onGenerateLetter = vi.fn();
    renderWorkspace({ onGenerateLetter });

    const missing = await screen.findByTestId('apply-letter-missing');
    expect(within(missing).getByText(/The cover letter could not be written\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open the employer form' })).toBeInTheDocument();
    fireEvent.click(within(missing).getByRole('button', { name: 'Generate letter' }));
    expect(onGenerateLetter).toHaveBeenCalledWith(expect.objectContaining({ key: 'vac-1', title: 'Frontend Engineer' }), 'attempt-1');
    fireEvent.click(within(missing).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(applicationPipeline.resume).toHaveBeenCalledWith('attempt-1'));
  });

  it('holds Try again until a provider limit resets and keeps the other actions available', async () => {
    resetProviderLimitsForTest();
    const stopped = makeAttempt({
      checkpointDetail: "Automatic CV tailoring stopped: You've hit your session limit · resets 11:59pm",
      updatedAt: new Date().toISOString(),
    });
    const { applicationPipeline } = setup({ sequence: [stopped] });
    renderWorkspace();

    expect(await screen.findByText(/Claude has reached its usage limit until 11:59pm\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Try again after / })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open the employer form' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Use my CV as it is' }));
    await waitFor(() => expect(applicationPipeline.useOriginalCv).toHaveBeenCalledWith('attempt-1'));
    // The restart stays in place: the same workspace goes back to preparing.
    expect(screen.getByTestId('apply-workspace')).toBeInTheDocument();
    resetProviderLimitsForTest();
  });

  it('shows a preparation stop with no documents and its Resume action, never "documents are ready"', async () => {
    const { applicationPipeline } = setup({
      sequence: [makeAttempt({ checkpointDetail: 'the captured job description is incomplete' })],
      documents: [],
    });
    renderWorkspace();

    expect(await screen.findByText('This application needs your attention.')).toBeInTheDocument();
    expect(screen.getByText('the captured job description is incomplete').closest('details')).not.toHaveAttribute('open');
    expect(screen.queryByText(/documents are ready/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open the employer form' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(applicationPipeline.resume).toHaveBeenCalledWith('attempt-1'));
  });

  it('skips with an Undo that stays in place and restores the exact checkpoint', async () => {
    const ready = makeAttempt();
    const { workspace } = setup({ sequence: [ready] });
    renderWorkspace();
    await screen.findByText('Ready to review');

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(workspace.updateApplicationAttempt).toHaveBeenCalledWith('attempt-1', { checkpoint: 'skipped' }));
    expect(await screen.findByText('Skipped Frontend Engineer at Acme Corp.')).toBeInTheDocument();

    (workspace.getApplicationAttempt as ReturnType<typeof vi.fn>).mockResolvedValue({ ...ready, checkpoint: 'skipped' });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(workspace.updateApplicationAttempt).toHaveBeenCalledWith('attempt-1', {
        checkpoint: 'needs_user',
        checkpointDetail: DOCS_READY,
      }),
    );
  });

  it('offers Next ready application when another application waits', async () => {
    const other = makeAttempt({ id: 'attempt-2', role: 'Designer', company: 'Globex', updatedAt: '2026-10-02T00:00:00.000Z' });
    setup({ attempts: [makeAttempt(), other] });
    const { onOpenAttempt } = renderWorkspace();
    await screen.findByText('Ready to review');

    const next = await screen.findByRole('button', { name: 'Next ready application' });
    expect(next).toHaveAccessibleDescription('Designer at Globex');
    fireEvent.click(next);
    expect(onOpenAttempt).toHaveBeenCalledWith('attempt-2');
  });

  it('shows no Next ready application when nothing else waits', async () => {
    setup({ attempts: [makeAttempt()] });
    renderWorkspace();
    await screen.findByText('Ready to review');
    await act(async () => undefined);
    expect(screen.queryByRole('button', { name: 'Next ready application' })).not.toBeInTheDocument();
  });

  it('keeps the allowlisted live review dialog for a policy-backed site (#202, #443)', async () => {
    const ready = makeAttempt({ checkpoint: 'ready', checkpointDetail: '' });
    const openReview = vi.fn(() => new Promise(() => {}));
    setup({ sequence: [ready], policyId: 'local-fixture-policy', executor: { openReview } });
    renderWorkspace();

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await waitFor(() => expect(openReview).toHaveBeenCalledWith({
      attemptId: 'attempt-1',
      policyId: 'local-fixture-policy',
      targetUrl: 'https://jobs.example.com/apply/123',
    }));
    // The manual actions never render for an allowlisted site.
    expect(screen.queryByRole('button', { name: 'Approve package' })).not.toBeInTheDocument();
  });

  it('every action is a labelled button and no em dash reaches the screen', async () => {
    setup({ attempts: [makeAttempt(), makeAttempt({ id: 'attempt-2' })] });
    renderWorkspace();
    await screen.findByText('Ready to review');
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName();
    }
    expect(screen.getByTestId('apply-workspace').textContent).not.toMatch(/—/);
  });

  it('leaves through the labelled Back control', async () => {
    setup();
    const { onClose } = renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Back to the vacancy' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ApplyWorkspace: a send in progress (#657 review)', () => {
  const sending = makeAttempt({ checkpoint: 'submitting', checkpointDetail: '' });

  it('says the application is being sent, never that it is still being prepared, and offers no manual submit', async () => {
    setup({ sequence: [sending] });
    renderWorkspace();

    const status = await screen.findByTestId('apply-workspace-status');
    await waitFor(() => expect(status).toHaveTextContent('Sending your application…'));
    const note = screen.getByTestId('apply-workspace-sending');
    expect(note).toHaveTextContent("Your application is being sent to Acme Corp. Do not submit it on the employer's site as well.");
    // None of the preparation view: no steps, no "Writing your letter", no "turns ready here" promise.
    expect(screen.queryByRole('list', { name: 'Preparation steps' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Writing your letter/)).not.toBeInTheDocument();
    expect(screen.queryByText(/turns ready here/)).not.toBeInTheDocument();
    expect(screen.queryByText('Ready to review')).not.toBeInTheDocument();
    // Nothing that could lead to a second, manual submission while the send is in flight.
    for (const name of ['Open the employer form', 'Approve package', 'I submitted it', 'I already submitted it', 'Skip']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('hands the application to the host once the send settles', async () => {
    const sent = makeAttempt({ checkpoint: 'submission_unknown', checkpointDetail: '', updatedAt: '2026-10-01T10:05:00.000Z' });
    setup({ sequence: [sending, sending, sent] });
    const onFinished = vi.fn();
    renderWorkspace({ onFinished });

    await screen.findByTestId('apply-workspace-sending');
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith(expect.objectContaining({ checkpoint: 'submission_unknown' })), {
      timeout: 5_000,
    });
    expect(onFinished).toHaveBeenCalledTimes(1);
  });
});

describe('ApplyWorkspace: a finished application (#657 review)', () => {
  it.each(['user_reported', 'submission_unknown', 'failed', 'skipped', 'submitted'] as const)(
    'hands a %s application read on opening to the host history view',
    async (checkpoint) => {
      const finished = makeAttempt({ checkpoint, checkpointDetail: '' });
      setup({ sequence: [finished] });
      const onFinished = vi.fn();
      renderWorkspace({ onFinished });
      await waitFor(() => expect(onFinished).toHaveBeenCalledWith(expect.objectContaining({ id: 'attempt-1', checkpoint })));
      expect(onFinished).toHaveBeenCalledTimes(1);
    },
  );

  it('decides from a fresh read: a stale skipped list row that was put back in review stays in the workspace', async () => {
    const staleRow = makeAttempt({ checkpoint: 'skipped' });
    const restored = makeAttempt({ updatedAt: '2026-10-01T10:05:00.000Z' });
    setup({ sequence: [restored] });
    const onFinished = vi.fn();
    renderWorkspace({ onFinished, initialAttempt: staleRow });

    expect(await screen.findByRole('button', { name: 'Approve package' })).toBeInTheDocument();
    expect(onFinished).not.toHaveBeenCalled();
  });
});

describe('ApplyWorkspace: I already submitted it (#657 review)', () => {
  it('records the submission from the ready view without opening the employer form', async () => {
    const { applicationExecutor } = setup();
    const { onChanged } = renderWorkspace();
    await screen.findByText('Ready to review');

    expect(screen.getByText("Already submitted it on Acme Corp's site?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'I already submitted it' }));
    await waitFor(() => expect(applicationExecutor.recordUserReportedSubmission).toHaveBeenCalledWith('attempt-1'));
    expect(await screen.findByText(/Recorded\. Frontend Engineer at Acme Corp is marked as applied\./)).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });

  it('records it from the approved view too, still without opening the employer form', async () => {
    const { applicationExecutor } = setup();
    renderWorkspace();
    await screen.findByText('Ready to review');
    fireEvent.click(screen.getByRole('button', { name: 'Approve package' }));
    await screen.findByRole('button', { name: 'Open the employer form' });

    fireEvent.click(screen.getByRole('button', { name: 'I already submitted it' }));
    await waitFor(() => expect(applicationExecutor.recordUserReportedSubmission).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/is marked as applied/)).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('shows a failed record as not sent', async () => {
    const recordUserReportedSubmission = vi.fn().mockResolvedValue({ ok: false, reason: 'not_found', detail: 'no such application' });
    setup({ executor: { recordUserReportedSubmission } });
    renderWorkspace();
    await screen.findByText('Ready to review');
    fireEvent.click(screen.getByRole('button', { name: 'I already submitted it' }));
    expect(await screen.findByText('Not sent. We could not record this application.')).toBeInTheDocument();
    expect(recordUserReportedSubmission).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/is marked as applied/)).not.toBeInTheDocument();
  });
});

describe('ApplyWorkspace: focus after each step (#657 review)', () => {
  it('moves focus to I submitted it after opening the employer form, then to Back after recording', async () => {
    setup();
    renderWorkspace();
    await screen.findByText('Ready to review');
    fireEvent.click(screen.getByRole('button', { name: 'Approve package' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open the employer form' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'I submitted it' })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'I submitted it' }));
    await screen.findByText(/is marked as applied/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back to the vacancy' })).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it('moves focus to Undo after Skip, and to the workspace heading after Undo', async () => {
    const ready = makeAttempt();
    const { workspace } = setup({ sequence: [ready] });
    renderWorkspace();
    await screen.findByText('Ready to review');

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    const undo = await screen.findByRole('button', { name: 'Undo' });
    await waitFor(() => expect(undo).toHaveFocus());

    // Undo reads the stored record once (still skipped), puts it back, then reads the restored record.
    (workspace.getApplicationAttempt as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...ready, checkpoint: 'skipped' });
    fireEvent.click(undo);
    const heading = screen.getByRole('heading', { level: 2, name: 'Frontend Engineer at Acme Corp' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(await screen.findByRole('button', { name: 'Approve package' })).toBeInTheDocument();
    expect(heading).toHaveFocus();
  });
});
