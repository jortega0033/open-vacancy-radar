import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InterviewPrepDrawer } from '../../../src/components/applications/InterviewPrepDrawer.js';
import type {
  ApplicationAttemptRecord,
  ApplicationRecord,
  CvDocumentRecord,
  LetterRecord,
  SavedJobRecord,
} from '../../../src/window.js';
import { installBridges } from '../../cv-bridges.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';

function makeApplication(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    id: 'app-1',
    savedJobId: 'saved-1',
    role: 'Senior Frontend Engineer',
    company: 'Redwood Software',
    location: 'Amsterdam, Netherlands',
    verification: 'Recognised sponsor',
    status: 'interview',
    appliedAt: '2026-08-01T10:00:00.000Z',
    nextStep: 'Technical interview, Friday 10:00',
    contact: 'Jane Recruiter',
    cvId: 'cv-1',
    letterId: 'letter-1',
    notes: 'Team is migrating from Angular to React.',
    archived: false,
    ...overrides,
  };
}

function makeSavedJob(overrides: Partial<SavedJobRecord> = {}): SavedJobRecord {
  return {
    id: 'saved-1',
    vacancyKey: 'vk-1',
    role: 'Senior Frontend Engineer',
    company: 'Redwood Software',
    location: 'Amsterdam, Netherlands',
    salary: 'EUR 6,500/month',
    arrangement: 'Hybrid',
    verification: 'Recognised sponsor',
    matchPercent: 82,
    sourceUrl: 'https://example.invalid/jobs/1',
    notes: '',
    status: 'applied',
    savedAt: '2026-07-01T10:00:00.000Z',
    gapAnalysis: null,
    gapAnalysisAt: null,
    ...overrides,
  };
}

