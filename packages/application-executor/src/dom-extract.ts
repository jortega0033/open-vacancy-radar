import type { FieldClassification, FieldControlType, SnapshotField, SnapshotOption, SnapshotSubmitControl } from './form-snapshot.js';
import { mintFieldRef, mintOptionRef, mintSubmitControlRef } from './form-snapshot.js';

/**
 * Pure extraction of `SnapshotField`s from a CDP `DOM.getDocument` response tree. Kept separate
 * from `executor.ts` (which owns the actual `sendCommand` calls) so this -- the part with real
 * logic worth getting right -- is unit-testable against a hand-built tree, with no CDP transport,
 * no Electron, and no live browser required.
 *
 * A minimal local shape for the CDP `DOM.Node` type, not the full protocol: only the fields this
 * extraction actually reads. `attributes` is CDP's own flat `[name, value, name, value, ...]`
 * encoding.
 */
export interface CdpDomNode {
  nodeName: string;
  nodeType: number;
  attributes?: readonly string[];
  children?: readonly CdpDomNode[];
  nodeValue?: string;
  /** CDP's own stable node handle -- what `DOM.focus`/`DOM.setFileInputFiles`/`DOM.getBoxModel`
   * actually target. More stable across the tree's lifetime than `nodeId`, which CDP is explicit
   * can be reused after certain operations. */
  backendNodeId: number;
  /** Present on an `IFRAME` node only when `DOM.getDocument` was called with `pierce: true`: the
   * root of that frame's own document, a distinct field from `children` per the CDP protocol (an
   * iframe's rendered content is never one of its DOM `children`). `executor.ts`'s `readDom()`
   * does request `pierce: true` -- this field is what makes that request actually do anything;
   * without reading it, a page whose real application form lives inside an iframe would silently
   * extract zero fields at all. */
  contentDocument?: CdpDomNode;
}

/** The internal (never public, never part of `SnapshotField`) map from a minted `fieldRef` to the
 * real CDP node handle it refers to -- `executor.ts` keeps one of these per snapshot generation so
 * `fill`/`select`/`attach` can issue real, correctly-targeted CDP calls. Kept out of
 * `SnapshotField`/`FormSnapshot` deliberately: those shapes cross into the field-map contract
 * (#196 §2.3) that the generation session sees, and a CDP node handle has no business there.
 */
export type FieldNodeMap = ReadonlyMap<string, number>;

function attr(node: CdpDomNode, name: string): string | undefined {
  const list = node.attributes;
  if (!list) return undefined;
  for (let i = 0; i + 1 < list.length; i += 2) {
    if (list[i]?.toLowerCase() === name.toLowerCase()) return list[i + 1];
  }
  return undefined;
}

function hasAttr(node: CdpDomNode, name: string): boolean {
  return attr(node, name) !== undefined;
}

/** Best-effort label text: ARIA label, then a placeholder, then the field's own name, then id.
 * A real associated `<label for=...>` requires correlating two different subtrees by id, which
 * this pass doesn't attempt in v1 -- an unlabeled field still gets a usable, if generic, label. */
function resolveLabel(node: CdpDomNode): string {
  return attr(node, 'aria-label') ?? attr(node, 'placeholder') ?? attr(node, 'name') ?? attr(node, 'id') ?? '';
}

const CREDENTIAL_AUTOCOMPLETE_PATTERN = /current-password|new-password|one-time-code|cc-|credit-card/i;
const CREDENTIAL_NAME_PATTERN = /password|passwd|ssn|social.?security/i;
// Deliberately no `\b` word boundaries: real form field names are as often camelCase
// ("agreeToTerms") or snake_case ("agree_to_terms") as space-separated, and a word boundary
// simply does not exist between "agree" and "ToTerms" in the first form -- an earlier version of
// this pattern used `\bterms\b`/`\bagree\b` and silently failed to classify exactly that shape.
const CONSENT_NAME_PATTERN = /consent|terms|agree|gdpr|marketing.?opt/i;

