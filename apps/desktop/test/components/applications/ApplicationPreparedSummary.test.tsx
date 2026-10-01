import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormSnapshot } from '@agent-dock/application-executor';
import { ApplicationPreparedSummary } from '../../../src/components/applications/index.js';
import type {
  ApplicationAnswerRecord,
  ApplicationArtifactRecord,
  ApplicationAttemptRecord,
  ConfirmApplicationAnswerResult,
  PreparedApplicationFields,
} from '../../../src/window.js';

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

  describe('reusable answers (#372)', () => {
    const PREPARED_WITH_TEXT_FIELD: PreparedApplicationFields = {
      ...PREPARED,
      fields: [
        ...PREPARED.fields,
        { label: 'Why do you want to work here?', controlType: 'textarea', required: true, status: 'awaiting_you', detail: 'none of your saved details answers this, so this app left it for you' },
      ],
    };

    const SNAPSHOT: FormSnapshot = {
      generation: 1,
      capturedAt: '2026-09-11T12:00:00.000Z',
      challengeDetected: false,
      activeFrameId: 0,
      pageStateFingerprint: 'fingerprint',
      fields: [
        { fieldRef: 'f0000000000000001', label: 'fullName', controlType: 'text', required: true, active: true, frameId: 0 },
        { fieldRef: 'f0000000000000002', label: 'Why do you want to work here?', controlType: 'textarea', required: true, active: true, frameId: 0 },
      ],
      submitControls: [],
    };

    function savedAnswer(overrides: Partial<ApplicationAnswerRecord> = {}): ApplicationAnswerRecord {
      return {
        id: 'answer-1',
        normalizedKey: 'textarea::why do you want to work here?',
        label: 'Why do you want to work here?',
        controlType: 'textarea',
        answer: 'I want to build reliable logistics software.',
        originCompany: 'A Previous Employer',
        originRole: 'Platform Engineer',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        lastConfirmedAt: '2026-09-01T00:00:00.000Z',
        ...overrides,
      };
    }

    // Using a saved answer records the use (bumps lastConfirmedAt) as best-effort bookkeeping --
    // stubbed globally for this block so every test that clicks "Use this answer" has something
    // real to call rather than hitting an undefined `window.workspace`.
    beforeEach(() => {
      (window as unknown as { workspace: unknown }).workspace = {
        recordApplicationAnswerUsed: vi.fn().mockResolvedValue(savedAnswer()),
      };
    });

    it('does not offer reuse controls for a text/textarea field without a live snapshot and confirm handler (backward compatible)', () => {
      render(<ApplicationPreparedSummary attempt={attempt({ preparedFields: PREPARED_WITH_TEXT_FIELD })} documents={[artifact()]} />);

      expect(screen.getByText('Why do you want to work here?')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /use this answer/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Why do you want to work here?' })).not.toBeInTheDocument();
    });

    it('shows a matching saved answer as a suggestion and only fills it after "Use this answer" is clicked', async () => {
      const onConfirmAnswer = vi.fn<(fieldIndex: number, fieldRef: string, value: string) => Promise<ConfirmApplicationAnswerResult>>().mockResolvedValue({ ok: true });

      render(
        <ApplicationPreparedSummary
          attempt={attempt({ preparedFields: PREPARED_WITH_TEXT_FIELD })}
          documents={[artifact()]}
          snapshot={SNAPSHOT}
          savedAnswers={[savedAnswer()]}
          onConfirmAnswer={onConfirmAnswer}
        />,
      );

      expect(screen.getByText('I want to build reliable logistics software.')).toBeInTheDocument();
      expect(screen.getByText(/used at A Previous Employer/)).toBeInTheDocument();
      // Not filled until the click -- the suggestion showing is not the same as it being applied.
      expect(onConfirmAnswer).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: /use this answer/i }));

      await waitFor(() => expect(onConfirmAnswer).toHaveBeenCalledWith(3, 'f0000000000000002', 'I want to build reliable logistics software.'));
      await waitFor(() => expect(window.workspace.recordApplicationAnswerUsed).toHaveBeenCalledWith('answer-1'));
    });

    it('resolves two awaiting_you fields that share an identical label and control type to two different live fields, by position', async () => {
      const preparedWithDuplicateLabels: PreparedApplicationFields = {
        ...PREPARED,
        fields: [
          { label: 'Comments', controlType: 'textarea', required: false, status: 'awaiting_you', detail: 'optional, and none of your saved details answers it' },
          { label: 'Comments', controlType: 'textarea', required: false, status: 'awaiting_you', detail: 'optional, and none of your saved details answers it' },
        ],
      };
      const duplicateSnapshot: FormSnapshot = {
        ...SNAPSHOT,
        fields: [
          { fieldRef: 'f0000000000000010', label: 'Comments', controlType: 'textarea', required: false, active: true, frameId: 0 },
          { fieldRef: 'f0000000000000011', label: 'Comments', controlType: 'textarea', required: false, active: true, frameId: 0 },
        ],
      };
      const onConfirmAnswer = vi.fn<(fieldIndex: number, fieldRef: string, value: string) => Promise<ConfirmApplicationAnswerResult>>().mockResolvedValue({ ok: true });

      render(
        <ApplicationPreparedSummary
          attempt={attempt({ preparedFields: preparedWithDuplicateLabels })}
          documents={[artifact()]}
          snapshot={duplicateSnapshot}
          savedAnswers={[]}
          onConfirmAnswer={onConfirmAnswer}
        />,
      );

      const textareas = screen.getAllByRole('textbox', { name: 'Comments' });
      expect(textareas).toHaveLength(2);
      const fillButtons = screen.getAllByRole('button', { name: /fill this field/i });
      expect(fillButtons).toHaveLength(2);

      fireEvent.change(textareas[1]!, { target: { value: 'For the second box.' } });
      fireEvent.click(fillButtons[1]!);

      // The second row (index 1) resolves to the second live field, not the first.
      await waitFor(() => expect(onConfirmAnswer).toHaveBeenCalledWith(1, 'f0000000000000011', 'For the second box.'));
      expect(onConfirmAnswer).not.toHaveBeenCalledWith(expect.anything(), 'f0000000000000010', expect.anything());
    });

    it('lets a person type and fill an awaiting_you field, and explicitly opt in to saving it for future applications', async () => {
      const onConfirmAnswer = vi.fn<(fieldIndex: number, fieldRef: string, value: string) => Promise<ConfirmApplicationAnswerResult>>().mockResolvedValue({ ok: true });
      const onSaveAnswer = vi.fn<(input: { label: string; controlType: 'text' | 'textarea'; answer: string }) => Promise<void>>().mockResolvedValue(undefined);

      render(
        <ApplicationPreparedSummary
          attempt={attempt({ preparedFields: PREPARED_WITH_TEXT_FIELD })}
          documents={[artifact()]}
          snapshot={SNAPSHOT}
          savedAnswers={[]}
          onConfirmAnswer={onConfirmAnswer}
          onSaveAnswer={onSaveAnswer}
        />,
      );

      const textarea = screen.getByRole('textbox', { name: 'Why do you want to work here?' });
      fireEvent.change(textarea, { target: { value: 'Because I care about reliable delivery.' } });
      // The checkbox defaults unchecked (saving is an explicit opt-in, not something to notice and
      // opt out of) -- this test checks it deliberately before filling.
      fireEvent.click(screen.getByRole('checkbox', { name: /save for future applications/i }));
      fireEvent.click(screen.getByRole('button', { name: /fill this field/i }));

      await waitFor(() => expect(onConfirmAnswer).toHaveBeenCalledWith(3, 'f0000000000000002', 'Because I care about reliable delivery.'));
      await waitFor(() =>
        expect(onSaveAnswer).toHaveBeenCalledWith({
          label: 'Why do you want to work here?',
          controlType: 'textarea',
          answer: 'Because I care about reliable delivery.',
        }),
      );
    });

    it('does not save a typed answer by default, unless the person explicitly checks "Save for future applications"', async () => {
      const onConfirmAnswer = vi.fn<(fieldIndex: number, fieldRef: string, value: string) => Promise<ConfirmApplicationAnswerResult>>().mockResolvedValue({ ok: true });
      const onSaveAnswer = vi.fn();

      render(
        <ApplicationPreparedSummary
          attempt={attempt({ preparedFields: PREPARED_WITH_TEXT_FIELD })}
          documents={[artifact()]}
          snapshot={SNAPSHOT}
          savedAnswers={[]}
          onConfirmAnswer={onConfirmAnswer}
          onSaveAnswer={onSaveAnswer}
        />,
      );

      // The checkbox is left at its default (unchecked) -- never touched.
      fireEvent.change(screen.getByRole('textbox', { name: 'Why do you want to work here?' }), { target: { value: 'A one-off answer.' } });
      fireEvent.click(screen.getByRole('button', { name: /fill this field/i }));

      await waitFor(() => expect(onConfirmAnswer).toHaveBeenCalled());
      expect(onSaveAnswer).not.toHaveBeenCalled();
    });

    it('shows an inline error, and never calls onSaveAnswer, when the live page refuses the confirm', async () => {
      const onConfirmAnswer = vi.fn<(fieldIndex: number, fieldRef: string, value: string) => Promise<ConfirmApplicationAnswerResult>>().mockResolvedValue({
        ok: false,
        reason: 'not_verified',
        detail: 'the page did not confirm the value afterwards',
      });
      const onSaveAnswer = vi.fn();

      render(
        <ApplicationPreparedSummary
          attempt={attempt({ preparedFields: PREPARED_WITH_TEXT_FIELD })}
          documents={[artifact()]}
          snapshot={SNAPSHOT}
          savedAnswers={[]}
          onConfirmAnswer={onConfirmAnswer}
          onSaveAnswer={onSaveAnswer}
        />,
      );

      fireEvent.change(screen.getByRole('textbox', { name: 'Why do you want to work here?' }), { target: { value: 'A typed answer.' } });
      fireEvent.click(screen.getByRole('button', { name: /fill this field/i }));

      expect(await screen.findByText('the page did not confirm the value afterwards')).toBeInTheDocument();
      expect(onSaveAnswer).not.toHaveBeenCalled();
    });
  });
});