function makeCv(overrides: Partial<CvDocumentRecord> = {}): CvDocumentRecord {
  return {
    id: 'cv-1',
    name: 'cv.pdf',
    kind: 'uploaded',
    targetRole: '',
    text: 'Angular architect. 8 years of frontend work. Led the design system rebuild.',
    profile: { title: '', years: '', location: '', languages: '', skills: [], summary: '', auth: '' },
    source: null,
    isDefault: true,
    uploadedAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

function makeLetter(overrides: Partial<LetterRecord> = {}): LetterRecord {
  return {
    id: 'letter-1',
    title: 'Cover letter for Redwood',
    company: 'Redwood Software',
    role: 'Senior Frontend Engineer',
    type: 'cover_letter',
    tone: 'natural',
    length: 'standard',
    status: 'final',
    vacancyKey: 'vk-1',
    cvId: 'cv-1',
    body: 'I am excited to apply for the Senior Frontend Engineer role.',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<ApplicationAttemptRecord> = {}): ApplicationAttemptRecord {
  return {
    id: 'attempt-1',
    applicationId: 'app-1',
    vacancyKey: 'vk-1',
    canonicalUrl: 'https://example.invalid/jobs/1',
    employerKey: 'redwood-software',
    requisitionId: null,
    canonicalUrlKey: 'example.invalid/jobs/1',
    company: 'Redwood Software',
    role: 'Senior Frontend Engineer',
    sourceCvId: 'cv-1',
    sourceCvContentHash: 'hash-1',
    jdSnapshot: 'Build and own the design system. Five years of frontend experience required.',
    jdSnapshotHash: 'jd-hash-1',
    jdComplete: true,
    workflowVersion: 'v1',
    tailoringMode: 'ai',
    checkpoint: 'submitted',
    checkpointDetail: '',
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:30:00.000Z',
    submittedAt: '2026-08-01T09:30:00.000Z',
    formStructureHash: null,
    scheduledAutomaticSubmitAt: null,
    submissionMode: 'manual',
    completionEvidence: null,
    supersedesAttemptId: null,
    reapplyReason: '',
    reapplyPreviousCvContentHash: null,
    preparedFields: null,
    ...overrides,
  };
}

function setupBridges(options: {
  attempts?: ApplicationAttemptRecord[];
  savedJobs?: SavedJobRecord[];
  cvDocuments?: CvDocumentRecord[];
  letters?: LetterRecord[];
} = {}) {
  const bridges = installBridges();
  const workspace = installWorkspaceBridge({
    listApplicationAttempts: vi.fn().mockResolvedValue(options.attempts ?? [makeAttempt()]),
    listSavedJobs: vi.fn().mockResolvedValue(options.savedJobs ?? [makeSavedJob()]),
    listCvDocuments: vi.fn().mockResolvedValue(options.cvDocuments ?? [makeCv()]),
    listLetters: vi.fn().mockResolvedValue(options.letters ?? [makeLetter()]),
  });
  return { ...bridges, workspace };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('InterviewPrepDrawer', () => {
  it('builds a prompt carrying every data section for a full context, and starts a run only on explicit click', async () => {
    const bridges = setupBridges();
    render(
      <InterviewPrepDrawer
        application={makeApplication()}
        savedJobs={[makeSavedJob()]}
        cvDocuments={[makeCv()]}
        letters={[makeLetter()]}
        onClose={vi.fn()}
      />,
    );

    // Opening the drawer alone must never start a run: this is a real AI turn, gated behind an
    // explicit click (mirroring GapAnalysis's "Check ATS fit" button).
    await waitFor(() => expect(bridges.workspace.listApplicationAttempts).toHaveBeenCalled());
    expect(bridges.agentDock.createSession).not.toHaveBeenCalled();

    await waitFor(() => expect(screen.getByRole('button', { name: /generate prep pack/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /generate prep pack/i }));

    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));
    const input = vi.mocked(bridges.agentDock.createSession).mock.calls[0]?.[0];
    expect(input?.prompt).toContain('## Likely questions');
    expect(input?.prompt).toContain('=== SAVED JOB DETAILS ===');
    expect(input?.prompt).toContain('=== VACANCY / JOB DESCRIPTION');
    expect(input?.prompt).toContain('=== YOUR CURRENT LINKED CV');
    expect(input?.prompt).toContain('=== YOUR CURRENT LINKED LETTER');
    expect(input?.prompt).toContain('Senior Frontend Engineer');

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: '## Likely questions' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    await waitFor(() =>
      expect(screen.getByRole('log', { name: /interview prep result/i })).toHaveTextContent(
        '## Likely questions',
      ),
    );
  });

  it('reflects missing CV, letter and JD snapshot in the actual prompt sent to the agent', async () => {
    const bridges = setupBridges({ attempts: [], cvDocuments: [], letters: [] });
    render(
      <InterviewPrepDrawer
        application={makeApplication({ cvId: null, letterId: null })}
        savedJobs={[makeSavedJob()]}
        cvDocuments={[]}
        letters={[]}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: /generate prep pack/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /generate prep pack/i }));

    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));
    const input = vi.mocked(bridges.agentDock.createSession).mock.calls[0]?.[0];
    expect(input?.prompt).toContain('No CV is linked to this application.');
    expect(input?.prompt).toContain('No letter is linked to this application.');
    expect(input?.prompt).toContain('No job description snapshot is available for this application.');
    expect(input?.prompt).not.toContain('=== YOUR CURRENT LINKED CV');
    expect(input?.prompt).not.toContain('=== YOUR CURRENT LINKED LETTER');
    expect(input?.prompt).not.toContain('=== VACANCY / JOB DESCRIPTION');
  });

  it('copies the result to the clipboard and shows the 2s "Copied" feedback', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const bridges = setupBridges();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(
      <InterviewPrepDrawer
        application={makeApplication()}
        savedJobs={[makeSavedJob()]}
        cvDocuments={[makeCv()]}
        letters={[makeLetter()]}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: /generate prep pack/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /generate prep pack/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Grounded prep pack.' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    const copyButton = await screen.findByRole('button', { name: /copy to clipboard/i });
    fireEvent.click(copyButton);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Grounded prep pack.'));
    expect(screen.getByText('Copied')).toBeInTheDocument();

    vi.advanceTimersByTime(2_000);
    await waitFor(() => expect(screen.queryByText('Copied')).not.toBeInTheDocument());
    vi.useRealTimers();
  });

  it('never calls a mutating workspace method across a full render + run + close cycle', async () => {
    const bridges = setupBridges();
    const onClose = vi.fn();
    render(
      <InterviewPrepDrawer
        application={makeApplication()}
        savedJobs={[makeSavedJob()]}
        cvDocuments={[makeCv()]}
        letters={[makeLetter()]}
        onClose={onClose}
      />,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: /generate prep pack/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /generate prep pack/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Grounded prep pack.' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });
    await screen.findByRole('log', { name: /interview prep result/i });

    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    expect(onClose).toHaveBeenCalledTimes(1);

    expect(bridges.workspace.updateApplication).not.toHaveBeenCalled();
    expect(bridges.workspace.updateCvDocument).not.toHaveBeenCalled();
    expect(bridges.workspace.updateLetter).not.toHaveBeenCalled();
    expect(bridges.workspace.createApplication).not.toHaveBeenCalled();
    expect(bridges.workspace.createCvDocument).not.toHaveBeenCalled();
    expect(bridges.workspace.createLetter).not.toHaveBeenCalled();
    expect(bridges.workspace.deleteApplication).not.toHaveBeenCalled();
  });

  it('shows a stage-gate message instead of the generate controls for a non-preparable status', async () => {
    setupBridges();
    render(
      <InterviewPrepDrawer
        application={makeApplication({ status: 'applied' })}
        savedJobs={[makeSavedJob()]}
        cvDocuments={[makeCv()]}
        letters={[makeLetter()]}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/recruiter screen or interview stage/i);
    expect(screen.queryByRole('button', { name: /generate prep pack/i })).not.toBeInTheDocument();
  });
});
