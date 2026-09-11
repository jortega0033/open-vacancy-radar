import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApplicationPreparedSummary } from '../../../src/components/applications/index.js';
import type { ApplicationArtifactRecord, ApplicationAttemptRecord, PreparedApplicationFields } from '../../../src/window.js';

/**
 * #272's third acceptance check at the surface a person actually reads: the review shows the exact
 * documents and committed answers for *this* employer and role, and nothing else.
 */

const PREPARED: PreparedApplicationFields = {
  version: 1,
  preparedAt: '2026-09-11T12:00:00.000Z',
  company: 'Northwind Freight',
  role: 'Logistics Platform Engineer',
  verification: 'applied',
  fields: [
    { label: 'fullName', controlType: 'text', required: true, status: 'committed', value: 'Jamie Rivera', provenance: 'cv' },
    { label: 'agreeToTerms', controlType: 'checkbox', required: true, status: 'awaiting_you', detail: 'a consent question, which this app never answers on your behalf' },
    { label: 'coverLetter', controlType: 'textarea', required: false, status: 'left_blank', detail: 'optional, and none of your saved details answers it' },
  ],
};

function attempt(overrides: Partial<ApplicationAttemptRecord> = {}): ApplicationAttemptRecord {
  return {
    id: 'attempt-1',
    applicationId: null,
    vacancyKey: 'vac-1',
    canonicalUrl: 'file:///fixtures/ashby-application-form-no-upload.html',
    employerKey: 'northwind-freight',
    requisitionId: null,
    canonicalUrlKey: 'fixtures/ashby-application-form-no-upload.html',
    company: 'Northwind Freight',
    role: 'Logistics Platform Engineer',
    sourceCvId: 'cv-1',
    sourceCvContentHash: 'cv-hash',
    jdSnapshot: 'Northwind Freight is hiring.',
    jdSnapshotHash: 'jd-hash',
    jdComplete: true,
    workflowVersion: 'review-mode-v1',
    tailoringMode: 'ai',
    checkpoint: 'ready',
    checkpointDetail: '',
    createdAt: '2026-09-11T11:00:00.000Z',
    updatedAt: '2026-09-11T12:00:00.000Z',
    submittedAt: null,
    formStructureHash: null,
    scheduledAutomaticSubmitAt: null,
    submissionMode: null,
    completionEvidence: null,
    supersedesAttemptId: null,
    reapplyReason: '',
    reapplyPreviousCvContentHash: null,
    preparedFields: PREPARED,
    ...overrides,
  };
}

function artifact(overrides: Partial<ApplicationArtifactRecord> = {}): ApplicationArtifactRecord {
  return {
    id: 'artifact-1',
    attemptId: 'attempt-1',
    kind: 'cv_pdf',
    fileName: 'resume.pdf',
    mimeType: 'application/pdf',
    byteSize: 2048,
    contentHash: 'hash',
    storagePath: '',
    createdAt: '2026-09-11T12:00:00.000Z',
    ...overrides,
  };
}

describe('ApplicationPreparedSummary', () => {
  it('names the documents staged for this attempt', () => {
    render(<ApplicationPreparedSummary attempt={attempt()} documents={[artifact(), artifact({ id: 'artifact-2', kind: 'cover_letter_pdf', fileName: 'cover-letter.pdf' })]} />);

    expect(screen.getByText('CV')).toBeInTheDocument();
    expect(screen.getByText('resume.pdf')).toBeInTheDocument();
    expect(screen.getByText('Cover letter')).toBeInTheDocument();
    expect(screen.getByText('cover-letter.pdf')).toBeInTheDocument();
  });

  it('shows the tailoring change and dropped-content summary before submission', () => {
    render(
      <ApplicationPreparedSummary
        attempt={attempt({ checkpointDetail: 'CV tailored for this vacancy. Removed unsupported output: skill "Rust".' })}
        documents={[artifact()]}
      />,
    );

    expect(screen.getByText('Tailoring and preparation')).toBeInTheDocument();
    expect(screen.getByText(/Removed unsupported output: skill "Rust"/)).toBeInTheDocument();
  });

  it('shows each committed answer with the value and where it came from', () => {
    render(<ApplicationPreparedSummary attempt={attempt()} documents={[artifact()]} />);

    expect(screen.getByText('Jamie Rivera')).toBeInTheDocument();
    expect(screen.getByText('(from your CV)')).toBeInTheDocument();
    expect(screen.getByText('Filled in')).toBeInTheDocument();
  });

  it('says plainly what it did not answer, rather than leaving it out', () => {
    render(<ApplicationPreparedSummary attempt={attempt()} documents={[artifact()]} />);

    expect(screen.getByText('You answer this')).toBeInTheDocument();
    expect(screen.getByText(/never answers on your behalf/)).toBeInTheDocument();
    expect(screen.getByText('Left blank')).toBeInTheDocument();
  });

  it('refuses to show a record prepared for a different employer or role', () => {
    render(
      <ApplicationPreparedSummary
        attempt={attempt({ preparedFields: { ...PREPARED, company: 'Some Other Employer' } })}
        documents={[artifact()]}
      />,
    );

    expect(screen.queryByText('Jamie Rivera')).not.toBeInTheDocument();
    expect(screen.getByText(/no record of filling this form/)).toBeInTheDocument();
  });

  it('is honest about an attempt nothing ever prepared', () => {
    render(<ApplicationPreparedSummary attempt={attempt({ preparedFields: null })} documents={[]} />);

    expect(screen.getByText(/no record of filling this form/)).toBeInTheDocument();
    expect(screen.getByText('No documents were prepared for this attempt.')).toBeInTheDocument();
  });
});