function classify(node: CdpDomNode, type: string, name: string): FieldClassification | undefined {
  if (type === 'password') return 'credential_field';
  const autocomplete = attr(node, 'autocomplete') ?? '';
  if (CREDENTIAL_AUTOCOMPLETE_PATTERN.test(autocomplete)) return 'credential_field';
  if (CREDENTIAL_NAME_PATTERN.test(name)) return 'credential_field';
  if (CONSENT_NAME_PATTERN.test(name)) return 'consent_field';
  if (type === 'checkbox' && CONSENT_NAME_PATTERN.test(resolveLabel(node))) return 'consent_field';
  return undefined;
}

function controlTypeFor(node: CdpDomNode, inputType: string): FieldControlType {
  switch (node.nodeName) {
    case 'TEXTAREA':
      return 'textarea';
    case 'SELECT':
      return 'select';
    case 'INPUT':
      switch (inputType) {
        case 'file':
          return 'file';
        case 'checkbox':
          return 'checkbox';
        case 'radio':
          return 'radio';
        default:
          return 'text';
      }
    default:
      return 'unknown';
  }
}

function textContent(node: CdpDomNode): string {
  if (node.nodeType === 3 /* TEXT_NODE */) return node.nodeValue ?? '';
  return (node.children ?? []).map(textContent).join('').trim();
}

function extractOptions(selectNode: CdpDomNode): SnapshotOption[] {
  const options: SnapshotOption[] = [];
  for (const child of selectNode.children ?? []) {
    if (child.nodeName !== 'OPTION') continue;
    options.push({ optionRef: mintOptionRef(), label: textContent(child) || (attr(child, 'value') ?? '') });
  }
  return options;
}

const FILLABLE_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

/** Whether `node` is a submit-shaped control: a `<button>` (default type is `submit` per the HTML
 * spec unless the page says otherwise) or an `<input type="submit">`. Every other button type
 * (`type="button"`, `type="reset"`) is a no-op or destructive control, never a target `submit()`
 * should ever click. */
function isSubmitControl(node: CdpDomNode): boolean {
  if (node.nodeName === 'BUTTON') {
    const type = (attr(node, 'type') ?? 'submit').toLowerCase();
    return type === 'submit';
  }
  if (node.nodeName === 'INPUT') {
    return (attr(node, 'type') ?? '').toLowerCase() === 'submit';
  }
  return false;
}

/** A `<button>`'s visible label is its text content; an `<input type="submit">` carries its own
 * label in `value` (the attribute the browser itself renders), falling back to the browser's own
 * default caption when the page didn't set one. */
function submitControlLabel(node: CdpDomNode): string {
  if (node.nodeName === 'INPUT') return attr(node, 'value') ?? 'Submit';
  return textContent(node) || 'Submit';
}

/**
 * Marks of a bot-detection challenge widget (reCAPTCHA, hCaptcha, Cloudflare Turnstile) that could
 * plausibly appear on a real application form -- checked against an `<iframe>`'s `src` (the
 * reliable signal, since these widgets are always framed) and, as a fallback for a challenge that
 * hasn't finished loading its iframe yet at snapshot time, well-known container class names. This
 * is deliberately a fixed, named list rather than a heuristic: #196's own design treats
 * circumventing a bot/CAPTCHA challenge as a hard stop regardless of terms (`docs/job-source-policy.md`),
 * so detecting one must fail closed (a widget this list doesn't recognize is simply not caught, but
 * nothing here is allowed to reduce a real match to a false negative on a technicality).
 */
const CHALLENGE_IFRAME_SRC_PATTERN = /google\.com\/recaptcha|hcaptcha\.com|challenges\.cloudflare\.com/i;
const CHALLENGE_CLASS_PATTERN = /(^|\s)(g-recaptcha|h-captcha|cf-turnstile)(\s|$)/i;

