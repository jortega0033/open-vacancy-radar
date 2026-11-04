import { describe, expect, it } from 'vitest';
import type { ApplicationAttemptRecord } from '../../../src/window.js';
import {
  attemptListStatus,
  classifyReviewEntry,
  hasUsefulManualDocuments,
  isDocumentsReadyDetail,
  isLetterMissing,
  isSendInProgress,
  nextReadyAttempt,
  pipelineLimit,
  preparationStatusLine,
  preparationSteps,
  workspaceStageFor,
} from '../../../src/components/applications/apply-workspace-state.js';

const DOCS_READY =
  'CV tailored. Your application documents are ready. This employer site is not approved for automated submission, so apply on the site yourself and mark the attempt when you finish.';

function attempt(overrides: Partial<ApplicationAttemptRecord>): ApplicationAttemptRecord {
  return {
    id: 'a1',
    role: 'Engineer',
    company: 'Acme',
    checkpoint: 'needs_user',
    checkpointDetail: '',
    updatedAt: '2026-10-01T10:00:00.000Z',
    scheduledAutomaticSubmitAt: null,
    ...overrides,
  } as ApplicationAttemptRecord;
}

describe('workspace stage (#657)', () => {
  it('maps every checkpoint to preparing, review or finished', () => {
    for (const checkpoint of ['queued', 'reading_jd', 'tailoring', 'rendering', 'filling', 'submitting'] as const) {
      expect(workspaceStageFor(checkpoint)).toBe('preparing');
    }
    expect(workspaceStageFor('ready')).toBe('review');
    expect(workspaceStageFor('needs_user')).toBe('review');
    for (const checkpoint of ['submitted', 'user_reported', 'skipped', 'failed', 'submission_unknown'] as const) {
      expect(workspaceStageFor(checkpoint)).toBe('finished');
    }
  });
});

describe('a send in progress (#657 review)', () => {
  it('treats only submitting as a send in flight, distinct from preparation', () => {
    expect(isSendInProgress('submitting')).toBe(true);
    for (const checkpoint of ['queued', 'reading_jd', 'tailoring', 'rendering', 'filling', 'ready', 'needs_user', 'submitted', 'submission_unknown'] as const) {
      expect(isSendInProgress(checkpoint)).toBe(false);
    }
    // Still re-read like preparation, so the workspace sees the send settle.
    expect(workspaceStageFor('submitting')).toBe('preparing');
  });

  it('says a send is under way, never that the form is being got ready', () => {
    expect(preparationStatusLine('submitting')).toBe('Sending your application…');
    expect(preparationStatusLine('filling')).toBe('Getting the employer form ready…');
    expect(preparationStatusLine('submitting')).not.toMatch(/ready|writing|preparing/i);
  });
});

describe('review entry', () => {
  it('opens a ready manual package for a site with no policy', () => {
    expect(classifyReviewEntry(attempt({ checkpointDetail: DOCS_READY }), null)).toEqual({ kind: 'manual' });
    expect(classifyReviewEntry(attempt({ checkpoint: 'ready' }), null)).toEqual({ kind: 'manual' });
  });

  it('keeps the allowlisted live review only for a ready, policy-backed site', () => {
    expect(classifyReviewEntry(attempt({ checkpoint: 'ready' }), 'local-fixture')).toEqual({ kind: 'live_review', policyId: 'local-fixture' });
    // A blocker on a policy-backed site never opens the live view.
    expect(classifyReviewEntry(attempt({ checkpointDetail: 'form blocker' }), 'local-fixture')).toEqual({
      kind: 'preparation_blocked',
      message: 'form blocker',
    });
  });

  it('routes a tailoring stop before anything else', () => {
    const stopped = attempt({ checkpointDetail: 'Automatic CV tailoring stopped: provider unavailable' });
    expect(classifyReviewEntry(stopped, null).kind).toBe('tailoring_blocked');
    expect(classifyReviewEntry(stopped, 'policy').kind).toBe('tailoring_blocked');
  });

  it('treats a needs_user detail with no useful documents as a blocker (no documents)', () => {
    expect(classifyReviewEntry(attempt({ checkpointDetail: 'the captured job description is incomplete' }), null)).toEqual({
      kind: 'preparation_blocked',
      message: 'the captured job description is incomplete',
    });
  });

  it('recognises every manual documents-ready phrase', () => {
    expect(hasUsefulManualDocuments('Your tailored CV is ready. Cover letter blocker: x.')).toBe(true);
    expect(hasUsefulManualDocuments('Your CV was prepared without any skills.')).toBe(true);
    expect(hasUsefulManualDocuments('nothing here')).toBe(false);
  });
});

describe('letter missing and limits', () => {
  it('is letter-missing only when no letter document exists and the detail names the letter', () => {
    const detail = 'Your tailored CV is ready. Cover letter blocker: unsupported source facts. Use Generate letter.';
    expect(isLetterMissing(detail, [])).toBe(true);
    expect(isLetterMissing(detail, [{ kind: 'cover_letter_pdf' } as never])).toBe(false);
    expect(isLetterMissing(DOCS_READY, [])).toBe(false);
  });

  it('reads a usage limit only from the provider text after a known marker', () => {
    const limited = pipelineLimit("Automatic CV tailoring stopped: You've hit your session limit · resets 11:59pm", new Date().toISOString());
    expect(limited?.kind).toBe('usage_limit');
    expect(pipelineLimit('this form returned 429 rate limit', new Date().toISOString())).toBeNull();
  });
});

describe('progress and labels (text diet)', () => {
  it('streams plain progress steps without pipeline names', () => {
    expect(preparationSteps('tailoring').map((step) => step.state)).toEqual(['done', 'current', 'todo', 'todo']);
    expect(preparationSteps('needs_user').every((step) => step.state === 'done')).toBe(true);
    const words = preparationSteps('queued').map((step) => step.label).join(' ') + preparationStatusLine('rendering');
    expect(words).not.toMatch(/checkpoint|policy|attempt|tailoring CV|Filling the form/i);
  });

  it('labels a successful manual package "Ready to review", never "Needs your input"', () => {
    expect(isDocumentsReadyDetail(DOCS_READY)).toBe(true);
    expect(attemptListStatus(attempt({ checkpointDetail: DOCS_READY }))).toEqual({
      label: 'Ready to review',
      badgeClass: 'badge badge-success badge-soft',
    });
    expect(attemptListStatus(attempt({ checkpointDetail: 'the captured job description is incomplete' })).label).toBe('Needs your input');
  });
});

describe('next ready application', () => {
  it('picks the newest other waiting application and skips scheduled sends', () => {
    const rows = [
      attempt({ id: 'current', updatedAt: '2026-10-05T00:00:00.000Z' }),
      attempt({ id: 'old', updatedAt: '2026-10-01T00:00:00.000Z' }),
      attempt({ id: 'newer', updatedAt: '2026-10-03T00:00:00.000Z' }),
      attempt({ id: 'scheduled', checkpoint: 'ready', scheduledAutomaticSubmitAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z' }),
      attempt({ id: 'preparing', checkpoint: 'tailoring', updatedAt: '2026-10-06T00:00:00.000Z' }),
    ];
    expect(nextReadyAttempt(rows, 'current')?.id).toBe('newer');
    expect(nextReadyAttempt([rows[0]!], 'current')).toBeNull();
  });
});
