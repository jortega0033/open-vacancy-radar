import { readAttachmentNames, readAxControlState, type AxControlState } from './ax-readback.js';
import { assertAllowedCdpMethod } from './cdp-allowlist.js';
import {
  extractSnapshotFields,
  extractSubmissionSignals,
  type CdpDomNode,
  type ExtractedSnapshot,
  type FieldGroup,
  type FieldNodeMap,
} from './dom-extract.js';
import { evaluateFormReadiness, type FormReadiness, type LiveFieldState } from './form-readiness.js';
import {
  computePageStateFingerprint,
  findSnapshotField,
  type FormSnapshot,
  type SnapshotField,
  type VerifiedFieldState,
} from './form-snapshot.js';
import { classifySubmissionOutcome, type ObservedResponse, type SubmissionOutcomeReport } from './submission-receipt.js';
import { resolveSubmitControl } from './submit-control.js';
import { isActionAllowed, isNavigationAllowed, type ApplicationTargetPolicy, type ExecutorAction } from './target-policy.js';

const EMPTY_SNAPSHOT_RETRY_LIMIT = 20;
const EMPTY_SNAPSHOT_RETRY_DELAY_MS = 100;

/** How long `observeSubmissionOutcome` will keep re-reading the page for a receipt before giving
 * up and reporting `unknown`. Bounded on purpose (#271 asks for a *bounded* observer): a real
 * confirmation lands in a second or two, and an observer that waited indefinitely would turn every
 * slow page into a hung attempt rather than an honest "outcome not established". */