export interface ExtractedSnapshot {
  fields: SnapshotField[];
  submitControls: SnapshotSubmitControl[];
  /** `fieldRef -> backendNodeId` AND `controlRef -> backendNodeId`, sharing one map since both are
   * opaque refs `executor.ts` resolves the exact same way (a real CDP node handle to click/focus).
   * For `executor.ts`'s own internal use only. */
  nodeIds: FieldNodeMap;
  /** Whether a known bot-detection challenge widget (reCAPTCHA/hCaptcha/Turnstile) was found
   * anywhere in the tree, checked in the same pass as field extraction. `executor.ts`'s `snapshot()`
   * surfaces this on `FormSnapshot` so a caller can `handoff('captcha')` immediately rather than
   * acting on fields that may sit behind an active challenge -- #196's design and
   * `docs/job-source-policy.md` both treat circumventing a bot/CAPTCHA challenge as a hard stop
   * regardless of terms, so detecting one here must fail closed. */
  challengeDetected: boolean;
}

/** The most frequent value in a list, or `undefined` for an empty list -- ties broken by
 * insertion order (`Map` preserves first-seen order, and the `>` comparison below never replaces
 * a leader on an equal count). Used to find "the" frame/form a page's real fields live in without
 * needing every field to agree exactly. */
function mostCommon<T>(values: readonly T[]): T | undefined {
  if (values.length === 0) return undefined;
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Walks a CDP DOM tree and mints a `SnapshotField` for every fillable element (`input`, `select`,
 * `textarea`), and, in the same pass, checks every node for a known CAPTCHA/bot-detection widget
 * (reCAPTCHA, hCaptcha, Cloudflare Turnstile) -- checked against an `<iframe>`'s `src` (the
 * reliable signal, since these widgets are always framed) and, as a fallback for a challenge that
 * hasn't finished loading its iframe yet at snapshot time, well-known container class names.
 *
 * Three kinds of fillable-looking element are skipped, none of them something a real applicant
 * could fill: `<input type="hidden">` (a value carrier, not a control); anything `disabled`; and
 * anything carrying the generic HTML `hidden` boolean attribute (confirmed against a real Electron
 * `WebContentsView` in `e2e/application-executor.spec.ts` -- a field the page marks `hidden` for
 * CSS-invisibility reasons, distinct from `type="hidden"`, was originally surfaced as fillable
 * because only the latter was checked). Hiding via a stylesheet rule (`display: none` in CSS,
 * rather than the attribute) is NOT detected -- that needs computed style, which this package has
 * no allowed CDP method to read -- so this remains a best-effort check, not a complete one.
 *
 * Descends into an `IFRAME`'s own `contentDocument` (present when the caller requested
 * `pierce: true`, as `executor.ts`'s `readDom()` does) under a fresh frame id, so a real
 * application form embedded in an iframe is actually reachable at all -- previously requested via
 * `pierce: true` but never consumed, silently extracting zero fields from such a page.
 *
 * Submit-control candidates are scoped to reduce (not eliminate -- see the caveat below) the
 * chance of resolving to a control that has nothing to do with the application: a control is kept
 * only if it shares BOTH the frame and the nearest enclosing `<form>` (or "no form", if that's
 * what the fields themselves have) that most of the extracted fields are found in. This rules out,
 * regardless of label wording, an unrelated iframe (a chat widget, an ad) and an unrelated `<form>`
 * on the same page (a newsletter signup, a header search box) as candidates. It does NOT solve the
 * hardest case -- a fully JS-driven page where neither the real fields nor an unrelated same-frame
 * button use a `<form>` element at all, so both end up in the same "no form" bucket -- that would
 * need real positional/structural reasoning (e.g. nearest common DOM ancestor) beyond this pass's
 * scope; `submit-control.ts`'s label heuristic and its "refuse rather than guess" rule remain the
 * only defense against that specific case.
 */
