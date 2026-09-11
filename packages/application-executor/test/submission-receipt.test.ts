import { describe, expect, it } from 'vitest';
import {
  classifyDelayedReceipt,
  classifySubmissionOutcome,
  readResponseSignals,
  type SubmissionPageObservation,
} from '../src/submission-receipt.js';

/**
 * Issue #271's acceptance cases, at the level where the actual decision is made. Everything here is
 * a hand-built observation fixture: nothing in this file opens a browser, and nothing in it could
 * reach a real employer's form even in principle.
 *
 * The fixture content is deliberately synthetic throughout -- an invented employer, an invented
 * reference format, invented field labels.
 */

const OBSERVED_AT = '2026-09-11T10:00:00.000Z';

function observation(overrides: Partial<SubmissionPageObservation> = {}): SubmissionPageObservation {
  return {
    text: 'Fixture Employer Apply for Staff Engineer Full name Email Submit Application',
    baselineText: 'Fixture Employer Apply for Staff Engineer Full name Email Submit Application',
    formStillPresent: true,
    errorMarkers: [],
    ...overrides,
  };
}

describe('classifySubmissionOutcome: acceptance case 1 -- a click that returns but leaves a form error is never submitted', () => {
  it('reports rejected when the page flags a structural field error', () => {
    const report = classifySubmissionOutcome(
      observation({ errorMarkers: ['Full name is required'] }),
      OBSERVED_AT,
    );
    expect(report.outcome).toBe('rejected');
    expect(report).toMatchObject({ reason: 'form_validation_error' });
    expect(report.detail).toContain('Full name is required');
  });

  it('reports rejected on worded validation text alone, for a form with no structural markers at all', () => {
    const report = classifySubmissionOutcome(
      observation({ text: 'Apply for Staff Engineer Please complete the highlighted questions before submitting.' }),
      OBSERVED_AT,
    );
    expect(report).toMatchObject({ outcome: 'rejected', reason: 'form_validation_error' });
  });

  it('never reports submitted for a page that is still standing the form, even with confirmation-shaped wording on it', () => {
    // The hardest version of the bug: a single-page form that renders a "thank you for applying"
    // banner alongside the still-unsubmitted form. Nothing here is allowed to reach `submitted`.
    const report = classifySubmissionOutcome(
      observation({ text: 'Thank you for applying! Full name Email Submit Application', formStillPresent: true }),
      OBSERVED_AT,
    );
    expect(report.outcome).toBe('unknown');
  });

  it('falls to unknown, never submitted, when the click simply changed nothing observable', () => {
    const report = classifySubmissionOutcome(observation(), OBSERVED_AT);
    expect(report).toMatchObject({ outcome: 'unknown', reason: 'no_receipt_observed' });
  });
});

describe('classifySubmissionOutcome: acceptance case 2 -- a real confirmation or receipt records submitted with evidence', () => {
  it('accepts a confirmation page that replaced the form, carrying the matched text as the evidence reference', () => {
    const report = classifySubmissionOutcome(
      observation({
        text: 'Fixture Employer Your application has been submitted. We will be in touch.',
        formStillPresent: false,
      }),
      OBSERVED_AT,
    );
    expect(report).toMatchObject({
      outcome: 'submitted',
      evidence: { kind: 'confirmation_page', reference: 'Your application has been submitted' },
      observedAt: OBSERVED_AT,
    });
  });

  it('accepts an unambiguous printed receipt reference', () => {
    const report = classifySubmissionOutcome(
      observation({
        text: 'Fixture Employer Application reference: FIXTURE-2026-000123 Keep this for your records.',
        formStillPresent: false,
      }),
      OBSERVED_AT,
    );
    expect(report).toMatchObject({ outcome: 'submitted', evidence: { kind: 'receipt_reference' } });
    expect(report.outcome === 'submitted' && report.evidence.reference).toContain('FIXTURE-2026-000123');
  });

  it('refuses a confirmation phrase that was already on the page before the click', () => {
    // A posting whose own boilerplate reads "Thank you for applying" would otherwise auto-confirm
    // every attempt against it, forever.
    const report = classifySubmissionOutcome(
      observation({
        text: 'Thank you for applying to Fixture Employer. Please review your answers.',
        baselineText: 'Thank you for applying to Fixture Employer. Please review your answers.',
        formStillPresent: false,
      }),
      OBSERVED_AT,
    );
    expect(report.outcome).toBe('unknown');
  });

  it('ignores a short, non-identifier-shaped "reference" rather than treating it as a receipt', () => {
    const report = classifySubmissionOutcome(
      observation({ text: 'Reference: 12 people applied this week', formStillPresent: false }),
      OBSERVED_AT,
    );
    expect(report.outcome).toBe('unknown');
  });
});

