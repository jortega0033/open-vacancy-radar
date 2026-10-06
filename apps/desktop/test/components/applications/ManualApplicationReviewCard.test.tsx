import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManualApplicationReviewCard } from '../../../src/components/applications/ManualApplicationReviewCard.js';
import type { ApplicationAttemptRecord } from '../../../src/window.js';

const attempt = {
  id: 'attempt-1',
  company: 'Example BV',
  role: 'Frontend Engineer',
  checkpointDetail: 'Documents are ready.',
} as ApplicationAttemptRecord;

function renderCard(
  overrides: {
    continued?: boolean;
    busy?: boolean;
    attempt?: ApplicationAttemptRecord;
    onGenerateLetter?: () => void;
    onRetryLetter?: () => void;
  } = {},
) {
  const actions = {
    onContinue: vi.fn(),
    onSkip: vi.fn(),
    onMarkApplied: vi.fn(),
    onStillInProgress: vi.fn(),
    onSaveArtifact: vi.fn(),
    onOpenArtifact: vi.fn(),
  };
  render(
    <ManualApplicationReviewCard
      attempt={overrides.attempt ?? attempt}
      documents={[
        {
          id: 'artifact-1',
          attemptId: attempt.id,
          kind: 'cv_pdf',
          fileName: 'resume.pdf',
        } as never,
      ]}
      busy={overrides.busy ?? false}
      continued={overrides.continued ?? false}
      onGenerateLetter={overrides.onGenerateLetter}
      onRetryLetter={overrides.onRetryLetter}
      {...actions}
    />,
  );
  return actions;
}

