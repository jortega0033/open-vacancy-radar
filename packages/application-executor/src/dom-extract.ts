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
 */
export function extractSnapshotFields(root: CdpDomNode): ExtractedSnapshot {
  const fields: SnapshotField[] = [];
  const submitControls: SnapshotSubmitControl[] = [];
  const nodeIds = new Map<string, number>();
  let challengeDetected = false;

  function walk(node: CdpDomNode): void {
    if (
      node.nodeName === 'IFRAME' &&
      CHALLENGE_IFRAME_SRC_PATTERN.test(attr(node, 'src') ?? '')
    ) {
      challengeDetected = true;
    } else if (CHALLENGE_CLASS_PATTERN.test(attr(node, 'class') ?? '')) {
      challengeDetected = true;
    }

    // A submit-shaped <input> (type="submit") is also technically an INPUT tag, but it is a click
    // target, never a fillable field -- checked first so it never falls through to the fillable
    // branch below and gets minted as a bogus text field.
    if (isSubmitControl(node)) {
      if (!hasAttr(node, 'disabled') && !hasAttr(node, 'hidden')) {
        const controlRef = mintSubmitControlRef();
        nodeIds.set(controlRef, node.backendNodeId);
        submitControls.push({ controlRef, label: submitControlLabel(node) });
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
      }
    }
    // SELECT's own OPTION children are already consumed by extractOptions above; don't also walk
    // into them as if they were independent top-level fields.
    if (node.nodeName !== 'SELECT') {
      for (const child of node.children ?? []) walk(child);
    }
  }

  walk(root);
  return { fields, submitControls, nodeIds, challengeDetected };
}