describe('classifySubmissionOutcome: acceptance case 5 -- an HTTP success carrying an application error is not delivery', () => {
  it('rejects a 200 whose payload reports application errors, even on a page showing a confirmation', () => {
    const report = classifySubmissionOutcome(
      observation({
        text: 'Your application has been submitted.',
        formStillPresent: false,
        response: { status: 200, body: JSON.stringify({ errors: [{ field: 'workAuthorization', message: 'unanswered' }] }) },
      }),
      OBSERVED_AT,
    );
    expect(report).toMatchObject({ outcome: 'rejected', reason: 'application_error_payload' });
    expect(report.detail).toContain('HTTP 200');
  });

  it('rejects a 200 whose payload says success: false', () => {
    const report = classifySubmissionOutcome(
      observation({ response: { status: 200, body: JSON.stringify({ success: false, message: 'try again' }) } }),
      OBSERVED_AT,
    );
    expect(report).toMatchObject({ outcome: 'rejected', reason: 'application_error_payload' });
  });

  it('rejects a 200 whose payload says status: "error"', () => {
    const report = classifySubmissionOutcome(
      observation({ response: { status: 200, body: JSON.stringify({ status: 'error' }) } }),
      OBSERVED_AT,
    );
    expect(report).toMatchObject({ outcome: 'rejected', reason: 'application_error_payload' });
  });

  it('does NOT treat a clean 200 with no identifier as delivery -- a transport success is not an application receipt', () => {
    const report = classifySubmissionOutcome(
      observation({ response: { status: 200, body: JSON.stringify({ status: 'ok' }) } }),
      OBSERVED_AT,
    );
    expect(report.outcome).toBe('unknown');
  });

  it('accepts a 200 that hands back a real application identifier', () => {
    const report = classifySubmissionOutcome(
      observation({ response: { status: 200, body: JSON.stringify({ applicationId: 'fixture-app-77', status: 'received' }) } }),
      OBSERVED_AT,
    );
    expect(report).toMatchObject({ outcome: 'submitted', evidence: { kind: 'delivery_receipt' } });
    expect(report.outcome === 'submitted' && report.evidence.reference).toContain('fixture-app-77');
  });

  it('never reads an unparseable body as positive evidence, however cheerful it sounds', () => {
    const report = classifySubmissionOutcome(
      observation({ response: { status: 200, body: '<html>Thank you for applying</html>' } }),
      OBSERVED_AT,
    );
    expect(report.outcome).toBe('unknown');
  });
});

describe('classifyDelayedReceipt: acceptance case 5 -- a delayed receipt can reconcile an unknown outcome', () => {
  it('resolves to submitted on a later acknowledgement carrying an application identifier', () => {
    const report = classifyDelayedReceipt({ status: 202, body: JSON.stringify({ confirmationNumber: 'FIXTURE-9001' }) }, OBSERVED_AT);
    expect(report).toMatchObject({ outcome: 'submitted', evidence: { kind: 'delivery_receipt' } });
  });

  it('stays unknown when the later acknowledgement carries nothing conclusive -- silence is not proof either way', () => {
    const report = classifyDelayedReceipt({ status: 200, body: JSON.stringify({ queued: true }) }, OBSERVED_AT);
    expect(report).toMatchObject({ outcome: 'unknown', reason: 'no_receipt_observed' });
  });

  it('reports a late application-error payload as rejected, not as a receipt', () => {
    const report = classifyDelayedReceipt({ status: 200, body: JSON.stringify({ error: 'application was not processed' }) }, OBSERVED_AT);
    expect(report).toMatchObject({ outcome: 'rejected', reason: 'application_error_payload' });
  });
});

describe('readResponseSignals', () => {
  it('reads a non-JSON body only for error wording, never for positive evidence', () => {
    expect(readResponseSignals({ status: 500, body: 'Internal Server Error' })).toMatchObject({ reference: undefined });
    expect(readResponseSignals({ status: 500, body: 'Internal Server Error' }).error).toBeDefined();
    expect(readResponseSignals({ status: 200, body: 'ok' })).toEqual({ error: undefined, reference: undefined });
  });

  it('reads an errors object keyed by field as an application error', () => {
    const signals = readResponseSignals({ status: 200, body: JSON.stringify({ errors: { fullName: 'required' } }) });
    expect(signals.error).toContain('fullName');
  });
});