describe('ManualApplicationReviewCard', () => {
  it('offers the same Continue and Skip decisions without requiring a swipe', () => {
    const actions = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Open the posting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(actions.onContinue).toHaveBeenCalledTimes(1);
    expect(actions.onSkip).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
  });

  it('is a plain static card with no swipe deck and no hint row', () => {
    renderCard();

    expect(screen.queryAllByTestId('manual-swipe-card-back')).toHaveLength(0);
    expect(screen.getByTestId('manual-application-swipe-card')).not.toHaveClass('cursor-grab');
    expect(screen.getByTestId('manual-application-swipe-card')).not.toHaveClass('cursor-wait');
    // The hint row is gone: the two buttons below say the same thing.
    expect(screen.queryByTestId('manual-swipe-guidance')).not.toBeInTheDocument();
    expect(screen.queryByText(/Manual application/)).not.toBeInTheDocument();
    expect(screen.queryByText('Submit', { exact: true })).not.toBeInTheDocument();
  });

  it('offers user-reported completion after the external handoff', () => {
    const actions = renderCard({ continued: true });
    fireEvent.click(screen.getByRole('button', { name: 'I applied' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not yet' }));
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
        checkpointDetail:
          'Your tailored CV is ready. Cover letter blocker: unsupported source facts.',
      },
      onGenerateLetter,
    });

    expect(screen.getByText('Your CV is ready. The cover letter could not be written.')).toBeInTheDocument();
    expect(screen.getByText('unsupported source facts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Generate letter' }));
    expect(onGenerateLetter).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Tailored CV')).toBeInTheDocument();
    expect(screen.queryByText('resume.pdf')).not.toBeInTheDocument();
  });

  it('does not start a swipe from a press on a button inside the card (#565)', () => {
    const actions = renderCard();
    const review = screen.getByRole('button', { name: 'Review' });
    const card = screen.getByTestId('manual-application-swipe-card');
    const capture = vi.fn();
    card.setPointerCapture = capture;

    function pointer(target: Element, type: string, clientX: number) {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, { clientX: { value: clientX }, pointerId: { value: 7 } });
      fireEvent(target, event);
    }

    pointer(review, 'pointerdown', 100);
    pointer(card, 'pointermove', 260);
    pointer(card, 'pointerup', 260);
    expect(capture).not.toHaveBeenCalled();
    expect(actions.onContinue).not.toHaveBeenCalled();
  });

  it('says Claude hit its limit and holds Try again until the reset (#565)', () => {
    const onRetryLetter = vi.fn();
    renderCard({
      attempt: {
        ...attempt,
        updatedAt: new Date().toISOString(),
        checkpointDetail:
          "Tailored. Your CV is ready. Cover letter blocker: automatic cover letter generation stopped: You've hit your session limit · resets 11:59pm. Use Generate letter to create and review one, then return here, or provide one on the employer site.",
      } as ApplicationAttemptRecord,
      onGenerateLetter: vi.fn(),
      onRetryLetter,
    });

    expect(
      screen.getByText('Your CV is ready. Claude has reached its usage limit until 11:59pm, so the cover letter was not written.'),
    ).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /^Try again after / });
    expect(retry).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Generate letter' })).toBeEnabled();
  });

  it('offers Try again for a letter that failed for another reason', () => {
    const onRetryLetter = vi.fn();
    renderCard({
      attempt: {
        ...attempt,
        checkpointDetail:
          'Your CV is ready. Cover letter blocker: automatic cover letter generation stopped: provider exited with code 1. Use Generate letter to create and review one.',
      },
      onRetryLetter,
    });

    expect(screen.getByText('Your CV is ready. The cover letter could not be written.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetryLetter).toHaveBeenCalledTimes(1);
  });

  it('lists the letter and drops the blocker once it is linked to the attempt (#552)', () => {
    const noop = vi.fn();
    const cv = { id: 'artifact-1', attemptId: attempt.id, kind: 'cv_pdf', fileName: 'resume.pdf' } as never;
    const letter = { id: 'artifact-2', attemptId: attempt.id, kind: 'cover_letter_pdf', fileName: 'cover-letter.pdf' } as never;
    const blocked = { ...attempt, checkpointDetail: 'Your tailored CV is ready. Cover letter blocker: not written.' };
    const linked = {
      ...attempt,
      checkpointDetail: 'Your application documents are ready. This employer site is not approved for automated submission.',
    };
    const props = {
      busy: false, continued: false, onContinue: noop, onSkip: noop, onMarkApplied: noop, onStillInProgress: noop,
      onSaveArtifact: noop, onOpenArtifact: noop, onGenerateLetter: noop, onRetryLetter: noop,
    };
    const { rerender } = render(<ManualApplicationReviewCard attempt={blocked} documents={[cv]} {...props} />);
    expect(screen.getByRole('button', { name: 'Generate letter' })).toBeInTheDocument();

    rerender(<ManualApplicationReviewCard attempt={linked} documents={[cv, letter]} {...props} />);

    expect(screen.queryByRole('button', { name: 'Generate letter' })).not.toBeInTheDocument();
    expect(screen.queryByText(/cover letter still needs attention/i)).not.toBeInTheDocument();
    expect(screen.getByText('Cover letter')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Save copy' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Review' })).toHaveLength(2);
  });

  it('shows no letter recovery when the documents are complete', () => {
    renderCard({ onRetryLetter: vi.fn(), onGenerateLetter: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByText('Details')).not.toBeInTheDocument();
  });

  it('is not draggable: a drag in either direction decides nothing and shows no badges', () => {
    const actions = renderCard();
    const card = screen.getByTestId('manual-application-swipe-card');
    const capture = vi.fn();
    card.setPointerCapture = capture;

    function drag(type: string, clientX: number, pointerId: number) {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, {
        clientX: { value: clientX },
        pointerId: { value: pointerId },
      });
      fireEvent(card, event);
    }

    drag('pointerdown', 100, 1);
    drag('pointermove', 230, 1);
    expect(card.style.transform).toBe('');
    drag('pointerup', 230, 1);
    drag('pointerdown', 230, 2);
    drag('pointermove', 90, 2);
    drag('pointerup', 90, 2);

    expect(capture).not.toHaveBeenCalled();
    expect(actions.onContinue).not.toHaveBeenCalled();
    expect(actions.onSkip).not.toHaveBeenCalled();
    expect(card).not.toHaveTextContent('Continue');
    expect(within(card).queryByText('Skip')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('manual-swipe-card-back')).toHaveLength(0);
  });

  it('blocks duplicate button and swipe decisions while busy', () => {
    const actions = renderCard({ busy: true });
    const card = screen.getByTestId('manual-application-swipe-card');
    const skip = screen.getByRole('button', { name: 'Skip' });
    const proceed = screen.getByRole('button', { name: 'Open the posting' });

    expect(skip).toBeDisabled();
    expect(proceed).toBeDisabled();
    fireEvent.pointerDown(card, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(card, { clientX: 240, pointerId: 1 });
    fireEvent.pointerUp(card, { clientX: 240, pointerId: 1 });

    expect(actions.onContinue).not.toHaveBeenCalled();
    expect(actions.onSkip).not.toHaveBeenCalled();
  });

  describe('reduced motion (issue #497)', () => {
    function mockReducedMotion(reduce: boolean) {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: reduce && query === '(prefers-reduced-motion: reduce)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })) as unknown as typeof window.matchMedia;
    }

    function pointer(card: HTMLElement, type: string, clientX: number) {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, { clientX: { value: clientX }, pointerId: { value: 1 } });
      fireEvent(card, event);
    }

    function dragRight() {
      const card = screen.getByTestId('manual-application-swipe-card');
      pointer(card, 'pointerdown', 100);
      pointer(card, 'pointermove', 140);
      return card;
    }

    afterEach(() => {
      // @ts-expect-error jsdom does not define matchMedia, so restore that absence
      delete window.matchMedia;
    });

    it('applies no tilt, translate or transition by default', () => {
      mockReducedMotion(false);
      renderCard();
      const card = dragRight();
      expect(card.style.transform).toBe('');
      pointer(card, 'pointerup', 140);
      expect(card.style.transition).toBe('');
    });

    it('applies no transform when reduced motion is set either', () => {
      mockReducedMotion(true);
      renderCard();
      const card = dragRight();
      expect(card.style.transform).toBe('');
      pointer(card, 'pointerup', 140);
      expect(card.style.transition).toBe('');
    });
  });
});
