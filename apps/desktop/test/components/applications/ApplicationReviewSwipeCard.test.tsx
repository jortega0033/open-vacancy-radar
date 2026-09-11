import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { FormReadiness, FormSnapshot } from '@agent-dock/application-executor';
import { ApplicationReviewSwipeCard } from '../../../src/components/applications/ApplicationReviewSwipeCard.js';
import type { ApplicationAttemptRecord } from '../../../src/window.js';

/**
 * #277 acceptance 5, at the surface a person actually reads: a screenshot and a field inventory
 * must never be presented as evidence that a form was filled.
 *
 * The card used to render `snapshot.fields.length` followed by the word "filled". For the fixture
 * below that reads "3 fields filled" for a form where nothing has been typed at all, which is the
 * specific sentence this ticket exists to stop the app from saying.
 */

const ATTEMPT = {
  id: '11111111-1111-4111-8111-111111111111',
  company: 'Acme Corp',
  role: 'Senior Engineer',
} as unknown as ApplicationAttemptRecord;

const SNAPSHOT: FormSnapshot = {
  generation: 1,
  capturedAt: '2026-01-01T00:00:00.000Z',
  challengeDetected: false,
  activeFrameId: 0,
  pageStateFingerprint: 'fingerprint',
  submitControls: [],
  fields: [
    { fieldRef: 'f1', label: 'Full name', controlType: 'text', required: true, frameId: 0, active: true },
    { fieldRef: 'f2', label: 'Email', controlType: 'text', required: true, frameId: 0, active: true },
    { fieldRef: 'f3', label: 'Portfolio', controlType: 'text', required: false, frameId: 0, active: true },
  ],
};

function readiness(overrides: Partial<FormReadiness> = {}): FormReadiness {
  return {
    ready: true,
    verifiedFilledCount: 3,
    discoveredFieldCount: 3,
    requiredFieldCount: 2,
    requiredFieldsSatisfied: 2,
    blockers: [],
    ...overrides,
  };
}

function renderCard(overrides: Partial<Parameters<typeof ApplicationReviewSwipeCard>[0]> = {}) {
  const onApprove = vi.fn();
  const onSkip = vi.fn();
  const onOpenLiveView = vi.fn();
  render(
    <ApplicationReviewSwipeCard
      attempt={ATTEMPT}
      snapshot={SNAPSHOT}
      screenshotBase64="ZmFrZQ=="
      readiness={readiness()}
      onApprove={onApprove}
      onSkip={onSkip}
      onOpenLiveView={onOpenLiveView}
      {...overrides}
    />,
  );
  return { onApprove, onSkip, onOpenLiveView };
}

describe('ApplicationReviewSwipeCard (#277)', () => {
  it('reports verified-filled against discovered, never the discovered count on its own', () => {
    renderCard({ readiness: readiness({ verifiedFilledCount: 1, ready: false, requiredFieldsSatisfied: 1 }) });
    expect(screen.getByText(/1 of 3 fields verified filled/i)).toBeInTheDocument();
  });

  it('says zero filled for a page that was only ever looked at, screenshot and all', () => {
    // The exact case that used to read "3 fields filled": a snapshot found three fields, a
    // screenshot exists, and nothing has been written to anything.
    renderCard({
      readiness: readiness({ verifiedFilledCount: 0, requiredFieldsSatisfied: 0, ready: false, blockers: [
        { kind: 'required_field_empty', fieldRef: 'f1', label: 'Full name' },
        { kind: 'required_field_empty', fieldRef: 'f2', label: 'Email' },
      ] }),
    });
    expect(screen.getByText(/0 of 3 fields verified filled/i)).toBeInTheDocument();
    expect(screen.queryByText(/3 fields filled/i)).not.toBeInTheDocument();
    // The screenshot is still shown; it just proves nothing about the fields.
    expect(screen.getByRole('img', { name: /live application page preview/i })).toBeInTheDocument();
    // And so is the field inventory, labelled as what it is rather than as a filled count.
    expect(screen.getByText(/Fields found on this form \(3\)/i)).toBeInTheDocument();
  });

  it('lists every blocker so a person can see what is actually wrong', () => {
    renderCard({
      readiness: readiness({
        ready: false,
        blockers: [
          { kind: 'required_field_empty', fieldRef: 'f1', label: 'Full name' },
          { kind: 'validation_error', fieldRef: 'f2', label: 'Email', message: 'Enter a valid email address.' },
          { kind: 'attachment_missing', fieldRef: 'f4', label: 'Resume' },
        ],
      }),
    });
    expect(screen.getByText(/This form is not ready to submit/i)).toBeInTheDocument();
    expect(screen.getByText(/"Full name" is required and still empty/i)).toBeInTheDocument();
    expect(screen.getByText(/Enter a valid email address/i)).toBeInTheDocument();
    expect(screen.getByText(/"Resume" needs a file and has none attached/i)).toBeInTheDocument();
  });

  it('disables submit while the form is not ready, and enables it once it is', () => {
    const { unmount } = render(
      <ApplicationReviewSwipeCard
        attempt={ATTEMPT}
        snapshot={SNAPSHOT}
        screenshotBase64="ZmFrZQ=="
        readiness={readiness({ ready: false, blockers: [{ kind: 'required_field_empty', fieldRef: 'f1', label: 'Full name' }] })}
        onApprove={vi.fn()}
        onSkip={vi.fn()}
        onOpenLiveView={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /submit application/i })).toBeDisabled();
    unmount();

    renderCard();
    expect(screen.getByRole('button', { name: /submit application/i })).toBeEnabled();
  });

  it('offers the live handoff even on a form with nothing blocking, since signing in is not a blocker', () => {
    const { onOpenLiveView } = renderCard();
    const button = screen.getByRole('button', { name: /open the live page/i });
    fireEvent.click(button);
    expect(onOpenLiveView).toHaveBeenCalledTimes(1);
  });

  it('renders a page-authored validation message as text, never as markup', () => {
    // Blocker text is written by the employer's own page. React escapes it; this asserts the
    // escaped text is what lands, rather than an element the page got to inject.
    renderCard({
      readiness: readiness({
        ready: false,
        blockers: [{ kind: 'validation_error', fieldRef: 'f2', label: 'Email', message: '<img src=x onerror="alert(1)">' }],
      }),
    });
    expect(screen.getByText(/<img src=x onerror="alert\(1\)">/)).toBeInTheDocument();
    expect(document.querySelector('img[onerror]')).toBeNull();
  });

  it('skip stays available on a form that is not ready, so a person is never stuck on it', () => {
    const { onSkip } = renderCard({ readiness: readiness({ ready: false, blockers: [{ kind: 'challenge_detected' }] }) });
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
