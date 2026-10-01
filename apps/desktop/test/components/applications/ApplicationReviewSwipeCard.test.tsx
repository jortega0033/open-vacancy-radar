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
    // The screenshot is still available, but no longer makes the decision card itself enormous.
    expect(screen.getByRole('img', { name: /live application page preview/i })).toBeInTheDocument();
    expect(screen.getByText(/Form checks \(2\) and fields \(3\)/i)).toBeInTheDocument();
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
    expect(screen.getByTestId('application-swipe-card')).toHaveAttribute('title', 'Drag left to skip or right to submit');
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
    it('shows a distinct, frame-origin-specific notice for a field the executor never fills, never a generic blocker', () => {
      renderCard({ snapshot: CROSS_ORIGIN_SNAPSHOT });
      expect(screen.getByText(/Also found in a different frame, not filled automatically/i)).toBeInTheDocument();
      expect(
        screen.getByText(
          /"Visitor name" was found in a different frame \(https:\/\/chat\.vendor\.invalid\) than this page \(https:\/\/careers\.employer\.invalid\) and is not part of the form under review, so it was left untouched\./i,
        ),
      ).toBeInTheDocument();
      expect(screen.getByText(/\+1 more in another frame/i)).toBeInTheDocument();
      // Never claims the policy refused a write: an inactive cross-origin field can equally be a
      // vendor embed the policy does allowlist that simply is not the winning group, and the card
      // cannot tell those apart from the snapshot. "Not part of the form" is what it does know.
      expect(screen.queryByText(/does not type into a third-party embed/i)).not.toBeInTheDocument();
      // Distinct from an ordinary blocker: the real form's own two required fields are unfilled
      // in this fixture too (readiness() defaults to zero blockers only because nothing here
      // asserts on it), but the cross-origin notice never claims to be one of `readiness.blockers`.
      expect(screen.queryByText(/is required and still empty/i)).not.toBeInTheDocument();
    });

    it('lists every cross-origin field, and folds the count into the form-checks summary', () => {
      renderCard({ snapshot: CROSS_ORIGIN_SNAPSHOT });
      expect(screen.getByText(/Form checks \(0\) and fields \(2\), 2 in another frame/i)).toBeInTheDocument();
      // Every cross-origin field is listed, not only the first one summarized on the card.
      expect(
        screen.getByText(
          /"Email" was found in a different frame \(https:\/\/chat\.vendor\.invalid\) than this page \(https:\/\/careers\.employer\.invalid\) and is not part of the form under review, so it was left untouched\./i,
        ),
      ).toBeInTheDocument();
    });

    it('never mentions another frame for a same-origin snapshot, additive-only as the ticket requires', () => {
      renderCard();
      expect(screen.queryByText(/different frame/i)).not.toBeInTheDocument();
      expect(screen.getByText(/Form checks \(0\) and fields \(3\)/i)).toBeInTheDocument();
    });

    it('explains the page whose entire form is inside a disallowed embed, where every field comes back active', () => {
      // The regression this whole predicate exists for. With the notice keyed on `!field.active`,
      // this page produced nothing at all: no notice, and two bare "required and still empty"
      // blockers for fields the executor was never going to be allowed to type into.
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

      expect(screen.getByText(/This form is inside a third-party embed/i)).toBeInTheDocument();
      expect(
        screen.getByText(
          /"Full name" is part of a form embedded from https:\/\/boards\.ats-vendor\.invalid, which is not this page's own address \(https:\/\/careers\.employer\.invalid\)\. This app does not type into a third-party embed, so nothing was entered here\./i,
        ),
      ).toBeInTheDocument();
      expect(screen.getByText(/\+1 more in another frame/i)).toBeInTheDocument();
      expect(screen.getByText(/Form checks \(2\) and fields \(2\), 2 in another frame/i)).toBeInTheDocument();
      // The unexplained blocker is still shown, as it should be -- the point is that it is no
      // longer the only thing a reviewer is given about this page.
      expect(screen.getByText(/"Full name" is required and still empty\./i)).toBeInTheDocument();
      // And the wording never calls the embedded form "not part of the form under review": it is
      // the form under review, which is exactly why nothing could be filled.
      expect(screen.queryByText(/not part of the form under review/i)).not.toBeInTheDocument();
    });

    it('summarizes the embedded form, not an unrelated widget that happens to come first in field order', () => {
      renderCard({
        snapshot: MIXED_ORIGIN_SNAPSHOT,
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

      // The heading and the one visible sentence must agree about which field they're describing:
      // the embedded form, not the chat widget that happens to sort first.
      expect(screen.getByText(/This form is inside a third-party embed/i)).toBeInTheDocument();
      expect(
        screen.getByText(
          /"Full name" is part of a form embedded from https:\/\/boards\.ats-vendor\.invalid, which is not this page's own address \(https:\/\/careers\.employer\.invalid\)\. This app does not type into a third-party embed, so nothing was entered here\./i,
        ),
      ).toBeInTheDocument();

      // Expanding the disclosure shows exactly the two fields the summary omitted -- the chat
      // widget (never shown above) and the second embedded-form field -- and never repeats the
      // summarized field.
      expect(screen.getByText(/\+2 more in another frame/i)).toBeInTheDocument();
      const summarySentenceCount = screen.getAllByText(
        /"Full name" is part of a form embedded from https:\/\/boards\.ats-vendor\.invalid/i,
      ).length;
      expect(summarySentenceCount).toBe(1);
      expect(
        screen.getByText(
          /"Visitor name" was found in a different frame \(https:\/\/chat\.vendor\.invalid\) than this page \(https:\/\/careers\.employer\.invalid\) and is not part of the form under review, so it was left untouched\./i,
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /"Email" is part of a form embedded from https:\/\/boards\.ats-vendor\.invalid, which is not this page's own address \(https:\/\/careers\.employer\.invalid\)\. This app does not type into a third-party embed, so nothing was entered here\./i,
        ),
      ).toBeInTheDocument();
    });
  });
});