export const SUBMISSION_OBSERVE_TIMEOUT_MS = 15_000;
export const SUBMISSION_OBSERVE_POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The deterministic executor (#196 §1.1, §2): `openTarget`/`snapshot`/`fill`/`select`/`attach`/
 * `capture`/`handoff`, plus `submit` -- see `target-policy.ts`'s own comment on `ExecutorAction`
 * for what changed in #202 and, just as importantly, what this class still does *not* guarantee
 * about `submit` on its own (the per-instance human confirmation is the caller's responsibility,
 * not something this package can see or enforce).
 *
 * Every method that ultimately calls the transport goes through `assertAllowedCdpMethod` first
 * (`cdp-allowlist.ts`), so a method outside the frozen allowlist throws before it ever reaches a
 * real CDP connection, regardless of how this class is called.
 *
 * `CdpTransport` is a structural interface, not `Electron.Debugger` itself: this package stays
 * Electron-free and fully unit-testable with a fake transport. The real adapter over
 * `webContents.debugger` lives in `apps/desktop/electron/`.
 */
export interface CdpTransport {
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export class ExecutorPolicyError extends Error {
  constructor(
    public readonly action: string,
    reason: string,
  ) {
    super(`action "${action}" refused: ${reason}`);
    this.name = 'ExecutorPolicyError';
  }
}

export type HandoffReason =
  | 'login_wall'
  | 'captcha'
  | 'missing_mandatory_answer'
  | 'unsupported_control'
  | 'off_policy_navigation'
  | 'unrecognized_field'
  | 'user_requested';

export interface HandoffResult {
  action: 'handoff';
  reason: HandoffReason;
}

interface BoxModel {
  content: readonly number[]; // [x1,y1, x2,y2, x3,y3, x4,y4] quad
}

/** One `Accessibility.getFullAXTree` node, narrowed to the two fields `readBackAttachment` reads.
 * CDP types `AXValue.value` as an arbitrary JSON value, so it stays `unknown` here and is narrowed
 * at the one place that consumes it rather than asserted to be a string. */
interface AxNode {
  backendDOMNodeId?: number;
  value?: { value?: unknown };
}

function boxCenter(box: BoxModel): { x: number; y: number } {
  const [x1, y1, , , x3, y3] = box.content;
  return { x: ((x1 ?? 0) + (x3 ?? 0)) / 2, y: ((y1 ?? 0) + (y3 ?? 0)) / 2 };
}

/** One executor instance per attempt/target. Owns the current snapshot generation and the
 * fieldRef -> CDP node-handle map so `fill`/`select`/`attach` can issue correctly-targeted CDP
 * calls -- the node map never leaves this class (see `dom-extract.ts`'s own doc comment on why). */
export class ApplicationExecutor {
  #generation = 0;
  #currentSnapshot: FormSnapshot | undefined;
  #nodeIds: FieldNodeMap = new Map();
  /** The page's own visible text as it stood immediately before the one real submit click, and
   * nothing else. `observeSubmissionOutcome` compares against it so a confirmation phrase that was
   * already on the page before the click can never be mistaken for evidence that the click did
   * something (#271). `undefined` until `submit()` has actually clicked. */
  #preSubmitPageText: string | undefined;
  /**
   * Every read-back this executor has recorded for its own writes, by `fieldRef` (#277). Cleared
   * on every `snapshot()`: a verification names a control by a ref minted in one generation, and a
   * re-read mints a fresh set, so carrying them across would let a stale "verified" claim describe
   * a control that is no longer the same one.
   */
  #verifications = new Map<string, VerifiedFieldState>();

  constructor(
    private readonly transport: CdpTransport,
    private readonly policy: ApplicationTargetPolicy,
  ) {}

  get currentSnapshot(): FormSnapshot | undefined {
    return this.#currentSnapshot;
  }

  /** Every field this executor wrote to during the current snapshot generation, with what the
   * browser reported the control actually holding afterwards. The only honest basis for a "filled"
   * count anywhere in this app. */
  get verifications(): readonly VerifiedFieldState[] {
    return [...this.#verifications.values()];
  }

  private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    assertAllowedCdpMethod(method);
    return this.transport.sendCommand(method, params);
  }

  private requireAction(action: ExecutorAction): void {
    if (!isActionAllowed(this.policy, action)) {
      throw new ExecutorPolicyError(action, `not permitted by policy "${this.policy.id}"`);
    }
  }

  private nodeIdFor(action: string, fieldRef: string): number {
    const backendNodeId = this.#nodeIds.get(fieldRef);
    if (backendNodeId === undefined) throw new ExecutorPolicyError(action, `unknown fieldRef ${fieldRef}`);
    return backendNodeId;
  }

  private currentField(fieldRef: string): ReturnType<typeof findSnapshotField> {
    if (!this.#currentSnapshot) return undefined;
    return findSnapshotField(this.#currentSnapshot, fieldRef);
  }

  /** A real mouse click at a node's own box-model center -- the one click primitive both a
   * checkbox toggle (`fill()`) and a real submit (`submit()`) need, since neither has an allowed
   * CDP method that fires the page's own handlers without a real dispatched click. Kept as one
   * method so a future fix to how the click itself is dispatched (a delay between press/release, a
   * different pointerType, a retry) only has one call site to change -- previously duplicated
   * verbatim in both places, the easiest way for exactly one of the two to silently miss a fix. */
  private async clickAt(backendNodeId: number): Promise<void> {
    const box = (await this.send('DOM.getBoxModel', { backendNodeId })) as { model: BoxModel };
    const { x, y } = boxCenter(box.model);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  /** Navigates to `url`, refusing anything outside the policy's compiled allowlist -- a
   * `handoff('off_policy_navigation')` is the caller's job when this throws, per #196 §1.1's "any
   * navigation to an unlisted origin produces a handoff, never a followed redirect" rule. This is
   * the *pre-navigate* half of that rule; the *never a followed redirect* half is enforced at the
   * Electron layer (`apps/desktop/electron/application-view.ts`'s `will-navigate`/`will-redirect`
   * handlers), since `CdpTransport` here is request/response only and cannot observe a navigation
   * CDP itself didn't initiate. */
  async openTarget(url: string): Promise<void> {
    this.requireAction('openTarget');
    if (!isNavigationAllowed(this.policy, url)) {
      throw new ExecutorPolicyError('openTarget', `url "${url}" is not allowed by policy "${this.policy.id}"`);
    }
    await this.send('Page.navigate', { url });
    this.#generation += 1; // navigation invalidates any prior snapshot's field refs
    this.#currentSnapshot = undefined;
    this.#nodeIds = new Map();
    this.#verifications.clear();
  }

  private async readDom(): Promise<ExtractedSnapshot> {
    const document = (await this.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: CdpDomNode };
    return extractSnapshotFields(document.root);
  }

  /**
   * Whether the browser actually laid `backendNodeId` out, via `DOM.getContentQuads` (#277). This
   * is the one question `dom-extract.ts` documents it cannot answer from markup: the `hidden`
   * attribute and `type="hidden"` are visible in the DOM, but a stylesheet's `display: none` is
   * not, and a page carrying a hidden duplicate of its own form is precisely where filling the
   * wrong copy goes unnoticed.
   *
   * Three outcomes, deliberately kept distinct rather than collapsed into a boolean at the call
   * site: a non-empty quad list is rendered, an empty one is not, and a transport error or a
   * response with no `quads` field at all is `undefined` -- "the browser did not answer". Chromium
   * raises a protocol error rather than returning an empty list for a node it could not compute
   * quads for, so a throw is treated as "not rendered"; anything else (a transport that does not
   * implement this read at all) stays unknown, and an unknown never demotes a field on its own.
   */
  private async isNodeRendered(backendNodeId: number): Promise<boolean | undefined> {
    let response: unknown;
    try {
      response = await this.send('DOM.getContentQuads', { backendNodeId });
    } catch {
      // Chromium's own "Could not compute content quads." for a node with no layout box.
      return false;
    }
    const quads = (response as { quads?: unknown } | undefined)?.quads;
    if (!Array.isArray(quads)) return undefined;
    return quads.length > 0;
  }

  /**
   * Picks the one frame/form pair a person is actually looking at out of an extracted read (#277).
   *
   * A page with exactly one group is unambiguous and costs zero extra CDP calls -- the overwhelming
   * majority of real application pages. Only a page holding fields in more than one frame/form pair
   * (a hidden duplicate of its own form, a stale previous step still in the DOM, an unrelated
   * newsletter or search form, an embedded widget) gets a rendering probe, and then only one probe
   * per group, against the group's own container element.
   *
   * Among the groups the browser actually rendered, the one holding the most fields wins, matching
   * how `dom-extract.ts` already resolves a dominant frame/form by count. If the probe finds none
   * of them rendered, or answers for none of them, the count-based resolution stands on its own
   * rather than the executor declaring the whole page unusable on the strength of a heuristic.
   *
   * Worth being explicit about the limit of this: the geometry answer comes from the page, so a
   * page can steer which of its own forms is treated as active by rendering a larger one. That is a
   * real property, and it is deliberately accepted. It does not widen what this executor can be
   * made to do (a same-origin page choosing which of its own controls receives an answer the
   * applicant already agreed to give it), and the alternative -- trusting markup order or field
   * count alone, which is what happened before -- is strictly worse, because it lets a form the
   * person cannot even see win.
   */
  private async resolveActiveGroup(
    extracted: ExtractedSnapshot,
  ): Promise<{ frameId: number; formScope?: number; renderedByRef: ReadonlyMap<string, boolean> }> {
    const fallback = {
      frameId: extracted.dominantFrameId,
      ...(extracted.dominantFormScope !== undefined ? { formScope: extracted.dominantFormScope } : {}),
      renderedByRef: new Map<string, boolean>(),
    };
    if (extracted.fieldGroups.length <= 1) return fallback;

    const renderedByRef = new Map<string, boolean>();
    const rendered: FieldGroup[] = [];
    for (const group of extracted.fieldGroups) {
      const isRendered = await this.isNodeRendered(group.containerNodeId);
      if (isRendered === undefined) continue;
      for (const fieldRef of group.fieldRefs) renderedByRef.set(fieldRef, isRendered);
      if (isRendered) rendered.push(group);
    }
    if (rendered.length === 0) return { ...fallback, renderedByRef };

    let best = rendered[0] as FieldGroup;
    for (const group of rendered) {
      if (group.fieldRefs.length > best.fieldRefs.length) best = group;
    }
    return {
      frameId: best.frameId,
      ...(best.formScope !== undefined ? { formScope: best.formScope } : {}),
      renderedByRef,
    };
  }

  /**
   * One complete read of the live page: the DOM extraction, the active frame/form resolution, and
   * the resulting page-state fingerprint -- without minting a new snapshot generation.
   *
   * Both `snapshot()` (which does mint one) and the freshness check before a submission go through
   * here, deliberately: comparing fingerprints only means something if both sides were computed by
   * the identical code path over the identical inputs. A separate "cheap" freshness read would be
   * exactly the kind of near-duplicate that drifts and then always reports fresh.
   */
  private async readPageState(): Promise<{
    extracted: ExtractedSnapshot;
    fields: SnapshotField[];
    submitControls: ExtractedSnapshot['submitControls'];
    activeFrameId: number;
    activeFormScope: number | undefined;
    fingerprint: string;
  }> {
    const extracted = await this.readDom();
    const active = await this.resolveActiveGroup(extracted);

    const fields = extracted.fields.map((field) => {
      const isRendered = active.renderedByRef.get(field.fieldRef);
      return {
        ...field,
        active: field.frameId === active.frameId && field.formScope === active.formScope,
        ...(isRendered !== undefined ? { rendered: isRendered } : {}),
      };
    });

    // Re-narrowed to whatever the rendering probe settled on, which is not always the group the
    // plain field count picked: a hidden decoy form with more inputs than the real one would
    // otherwise take its submit button along with it.
    const submitControls = extracted.submitCandidates
      .filter((candidate) => candidate.frameId === active.frameId && candidate.formScope === active.formScope)
      .map((candidate) => candidate.control);

    return {
      extracted,
      fields,
      submitControls,
      activeFrameId: active.frameId,
      activeFormScope: active.formScope,
      fingerprint: computePageStateFingerprint({
        fields,
        submitControlLabels: submitControls.map((control) => control.label),
        challengeDetected: extracted.challengeDetected,
        activeFrameId: active.frameId,
        ...(active.formScope !== undefined ? { activeFormScope: active.formScope } : {}),
      }),
    };
  }

  /** Reads the current DOM into a fresh `FormSnapshot`, minting a new set of field/option refs.
   * Bumps the generation counter, so a field map produced against the previous snapshot is
   * structurally stale afterward (Domain B's rule 2).
   *
   * Retries a genuinely empty read a few times before minting an empty snapshot: `Page.navigate`
   * resolves once navigation is dispatched, not once the document is parsed, so a `snapshot()` called
   * immediately after `openTarget()` can race ahead of the real page and see an empty/interim
   * document -- confirmed against a real Electron `WebContentsView` (`e2e/application-executor.spec.ts`),
   * where every fake-transport unit test's fixed, always-non-empty tree never triggers this path.
   * Checks both `fields` and `submitControls` (not just `fields`, a gap once `submit` became a real
   * action): a field-less "review and submit" final step is legitimately actionable with zero
   * fields, so retrying only on an empty `fields` array would burn the whole budget waiting for
   * fields that will never come; conversely, stopping as soon as `fields` is non-empty without also
   * checking `submitControls` would return prematurely on a page whose inputs render before its
   * submit button does. A read that finds neither retries; a real page that legitimately has
   * neither is indistinguishable from that race and simply pays the (bounded) retry cost once. */
  async snapshot(): Promise<FormSnapshot> {
    this.requireAction('snapshot');
    let state = await this.readPageState();
    // A real challenge widget is a terminal signal, not a loading race: retrying an empty read
    // burns the whole budget for no reason when the page is showing a CAPTCHA on purpose, not
    // still parsing.
    for (
      let attempt = 0;
      state.fields.length === 0 &&
      state.submitControls.length === 0 &&
      !state.extracted.challengeDetected &&
      attempt < EMPTY_SNAPSHOT_RETRY_LIMIT;
      attempt++
    ) {
      await sleep(EMPTY_SNAPSHOT_RETRY_DELAY_MS);
      state = await this.readPageState();
    }
    this.#generation += 1;
    this.#nodeIds = state.extracted.nodeIds;
    // A fresh read means fresh refs: every verification recorded against the previous generation
    // describes controls this snapshot no longer names. Dropped rather than carried forward, so a
    // "verified" claim can never outlive the read it was made against.
    this.#verifications.clear();
    const result: FormSnapshot = {
      generation: this.#generation,
      fields: state.fields,
      submitControls: state.submitControls,
      capturedAt: new Date().toISOString(),
      challengeDetected: state.extracted.challengeDetected,
      activeFrameId: state.activeFrameId,
      ...(state.activeFormScope !== undefined ? { activeFormScope: state.activeFormScope } : {}),
      pageStateFingerprint: state.fingerprint,
    };
    this.#currentSnapshot = result;
    return result;
  }

  /**
   * Reads one control's committed state straight out of the browser (#277), via the narrowest
   * allowed read: `Accessibility.getPartialAXTree` for that one `backendNodeId`, with no relatives.
   *
   * Returns `undefined` when the browser published nothing for the node, which every caller must
   * treat as "unknown", never as "empty" -- the whole point of this method is that a claim about a
   * field's contents has to come from the browser rather than from the fact that a command was
   * sent.
   */
  private async readControlState(backendNodeId: number): Promise<AxControlState | undefined> {
    let response: unknown;
    try {
      response = await this.send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false });
    } catch {
      // A node that has gone away between the write and the read (the page re-rendered its form) is
      // a legitimate, non-exceptional "cannot say", and is reported as such rather than thrown:
      // `unreadable` is a real verification outcome that blocks readiness on its own.
      return undefined;
    }
    return readAxControlState(response, backendNodeId);
  }

  /** Blurs the focused control by moving focus off it with a real Tab press. This is what actually
   * commits a value in a real browser: `change` fires on blur, not on every keystroke, and a page
   * that normalizes, rejects or rewrites what was typed does it here. Every read-back happens after
   * this, so what is verified is the committed value rather than the characters that were sent. */
  private async blurFocusedControl(): Promise<void> {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  }

  private recordVerification(verification: VerifiedFieldState): VerifiedFieldState {
    this.#verifications.set(verification.fieldRef, verification);
    return verification;
  }

  /** Refuses any write to a field that is not part of the active form (#277). A field found in a
   * hidden duplicate frame, a decoy copy, or an unrelated form on the same page has a perfectly
   * ordinary label and type -- being findable has never been evidence that it is the control an
   * applicant would have typed into. */
  private requireActiveField(action: string, field: SnapshotField): void {
    if (field.active) return;
    throw new ExecutorPolicyError(
      action,
      `fieldRef ${field.fieldRef} is not part of the active form (frame ${field.frameId}, form ${field.formScope ?? 'none'})`,
    );
  }

  /**
   * Fills a text/textarea/checkbox/radio field and verifies what the control actually ended up
   * holding. `value` must already have been resolved by Domain B from the attempt's own value table
   * -- this method takes a plain string because by the time it is called, validation has already
   * happened; it is not itself a validation boundary.
   *
   * The write is an explicit *replace*, not an insert (#277): `Input.insertText` inserts at the
   * caret, so calling this twice on the same email field used to produce
   * "ada@example.invalidada@example.invalid" rather than the value asked for -- and nothing in the
   * old code path could have noticed, because it never read the field back. The sequence is now
   * focus, select the control's entire contents, replace the selection (or delete it outright for
   * an empty value), blur to commit, and only then read the committed value back out of the
   * browser.
   *
   * Returns what the browser reports the control holding afterwards. A `mismatch` is returned, not
   * thrown: a controlled input that rewrote or rejected the value is a real state a person needs to
   * see and `form-readiness.ts` needs to block on, not an exception to unwind a whole field map for.
   */
  async fill(fieldRef: string, value: string): Promise<VerifiedFieldState> {
    this.requireAction('fill');
    const field = this.currentField(fieldRef);
    if (!field) throw new ExecutorPolicyError('fill', `unknown fieldRef ${fieldRef}`);
    if (field.classification) {
      throw new ExecutorPolicyError('fill', `fieldRef ${fieldRef} is a ${field.classification}, never fillable`);
    }
    this.requireActiveField('fill', field);
    const backendNodeId = this.nodeIdFor('fill', fieldRef);

    if (field.controlType === 'checkbox' || field.controlType === 'radio') {
      // A checkbox/radio has no allowed-method way to set its checked state directly
      // (`DOM.setAttributeValue` is deliberately not on the allowlist -- it would not fire the
      // page's own change handlers at all). A real click at the element's own box-model center
      // does, toggling whatever the box's current state is -- so a click is only correct when the
      // desired state actually differs from it. Comparing against `field.checked` (rather than
      // assuming every checkbox starts unchecked, a real gap found during #201's review) is what
      // makes this work in both directions: a pre-checked box can now be unchecked, and an
      // already-correct box is left alone rather than toggled by an unnecessary click.
      const desiredChecked = value === 'true';
      if (desiredChecked !== (field.checked ?? false)) await this.clickAt(backendNodeId);
      const state = await this.readControlState(backendNodeId);
      return this.recordVerification(
        this.#verificationFor(field, {
          intendedValue: value,
          state,
          committedValue: state?.checked === undefined ? '' : String(state.checked),
          matches: state?.checked === undefined ? undefined : state.checked === desiredChecked,
        }),
      );
    }

    await this.send('DOM.focus', { backendNodeId });
    // `commands` is how CDP asks the renderer to run a real editing command; `selectAll` selects
    // the focused control's entire contents, so the insert below replaces rather than appends. The
    // key/modifier fields describe the same gesture a person would make, since a page listening for
    // the keystroke itself should see a coherent one.
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: 2, // Ctrl
      commands: ['selectAll'],
    });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    if (value === '') {
      // `Input.insertText` with empty text inserts nothing at all, so it would leave the selection
      // in place and the old value untouched: clearing a field has to be a real delete.
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Delete',
        code: 'Delete',
        windowsVirtualKeyCode: 46,
        commands: ['delete'],
      });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    } else {
      await this.send('Input.insertText', { text: value });
    }
    await this.blurFocusedControl();

    const state = await this.readControlState(backendNodeId);
    return this.recordVerification(
      this.#verificationFor(field, {
        intendedValue: value,
        state,
        committedValue: state?.value ?? '',
        matches: state?.value === undefined ? undefined : state.value === value,
      }),
    );
  }

  /** Assembles one `VerifiedFieldState` from a read-back, in one place so `fill`/`select`/`attach`
   * cannot drift on what counts as verified. `matches: undefined` means the browser published
   * nothing to compare against, which is `unreadable` -- never quietly `verified`. */
  #verificationFor(
    field: SnapshotField,
    input: { intendedValue: string; state: AxControlState | undefined; committedValue: string; matches: boolean | undefined; attachmentNames?: readonly string[] },
  ): VerifiedFieldState {
    const validationMessage = input.state?.description ?? field.validationMessage;
    const invalid = input.state?.invalid === true;
    return {
      fieldRef: field.fieldRef,
      status: input.matches === undefined ? 'unreadable' : input.matches ? 'verified' : 'mismatch',
      intendedValue: input.intendedValue,
      committedValue: input.committedValue,
      ...(input.state?.checked !== undefined ? { checked: input.state.checked } : {}),
      ...(input.attachmentNames ? { attachmentNames: input.attachmentNames } : {}),
      ...(invalid && validationMessage ? { validationMessage } : {}),
      generation: this.#generation,
      verifiedAt: new Date().toISOString(),
    };
  }

  /** Selects one option on a `select` field. Best-effort within the CDP allowlist: focuses the
   * control, then drives it with real keyboard events (arrow-down to the option's index, then
   * Enter) -- there is no allowed CDP method that sets a `<select>`'s value directly and still
   * fires the page's own change handlers, and `DOM.setAttributeValue` is deliberately not on the
   * allowlist for exactly that reason (it would not fire them at all).
   *
   * Normalizes to index 0 with a burst of `ArrowUp` presses before counting `ArrowDown` presses to
   * the target -- confirmed as a real gap during #201's review: counting `ArrowDown` alone assumes
   * the control's real starting selection is always index 0, which is false for a field with a
   * non-first `<option selected>`, a browser-remembered value, or a second `select()` call on the
   * same field. `ArrowUp` on an already-first option is a no-op in every real `<select>`, so
   * sending one per option is a safe, allowlist-only way to guarantee a known starting point
   * without any CDP method that reads the control's current value. */
  async select(fieldRef: string, optionRef: string): Promise<VerifiedFieldState> {
    this.requireAction('select');
    const field = this.currentField(fieldRef);
    if (!field) throw new ExecutorPolicyError('select', `unknown fieldRef ${fieldRef}`);
    const options = field.options ?? [];
    const index = options.findIndex((option) => option.optionRef === optionRef);
    if (index === -1) throw new ExecutorPolicyError('select', `optionRef ${optionRef} is not on fieldRef ${fieldRef}`);
    this.requireActiveField('select', field);
    const backendNodeId = this.nodeIdFor('select', fieldRef);
    const intendedLabel = options[index]?.label ?? '';

    await this.send('DOM.focus', { backendNodeId });
    for (let i = 0; i < options.length; i++) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp' });
    }
    for (let i = 0; i < index; i++) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown' });
    }
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' });
    await this.blurFocusedControl();

    // The whole reason the arrow-key drive above needs verifying at all: it is a best-effort
    // sequence within the allowlist, and a `<select>` that ignored it, wrapped around, or was
    // re-rendered mid-drive would previously have been indistinguishable from one that moved. The
    // browser reports a combobox's committed selection as its accessibility value, which is the
    // selected option's own label -- the same text `dom-extract.ts` minted the option ref from.
    const state = await this.readControlState(backendNodeId);
    const committedValue = state?.value ?? '';
    return this.recordVerification(
      this.#verificationFor(field, {
        intendedValue: intendedLabel,
        state,
        committedValue,
        matches: state?.value === undefined ? undefined : committedValue.trim() === intendedLabel.trim(),
      }),
    );
  }

  /**
   * Attaches a local file (resolved by the caller from a registered artifact id -- never a path
   * the field map itself carries) to a `file` input.
   *
   * `mimeType`/`byteSize` come from the caller's own trusted artifact record (#198), never derived
   * here from the file itself (a file extension is not a security boundary) -- this package does no
   * filesystem I/O by design. Checked against `policy.uploadConstraints` before the CDP call: a real
   * gap found during #201's review had this field declared on `ApplicationTargetPolicy` but never
   * actually enforced anywhere, so an oversized or wrong-type artifact would have reached
   * `DOM.setFileInputFiles` unchecked once artifact resolution (#198) was wired up.
   */
  async attach(fieldRef: string, file: { localFilePath: string; mimeType: string; byteSize: number }): Promise<VerifiedFieldState> {
    this.requireAction('attach');
    const field = this.currentField(fieldRef);
    if (!field) throw new ExecutorPolicyError('attach', `unknown fieldRef ${fieldRef}`);
    if (field.controlType !== 'file') throw new ExecutorPolicyError('attach', `fieldRef ${fieldRef} is not a file input`);
    this.requireActiveField('attach', field);
    const { maxBytes, mimeTypes } = this.policy.uploadConstraints;
    if (file.byteSize > maxBytes) {
      throw new ExecutorPolicyError('attach', `file (${file.byteSize} bytes) exceeds policy "${this.policy.id}"'s ${maxBytes}-byte limit`);
    }
    if (!mimeTypes.includes(file.mimeType)) {
      throw new ExecutorPolicyError('attach', `mime type "${file.mimeType}" is not allowed by policy "${this.policy.id}"`);
    }
    const backendNodeId = this.nodeIdFor('attach', fieldRef);
    await this.send('DOM.setFileInputFiles', { files: [file.localFilePath], backendNodeId });

    // `DOM.setFileInputFiles` resolving means the command was accepted, not that the control holds
    // the file: an input the page swapped out, or one whose `accept` filter rejected it, resolves
    // just the same (#277). A file input has no text value, so the read-back matches the base name
    // the executor itself chose against the accessible name the browser publishes for the control.
    // Splitting on both separators, rather than using `node:path`, keeps this package free of any
    // filesystem dependency: a path handed to it may be in either platform's form regardless of
    // which platform this process is running on.
    const baseName = file.localFilePath.split(/[\\/]/).pop() ?? file.localFilePath;
    const state = await this.readControlState(backendNodeId);
    const attachmentNames = readAttachmentNames(state, [baseName]);
    return this.recordVerification(
      this.#verificationFor(field, {
        intendedValue: baseName,
        state,
        committedValue: attachmentNames.join(', '),
        // A file input whose accessibility node published nothing at all is `unreadable`; one that
        // published something not containing the chosen name is a real `mismatch`.
        matches: state === undefined ? undefined : attachmentNames.length > 0,
        attachmentNames,
      }),
    );
  }

  /**
   * Reads what every active field on the current snapshot is holding right now, re-reads the page's
   * own state to check freshness, and answers whether this application is actually ready to submit
   * (#277).
   *
   * This is the check that replaces "the snapshot found nine fields, so nine fields are filled". It
   * costs one DOM read plus one narrow accessibility read per active field, and it is the only
   * thing in this package entitled to describe a field as filled. Note what it deliberately does
   * NOT depend on: a screenshot proves a page rendered, a field inventory proves a form exists, and
   * neither contributes to `verifiedFilledCount`.
   *
   * Requires the `snapshot` action, since that is exactly what it does -- it reads the live page and
   * nothing else. It never writes, never clicks, and never mints a new generation, so the refs a
   * person is currently reviewing stay valid across it.
   */
  async evaluateReadiness(): Promise<FormReadiness> {
    this.requireAction('snapshot');
    const snapshot = this.#currentSnapshot;
    if (!snapshot) throw new ExecutorPolicyError('snapshot', 'no current snapshot to evaluate readiness against');

    const fresh = await this.readPageState();
    const liveState = new Map<string, LiveFieldState>();
    for (const field of snapshot.fields) {
      if (!field.active || field.classification) continue;
      const backendNodeId = this.#nodeIds.get(field.fieldRef);
      if (backendNodeId === undefined) continue;
      const state = await this.readControlState(backendNodeId);
      if (!state) continue;
      const recorded = this.#verifications.get(field.fieldRef);
      liveState.set(field.fieldRef, {
        ...(state.value !== undefined ? { value: state.value } : {}),
        ...(state.checked !== undefined ? { checked: state.checked } : {}),
        ...(state.invalid !== undefined ? { invalid: state.invalid } : {}),
        ...(state.invalid === true && state.description ? { validationMessage: state.description } : {}),
        ...(field.controlType === 'file'
          ? {
              // A file input has no text value of its own. Prefer the names this executor verified
              // for its own upload; otherwise fall back to whatever value the browser published,
              // which is how a file a person attached themselves during a live handoff is seen at
              // all. An empty published value is an empty attachment list, not an unknown one.
              attachmentNames: recorded?.attachmentNames ?? (state.value ? [state.value] : []),
            }
          : {}),
      });
    }

    return evaluateFormReadiness({
      snapshot,
      liveState,
      verifications: this.verifications,
      currentPageStateFingerprint: fresh.fingerprint,
    });
  }

  /**
   * What the browser itself reports is currently selected on a `file` input, or `null` when it
   * reports nothing at all -- the read-back half of `attach`, so a caller can confirm the file
   * actually landed on the control rather than assuming `DOM.setFileInputFiles` resolving means it
   * did (#273: "read back the attached filename ... before ready", never fire-and-forget).
   *
   * Reads the control's own accessible value out of `Accessibility.getFullAXTree`, matched by the
   * exact `backendNodeId` this executor already holds for `fieldRef` -- never by label or by
   * scanning for a string that looks like a file name. Chromium reports a file input's status text
   * as that node's accessible value: verified directly against a real Electron process driving the
   * `e2e/fixtures/ashby-application-form.html` file input over CDP, which reported
   * `value: "No file chosen"` before `DOM.setFileInputFiles` and the selected file's own base name
   * after it, with no `Accessibility.enable` call needed first.
   *
   * That is the only read-back available inside the frozen CDP allowlist: the selected file is an
   * IDL property, not an HTML attribute, so `DOM.getAttributes`/`DOM.describeNode` cannot see it,
   * and the one domain that could read a property directly is structurally denied
   * (`cdp-allowlist.ts`'s `DENIED_CDP_DOMAINS`). Note the reported name is the *on-disk* file's
   * base name, not whatever logical name the caller's artifact record carries.
   *
   * Deliberately returns the raw reported string rather than a boolean: deciding what counts as a
   * confirmed attachment is the caller's judgment (it is the side that knows which file name it
   * asked for), and a wrong-but-present file name must be distinguishable from nothing at all.
   */
  async readBackAttachment(fieldRef: string): Promise<string | null> {
    this.requireAction('attach');
    const field = this.currentField(fieldRef);
    if (!field) throw new ExecutorPolicyError('attach', `unknown fieldRef ${fieldRef}`);
    if (field.controlType !== 'file') throw new ExecutorPolicyError('attach', `fieldRef ${fieldRef} is not a file input`);
    const backendNodeId = this.nodeIdFor('attach', fieldRef);
    const tree = (await this.send('Accessibility.getFullAXTree', {})) as { nodes?: readonly AxNode[] };
    const node = (tree.nodes ?? []).find((candidate) => candidate.backendDOMNodeId === backendNodeId);
    const value = node?.value?.value;
    return typeof value === 'string' ? value : null;
  }

  /** Captures a screenshot for the review UI / submission evidence record. */
  async capture(): Promise<string> {
    this.requireAction('capture');
    const result = (await this.send('Page.captureScreenshot', {})) as { data: string };
    return result.data;
  }

  /**
   * Clicks the identified submit control for real, via the same box-model-center mouse click
   * `fill()` already uses for a checkbox (`clickAt`) -- there is no allowed CDP method that
   * submits a form directly (and none should exist: a real click is what a real applicant does,
   * and is what the page's own submit-handler, validation, and any fraud/bot scoring actually
   * observe).
   *
   * `controlRef` must name the *same* control `submit-control.ts`'s `resolveSubmitControl` would
   * itself pick out of the current snapshot's `submitControls` -- this method re-derives that
   * resolution and refuses if `controlRef` names anything else, rather than trusting the caller to
   * have called `resolveSubmitControl` correctly (an earlier version of this method took that on
   * faith; a caller bug, or any future code path that hands `submit()` a raw ref from the
   * unfiltered `submitControls` list, would have had no structural check stopping it from clicking
   * a "Cancel" or "Save as draft" button that happened to share the snapshot with a genuine one).
   * It also refuses outright when the current snapshot reports `challengeDetected` -- the one
   * `handoff('captcha')` signal this package can check for itself, on the one action here with no
   * undo, even though `fill`/`select`/`attach` don't perform the same check (their effects are
   * reversible; this one isn't).
   *
   * None of this is a substitute for the orchestrator's own responsibility: the pre-submit content
   * gate, and above all a specific human's per-instance confirmation that this exact filled
   * application should be sent. By the time `submit()` is called, that decision must already have
   * been made -- this method only guards against clicking the *wrong* control once that decision
   * has been made, not whether the decision to submit at all was a sound one.
   *
   * Returning from this method means the click was dispatched, and nothing more than that (#271).
   * It is emphatically NOT a statement that the application was accepted: the page's own handler
   * can re-render the same form with a required-field error and still resolve this promise
   * normally. `observeSubmissionOutcome()` is what answers that separate question.
   */
  async submit(controlRef: string): Promise<void> {
    this.requireAction('submit');
    if (!this.#currentSnapshot) throw new ExecutorPolicyError('submit', 'no current snapshot to submit from');
    if (this.#currentSnapshot.challengeDetected) {
      throw new ExecutorPolicyError('submit', 'refusing to submit: the current snapshot has an active CAPTCHA/bot-detection challenge');
    }
    // Freshness, checked here and not only by the caller (#277): between a person reviewing this
    // page and this click, the page may have grown a required field, started showing a validation
    // error, replaced its form, or raised a challenge. This compares a fresh read of the page's own
    // state against the snapshot under review and refuses outright if they differ, on the one
    // action in this class that has no undo. It is a structural last line, not a substitute for the
    // caller's own readiness evaluation, which reports *why* and can be acted on.
    const fresh = await this.readPageState();
    if (fresh.fingerprint !== this.#currentSnapshot.pageStateFingerprint) {
      throw new ExecutorPolicyError(
        'submit',
        'refusing to submit: the page changed since the snapshot under review was taken, so nothing reviewed describes it any more',
      );
    }
    const resolved = resolveSubmitControl(this.#currentSnapshot.submitControls);
    if (!resolved || resolved.controlRef !== controlRef) {
      throw new ExecutorPolicyError('submit', `controlRef ${controlRef} is not the sole resolved submit control for the current snapshot`);
    }
    const backendNodeId = this.nodeIdFor('submit', controlRef);

    // The pre-click baseline for `observeSubmissionOutcome`, read *after* every refusal above has
    // already passed, so nothing here can turn a clean pre-click refusal into a click. Failing to
    // read it is deliberately not fatal: this is an observation aid, and letting it throw would
    // turn a page whose DOM read hiccuped into a `submission_unknown` for an attempt that never
    // actually clicked anything. An unreadable baseline just means no phrase can be discounted as
    // pre-existing, which withholds evidence rather than inventing it.
    try {
      this.#preSubmitPageText = extractSubmissionSignals((await this.send('DOM.getDocument', { depth: -1, pierce: true }) as { root: CdpDomNode }).root).text;
    } catch {
      this.#preSubmitPageText = '';
    }

    await this.clickAt(backendNodeId);
  }

  /**
   * The bounded, deterministic submission-outcome observer #271 asks for: after the click, re-read
   * the page (allowlisted `DOM.getDocument` only -- the `Network` domain is denied outright, see
   * `cdp-allowlist.ts`) until one of three things is established, or the budget runs out.
   *
   *  - `submitted`, only on real positive evidence: a confirmation the page was not already
   *    showing before the click, or a printed receipt reference, or an application identifier in a
   *    response the *host* layer observed and passed in. Never on "the click didn't throw".
   *  - `rejected`, when the form is flagging field errors or the observed response carries an
   *    application-level error -- including one delivered over an HTTP success.
   *  - `unknown`, for everything else: the budget elapsed with nothing conclusive, the page could
   *    no longer be read at all (navigation loss, a crashed renderer), or the form is simply still
   *    standing with nothing to say. The caller records this as the existing `submission_unknown`
   *    checkpoint rather than guessing in either direction.
   *
   * Read-only: it mints no refs, touches no node map, and never clicks anything, so calling it can
   * never produce a second submission. It also never re-clicks on an inconclusive read -- retrying
   * a submit is exactly the blind retry `submission_unknown` exists to prevent.
   */
  async observeSubmissionOutcome(
    options: { timeoutMs?: number; pollIntervalMs?: number; response?: ObservedResponse } = {},
  ): Promise<SubmissionOutcomeReport> {
    if (this.#preSubmitPageText === undefined) {
      throw new ExecutorPolicyError('observeSubmissionOutcome', 'there is nothing to observe: submit() was never called on this executor');
    }
    const baselineText = this.#preSubmitPageText;
    const timeoutMs = Math.max(0, options.timeoutMs ?? SUBMISSION_OBSERVE_TIMEOUT_MS);
    const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? SUBMISSION_OBSERVE_POLL_INTERVAL_MS);
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      let signals: ReturnType<typeof extractSubmissionSignals>;
      try {
        const document = (await this.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: CdpDomNode };
        signals = extractSubmissionSignals(document.root);
      } catch (err) {
        // The page stopped being readable after a real click was already dispatched. That is the
        // genuinely ambiguous case -- the submission may well have gone through on the way out.
        return {
          outcome: 'unknown',
          reason: 'navigation_lost',
          detail: `the page could not be read after the submit click: ${err instanceof Error ? err.message : String(err)}`,
          observedAt: new Date().toISOString(),
        };
      }

      const report = classifySubmissionOutcome(
        {
          text: signals.text,
          baselineText,
          formStillPresent: signals.formStillPresent,
          errorMarkers: signals.errorMarkers,
          ...(options.response ? { response: options.response } : {}),
        },
        new Date().toISOString(),
      );
      if (report.outcome !== 'unknown') return report;

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          outcome: 'unknown',
          reason: 'observation_timeout',
          // Carries the last read's own account of what it saw, so an inconclusive outcome still
          // says something specific rather than only "nothing happened".
          detail: `no submission receipt was observed within ${timeoutMs}ms: ${report.detail}`,
          observedAt: new Date().toISOString(),
        };
      }
      await sleep(Math.min(pollIntervalMs, remaining));
    }
  }

  /** A pure state transition -- no CDP call. Surfaces the live view to the user and stops the
   * attempt. The caller (main process) is what actually shows the window. */
  handoff(reason: HandoffReason): HandoffResult {
    return { action: 'handoff', reason };
  }
}
