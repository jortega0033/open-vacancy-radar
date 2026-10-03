import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

/**
 * A support-chat widget embedded on the page, reusing the shape from
 * `application-executor`'s `cross-origin-frame-fill.test.ts`: two same-origin, active,
 * required fields (the real form) plus two inactive fields the executor found in a
 * different frame's origin and would refuse to write into. `topFrameOrigin` is the baseline
 * those fields' `frameOrigin` is judged against, exactly as `FormSnapshot` already carries it.
 */
const CROSS_ORIGIN_SNAPSHOT: FormSnapshot = {
  generation: 1,
  capturedAt: '2026-01-01T00:00:00.000Z',
  challengeDetected: false,
  activeFrameId: 0,
  pageStateFingerprint: 'fingerprint',
  topFrameOrigin: 'https://careers.employer.invalid',
  submitControls: [],
  fields: [
    { fieldRef: 'f1', label: 'Full name', controlType: 'text', required: true, frameId: 0, active: true },
    { fieldRef: 'f2', label: 'Email', controlType: 'text', required: true, frameId: 0, active: true },
    { fieldRef: 'w1', label: 'Visitor name', controlType: 'text', required: false, frameId: 1, active: false, frameOrigin: 'https://chat.vendor.invalid' },
    { fieldRef: 'w2', label: 'Email', controlType: 'text', required: false, frameId: 1, active: false, frameOrigin: 'https://chat.vendor.invalid' },
  ],
};

/**
 * The page the cross-origin ticket was actually written about, and the one the first
 * implementation went blind on: the top document holds no form of its own, and the only two
 * required fields live in a single embed from an origin no policy authorizes a write into.
 *
 * Every value here is what the real executor produces for that page, not a convenient
 * invention. `resolveActiveGroup` filters the page's groups through `isFrameFillAllowed`,
 * finds none eligible, and keeps the count-based dominant group anyway
 * (`executor.ts`: `if (eligible.length === 0) return fallback;`). `readPageState` then marks
 * those fields `active: true` against that fallback frame, so `activeFrameId` is the vendor's
 * frame and the fields carry the vendor's `frameOrigin`. `fill()` still refuses each one at
 * `requireFillableFrame`, and `evaluateFormReadiness` -- which only ever looks at active
 * fields -- reports them as ordinary `required_field_empty` blockers with no explanation
 * attached (see the test using this fixture for the readiness it is paired with).
 */
const EMBEDDED_FORM_ONLY_SNAPSHOT: FormSnapshot = {
  generation: 1,
  capturedAt: '2026-01-01T00:00:00.000Z',
  challengeDetected: false,
  activeFrameId: 1,
  pageStateFingerprint: 'fingerprint',
  topFrameOrigin: 'https://careers.employer.invalid',
  submitControls: [],
  fields: [
    { fieldRef: 'e1', label: 'Full name', controlType: 'text', required: true, frameId: 1, active: true, frameOrigin: 'https://boards.ats-vendor.invalid' },
    { fieldRef: 'e2', label: 'Email', controlType: 'text', required: true, frameId: 1, active: true, frameOrigin: 'https://boards.ats-vendor.invalid' },
  ],
};

/**
 * A page that mixes both cross-origin shapes at once: an ordinary inactive chat widget (which
 * happens to come *first* in `fields` order) alongside the real form, itself embedded from a
 * third origin the policy doesn't authorize. Regression for the bug the re-verify pass of
 * `draft-cross-origin-ipc-bridge-visibility.md` found in the first fix-up: picking "the first
 * cross-origin field in snapshot order" for the card's one-sentence summary showed the
 * "third-party embed" heading next to a sentence about the unrelated chat widget, while the
 * two sentences that actually explain why nothing was filled were buried in the collapsed list.
 */