export function extractSnapshotFields(root: CdpDomNode): ExtractedSnapshot {
  const fields: SnapshotField[] = [];
  const nodeIds = new Map<string, number>();
  let challengeDetected = false;
  let nextFrameId = 0;

  const fieldFrameIds: number[] = [];
  const fieldFormScopes: (number | undefined)[] = [];
  const submitCandidates: Array<{ control: SnapshotSubmitControl; frameId: number; formScope: number | undefined }> = [];

  function walk(node: CdpDomNode, frameId: number, formScope: number | undefined): void {
    if (
      node.nodeName === 'IFRAME' &&
      CHALLENGE_IFRAME_SRC_PATTERN.test(attr(node, 'src') ?? '')
    ) {
      challengeDetected = true;
    } else if (CHALLENGE_CLASS_PATTERN.test(attr(node, 'class') ?? '')) {
      challengeDetected = true;
    }

    const childFormScope = node.nodeName === 'FORM' ? node.backendNodeId : formScope;

    // A submit-shaped <input> (type="submit") is also technically an INPUT tag, but it is a click
    // target, never a fillable field -- checked first so it never falls through to the fillable
    // branch below and gets minted as a bogus text field.
    if (isSubmitControl(node)) {
      if (!hasAttr(node, 'disabled') && !hasAttr(node, 'hidden')) {
        const controlRef = mintSubmitControlRef();
        nodeIds.set(controlRef, node.backendNodeId);
        submitCandidates.push({ control: { controlRef, label: submitControlLabel(node) }, frameId, formScope });
      }
    } else if (FILLABLE_TAGS.has(node.nodeName)) {
      const inputType = (attr(node, 'type') ?? 'text').toLowerCase();
      if (inputType !== 'hidden' && !hasAttr(node, 'disabled') && !hasAttr(node, 'hidden')) {
        const label = resolveLabel(node);
        const controlType = controlTypeFor(node, inputType);
        const classification = classify(node, inputType, `${label} ${attr(node, 'name') ?? ''} ${attr(node, 'id') ?? ''}`);
        const fieldRef = mintFieldRef();
        nodeIds.set(fieldRef, node.backendNodeId);
        fields.push({
          fieldRef,
          label,
          controlType,
          required: hasAttr(node, 'required'),
          ...(controlType === 'select' ? { options: extractOptions(node) } : {}),
          ...(controlType === 'checkbox' ? { checked: hasAttr(node, 'checked') } : {}),
          ...(classification ? { classification } : {}),
        });
        fieldFrameIds.push(frameId);
        fieldFormScopes.push(formScope);
      }
    }

    if (node.nodeName === 'IFRAME' && node.contentDocument) {
      nextFrameId += 1;
      walk(node.contentDocument, nextFrameId, undefined);
    } else if (node.nodeName !== 'SELECT') {
      // SELECT's own OPTION children are already consumed by extractOptions above; don't also
      // walk into them as if they were independent top-level fields.
      for (const child of node.children ?? []) walk(child, frameId, childFormScope);
    }
  }

  walk(root, 0, undefined);

  // A page with no fields yet (a field-less "review and submit" step, or an empty read still
  // mid-retry in executor.ts) has nothing to compute a dominant frame/form from -- default to the
  // top document's own top-level scope (frame 0, no form) rather than excluding every candidate.
  const dominantFrameId = mostCommon(fieldFrameIds) ?? 0;
  const dominantFormScope = mostCommon(fieldFormScopes) ?? undefined;
  const submitControls = submitCandidates
    .filter((candidate) => candidate.frameId === dominantFrameId && candidate.formScope === dominantFormScope)
    .map((candidate) => candidate.control);

  return { fields, submitControls, nodeIds, challengeDetected };
}

// ------------------------------------------------------- post-submit observation signals (#271)

/** Never walked for visible text: neither carries anything a person reads on the page, and a
 * script body in particular is full of strings that would poison every phrase match in
 * `submission-receipt.ts`. */
const NON_VISIBLE_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);

/** Hard cap on collected page text. A real confirmation is at the top of a confirmation page, not
 * 200KB into one, and an unbounded read of third-party page text has no business crossing into a
 * classifier or a database row. */
export const MAX_OBSERVED_PAGE_TEXT_LENGTH = 20_000;

