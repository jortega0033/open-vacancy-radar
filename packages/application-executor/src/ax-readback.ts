/**
 * Pure parsing of a CDP `Accessibility.getPartialAXTree` response into the committed state of one
 * control (#277). Kept separate from `executor.ts` -- which owns the actual `sendCommand` calls --
 * for the same reason `dom-extract.ts` is: this is the part with real logic worth getting right,
 * and it is unit-testable against a hand-built response with no CDP transport, no Electron, and no
 * live browser.
 *
 * Why the accessibility tree rather than the DOM: a text input's *committed* value lives in its
 * `value` IDL property, which is not reflected back into the `value` content attribute that
 * `DOM.getDocument`/`DOM.getAttributes` return. Reading markup after typing therefore reports what
 * the page shipped, never what the control now holds -- which is exactly the confusion #277 exists
 * to remove. The accessibility tree is where the browser itself publishes the live value, the live
 * checked state, and whether the page has marked the control invalid, and it is reachable without
 * any method that can execute page script.
 *
 * Everything parsed here is untrusted third-party page content. It is carried as data and compared
 * against what the executor itself wrote; nothing read here is ever interpreted as an instruction,
 * and nothing read here influences which CDP command runs next.
 */

/** A minimal local shape for CDP's `AXValue`, not the full protocol: only what is read below. */
export interface CdpAxValue {
  type?: string;
  value?: unknown;
}

export interface CdpAxProperty {
  name?: string;
  value?: CdpAxValue;
}

export interface CdpAxNode {
  nodeId?: string;
  ignored?: boolean;
  role?: CdpAxValue;
  name?: CdpAxValue;
  description?: CdpAxValue;
  value?: CdpAxValue;
  properties?: readonly CdpAxProperty[];
  /** The DOM node this accessibility node describes. The only reliable way to pick the node the
   * caller actually asked about out of a response that may also carry ancestors/relatives. */
  backendDOMNodeId?: number;
}

export interface CdpPartialAxTreeResponse {
  nodes?: readonly CdpAxNode[];
}

/** One control's committed state, as the browser reports it. Every field is optional because a
 * real accessibility node legitimately omits any of them, and "the browser did not say" must stay
 * distinguishable from "the browser said no". */
export interface AxControlState {
  /** The control's live value. `undefined` when the browser published none at all. */
  value?: string;
  /** Committed checked state for a checkbox/radio. `undefined` when the node is not checkable. */
  checked?: boolean;
  /** Whether the browser or the page has marked this control invalid. */
  invalid?: boolean;
  /** Whether the browser reports this control as required. */
  required?: boolean;
  /** The control's accessible name -- for a file input, this is where Chromium publishes the
   * chosen file name(s), since such a control has no text value of its own. */
  name?: string;
  /** The control's accessible description, which is where an `aria-describedby`/`aria-errormessage`
   * association surfaces once the browser has resolved it. */
  description?: string;
}

/**
 * How long any single string read out of a page's accessibility node is allowed to be (#277).
 *
 * Every string here is page-authored and of page-chosen length, and they travel a long way from
 * this function: into a snapshot, across IPC, into a refusal `detail`, and on the automatic path
 * into a desktop notification body. Bounded once at the boundary where they enter, rather than at
 * each place they are later displayed, so no future consumer has to remember to do it. Generous
 * enough that no real control's value or error text is truncated.
 */
const MAX_AX_STRING_LENGTH = 2000;

function stringValue(value: CdpAxValue | undefined): string | undefined {
  if (!value) return undefined;
  const raw = value.value;
  if (typeof raw === 'string') return raw.slice(0, MAX_AX_STRING_LENGTH);
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return undefined;
}

function propertyValue(node: CdpAxNode, name: string): CdpAxValue | undefined {
  for (const property of node.properties ?? []) {
    if (property.name === name) return property.value;
  }
  return undefined;
}

/** CDP publishes `checked` as a tristate string (`"true"`/`"false"`/`"mixed"`), not a boolean.
 * `"mixed"` is a real third state, and is deliberately not folded into either answer. */
