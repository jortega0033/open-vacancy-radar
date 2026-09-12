import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ManualApplicationReviewCard } from '../../../src/components/applications/ManualApplicationReviewCard.js';
import type { ApplicationAttemptRecord } from '../../../src/window.js';

const attempt = {
  id: 'attempt-1', company: 'Example BV', role: 'Frontend Engineer', checkpointDetail: 'Documents are ready.',
} as ApplicationAttemptRecord;

function renderCard(overrides: { continued?: boolean; attempt?: ApplicationAttemptRecord; onGenerateLetter?: () => void } = {}) {
  const actions = {
    onContinue: vi.fn(), onSkip: vi.fn(), onMarkApplied: vi.fn(), onStillInProgress: vi.fn(), onSaveArtifact: vi.fn(), onOpenArtifact: vi.fn(),
  };
  render(
    <ManualApplicationReviewCard
      attempt={overrides.attempt ?? attempt}
      documents={[{ id: 'artifact-1', attemptId: attempt.id, kind: 'cv_pdf', fileName: 'resume.pdf' } as never]}
      busy={false}
      continued={overrides.continued ?? false}
      onGenerateLetter={overrides.onGenerateLetter}
      {...actions}
    />,
  );
  return actions;
}

describe('ManualApplicationReviewCard', () => {
  it('offers the same Continue and Skip decisions without requiring a swipe', () => {
    const actions = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Continue on employer site' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(actions.onContinue).toHaveBeenCalledTimes(1);
    expect(actions.onSkip).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
  });

  it('offers user-reported completion after the external handoff', () => {
    const actions = renderCard({ continued: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark as applied externally' }));
    fireEvent.click(screen.getByRole('button', { name: 'Still in progress' }));
    expect(actions.onMarkApplied).toHaveBeenCalledTimes(1);
    expect(actions.onStillInProgress).toHaveBeenCalledTimes(1);
  });

  it('lets the person save the exact attempt-owned document', () => {
    const actions = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Save copy' }));
    expect(actions.onSaveArtifact).toHaveBeenCalledWith('artifact-1');
  });

  it('opens the complete staged document for review', () => {
    const actions = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(actions.onOpenArtifact).toHaveBeenCalledWith('artifact-1');
  });

  it('keeps the tailored CV visible and offers letter recovery when generation was blocked', () => {
    const onGenerateLetter = vi.fn();
    renderCard({
      attempt: {
        ...attempt,
        checkpointDetail: 'Your tailored CV is ready. Cover letter blocker: unsupported source facts.',
      },
      onGenerateLetter,
    });

    expect(screen.getByText(/tailored CV is ready, but the letter still needs attention/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Generate letter' }));
    expect(onGenerateLetter).toHaveBeenCalledTimes(1);
    expect(screen.getByText('resume.pdf')).toBeInTheDocument();
  });

  it('maps right and left drags to the same visible decisions', () => {
    const actions = renderCard();
    const card = screen.getByText('Manual application').closest('div[class*="select-none"]');
    expect(card).not.toBeNull();

    function drag(type: string, clientX: number, pointerId: number) {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, {
        clientX: { value: clientX },
        pointerId: { value: pointerId },
      });
      fireEvent(card!, event);
    }

    drag('pointerdown', 100, 1);
    drag('pointermove', 230, 1);
    drag('pointerup', 230, 1);
    expect(actions.onContinue).toHaveBeenCalledTimes(1);

    drag('pointerdown', 230, 2);
    drag('pointermove', 90, 2);
    drag('pointerup', 90, 2);
    expect(actions.onSkip).toHaveBeenCalledTimes(1);
  });
});