const MIXED_ORIGIN_SNAPSHOT: FormSnapshot = {
  generation: 1,
  capturedAt: '2026-01-01T00:00:00.000Z',
  challengeDetected: false,
  activeFrameId: 1,
  pageStateFingerprint: 'fingerprint',
  topFrameOrigin: 'https://careers.employer.invalid',
  submitControls: [],
  fields: [
    { fieldRef: 'w1', label: 'Visitor name', controlType: 'text', required: false, frameId: 2, active: false, frameOrigin: 'https://chat.vendor.invalid' },
    { fieldRef: 'e1', label: 'Full name', controlType: 'text', required: true, frameId: 1, active: true, frameOrigin: 'https://boards.ats-vendor.invalid' },
    { fieldRef: 'e2', label: 'Email', controlType: 'text', required: true, frameId: 1, active: true, frameOrigin: 'https://boards.ats-vendor.invalid' },
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
  it('never reports a field count, and says an unready form still needs the person', () => {
    // The card used to read "N fields filled" from the page's own field count (#277). It now
    // carries no count at all: either everything required is filled, or some answers still need you.
    renderCard({ readiness: readiness({ verifiedFilledCount: 1, ready: false, requiredFieldsSatisfied: 1, blockers: [{ kind: 'required_field_empty', fieldRef: 'f1', label: 'Full name' }] }) });
    expect(screen.queryByText(/fields? (verified )?filled/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Form checks/i)).not.toBeInTheDocument();
    expect(screen.getByText('Some answers still need you.')).toBeInTheDocument();
  });

  it('says everything required is filled in only when the form is ready', () => {
    renderCard();
    expect(screen.getByText('Everything required is filled in.')).toBeInTheDocument();
    expect(screen.queryByText('Some answers still need you.')).not.toBeInTheDocument();
  });

  it('keeps the screenshot available without a stat strip or a field inventory', () => {
    renderCard({
      readiness: readiness({ verifiedFilledCount: 0, requiredFieldsSatisfied: 0, ready: false, blockers: [
        { kind: 'required_field_empty', fieldRef: 'f1', label: 'Full name' },
        { kind: 'required_field_empty', fieldRef: 'f2', label: 'Email' },
      ] }),
    });
    expect(screen.getByRole('img', { name: /live application page preview/i })).toBeInTheDocument();
    expect(screen.queryByText('Checks left')).not.toBeInTheDocument();
    expect(screen.queryByText(/\(text, required\)/i)).not.toBeInTheDocument();
  });

  it('keeps the swipe target compact and puts the full review behind disclosures', () => {
    renderCard();
    const swipeCard = screen.getAllByText(/Senior Engineer/)[0]?.closest('div[class*="select-none"]');
    const preview = screen.getByRole('img', { name: /live application page preview/i });
    expect(swipeCard).not.toContainElement(preview);
    expect(screen.getByText('Prepared application details').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('Review application form').closest('details')).not.toHaveAttribute('open');
  });

  it('looks and behaves like the front card in a swipe deck', () => {
    renderCard();
    const cardBacks = screen.getAllByTestId('swipe-card-back');
    expect(cardBacks).toHaveLength(2);
    cardBacks.forEach((cardBack) => expect(cardBack).toHaveAttribute('aria-hidden', 'true'));
    expect(screen.queryByText(/Drag left/i)).not.toBeInTheDocument();
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
    expect(screen.getByText('Some answers still need you.')).toBeInTheDocument();
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

  it('maps right and left drags to submit and skip without stale drag state', () => {
    const { onApprove, onSkip } = renderCard();
    const card = screen.getAllByText(/Senior Engineer/)[0]?.closest('div[class*="select-none"]');
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
    expect(onApprove).toHaveBeenCalledTimes(1);

    drag('pointerdown', 230, 2);
    drag('pointermove', 90, 2);
    drag('pointerup', 90, 2);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('does not finish a drag after another decision makes the card busy', () => {
    const onApprove = vi.fn();
    const onSkip = vi.fn();
    const props = {
      attempt: ATTEMPT,
      snapshot: SNAPSHOT,
      screenshotBase64: 'ZmFrZQ==',
      readiness: readiness(),
      onApprove,
      onSkip,
      onOpenLiveView: vi.fn(),
    };
    const { rerender } = render(<ApplicationReviewSwipeCard {...props} />);
    const card = screen.getByTestId('application-swipe-card');

    function pointer(type: string, clientX: number) {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, { clientX: { value: clientX }, pointerId: { value: 1 } });
      fireEvent(card, event);
    }

    pointer('pointerdown', 100);
    pointer('pointermove', 240);
    rerender(<ApplicationReviewSwipeCard {...props} busy />);
    pointer('pointerup', 240);

    expect(onApprove).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('never submits from a right swipe while readiness blocks the button', () => {
    const { onApprove } = renderCard({
      readiness: readiness({
        ready: false,
        blockers: [{ kind: 'required_field_empty', fieldRef: 'f1', label: 'Full name' }],
      }),
    });
    const card = screen.getAllByText(/Senior Engineer/)[0]?.closest('div[class*="select-none"]');
    expect(card).not.toBeNull();

    const down = new Event('pointerdown', { bubbles: true });
    Object.defineProperties(down, { clientX: { value: 100 }, pointerId: { value: 1 } });
    const move = new Event('pointermove', { bubbles: true });
    Object.defineProperties(move, { clientX: { value: 240 }, pointerId: { value: 1 } });
    const up = new Event('pointerup', { bubbles: true });
    Object.defineProperties(up, { clientX: { value: 240 }, pointerId: { value: 1 } });
    fireEvent(card!, down);
    fireEvent(card!, move);
    fireEvent(card!, up);

    expect(onApprove).not.toHaveBeenCalled();
  });

  describe('cross-origin field visibility (draft-cross-origin-ipc-bridge-visibility)', () => {
    const HOSTED_ELSEWHERE = /Part of this form is hosted by another site, so the app left it blank\. Use the live page to fill it in\./i;

    it('says nothing about a widget in another frame that is not the form under review', () => {
      renderCard({ snapshot: CROSS_ORIGIN_SNAPSHOT });
      expect(screen.queryByText(HOSTED_ELSEWHERE)).not.toBeInTheDocument();
      expect(screen.queryByText(/different frame/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/https:\/\/chat\.vendor\.invalid/i)).not.toBeInTheDocument();
    });

    it('never mentions another frame for a same-origin snapshot, additive-only as the ticket requires', () => {
      renderCard();
      expect(screen.queryByText(HOSTED_ELSEWHERE)).not.toBeInTheDocument();
    });

    it('explains the page whose entire form is inside a disallowed embed, in one line with no addresses', () => {
      // With the notice keyed on `!field.active`, this page produced nothing at all: no notice, and
      // two bare "required and still empty" blockers for fields the executor was never allowed to
      // type into.
      renderCard({
        snapshot: EMBEDDED_FORM_ONLY_SNAPSHOT,
        readiness: readiness({
          ready: false,
          verifiedFilledCount: 0,
          discoveredFieldCount: 2,
          requiredFieldsSatisfied: 0,
          blockers: [
            { kind: 'required_field_empty', fieldRef: 'e1', label: 'Full name' },
            { kind: 'required_field_empty', fieldRef: 'e2', label: 'Email' },
          ],
        }),
      });

      expect(screen.getByText(HOSTED_ELSEWHERE)).toBeInTheDocument();
      expect(screen.queryByText(/ats-vendor/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/\+\d+ more/i)).not.toBeInTheDocument();
      // The blockers are listed on the card itself, label only.
      expect(screen.getByText(/"Full name" is required and still empty\./i)).toBeInTheDocument();
      expect(screen.getByText(/"Email" is required and still empty\./i)).toBeInTheDocument();
    });

    it('shows the one notice for a page mixing a chat widget with an embedded form', () => {
      renderCard({
        snapshot: MIXED_ORIGIN_SNAPSHOT,
        readiness: readiness({
          ready: false,
          verifiedFilledCount: 0,
          discoveredFieldCount: 2,
          requiredFieldsSatisfied: 0,
          blockers: [{ kind: 'required_field_empty', fieldRef: 'e1', label: 'Full name' }],
        }),
      });
      expect(screen.getAllByText(HOSTED_ELSEWHERE)).toHaveLength(1);
      expect(screen.queryByText(/Visitor name/i)).not.toBeInTheDocument();
    });
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
      const card = screen.getByTestId('application-swipe-card');
      pointer(card, 'pointerdown', 100);
      pointer(card, 'pointermove', 140);
      return card;
    }

    afterEach(() => {
      // @ts-expect-error jsdom does not define matchMedia, so restore that absence
      delete window.matchMedia;
    });

    it('tilts and animates the card by default', () => {
      mockReducedMotion(false);
      renderCard();
      const card = dragRight();
      expect(card.style.transform).toContain('rotate(');
      pointer(card, 'pointerup', 140);
      expect(card.style.transition).toContain('transform');
    });

    it('drops the tilt and the transform transition when reduced motion is set', () => {
      mockReducedMotion(true);
      renderCard();
      const card = dragRight();
      expect(card.style.transform).toBe('translateX(40px)');
      pointer(card, 'pointerup', 140);
      expect(card.style.transition).toBe('none');
      expect(card.style.transform).not.toContain('rotate(');
    });
  });
});

describe('ApplicationReviewSwipeCard wide layout (#469)', () => {
  it('puts the screenshot in its own always-visible pane with no height cap and no card stack', () => {
    renderCard({ wide: true });
    const pane = screen.getByTestId('review-screenshot-pane');
    const preview = within(pane).getByRole('img', { name: /live application page preview/i });
    expect(preview.closest('details')).toBeNull();
    expect(preview.closest('[class*="max-h-72"]')).toBeNull();
    expect(screen.getByTestId('review-layout')).toHaveAttribute('data-layout', 'wide');
    expect(screen.queryAllByTestId('swipe-card-back')).toHaveLength(0);
    // Same accessible names as the compact card.
    expect(screen.getByRole('group', { name: /application decision card for senior engineer at acme corp/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit application' })).toBeInTheDocument();
  });

  it('keeps the compact card, with the capped screenshot behind a disclosure, by default', () => {
    renderCard();
    expect(screen.getByTestId('review-layout')).toHaveAttribute('data-layout', 'compact');
    expect(screen.queryByTestId('review-screenshot-pane')).not.toBeInTheDocument();
    const preview = screen.getByRole('img', { name: /live application page preview/i });
    expect(preview.closest('[class*="max-h-72"]')).not.toBeNull();
  });

  it('offers View full size in both layouts', () => {
    const { unmount } = render(
      <ApplicationReviewSwipeCard
        attempt={ATTEMPT}
        snapshot={SNAPSHOT}
        screenshotBase64="ZmFrZQ=="
        readiness={readiness()}
        onApprove={vi.fn()}
        onSkip={vi.fn()}
        onOpenLiveView={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'View full size' })).toBeInTheDocument();
    unmount();
    renderCard({ wide: true });
    fireEvent.click(screen.getByRole('button', { name: 'View full size' }));
    expect(screen.getByRole('dialog', { name: 'Form screenshot at original size' })).toBeInTheDocument();
  });
});
