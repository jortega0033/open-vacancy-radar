import type { FieldClassification, FieldControlType, SnapshotField, SnapshotOption } from './form-snapshot.js';
import { mintFieldRef, mintOptionRef } from './form-snapshot.js';

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

export interface ExtractedSnapshot {
  fields: SnapshotField[];
  /** `fieldRef -> backendNodeId`, for `executor.ts`'s own internal use only. */
  nodeIds: FieldNodeMap;
}

/**
 * Walks a CDP DOM tree and mints a `SnapshotField` for every fillable element (`input`, `select`,
 * `textarea`). `hidden`/`disabled` inputs are skipped -- there is nothing a real applicant could
 * fill in either, so nothing for the field map to target.
 */
export function extractSnapshotFields(root: CdpDomNode): ExtractedSnapshot {
  const fields: SnapshotField[] = [];
  const nodeIds = new Map<string, number>();

  function walk(node: CdpDomNode): void {
    if (FILLABLE_TAGS.has(node.nodeName)) {
      const inputType = (attr(node, 'type') ?? 'text').toLowerCase();
      if (inputType !== 'hidden' && !hasAttr(node, 'disabled')) {
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
  return { fields, nodeIds };
}