/** How many distinct error markers are worth collecting. The classifier only needs to know that
 * at least one exists and roughly what it said. */
const MAX_ERROR_MARKERS = 10;

/** The fallback structural mark of a validation error, for a form that does not set
 * `aria-invalid`. Anchored to whole class tokens so `error` matches but `terrorism-question` does
 * not, and deliberately never matching a generic alert/banner token: `role="alert"` and
 * `class="alert"` are used just as often for a *success* banner ("Your application was submitted"),
 * and reading one of those as a field error would misreport a genuinely delivered application as
 * one still needing attention. A success banner's own class (`alert-success`) does not match here. */
const ERROR_CLASS_PATTERN = /(^|\s)(?:field-)?(?:error|errors|invalid|has-error|is-invalid|error-message|validation-error)(\s|$)/i;

export interface SubmissionSignals {
  /** Visible page text, whitespace-collapsed and capped at `MAX_OBSERVED_PAGE_TEXT_LENGTH`. */
  text: string;
  /** Whether any submit-shaped control is still on the page, i.e. the form is still standing.
   * Deliberately the *unscoped* check (any submit-shaped control anywhere), not
   * `extractSnapshotFields`'s dominant-frame/form narrowing: for this question a false "the form is
   * still there" is the safe answer, since it is what withholds a `submitted` verdict. */
  formStillPresent: boolean;
  /** Non-empty text of each structural error marker found, capped at `MAX_ERROR_MARKERS`. */
  errorMarkers: string[];
}

/**
 * Reads a CDP `DOM.getDocument` tree for the three things #271's outcome classifier is allowed to
 * look at after the submit click: what the page now says, whether the form is still standing, and
 * whether the page is flagging field errors.
 *
 * Pure, like `extractSnapshotFields` above and for the same reason -- every branch here is
 * exercisable against a hand-built fixture tree, with no browser and no real submission anywhere.
 * Mints no refs and touches no node map: this pass is read-only observation, never a step that
 * could be acted on.
 */
export function extractSubmissionSignals(root: CdpDomNode): SubmissionSignals {
  const chunks: string[] = [];
  let length = 0;
  let formStillPresent = false;
  const errorMarkers: string[] = [];

  function walk(node: CdpDomNode): void {
    if (NON_VISIBLE_TAGS.has(node.nodeName)) return;

    if (node.nodeType === 3 /* TEXT_NODE */) {
      const value = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
      if (value && length < MAX_OBSERVED_PAGE_TEXT_LENGTH) {
        chunks.push(value);
        length += value.length + 1;
      }
      return;
    }

    if (isSubmitControl(node) && !hasAttr(node, 'hidden')) formStillPresent = true;

    const ariaInvalid = (attr(node, 'aria-invalid') ?? '').toLowerCase() === 'true';
    const isErrorMarker = ariaInvalid || ERROR_CLASS_PATTERN.test(attr(node, 'class') ?? '');
    if (isErrorMarker && errorMarkers.length < MAX_ERROR_MARKERS && !hasAttr(node, 'hidden')) {
      const markerText = textContent(node).replace(/\s+/g, ' ').trim();
      if (markerText) {
        errorMarkers.push(markerText.slice(0, 200));
      } else if (ariaInvalid) {
        // A flagged *control* carries no text of its own -- the message it points at is a sibling
        // node. The flag alone is still an unambiguous "this field was refused", so record it by
        // the field's own name rather than dropping it. A merely empty error *container*, which
        // plenty of forms ship in the markup and fill in only on failure, is dropped (below).
        errorMarkers.push(`field "${resolveLabel(node) || node.nodeName.toLowerCase()}" was flagged invalid`);
      }
    }

    if (node.nodeName === 'IFRAME' && node.contentDocument) {
      walk(node.contentDocument);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  }

  walk(root);

  return { text: chunks.join(' ').slice(0, MAX_OBSERVED_PAGE_TEXT_LENGTH), formStillPresent, errorMarkers };
}