function checkedState(node: CdpAxNode): boolean | undefined {
  const raw = stringValue(propertyValue(node, 'checked'));
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

/** `invalid` is published as `"false"` / `"true"` / `"spelling"` / `"grammar"`. Only an explicit
 * `"false"` means valid; a spelling/grammar hint is a real invalid state for this purpose, since a
 * page using it is telling the user something is wrong with what the control holds. */
function invalidState(node: CdpAxNode): boolean | undefined {
  const raw = stringValue(propertyValue(node, 'invalid'));
  if (raw === undefined) return undefined;
  return raw !== 'false';
}

function booleanProperty(node: CdpAxNode, name: string): boolean | undefined {
  const raw = propertyValue(node, name);
  if (!raw) return undefined;
  if (typeof raw.value === 'boolean') return raw.value;
  const asString = stringValue(raw);
  if (asString === 'true') return true;
  if (asString === 'false') return false;
  return undefined;
}

/**
 * Picks the accessibility node describing `backendNodeId` out of a partial-tree response and reads
 * its committed state.
 *
 * A partial tree legitimately carries ancestors (and, with `fetchRelatives`, siblings) alongside
 * the node that was asked for, so this matches on `backendDOMNodeId` rather than taking the first
 * or last entry -- picking positionally is the kind of thing that works on every fixture and then
 * silently reads a `<div>`'s state on a real page. Returns `undefined` when no node in the response
 * describes that DOM node at all, which the caller must treat as `'unreadable'`, never as empty.
 */
export function readAxControlState(response: unknown, backendNodeId: number): AxControlState | undefined {
  const nodes = (response as CdpPartialAxTreeResponse | undefined)?.nodes;
  if (!Array.isArray(nodes)) return undefined;

  // An ignored node (`aria-hidden`, or not exposed at all) still describes the right DOM node and
  // is worth reporting over nothing, but a non-ignored match is always preferred.
  let ignoredMatch: CdpAxNode | undefined;
  let match: CdpAxNode | undefined;
  for (const node of nodes) {
    if (!node || node.backendDOMNodeId !== backendNodeId) continue;
    if (node.ignored) {
      ignoredMatch ??= node;
      continue;
    }
    match = node;
    break;
  }
  const chosen = match ?? ignoredMatch;
  if (!chosen) return undefined;

  const value = stringValue(chosen.value);
  const name = stringValue(chosen.name);
  const description = stringValue(chosen.description);
  const checked = checkedState(chosen);
  const invalid = invalidState(chosen);
  const required = booleanProperty(chosen, 'required');

  return {
    ...(value !== undefined ? { value } : {}),
    ...(checked !== undefined ? { checked } : {}),
    ...(invalid !== undefined ? { invalid } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

/**
 * The file names a file input reports holding, derived from its accessible name (#277).
 *
 * A `<input type="file">` has no text value; Chromium publishes the chosen file name(s) as part of
 * the control's accessible name, alongside the browser's own button caption. There is no allowed
 * CDP method that returns the selected `FileList` directly, and reading one would need page script,
 * so this compares against the base names the caller itself passed to `DOM.setFileInputFiles` --
 * evidence that the file the executor chose is the file the control now holds, never an attempt to
 * enumerate whatever else might be there.
 *
 * `expectedNames` is matched case-insensitively and as a substring, because the surrounding caption
 * ("2 files", "No file chosen", a localized equivalent) is browser- and locale-dependent and must
 * never be the thing a match depends on.
 *
 * Matched against the control's accessibility **value** only, deliberately -- never its name or
 * description. Those two are author-supplied: a page can put anything it likes in `aria-label` or
 * `aria-describedby`, including the exact file name it just read out of `input.files[0].name`
 * before discarding the file. Matching them would let a page produce a confirmed attachment it does
 * not hold, which is worse than an unconfirmed one: the person would be told their CV landed on a
 * form that threw it away. The value is what Chromium itself computes for a file input's current
 * selection (confirmed against a real Electron/Chromium process in #273: `"No file chosen"` before
 * the upload, the selected file's own base name after it), and is the only half a page cannot
 * author directly.
 */
export function readAttachmentNames(state: AxControlState | undefined, expectedNames: readonly string[]): string[] {
  if (!state) return [];
  const haystack = (state.value ?? '').toLowerCase();
  return expectedNames.filter((expected) => expected.length > 0 && haystack.includes(expected.toLowerCase()));
}
